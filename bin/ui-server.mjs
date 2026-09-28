// Painel web ao vivo do graph-watch (`graph-watch ui`) — docs/specs/2026-09-27-painel-web.md.
// Node puro (node:http), sem dependências. Rotas de escrita: PUT /api/config (grava
// ~/.claude/graph-eng/config.json, via bin/config.mjs) e POST /api/org/* (grava <stateDir>/organize.json,
// via bin/organize.mjs; o apagar remove só .graph-runs/<run>/ depois da contenção). Nenhum outro endpoint
// escreve em disco. Spec das ações e da organização: docs/specs/2026-09-28-acoes-no-painel.md (C1, C10, C11).
//
// ── Contrato HTTP (consumido pela página em bin/ui/) ──
// Todas as respostas: só GET (outro método → 405 com `Allow: GET`), exceto /api/config, que aceita GET e
// PUT (outro método → 405 com `Allow: GET, PUT`), e /api/org/*, que só aceita POST (`Allow: POST`). A
// tabela de escrita é conferida antes da regra GET-only. `Host` precisa ser `127.0.0.1:<porta>` ou
// `localhost:<porta>` (senão 403, contra DNS rebinding), em toda rota e todo método. Sem CORS: nenhuma
// resposta leva `Access-Control-Allow-*`, e o preflight `OPTIONS` recebe 405. Erros vêm como JSON
// `{ "error": "<texto pt-BR>" }`.
//
// GET /api/health → 200 `{ "app": "graph-watch", "version": 1 }`
//
// GET /api/config → 200 ConfigPublica, sempre (arquivo ausente = padrões; campo inválido no arquivo volta
//   ao padrão e vira `warnings`) | 500 (erro de E/S na leitura que não seja arquivo ausente).
//   ConfigPublica = {
//     config:   { effort, ceiling, economy, planGate, maxRounds, maxRepairs },   // efetiva
//     source:   { <mesmos campos>: "config" | "default" },
//     defaults: { <mesmos campos> },                                           // fábrica: 24/auto
//     limits:   { ceiling: { min: 8, max: 100 }, maxRounds: { min: 1, max: 5 }, maxRepairs: { min: 1, max: 3 },
//                 effort: ["manual","auto","low","medium","high","max"], economy: ["lean","balanced","max"] },
//     file: "~/.claude/graph-eng/config.json",                                 // home trocado por ~
//     warnings: string[],
//   }
//   A tabela de alvos não vem daqui: a página a calcula com /agent-target.mjs.
//
// PUT /api/config → 200 ConfigPublica (depois de gravar). Checagens em ordem, parando no primeiro erro:
//   403 `Origin` ausente, "null" ou ≠ `http://<Host>` · 415 Content-Type ≠ application/json (charset pode vir)
//   · 413 corpo > 4096 bytes · 400 JSON inválido / corpo que não é objeto / `{ error: "config inválida",
//   fields: { <campo>: "<motivo>" } }` (campo desconhecido, tipo, faixa, teto < 8 ou > 100) · 500 falha ao
//   gravar. O PUT substitui o arquivo: chave ausente volta ao padrão, e chave desconhecida posta à mão no
//   arquivo some. Gravação atômica (tmp no mesmo diretório + rename). Nada é gravado em caminho de erro.
//
// POST /api/org/* (C10 O1-O9) → 200 `{ org: OrgPublica, … }`. Mesmas travas do PUT /api/config, na mesma
//   ordem (readJsonBody): 403 Origin · 415 · 413 (declarado ou em chunks) · 400 JSON inválido / corpo que não
//   é objeto / `{ error: "pedido de organização inválido", fields: { <campo>: "<motivo>" } }` (tabela
//   estrita: campo a mais dá "campo desconhecido"). Depois: 404 run/grupo · 409 conflito · 500 E/S. A key da
//   run nunca vem do cliente: o `wf` (qualquer wf da run) vira a key no servidor.
//   O1 pin {wf, pinned} · O2 groups {name, wf?} → +group · O3 groups/:gid/rename {name} ·
//   O4 groups/:gid/move {index} · O5 groups/:gid/delete {} → +released · O6 move {wf, group|null} (desafixa)
//   · O7 archive {wf, archived} · O8 delete {wf, confirm = name} → +deleted, removedDir ·
//   O9 delete-finished {wfs, confirm: "apagar N"} → +deleted[], failed[{wf, reason}].
//   OrgPublica = { groups: [{ id, name }], pinned: key[], warnings: string[] }.
//
// GET /api/runs → 200 `{ "runs": RunResumo[], "org": OrgPublica }`: uma entrada por key (P3: o runId da
//   skill, ou `<slug>/<wf>` sem ele), no máximo 50 keys (fixadas e em grupo nunca somem por idade; key
//   apagada fica fora até um wf dela ficar mais novo que o apagar), `rodando` primeiro e depois `mtime` desc.
//   Os campos de estado são os do representante (o wf rodando mais novo; senão o mais novo que não é
//   planOnly; senão o planOnly mais novo).
//   RunResumo = {
//     key, runId: string | null, name,  // name = runId, ou o wf sem `wf_` (é o texto que o apagar exige)
//     wfs: ["wf_…"],                    // do mais novo para o mais velho; `wf` é o representante
//     pinned: bool, group: gid | null, archived: bool,
//     runDir: string | null,            // pasta da run com o home como ~; null sem pasta ou fora da contenção
//     wf: "wf_…",                       // id do diretório do workflow (o representante)
//     project: "postify-backend",       // basename do `cwd` das transcrições; sem elas, último trecho do slug
//     status: "rodando" | "parada?" | "terminado",
//                                       // terminado = synth com result, ou run planOnly (spec C6);
//                                       // parada? = computeStop() ≠ null (mesma regra do buildModel,
//                                       // bin/graph-watch.mjs: silêncio > N min sem sessão dona ouvindo,
//                                       // ou 3·N com ela, cota/interrupção na hora); senão rodando.
//     stop: null | { reason, text, idleSec }, // motivo da parada (spec C6), null fora de "parada?"
//     planOnly: boolean,                // só o planner rodou; nunca conta como parada
//     goal: string | null,              // goal do plano
//     done: number, total: number,      // nós com estado pronto* / todos os nós
//     round: number,
//     mtime: number,                    // ms epoch da última atividade (journal ou transcrição)
//     nodes: [{ id, state, round }],    // faixa-miniatura da barra lateral, na ordem do modelo
//   }
//
// GET /api/runs/:wf → 200 Modelo | 400 (wf fora de /^wf_[A-Za-z0-9_-]+$/) | 404 (fora da lista de runs)
//   Modelo = saída de buildModel (bin/graph-watch.mjs) +
//     { project, goal, mode, lastActivity } e `status` trocado pelo status do RunResumo (considera a
//     atividade das transcrições). Campos de buildModel: wf, round, status, idleSec, warns: string[],
//     nodes: [{ id, kind, risk, round, title, deps: string[], explore, state, reps, closed,
//               orphan?, running?: { label, agentId } }],
//     critic: null | { r, running, gaps?, done? }, synth: "aguardando" | "rodando" | "pronto", spent,
//     estimate?/ceiling? (só quando há economy). `mode` e `economy` vêm das linhas `Mode:` e `Economy:` do
//     prompt do agente `plan` (ausentes se não achar; `Economy:` só existe em runs da 0.3.0 em diante).
//   Estados de nó: trabalhando | verificando | reparando (rodando agora); pronto | pronto-sem-verif |
//     pronto-sem-verif? | sem-reverificacao (já rodou); falhou | falhou-check | bloqueado | erro (falha);
//     aguardando (ainda não rodou); pulado.
//
// GET /api/runs/:wf/nodes/:id → 200 Detalhe | 400 (id fora de /^[A-Za-z0-9_-]{1,64}$/) | 404
//   :id é um nó do modelo ou um pseudo-nó `plan` | `critic` (todas as rodadas) | `design-review` (todas as
//   tentativas) | `polish-<k>` (o polidor `polish:<k>`; a URL usa hífen porque `:` não passa na regex) |
//   `synth`. O nó do plano vence o pseudo-nó de mesmo id.
//   Detalhe = { wf, id, pseudo: bool, title, kind?, risk?, round?, deps?, state, reps?, closed?,
//     agents: Agente[] }   // agents vazio = nó ainda não começou
//   Agente = { label: "work:I2", agentId, status: "rodando" | "terminou" | "erro",
//     transcript: bool, prompt: string (até 600 chars), totalCalls,
//     toolCalls: [{ ts: ISO-8601 UTC | null, time: "HH:MM:SS" (hora local do servidor), name, desc }],
//                  // últimas 20; a UI deve formatar `ts` na hora local do browser (`time` é conveniência)
//     lastText: string | null, think, thinkEmpty,
//     verdict: null | { pass, confidence, blocking: [{ issue, where?, evidence?, fix? }] },
//     result: objeto cru do journal | null, checks: [{ cmd, ok, output? }] }
//
// GET /api/events → text/event-stream (SSE). Ao conectar: `event: runs` com `{ runs, org }` (o corpo do
//   GET /api/runs). Depois, poll a cada ~1 s (e logo depois de cada escrita em /api/org/*): `event: runs`
//   (mesmo formato) quando a lista muda (wf, status, done/total, estados dos nós, goal, organização);
//   `event: run` com `{ "wf": "wf_…" }` quando o journal (mtime/tamanho) ou a
//   transcrição de um agente daquela run muda. Comentário `: ping` a cada ~15 s. Timers limpos quando o
//   último cliente desconecta.
//
// Estáticos (lista fixa, qualquer outro caminho → 404): `/` e `/index.html` (text/html), `/app.js`
// (text/javascript), `/graph-layout.mjs` (módulo importado pelo app.js), `/agent-target.mjs` (fórmula de
// alvos, importada pelo modal), `/config-modal.mjs` (modal de engrenagem), `/theme.js` (aplica o tema antes
// da pintura), `/style.css`, `/favicon.svg` e as fontes Geist em `/fonts/*.woff2` (SIL OFL, fonts/OFL.txt),
// lidos de bin/ui/. Além da lista, a regra fechada dos módulos da UI (C10): `/<nome>.mjs` com nome
// `[a-z0-9-]+` serve um arquivo regular (sem symlink) direto em bin/ui/, como text/javascript; assim um
// módulo novo da página entra sem editar este arquivo. Nada vem de fora: CSP com script, estilo, fonte e
// conexão só 'self'.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { buildModel, computeStop, listAllWfDirs, isGraphEngRun, isTerminatedRun, agentsOfNode, readJournalTolerant, GraphWatchError } from './graph-watch.mjs'
import { MAX_BODY, defaultConfigPath, defaultStateDir, displayPath, isPlainObject, publicConfig, readConfig, resolveConfig, validateConfig, writeConfig } from './config.mjs'
import {
  GROUP_RE,
  RUN_ID_RE,
  applyOrgOp,
  emptyOrg,
  isInFinishedSection,
  pickRepresentative,
  pruneRevived,
  publicOrg,
  readOrg,
  removeRunDir,
  resolveRunDir,
  runKey,
  validateOrgBody,
  writeOrg,
} from './organize.mjs'

export const DEFAULT_PORT = 4477
const HOST = '127.0.0.1'
const RUNS_LIMIT = 50
const WF_RE = /^wf_[A-Za-z0-9_-]+$/
const NODE_RE = /^[A-Za-z0-9_-]{1,64}$/
const PSEUDO = new Set(['plan', 'critic', 'design-review', 'synth'])
const POLISH_API_RE = /^polish-(\d{1,3})$/ // subconjunto do NODE_RE: o polidor `polish:<k>` na URL
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui')
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/graph-layout.mjs': ['graph-layout.mjs', 'text/javascript; charset=utf-8'],
  '/agent-target.mjs': ['agent-target.mjs', 'text/javascript; charset=utf-8'],
  '/config-modal.mjs': ['config-modal.mjs', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/fonts/geist-latin.woff2': ['fonts/geist-latin.woff2', 'font/woff2'],
  '/fonts/geist-latin-ext.woff2': ['fonts/geist-latin-ext.woff2', 'font/woff2'],
  '/fonts/geist-mono-latin.woff2': ['fonts/geist-mono-latin.woff2', 'font/woff2'],
  '/fonts/geist-mono-latin-ext.woff2': ['fonts/geist-mono-latin-ext.woff2', 'font/woff2'],
}
// Regra fechada dos módulos da UI (C10), complemento do STATIC: só nome [a-z0-9-]+.mjs direto em bin/ui/.
const UI_MODULE_RE = /^\/([a-z0-9-]+\.mjs)$/

// Tabela de escrita da organização (C10 O1-O9): caminho → { op, gid? }. Map, e não objeto, para um
// segmento como `__proto__` nunca casar com nada herdado.
const ORG_ROUTES = new Map([
  ['pin', 'pin'],
  ['groups', 'group-create'],
  ['move', 'move'],
  ['archive', 'archive'],
  ['delete', 'delete'],
  ['delete-finished', 'delete-finished'],
])
const ORG_GROUP_ROUTES = new Map([
  ['rename', 'group-rename'],
  ['move', 'group-move'],
  ['delete', 'group-delete'],
])
function orgRoute(pathname) {
  const parts = pathname.split('/').slice(1)
  if (parts[0] !== 'api' || parts[1] !== 'org') return null
  if (parts.length === 3 && ORG_ROUTES.has(parts[2])) return { op: ORG_ROUTES.get(parts[2]) }
  if (parts.length === 5 && parts[2] === 'groups' && ORG_GROUP_ROUTES.has(parts[4])) return { op: ORG_GROUP_ROUTES.get(parts[4]), gid: parts[3] }
  return null
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

// ── Leitura das runs (com cache por assinatura do journal, para não reler journal antigo a cada tick) ──

function statOr(p) {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

// Maior mtime entre as transcrições `agent-*.jsonl` da run (elas mudam a cada tool call; o journal só
// muda quando um agente começa ou termina).
function agentActivity(dir) {
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return 0
  }
  let max = 0
  for (const f of files) {
    if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue
    const st = statOr(path.join(dir, f))
    if (st && st.mtimeMs > max) max = st.mtimeMs
  }
  return max
}

function projectOf(projectsDir, dir) {
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
  } catch {
    /* sem arquivos de agente */
  }
  for (const f of files) {
    let fd
    try {
      fd = fs.openSync(path.join(dir, f), 'r')
      const buf = Buffer.alloc(65536)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/)
      if (m) {
        const cwd = JSON.parse(`"${m[1]}"`)
        const base = path.basename(cwd.replace(/[\\/]+$/, ''))
        if (base) return base
      }
    } catch {
      /* transcrição ilegível: tenta a próxima */
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  const slug = path.relative(projectsDir, dir).split(path.sep)[0] || ''
  const parts = slug.split('-').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : slug || '?'
}

// Todo prompt do graph-eng abre com o mesmo prefixo (`SHARED` em workflows/graph-eng.js), com as linhas
// `Mode: <modo>` e `Economy: <preset>` (esta, só em runs a partir da 0.3.0) e, em runs com esforço e teto,
// `Effort: <nível>`, `Ceiling: <int>` e `Target: <int> | auto <min>-<max>`. Lê o começo da transcrição do
// `plan` e, sem ela (plano vindo de run planOnly irmã), de outro agente. Sem economy o modelo não sabe se
// um nó recém-terminado ainda vai ser verificado, e a bolinha pisca "já rodou" antes do verify.
const ECONOMIES = new Set(['lean', 'balanced', 'max'])
function inferHeader(dir) {
  const { events } = readJournalTolerant(path.join(dir, 'journal.jsonl'))
  const st = [...events].reverse().find((e) => e.type === 'started' && e.label === 'plan')
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl')).sort()
  } catch {
    return {}
  }
  if (st && st.agentId) files = [`agent-${st.agentId}.jsonl`, ...files.filter((f) => f !== `agent-${st.agentId}.jsonl`)]
  for (const f of files.slice(0, 3)) {
    let fd
    try {
      fd = fs.openSync(path.join(dir, f), 'r')
      const buf = Buffer.alloc(65536)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      // o prompt vem como string JSON: a quebra de linha antes de `Mode:` aparece escapada (\n), e o
      // harness pode indentar o texto da tarefa
      const text = buf.toString('utf8', 0, n)
      const m = text.match(/(?:^|\\n|\n)[ \t]*Mode: ([a-z]+)/)
      if (!m) continue
      const e = text.match(/(?:^|\\n|\n)[ \t]*Economy: ([a-z]+)/)
      const ef = text.match(/(?:^|\\n|\n)[ \t]*Effort: (auto|low|medium|high|max)/)
      const c = text.match(/(?:^|\\n|\n)[ \t]*Ceiling: (\d+)/)
      const t = text.match(/(?:^|\\n|\n)[ \t]*Target: (?:(\d+)|auto (\d+)-(\d+))/)
      // chave da run e pasta de artefatos (D4 §3.1): `# Graph run <runId>` e `Run dir (paper trail): <dir>`.
      // O `# Graph run` pode abrir o prompt, logo depois da aspa da string JSON.
      const r = text.match(/(?:^|\\n|\n|")[ \t]*# Graph run ([A-Za-z0-9._-]{1,96})/)
      const d = text.match(/(?:^|\\n|\n)[ \t]*Run dir \(paper trail\): ([^\\"\n]{1,1024})/)
      return {
        runId: r ? r[1] : undefined,
        runDirRaw: d ? d[1].trim() || undefined : undefined,
        mode: m[1],
        economy: e && ECONOMIES.has(e[1]) ? e[1] : undefined,
        effort: ef ? ef[1] : undefined,
        ceiling: c ? Number(c[1]) : undefined,
        target: t && t[1] ? Number(t[1]) : undefined,
        targetRange: t && t[2] ? { min: Number(t[2]), max: Number(t[3]) } : undefined,
      }
    } catch {
      /* transcrição ausente ou ilegível: tenta a próxima */
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  return {}
}

function planGoal(dir) {
  const { events } = readJournalTolerant(path.join(dir, 'journal.jsonl'))
  const starts = events.filter((e) => e.type === 'started' && e.label === 'plan')
  for (const st of starts.reverse()) {
    const res = events.find((e) => e.key === st.key && e.type === 'result')
    if (res && res.result && typeof res.result.goal === 'string') return res.result.goal
  }
  return null
}

// Cria o leitor de runs de um projectsDir. `scanAll()` devolve a lista agrupada por key (RunResumo +
// campos internos `dir`, `sig`, `runDirRaw`, `entries`…), a org lida e o índice por wf (`byWf`, que acha
// também o wf superado de uma run retomada). `scan()` devolve só a lista. O cache guarda o que depende só
// do journal. `configPath` é de onde sai `stallMinutes` (C6): lido a cada scan, tolerante como o resto da
// config, para o modal de engrenagem valer na hora. `organizePath` (C1) é a organização da lista; sem ele,
// a lista sai sem organização.
export function createRunIndex(projectsDir, { configPath = defaultConfigPath(), organizePath = null, graphRunsHome = null, home = os.homedir() } = {}) {
  const runsHome = graphRunsHome || path.join(home, '.claude', 'graph-runs')
  const cache = new Map() // dir → { sig, head | null, info? }
  const projects = new Map() // dir → nome do projeto (fixo depois de achado pelo cwd)

  // Parte leve, lida de todo wf (é o que dá a key): graph-eng? + cabeçalho do prompt.
  function headOf(c) {
    const st = statOr(path.join(c.dir, 'journal.jsonl'))
    if (!st) return null
    const sig = `${st.mtimeMs}:${st.size}`
    const hit = cache.get(c.dir)
    if (hit && hit.sig === sig) return hit.head
    const head = isGraphEngRun(c.dir) ? { ...inferHeader(c.dir), sig, journalMtime: st.mtimeMs } : null
    cache.set(c.dir, { sig, head })
    return head
  }

  // Parte pesada (modelo), só dos wfs das keys que entram na lista.
  async function describe(c, head) {
    const hit = cache.get(c.dir)
    if (hit && hit.sig === head.sig && hit.info) return hit.info
    const { mode, economy, effort, ceiling } = head
    let model = null
    try {
      model = await buildModel({ runDir: c.dir, mode, economy, effort, ceiling })
    } catch {
      /* journal de formato estranho: entra na lista sem nós */
    }
    const nodes = model ? model.nodes : []
    const info = {
      terminated: isTerminatedRun(c.dir),
      planOnly: model ? model.planOnly : false,
      openAgentIds: model ? model.openAgentIds : [],
      goal: planGoal(c.dir),
      done: nodes.filter((n) => n.state.startsWith('pronto')).length,
      total: nodes.length,
      round: model ? model.round : 1,
      nodes: nodes.map((n) => ({ id: n.id, state: n.state, round: n.round })),
    }
    if (hit && hit.sig === head.sig) hit.info = info
    return info
  }

  function loadOrg() {
    if (!organizePath) return { org: emptyOrg(), warnings: [] }
    try {
      return readOrg(organizePath)
    } catch (e) {
      return { org: emptyOrg(), warnings: [`não consegui ler organize.json: ${e.message}`] }
    }
  }

  async function scanAll(now = Date.now()) {
    // Só `stallMinutes` importa aqui; os demais campos (effort/ceiling/…) não afetam a lista.
    let stallMinutes = 5
    try {
      stallMinutes = resolveConfig({ stored: readConfig(configPath).stored }).config.stallMinutes
    } catch {
      /* config ilegível: mantém o padrão, como o resto da leitura de config */
    }
    const { org, warnings: orgWarnings } = loadOrg()
    const keep = new Set([...org.pinned, ...Object.keys(org.placement)])
    const all = listAllWfDirs(projectsDir).sort((a, b) => b.mtime - a.mtime)

    // 1) agrupa por key, do mais novo para o mais velho. RUNS_LIMIT conta keys; fixadas e em grupo entram
    //    sempre. `latest` guarda o maior mtime de toda key vista, inclusive das apagadas.
    const groups = new Map() // key → [{ c, head, slug, runId }]
    const latest = new Map()
    const seen = new Set()
    for (const c of all) {
      if (seen.has(c.wf)) continue
      const head = headOf(c)
      if (!head) continue
      seen.add(c.wf)
      const slug = path.relative(projectsDir, c.dir).split(path.sep)[0] || ''
      const runId = typeof head.runId === 'string' && RUN_ID_RE.test(head.runId) ? head.runId : null
      const key = runKey({ slug, runId, wf: c.wf })
      if (!latest.has(key)) latest.set(key, c.mtime)
      const deletedAt = org.deleted[key]
      if (deletedAt !== undefined && !(latest.get(key) > deletedAt)) continue
      if (!groups.has(key)) {
        if (groups.size >= RUNS_LIMIT && !keep.has(key)) continue
        groups.set(key, [])
      }
      groups.get(key).push({ c, head, slug, runId })
    }

    // 2) estado de cada wf das keys escolhidas e o representante de cada key
    const runs = []
    const byWf = new Map()
    const dupWarnings = []
    for (const [key, items] of groups) {
      const entries = []
      for (const { c, head, slug, runId } of items) {
        const info = await describe(c, head)
        const agents = info.terminated ? 0 : agentActivity(c.dir)
        const last = Math.max(head.journalMtime, agents)
        if (!projects.has(c.dir)) projects.set(c.dir, projectOf(projectsDir, c.dir))
        // C6: a mesma regra e o mesmo motivo do `buildModel` (bin/graph-watch.mjs), sem janela fixa —
        // `openAgentIds`/`planOnly` vêm cacheados (dependem só do journal); `computeStop` é recalculado
        // a cada scan porque depende de `now` e lê a cauda só dos agentes ainda abertos.
        const stop = computeStop({ runDir: c.dir, openAgentIds: info.openAgentIds, terminated: info.terminated, planOnly: info.planOnly, now, stallMinutes })
        const status = info.terminated || info.planOnly ? 'terminado' : stop ? 'parada?' : 'rodando'
        entries.push({
          wf: c.wf,
          project: projects.get(c.dir),
          status,
          stop,
          planOnly: info.planOnly,
          goal: info.goal,
          done: info.done,
          total: info.total,
          round: info.round,
          mtime: Math.round(last),
          nodes: info.nodes,
          dir: c.dir,
          mode: head.mode,
          economy: head.economy,
          effort: head.effort,
          ceiling: head.ceiling,
          sig: `${head.sig}:${agents}`,
          key,
          slug,
          runId,
          runDirRaw: head.runDirRaw || null,
        })
      }
      const rep = pickRepresentative(entries)
      if (!rep) continue
      const byNew = [...entries].sort((a, b) => b.mtime - a.mtime)
      const runId = rep.runId || (byNew.find((e) => e.runId) || {}).runId || null
      // Limite conhecido da chave (D4 §3.1): dois runIds iguais com pastas diferentes viram uma linha só.
      const raws = new Set(entries.map((e) => e.runDirRaw).filter(Boolean))
      if (raws.size > 1) dupWarnings.push(`duas runs com o mesmo runId: ${runId}`)
      const runDirRaw = rep.runDirRaw || (byNew.find((e) => e.runDirRaw) || {}).runDirRaw || null
      const where = runDirRaw ? resolveRunDir(runDirRaw, runId, { projectsDir, graphRunsHome: runsHome, home }) : null
      const run = {
        ...rep,
        key,
        runId,
        name: runId || rep.wf.replace(/^wf_/, ''),
        wfs: byNew.map((e) => e.wf),
        pinned: org.pinned.includes(key),
        group: Object.hasOwn(org.placement, key) ? org.placement[key] : null,
        archived: Object.hasOwn(org.archived, key),
        runDir: where && where.ok ? displayPath(runDirRaw, home) : null,
        runDirRaw,
        entries,
      }
      runs.push(run)
      for (const e of entries) byWf.set(e.wf, { entry: e, run })
    }
    const rank = (r) => (r.status === 'rodando' ? 0 : 1)
    runs.sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime)
    return { runs, org, warnings: [...orgWarnings, ...dupWarnings], dupWarnings, latest, byWf }
  }

  async function scan(now = Date.now()) {
    return (await scanAll(now)).runs
  }

  return { scan, scanAll }
}

// RunResumo público: os campos internos (`dir`, `sig`, o cabeçalho, o caminho cru e as execuções) ficam
// no servidor.
const publicRun = ({ dir, sig, mode, economy, effort, ceiling, slug, runDirRaw, entries, ...r }) => r

// ── Servidor ──

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  })
  res.end(payload)
}

const sendError = (res, status, msg, extra) => send(res, status, { error: msg }, undefined, extra)

function pseudoState(agents) {
  const last = agents[agents.length - 1]
  if (!last) return 'aguardando'
  if (last.status === 'rodando') return 'trabalhando'
  return last.status === 'erro' ? 'erro' : 'pronto'
}

// Lê o corpo com limite de MAX_BODY bytes. Acima disso, descarta o resto (sem acumular) e resolve
// { tooBig: true } no fim; nunca guarda mais que o limite na memória.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooBig = false
    req.on('data', (d) => {
      size += d.length
      if (size > MAX_BODY) tooBig = true
      else chunks.push(d)
    })
    req.on('end', () => resolve(tooBig ? { tooBig } : { text: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', reject)
  })
}

// Opções (C1): `configPath` (config.json), `stateDir` (padrão: a pasta do configPath explícito, ou
// defaultStateDir()), `organizePath` (padrão `<stateDir>/organize.json`), `graphRunsHome` (o graph-runs
// global, padrão ~/.claude/graph-runs; só a contenção do apagar o usa), `now` (relógio) e `canDelete(key)
// → motivo | null` (o gancho que o I5 liga à fila de pedidos: um pedido aberto impede o apagar).
export function createPanelServer(opts = {}) {
  const { projectsDir, pollMs = 1000, heartbeatMs = 15000, home = os.homedir(), now = () => Date.now(), canDelete = () => null } = opts
  const configPath = opts.configPath ?? defaultConfigPath()
  const stateDir = opts.stateDir ?? (opts.configPath ? path.dirname(opts.configPath) : defaultStateDir())
  const organizePath = opts.organizePath ?? path.join(stateDir, 'organize.json')
  const graphRunsHome = opts.graphRunsHome ?? path.join(home, '.claude', 'graph-runs')
  const index = createRunIndex(projectsDir, { configPath, organizePath, graphRunsHome, home })
  const clients = new Set()
  let pollTimer = null
  let beatTimer = null
  let lastListSig = null
  let runSigs = new Map()
  let polling = false

  const listBody = (snap) => ({ runs: snap.runs.map(publicRun), org: publicOrg(snap.org, snap.warnings) })
  const listSig = (snap) =>
    JSON.stringify([
      snap.runs.map((r) => [r.key, r.wf, r.status, r.done, r.total, r.goal, r.round, r.nodes, r.pinned, r.group, r.archived, r.planOnly, r.wfs, r.runDir]),
      publicOrg(snap.org, snap.warnings),
    ])
  // assinatura de cada wf das runs listadas (também dos superados, que a página ainda pode ter aberto)
  const wfSigs = (snap) => new Map([...snap.byWf].map(([wf, { entry }]) => [wf, entry.sig]))

  function broadcast(event, data) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) res.write(chunk)
  }

  async function tick() {
    if (polling) return
    polling = true
    try {
      const snap = await index.scanAll(now())
      const sig = listSig(snap)
      if (sig !== lastListSig) {
        lastListSig = sig
        broadcast('runs', listBody(snap))
      }
      const next = wfSigs(snap)
      for (const [wf, s] of next) {
        const prev = runSigs.get(wf)
        if (prev !== undefined && prev !== s) broadcast('run', { wf })
      }
      runSigs = next
    } catch {
      /* leitura transitória: tenta no próximo tick */
    } finally {
      polling = false
    }
  }

  function stopTimers() {
    clearInterval(pollTimer)
    clearInterval(beatTimer)
    pollTimer = null
    beatTimer = null
  }

  async function openEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    })
    res.write('retry: 2000\n\n')
    const snap = await index.scanAll(now())
    if (!clients.size) {
      // primeiro cliente: fotografa o estado atual para só avisar mudanças daqui em diante
      lastListSig = listSig(snap)
      runSigs = wfSigs(snap)
    }
    res.write(`event: runs\ndata: ${JSON.stringify(listBody(snap))}\n\n`)
    clients.add(res)
    if (!pollTimer) {
      pollTimer = setInterval(tick, pollMs)
      beatTimer = setInterval(() => {
        for (const c of clients) c.write(': ping\n\n')
      }, heartbeatMs)
    }
    const drop = () => {
      clients.delete(res)
      if (!clients.size) stopTimers()
    }
    req.on('close', drop)
    res.on('error', drop)
  }

  // O wf pedido, inclusive uma execução superada de uma run retomada (P3): devolve a entrada dele, com o
  // estado dele, e não o do representante.
  async function findListed(wf) {
    const hit = (await index.scanAll(now())).byWf.get(wf)
    return hit ? hit.entry : null
  }

  function getConfig(res) {
    let body
    try {
      body = publicConfig(configPath)
    } catch (e) {
      return sendError(res, 500, `não consegui ler a config: ${e.message}`)
    }
    return send(res, 200, body)
  }

  // Travas comuns de toda escrita (C10), na ordem do PUT /api/config de sempre (Host e método já foram
  // conferidos em handle()): Origin 403 → Content-Type 415 → 413 declarado → 413 em chunks → 400 JSON
  // inválido → 400 corpo que não é objeto. → o objeto, ou null (a resposta de erro já saiu).
  async function readJsonBody(req, res, host) {
    // recusa antes de ler o corpo: descarta o que vier sem guardar (req.resume) e responde
    const refuse = (status, msg) => {
      req.resume()
      sendError(res, status, msg)
      return null
    }
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin.toLowerCase() !== `http://${host}`) return refuse(403, 'Origin não permitido')
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json') return refuse(415, 'use Content-Type: application/json')
    const tooBig = `corpo acima de ${MAX_BODY} bytes`
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY) return refuse(413, tooBig)
    const body = await readBody(req)
    if (body.tooBig) {
      sendError(res, 413, tooBig)
      return null
    }
    let parsed
    try {
      parsed = JSON.parse(body.text)
    } catch {
      sendError(res, 400, 'JSON inválido')
      return null
    }
    if (!isPlainObject(parsed)) {
      sendError(res, 400, 'o corpo deve ser um objeto')
      return null
    }
    return parsed
  }

  async function putConfig(req, res, host) {
    const parsed = await readJsonBody(req, res, host)
    if (parsed === null) return
    const checked = validateConfig(parsed)
    if (!checked.ok) return send(res, 400, { error: 'config inválida', fields: checked.errors })
    try {
      writeConfig(configPath, checked.value)
    } catch (e) {
      return sendError(res, 500, `não consegui gravar a config: ${e.message}`)
    }
    return getConfig(res)
  }

  // ── Organização da lista (C10 O1-O9) ──

  // Ler, aplicar e gravar sem `await` no meio: duas abas no mesmo servidor não perdem escrita. As keys
  // apagadas que voltaram (wf mais novo que o apagar) saem de `deleted` nesta mesma escrita.
  function commitOrg(snap, op, args) {
    const { org } = readOrg(organizePath)
    const r = applyOrgOp(pruneRevived(org, snap.latest), op, args, { now: now() })
    if (!r.ok) return r
    const written = writeOrg(organizePath, r.org)
    return { ok: true, org: written, extra: r.extra }
  }

  function sendOrgResult(res, snap, r, extra = {}) {
    if (!r.ok) return r.fields ? send(res, r.status, { error: r.error, fields: r.fields }) : sendError(res, r.status, r.error)
    tick() // avisa as outras abas na hora (event: runs)
    return send(res, 200, { org: publicOrg(r.org, snap.dupWarnings), ...r.extra, ...extra })
  }

  const whereOf = (run) => resolveRunDir(run.runDirRaw, run.runId, { projectsDir, graphRunsHome, home })

  async function postOrg(req, res, host, route) {
    const body = await readJsonBody(req, res, host)
    if (body === null) return
    if (route.gid !== undefined && !GROUP_RE.test(route.gid)) return sendError(res, 400, 'id de grupo inválido')
    const checked = validateOrgBody(route.op, body)
    if (!checked.ok) return send(res, 400, { error: 'pedido de organização inválido', fields: checked.errors })
    const v = checked.value
    const snap = await index.scanAll(now())
    let run = null
    if (v.wf !== undefined) {
      const hit = snap.byWf.get(v.wf)
      if (!hit) return sendError(res, 404, `run ${v.wf} não encontrada`)
      run = hit.run
    }

    if (route.op === 'delete') return deleteOne(res, snap, run, v)
    if (route.op === 'delete-finished') return deleteFinished(res, snap, v)

    const args = { ...v, gid: route.gid }
    delete args.wf
    if (run) args.key = run.key
    let r
    try {
      r = commitOrg(snap, route.op, args)
    } catch (e) {
      return sendError(res, 500, `não consegui gravar a organização: ${e.message}`)
    }
    return sendOrgResult(res, snap, r)
  }

  // O8: nome digitado idêntico ao `name` (sem trim nem caixa); rodando → 409; pedido aberto → 409 (gancho
  // do I5); pasta fora da contenção → 409 sem remover nada; a pasta sai antes de gravar a lista.
  async function deleteOne(res, snap, run, v) {
    if (v.confirm !== run.name) return send(res, 400, { error: 'pedido de organização inválido', fields: { confirm: 'digite o nome da run exatamente como aparece' } })
    if (run.status === 'rodando') return sendError(res, 409, 'Pare a run antes de apagar.')
    const why = canDelete(run.key)
    if (why) return sendError(res, 409, why)
    const where = whereOf(run)
    if (!where.ok && !where.absent) return sendError(res, 409, `não apago: ${where.why}`)
    let removedDir = false
    if (where.ok) {
      try {
        removeRunDir(where.real)
        removedDir = true
      } catch (e) {
        return sendError(res, 500, `não consegui apagar a pasta: ${e.message}`)
      }
    }
    let r
    try {
      r = commitOrg(snap, 'delete', { key: run.key })
    } catch (e) {
      return sendError(res, 500, removedDir ? `a pasta foi apagada, mas não consegui gravar a lista: ${e.message}` : `não consegui gravar a lista: ${e.message}`)
    }
    return sendOrgResult(res, snap, r, { deleted: run.key, removedDir })
  }

  // O9: os wfs são os representantes da seção Finalizadas quando o dialog abriu. Qualquer um que sumiu,
  // deixou de ser o representante, passou a rodar ou saiu da seção → 409 e nada é apagado. Falha de
  // contenção, de `rm` ou do gancho vai para `failed`, e as outras seguem; a lista é gravada uma vez.
  async function deleteFinished(res, snap, v) {
    const stale = () => sendError(res, 409, 'a lista de finalizadas mudou; reabra o dialog')
    const runs = []
    for (const wf of v.wfs) {
      const hit = snap.byWf.get(wf)
      if (!hit || hit.run.wf !== wf) return stale()
      if (hit.run.status === 'rodando' || !isInFinishedSection(hit.run)) return stale()
      if (runs.includes(hit.run)) return stale()
      runs.push(hit.run)
    }
    const keys = []
    const failed = []
    for (const run of runs) {
      const why = canDelete(run.key)
      if (why) {
        failed.push({ wf: run.wf, reason: why })
        continue
      }
      const where = whereOf(run)
      if (!where.ok && !where.absent) {
        failed.push({ wf: run.wf, reason: `não apago: ${where.why}` })
        continue
      }
      if (where.ok) {
        try {
          removeRunDir(where.real)
        } catch (e) {
          failed.push({ wf: run.wf, reason: `não consegui apagar a pasta: ${e.message}` })
          continue
        }
      }
      keys.push(run.key)
    }
    let r
    try {
      r = keys.length ? commitOrg(snap, 'delete-finished', { keys }) : { ok: true, org: readOrg(organizePath).org, extra: {} }
    } catch (e) {
      return sendError(res, 500, `as pastas foram apagadas, mas não consegui gravar a lista: ${e.message}`)
    }
    return sendOrgResult(res, snap, r, { deleted: keys, failed })
  }

  // Serve um módulo da UI pela regra fechada (C10): nome [a-z0-9-]+.mjs, arquivo regular direto em bin/ui/.
  function sendUiModule(res, name) {
    const file = path.join(UI_DIR, name)
    let body
    try {
      if (!fs.lstatSync(file).isFile()) return sendError(res, 404, 'não encontrado')
      body = fs.readFileSync(file)
    } catch {
      return sendError(res, 404, 'não encontrado')
    }
    return send(res, 200, body, 'text/javascript; charset=utf-8')
  }

  async function handle(req, res) {
    const port = server.address() && server.address().port
    const host = String(req.headers.host || '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendError(res, 403, 'Host não permitido')
    let pathname
    try {
      pathname = new URL(req.url, `http://${HOST}`).pathname
    } catch {
      return sendError(res, 400, 'URL inválida')
    }
    if (pathname === '/api/config') {
      if (req.method === 'GET') return getConfig(res)
      if (req.method === 'PUT') return putConfig(req, res, host)
      return sendError(res, 405, 'use GET ou PUT', { Allow: 'GET, PUT' })
    }
    // tabela de escrita antes da regra GET-only (C10); OPTIONS continua 405
    const write = orgRoute(pathname)
    if (write) {
      if (req.method !== 'POST') return sendError(res, 405, 'use POST', { Allow: 'POST' })
      return postOrg(req, res, host, write)
    }
    if (req.method !== 'GET') return sendError(res, 405, 'só leitura: use GET', { Allow: 'GET' })

    if (Object.hasOwn(STATIC, pathname)) {
      const [file, type] = STATIC[pathname]
      let body
      try {
        body = fs.readFileSync(path.join(UI_DIR, file))
      } catch {
        return sendError(res, 404, 'arquivo do painel ausente')
      }
      return send(res, 200, body, type, type.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {})
    }

    const mod = UI_MODULE_RE.exec(pathname)
    if (mod) return sendUiModule(res, mod[1])

    if (pathname === '/favicon.ico') return send(res, 204, '')
    const parts = pathname.split('/').slice(1)
    if (parts[0] !== 'api') return sendError(res, 404, 'não encontrado')
    if (parts.length === 2 && parts[1] === 'health') return send(res, 200, { app: 'graph-watch', version: 1 })
    if (parts.length === 2 && parts[1] === 'events') return openEvents(req, res)
    if (parts.length === 2 && parts[1] === 'runs') return send(res, 200, listBody(await index.scanAll(now())))

    if (parts[1] === 'runs' && (parts.length === 3 || (parts.length === 5 && parts[3] === 'nodes'))) {
      const wf = parts[2]
      if (!WF_RE.test(wf)) return sendError(res, 400, 'id de run inválido')
      if (parts.length === 5 && !NODE_RE.test(parts[4])) return sendError(res, 400, 'id de nó inválido')
      const run = await findListed(wf)
      if (!run) return sendError(res, 404, `run ${wf} não encontrada`)
      let model
      try {
        model = await buildModel({ runDir: run.dir, mode: run.mode, economy: run.economy, effort: run.effort, ceiling: run.ceiling })
      } catch (e) {
        if (e instanceof GraphWatchError) return sendError(res, 404, e.message)
        throw e
      }
      if (parts.length === 3) {
        // status/stop/planOnly vêm do RunResumo (run.*), não do buildModel isolado acima: só ele usa o
        // stallMinutes da config (o buildModel aqui roda com o default, sem ler ~/.claude/graph-eng).
        return send(res, 200, {
          ...model,
          status: run.status,
          stop: run.stop,
          planOnly: run.planOnly,
          project: run.project,
          goal: run.goal,
          mode: run.mode,
          economy: run.economy,
          lastActivity: run.mtime,
        })
      }
      const id = parts[4]
      const node = model.nodes.find((n) => n.id === id)
      const polish = POLISH_API_RE.exec(id)
      if (!node && !PSEUDO.has(id) && !polish) return sendError(res, 404, `nó ${id} não existe em ${wf}`)
      const agents = agentsOfNode(run.dir, id, 20) // polish-<k> → rótulo polish:<k> (graph-watch)
      if (node) return send(res, 200, { wf, ...node, pseudo: false, agents })
      const title = polish ? `polimento ${Number(polish[1])}` : id
      return send(res, 200, { wf, id, pseudo: true, title, state: pseudoState(agents), agents })
    }
    return sendError(res, 404, 'não encontrado')
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) sendError(res, 500, `erro inesperado: ${String((e && e.message) || e)}`)
      else res.end()
    })
  })

  server.stateDir = stateDir
  server.organizePath = organizePath
  server.closePanel = () =>
    new Promise((resolve) => {
      stopTimers()
      for (const c of clients) c.end()
      clients.clear()
      server.close(() => resolve())
      if (server.closeAllConnections) server.closeAllConnections()
    })

  return server
}

// ── Instância única ──

// 'graph-watch' | 'outro' | 'livre'
export function probePanel(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/api/health', timeout: timeoutMs, headers: { Host: `${HOST}:${port}` } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => {
        if (body.length < 4096) body += d
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).app === 'graph-watch' ? 'graph-watch' : 'outro')
        } catch {
          resolve('outro')
        }
      })
      res.on('error', () => resolve('outro'))
    })
    req.on('timeout', () => {
      req.destroy()
      resolve('outro')
    })
    req.on('error', (e) => resolve(e.code === 'ECONNREFUSED' ? 'livre' : 'outro'))
  })
}

// Garante um painel em 127.0.0.1:<port>. Se já há um graph-watch lá, reaproveita (reused: true, não sobe
// nada). Porta com outro programa → GraphWatchError(5). `port: 0` pula o probe e usa porta efêmera
// (testes). Devolve { url, port, reused, server?, close() }.
export async function ensurePanel(opts = {}) {
  const { port = DEFAULT_PORT, projectsDir = path.join(os.homedir(), '.claude', 'projects'), pollMs, heartbeatMs, configPath, stateDir, organizePath, graphRunsHome, home, now, canDelete } = opts
  const reused = (p) => ({ url: `http://${HOST}:${p}`, port: p, reused: true, close: async () => {} })
  const busy = () => new GraphWatchError(5, `porta ${port} ocupada por outro programa; use --port <N> ou GRAPH_ENG_PORT=<N>`)
  if (port !== 0) {
    const who = await probePanel(port)
    if (who === 'graph-watch') return reused(port)
    if (who === 'outro') throw busy()
  }
  const server = createPanelServer({ projectsDir, pollMs, heartbeatMs, configPath, stateDir, organizePath, graphRunsHome, home, now, canDelete })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, HOST, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      // corrida: outro graph-watch pode ter subido entre o probe e o listen
      if (port !== 0 && (await probePanel(port)) === 'graph-watch') return reused(port)
      throw busy()
    }
    throw new GraphWatchError(5, `não consegui abrir 127.0.0.1:${port}: ${e.message}`)
  }
  const real = server.address().port
  return { url: `http://${HOST}:${real}`, port: real, reused: false, server, close: () => server.closePanel() }
}

// Abre a URL no browser padrão; falha em silêncio (o link já foi impresso).
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* sem browser: ignora */
  }
}
