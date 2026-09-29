// Fila de pedidos painel → sessão, e sinal de vida dos watchers (spec
// docs/specs/2026-09-28-acoes-no-painel.md C1-C5). Node puro, sem dependências.
//
// Três tipos de pedido — resume, stop, rerun-node — cada um com id próprio (`req-<carimbo>-<hex>`)
// e uma máquina de estados pendente → aceito → feito|falhou, gravada em disco de forma atômica
// (tmp `wx` 0600 + rename, como bin/config.mjs). A "corrida" de quem sai de `pendente` e quem grava
// o estado final é resolvida por dois arquivos O_EXCL (`.claim` e `.final`): quem recebe EEXIST
// perdeu a corrida e não grava nada (regra única de escrita, C2).
//
// Quem usa: o CLI deste arquivo (accept/done/fail/list, C5), rodado pela sessão que atende o
// pedido; o painel (bin/ui-server.mjs, I4/I5), que cria pedidos e lê o estado; o `graph-watch
// events` (I3, mesmo nó), que emite a linha do pedido elegível e grava o sinal de vida do watcher.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { defaultStateDir } from './config.mjs'

export { defaultStateDir }

// ── Regexes e constantes (C2, C3) ──
export const REQ_RE = /^req-\d{8}T\d{6}-[0-9a-f]{6}$/
export const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const WF_RE = /^wf_[A-Za-z0-9_-]+$/
export const NODE_RE = /^[A-Za-z0-9_-]{1,64}$/
export const REQUEST_TYPES = ['resume', 'stop', 'rerun-node']
export const ROUTES = ['project', 'owner']

export const PENDING_TTL_MS = 600000 // 10 min (C2)
export const ACCEPTED_TTL_MS = 1800000 // 30 min (C2)
export const ACCEPTED_GRACE_MS = 120000 // 2 min: o painel pode descartar um `aceito` (C2)
export const OPEN_DONE_WINDOW_MS = 600000 // 10 min: resume/rerun-node `feito` ainda conta como aberto (C2)
export const HEARTBEAT_MS = 10000 // cadência do sinal de vida (C3)
export const LISTEN_FRESH_MS = 30000 // um listener conta como vivo por até 30 s sem novo beat (C3)
export const REARM_GRACE_MS = 120000 // 2 min de carência para não confundir rearme com sessão encerrada (C3)
export const MAX_REASON_LEN = 300

// ── Caminhos (C1) ──
export const requestsDir = (stateDir) => path.join(stateDir, 'requests')
export const listenersDir = (stateDir) => path.join(stateDir, 'listeners')
const reqFile = (stateDir, id) => path.join(requestsDir(stateDir), `${id}.json`)
const claimFile = (stateDir, id) => path.join(requestsDir(stateDir), `${id}.claim`)
const finalFile = (stateDir, id) => path.join(requestsDir(stateDir), `${id}.final`)
const seenFile = (stateDir, id, session) => path.join(requestsDir(stateDir), `${id}.seen-${session}`)
const listenerFile = (stateDir, session, pid) => path.join(listenersDir(stateDir), `${session}.${pid}.json`)

// ── E/S atômica (C1: "sempre tmp <arquivo>.tmp-<pid>-<seq> com wx/0600 + renameSync") ──
let seq = 0
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${++seq}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* tmp nem chegou a existir */
    }
    throw e
  }
}

// Cria um arquivo "cadeado" (.claim/.final/.seen-*) com `wx`: quem recebe EEXIST perdeu a corrida.
// Devolve true se criou, false se já existia (EEXIST); relança qualquer outro erro.
export function createExclusive(file, value = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
    return true
  } catch (e) {
    if (e && e.code === 'EEXIST') return false
    throw e
  }
}

// Leitura tolerante: nunca lança por conteúdo (arquivo pela metade ou apagado entre o readdir e o
// read não derruba o painel nem o watcher), como readConfig em bin/config.mjs.
export function readJsonTolerant(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw e
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isoNow(now) {
  return new Date(now).toISOString()
}

function randHex(n = 3) {
  return crypto.randomBytes(n).toString('hex')
}

function carimbo(now) {
  // req-YYYYMMDDTHHMMSS-hex (REQ_RE), sempre em UTC para não depender do fuso da máquina.
  const iso = new Date(now).toISOString() // 2026-09-28T15:12:03.412Z
  return iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + 'T' + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19)
}

function genRequestId(now) {
  return `req-${carimbo(now)}-${randHex(3)}`
}

// ── Pedidos (C2) ──

// `input` já resolvido pelo servidor: { type, wf, node?, dependents?, dependentsList?, runKey, runId,
// project, ownerSession, runDir, route }. O cliente manda só { type, wf, node?, dependents? }; o
// resto sai do índice/Modelo da execução atual (o servidor monta `input` antes de chamar isto).
export function createRequest(stateDir, input, now = Date.now()) {
  const { type, wf, node = null, dependents = false, dependentsList = [], runKey, runId, project, ownerSession, runDir, route } = input
  if (!REQUEST_TYPES.includes(type)) throw new Error(`tipo de pedido inválido: ${type}`)
  if (!WF_RE.test(String(wf))) throw new Error(`id de run inválido: ${wf}`)
  if (type === 'rerun-node' && !NODE_RE.test(String(node))) throw new Error(`id de nó inválido: ${node}`)
  if (!ROUTES.includes(route)) throw new Error(`route inválida: ${route}`)
  // `stop` sempre grava `owner` (spec C2/C5): só a sessão dona pode parar sua própria run.
  const effectiveRoute = type === 'stop' ? 'owner' : route

  const id = genRequestId(now)
  const at = isoNow(now)
  const req = {
    v: 1,
    id,
    type,
    wf,
    runKey: runKey ?? null,
    runId: runId ?? null,
    project: project ?? null,
    ownerSession: ownerSession ?? null,
    runDir: runDir ?? null,
    node: type === 'rerun-node' ? node : null,
    dependents: type === 'rerun-node' ? !!dependents : false,
    dependentsList: type === 'rerun-node' ? dependentsList : [],
    route: effectiveRoute,
    state: 'pendente',
    reason: null,
    createdAt: at,
    updatedAt: at,
    acceptedAt: null,
    acceptedBy: null,
    finishedAt: null,
    newWf: null,
    history: [{ state: 'pendente', at, by: 'painel' }],
  }
  writeJsonAtomic(reqFile(stateDir, id), req)
  return req
}

export function readRequest(stateDir, id) {
  if (!REQ_RE.test(String(id))) return null
  return readJsonTolerant(reqFile(stateDir, id))
}

// Sempre lê `route: 'owner'` quando o campo falta (arquivo antigo/corrompido, o lado seguro — C2),
// e sempre para `stop` (C2: "stop sempre grava owner"; C4: "route: owner (e todo stop)"), mesmo que
// o arquivo em disco traga `route: 'project'` por engano ou corrupção.
function normalizeRoute(req) {
  if (req.type === 'stop') return 'owner'
  return req.route === 'project' ? 'project' : 'owner'
}

export function listRequests(stateDir) {
  const dir = requestsDir(stateDir)
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const id = f.slice(0, -5)
    if (!REQ_RE.test(id)) continue
    const req = readJsonTolerant(path.join(dir, f))
    if (req) out.push({ ...req, route: normalizeRoute(req) })
  }
  out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  return out
}

export function isPendingExpired(req, now = Date.now()) {
  if (req.state !== 'pendente') return false
  const t = Date.parse(req.createdAt)
  return Number.isNaN(t) || now - t > PENDING_TTL_MS
}

export function isAcceptedExpired(req, now = Date.now()) {
  if (req.state !== 'aceito') return false
  const t = Date.parse(req.acceptedAt)
  return Number.isNaN(t) || now - t > ACCEPTED_TTL_MS
}

export function isAcceptedDiscardable(req, now = Date.now()) {
  if (req.state !== 'aceito') return false
  const t = Date.parse(req.acceptedAt)
  return Number.isNaN(t) || now - t >= ACCEPTED_GRACE_MS
}

// "Um pedido aberto por runKey" (C2): pendente/aceito não vencido, ou resume/rerun-node feito há
// menos de 10 min cujo wf ainda é a execução atual.
export function isOpenForRunKey(req, runKey, currentWf, now = Date.now()) {
  if (req.runKey !== runKey) return false
  if (req.state === 'pendente') return !isPendingExpired(req, now)
  if (req.state === 'aceito') return !isAcceptedExpired(req, now)
  if (req.state === 'feito' && (req.type === 'resume' || req.type === 'rerun-node')) {
    const t = Date.parse(req.finishedAt)
    return !Number.isNaN(t) && now - t < OPEN_DONE_WINDOW_MS && req.wf === currentWf
  }
  return false
}

function appendHistory(req, state, at, by) {
  return { ...req, history: [...(req.history || []), { state, at, by }] }
}

// Grava `falhou` sobre um pedido que já tem `.final` (a corrida foi ganha por outra gravação; só
// atualiza o JSON para refletir, tolerando falha — quem leu por último decide o texto exibido).
function markFinal(stateDir, id, req, state, reason, now, newWf) {
  const at = isoNow(now)
  const updated = appendHistory({ ...req, state, reason: reason ?? null, finishedAt: at, updatedAt: at, newWf: newWf ?? req.newWf ?? null }, state, at, 'sistema')
  try {
    writeJsonAtomic(reqFile(stateDir, id), updated)
  } catch {
    /* melhor esforço: o `.final` já é a fonte da verdade de que o pedido está encerrado */
  }
  return updated
}

// `accept <id> --session <s>` (C5). Devolve { ok, code, req?, reason? }.
// Códigos: 0 ok · 1 E/S · 2 id inválido/inexistente · 3 já aceito/encerrado/vencido · 4 sessão errada.
export function acceptRequest(stateDir, id, { session, now = Date.now() } = {}) {
  if (!REQ_RE.test(String(id))) return { ok: false, code: 2, reason: 'id de pedido inválido' }
  if (!SESSION_RE.test(String(session))) return { ok: false, code: 1, reason: 'sessão inválida' }
  let req = readRequest(stateDir, id)
  if (!req) return { ok: false, code: 2, reason: 'pedido não encontrado' }
  if (req.state !== 'pendente') return { ok: false, code: 3, reason: `pedido já está ${req.state}` }
  if (normalizeRoute(req) === 'owner' && session !== req.ownerSession) {
    return { ok: false, code: 4, reason: 'esta sessão não é a dona da run' }
  }
  let created
  try {
    created = createExclusive(claimFile(stateDir, id), { by: session, pid: process.pid, at: isoNow(now) })
  } catch (e) {
    return { ok: false, code: 1, reason: `E/S: ${(e && e.message) || e}` }
  }
  if (!created) return { ok: false, code: 3, reason: 'outra sessão já aceitou' }

  req = readRequest(stateDir, id) || req
  if (req.state !== 'pendente') return { ok: false, code: 3, reason: `pedido já está ${req.state}` }
  if (isPendingExpired(req, now)) {
    if (createExclusive(finalFile(stateDir, id), { by: 'sistema', state: 'falhou', at: isoNow(now) })) {
      markFinal(stateDir, id, req, 'falhou', 'nenhuma sessão aceitou em 10 min', now)
    }
    return { ok: false, code: 3, reason: 'pedido vencido' }
  }

  const at = isoNow(now)
  const updated = appendHistory({ ...req, state: 'aceito', acceptedAt: at, acceptedBy: session, updatedAt: at }, 'aceito', at, session)
  writeJsonAtomic(reqFile(stateDir, id), updated)
  return { ok: true, code: 0, req: updated }
}

// `done`/`fail` (C5): a mesma trava do `.final` O_EXCL — quem cria primeiro ganha o direito de
// gravar o estado terminal. Códigos: 0 ok · 1 E/S · 2 id inválido/inexistente · 4 sessão errada ·
// 5 já encerrado ou transição inválida (não está `aceito`, ou o claim não é desta sessão).
function finishRequest(stateDir, id, { session, state, reason = null, newWf = null, now = Date.now() } = {}) {
  if (!REQ_RE.test(String(id))) return { ok: false, code: 2, reason: 'id de pedido inválido' }
  if (!SESSION_RE.test(String(session))) return { ok: false, code: 1, reason: 'sessão inválida' }
  if (state === 'falhou' && reason != null && (String(reason).length > MAX_REASON_LEN || /[\u0000-\u001f]/.test(String(reason)))) {
    return { ok: false, code: 1, reason: 'motivo inválido (até 300 caracteres, sem caractere de controle)' }
  }
  let req = readRequest(stateDir, id)
  if (!req) return { ok: false, code: 2, reason: 'pedido não encontrado' }
  const claim = readJsonTolerant(claimFile(stateDir, id))
  if (!claim || claim.by !== session) return { ok: false, code: 4, reason: 'esta sessão não é dona do claim' }

  let created
  try {
    created = createExclusive(finalFile(stateDir, id), { by: session, state, at: isoNow(now) })
  } catch (e) {
    return { ok: false, code: 1, reason: `E/S: ${(e && e.message) || e}` }
  }
  if (!created) return { ok: false, code: 5, reason: 'pedido já encerrado' }

  req = readRequest(stateDir, id) || req
  if (req.state !== 'aceito') return { ok: false, code: 5, reason: 'transição inválida' }

  const updated = markFinal(stateDir, id, req, state, reason, now, newWf)
  return { ok: true, code: 0, req: updated }
}

export function doneRequest(stateDir, id, { session, newWf = null, note = null, now = Date.now() } = {}) {
  return finishRequest(stateDir, id, { session, state: 'feito', reason: note, newWf, now })
}

export function failRequest(stateDir, id, { session, reason, now = Date.now() } = {}) {
  return finishRequest(stateDir, id, { session, state: 'falhou', reason, now })
}

// Encerra `pendente`/`aceito` vencidos na leitura (C2, "o servidor, na leitura"). Melhor esforço:
// não lança em corrida com um accept/done/fail concorrente.
export function reapExpired(stateDir, now = Date.now()) {
  const out = []
  for (const req of listRequests(stateDir)) {
    if (req.state === 'pendente' && isPendingExpired(req, now)) {
      if (createExclusive(finalFile(stateDir, req.id), { by: 'sistema', state: 'falhou', at: isoNow(now) })) {
        out.push(markFinal(stateDir, req.id, req, 'falhou', 'nenhuma sessão aceitou em 10 min', now))
      }
    } else if (req.state === 'aceito' && isAcceptedExpired(req, now)) {
      if (createExclusive(finalFile(stateDir, req.id), { by: 'sistema', state: 'falhou', at: isoNow(now) })) {
        out.push(markFinal(stateDir, req.id, req, 'falhou', 'a sessão aceitou e não confirmou em 30 min', now))
      }
    }
  }
  return out
}

// Descarte pelo painel de um `aceito` com ≥ 2 min (A3, C2). Não exige `.claim` desta sessão: é o
// painel, não uma sessão, quem cancela.
export function discardAccepted(stateDir, id, { reason = 'descartado no painel', now = Date.now() } = {}) {
  if (!REQ_RE.test(String(id))) return { ok: false, code: 2, reason: 'id de pedido inválido' }
  const req = readRequest(stateDir, id)
  if (!req) return { ok: false, code: 2, reason: 'pedido não encontrado' }
  if (!isAcceptedDiscardable(req, now)) return { ok: false, code: 3, reason: 'ainda não passou a carência de 2 min' }
  createExclusive(claimFile(stateDir, id), { by: 'painel', pid: 0, at: isoNow(now) })
  if (!createExclusive(finalFile(stateDir, id), { by: 'painel', state: 'falhou', at: isoNow(now) })) {
    return { ok: false, code: 3, reason: 'pedido já encerrado' }
  }
  return { ok: true, code: 0, req: markFinal(stateDir, id, req, 'falhou', reason, now) }
}

// ── Elegibilidade de emissão (C4) ──
// route 'project': a sessão do watcher tem o mesmo project do pedido. route 'owner' (e todo
// `stop`): a sessão do watcher é a ownerSession.
export function isEligible(req, { session, project }) {
  const route = normalizeRoute(req)
  if (route === 'owner') return session === req.ownerSession
  return project != null && req.project === project
}

// Marca que `session` já viu (e emitiu) este pedido — evita repetir a linha a cada tick do loop.
// Devolve true se marcou agora (era a primeira vez), false se já estava marcado.
export function markSeen(stateDir, id, session) {
  return createExclusive(seenFile(stateDir, id, session), { at: isoNow(Date.now()) })
}

// Texto da linha que o Claude lê (C4).
export function requestEventLine(req, { root, session }) {
  const runLabel = req.runId || req.wf
  const parts = [`graph-eng pedido ${req.id}`, req.type, `run ${runLabel} (${req.wf})`]
  if (req.type === 'rerun-node' && req.node) parts.push(`nó ${req.node}${req.dependents ? ' + dependentes' : ''}`)
  parts.push('confirmado no painel')
  parts.push(`aceite: node "${root}/bin/requests.mjs" accept ${req.id} --session ${session}`)
  return parts.join(' · ')
}

// ── Sinal de vida (C3) ──

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !(e && e.code === 'ESRCH')
  }
}

export function writeHeartbeat(stateDir, hb) {
  const file = listenerFile(stateDir, hb.session, hb.pid)
  const value = {
    v: 1,
    session: hb.session,
    project: hb.project,
    cwd: hb.cwd ?? null,
    pid: hb.pid,
    wf: hb.wf ?? null,
    runId: hb.runId ?? null,
    mode: hb.mode ?? 'run',
    startedAt: hb.startedAt,
    beatAt: hb.beatAt,
    listenUntil: hb.listenUntil ?? null,
    exitedAt: hb.exitedAt ?? null,
    plugin: hb.plugin ?? null,
  }
  writeJsonAtomic(file, value)
  return value
}

export function readListeners(stateDir, now = Date.now()) {
  const dir = listenersDir(stateDir)
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const hb = readJsonTolerant(path.join(dir, f))
    if (!hb || !hb.session || !hb.pid) continue
    const live = !hb.exitedAt && now - Date.parse(hb.beatAt || 0) <= LISTEN_FRESH_MS && pidAlive(hb.pid)
    out.push({ ...hb, live })
  }
  return out
}

// ── Marcador de término (C4): sobrevive ao rearme do Monitor, que reinicia o *processo* do watcher
// (`--run`, timeout de 30 min da doc da tool). Sem isto, cada rearme recomeçava a janela de escuta
// do zero (`terminatedAt = clock()` a cada arme) e o `TERMINADO` saía de novo a cada vez — a linha
// "escuta do painel encerrada" (condição de parada da skill, P2) nunca chegava a sair de verdade.
// Primeira gravação vence (O_EXCL, mesma regra de corrida do resto do arquivo): um rearme só lê o
// valor já gravado pelo primeiro watcher a detectar o TERMINADO.
const terminatedDir = (stateDir) => path.join(stateDir, 'terminated')
const terminatedFile = (stateDir, wf) => path.join(terminatedDir(stateDir), `${wf}.json`)

// Já existe marcador de término para este wf? (decide se o rearme repete o `TERMINADO` ou só
// imprime `ouvindo…`, C4). `wf` fora de `WF_RE` nunca tem marcador (mesmo lado seguro do resto do
// módulo: sem persistência em vez de um caminho fora do controle).
export function hasTerminatedMarker(stateDir, wf) {
  if (!WF_RE.test(String(wf))) return false
  try {
    fs.accessSync(terminatedFile(stateDir, wf))
    return true
  } catch {
    return false
  }
}

// Marca (uma vez) o instante em que a run terminou e devolve esse instante (ms epoch), gravado por
// quem chegou primeiro — inclusive quando quem chama agora não foi quem gravou. Sem `WF_RE`, não
// persiste: devolve `now` como fallback, igual ao comportamento de antes desta correção.
export function markTerminated(stateDir, wf, now = Date.now()) {
  if (!WF_RE.test(String(wf))) return now
  const file = terminatedFile(stateDir, wf)
  createExclusive(file, { wf, terminatedAt: isoNow(now) })
  const v = readJsonTolerant(file)
  const t = v && v.terminatedAt ? Date.parse(v.terminatedAt) : NaN
  return Number.isNaN(t) ? now : t
}

export function projectListening(listeners, project) {
  return listeners.some((l) => l.live && l.project === project)
}

// 'ouvindo' | 'rearmando' | 'encerrada' | 'nunca' (C3).
export function ownerPresence(listeners, session, now = Date.now()) {
  const mine = listeners.filter((l) => l.session === session)
  if (mine.some((l) => l.live)) return 'ouvindo'
  if (!mine.length) return 'nunca'
  let newest = -Infinity
  for (const l of mine) {
    const t = Date.parse(l.exitedAt || l.beatAt || '')
    if (!Number.isNaN(t) && t > newest) newest = t
  }
  if (newest === -Infinity) return 'nunca'
  return now - newest <= REARM_GRACE_MS ? 'rearmando' : 'encerrada'
}

// ── Caminho do wf → project/session (C3: "só quando o caminho do wf tem a forma
// <projectsDir>/<slug>/<sessão>/subagents/workflows/<wf>, com <sessão> casando com SESSION_RE") ──
export function ownerPathInfo(runDir) {
  const parts = String(runDir).split(path.sep).filter(Boolean)
  if (parts.length < 5) return null
  const wf = parts[parts.length - 1]
  const workflows = parts[parts.length - 2]
  const subagents = parts[parts.length - 3]
  const session = parts[parts.length - 4]
  const project = parts[parts.length - 5]
  if (workflows !== 'workflows' || subagents !== 'subagents') return null
  if (!SESSION_RE.test(session)) return null
  return { project, session, wf }
}

// ── CLI (C5) ──
const CLI_FLAGS_WITH_VALUE = new Set(['--session', '--wf', '--note', '--reason', '--state-dir'])

function parseCliArgs(rest) {
  const opts = {}
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('--')) {
      if (CLI_FLAGS_WITH_VALUE.has(a)) opts[a] = rest[++i]
      else opts[a] = true
    } else positional.push(a)
  }
  return { opts, positional }
}

async function cliMain() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const { opts, positional } = parseCliArgs(argv.slice(1))
  const stateDir = opts['--state-dir'] || defaultStateDir()

  const fail = (code, msg) => {
    console.error(`requests: ${msg}`)
    process.exit(code)
  }

  if (cmd === 'list') {
    const reqs = listRequests(stateDir)
    if (opts['--json']) console.log(JSON.stringify(reqs))
    else for (const r of reqs) console.log(JSON.stringify(r))
    process.exit(0)
  } else if (cmd === 'accept') {
    const id = positional[0]
    if (!id) fail(2, 'uso: requests accept <id> --session <s>')
    const r = acceptRequest(stateDir, id, { session: opts['--session'] })
    if (!r.ok) fail(r.code, r.reason)
    console.log(JSON.stringify(r.req))
    process.exit(0)
  } else if (cmd === 'done') {
    const id = positional[0]
    if (!id) fail(2, 'uso: requests done <id> --session <s> [--wf <novo>] [--note <txt>]')
    const r = doneRequest(stateDir, id, { session: opts['--session'], newWf: opts['--wf'] || null, note: opts['--note'] || null })
    if (!r.ok) fail(r.code, r.reason)
    console.log(JSON.stringify(r.req))
    process.exit(0)
  } else if (cmd === 'fail') {
    const id = positional[0]
    if (!id) fail(2, 'uso: requests fail <id> --session <s> --reason <txt>')
    const r = failRequest(stateDir, id, { session: opts['--session'], reason: opts['--reason'] })
    if (!r.ok) fail(r.code, r.reason)
    console.log(JSON.stringify(r.req))
    process.exit(0)
  } else {
    fail(2, `comando desconhecido: ${cmd || '(nenhum)'}`)
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
  cliMain().catch((e) => {
    console.error(`requests: erro inesperado: ${(e && e.stack) || e}`)
    process.exit(1)
  })
}
