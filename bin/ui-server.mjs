// Painel web ao vivo do graph-watch (`graph-watch ui`) — docs/specs/2026-09-27-painel-web.md.
// Node puro (node:http), sem dependências. Só leitura: nenhum endpoint escreve em disco.
//
// ── Contrato HTTP (consumido pela página em bin/ui/) ──
// Todas as respostas: só GET (outro método → 405). `Host` precisa ser `127.0.0.1:<porta>` ou
// `localhost:<porta>` (senão 403, contra DNS rebinding). Erros vêm como JSON `{ "error": "<texto pt-BR>" }`.
//
// GET /api/health → 200 `{ "app": "graph-watch", "version": 1 }`
//
// GET /api/runs → 200 `{ "runs": RunResumo[] }`, no máximo 50, `rodando` primeiro e depois `mtime` desc.
//   RunResumo = {
//     wf: "wf_…",                       // id do diretório do workflow
//     project: "postify-backend",       // basename do `cwd` das transcrições; sem elas, último trecho do slug
//     status: "rodando" | "parada?" | "terminado",
//                                       // terminado = synth com result; rodando = journal ou transcrição de
//                                       // agente mexeu nos últimos 2 min; senão parada?
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
//   :id é um nó do modelo ou um pseudo-nó `plan` | `critic` (todas as rodadas) | `synth`.
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
// GET /api/events → text/event-stream (SSE). Ao conectar: `event: runs` com `{ "runs": RunResumo[] }`.
//   Depois, poll a cada ~1 s: `event: runs` (mesmo formato) quando a lista muda (wf, status, done/total,
//   estados dos nós, goal); `event: run` com `{ "wf": "wf_…" }` quando o journal (mtime/tamanho) ou a
//   transcrição de um agente daquela run muda. Comentário `: ping` a cada ~15 s. Timers limpos quando o
//   último cliente desconecta.
//
// Estáticos (lista fixa, qualquer outro caminho → 404): `/` e `/index.html` (text/html), `/app.js`
// (text/javascript), `/graph-layout.mjs` (módulo importado pelo app.js), `/theme.js` (aplica o tema antes
// da pintura), `/style.css`, `/favicon.svg` e as fontes Geist em `/fonts/*.woff2` (SIL OFL, fonts/OFL.txt),
// lidos de bin/ui/. Nada vem de fora: CSP com script, estilo, fonte e conexão só 'self'.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { buildModel, listAllWfDirs, isGraphEngRun, isTerminatedRun, agentsOfNode, readJournalTolerant, GraphWatchError } from './graph-watch.mjs'

export const DEFAULT_PORT = 4477
const HOST = '127.0.0.1'
const RUNS_LIMIT = 50
const ACTIVE_WINDOW_MS = 2 * 60 * 1000
const WF_RE = /^wf_[A-Za-z0-9_-]+$/
const NODE_RE = /^[A-Za-z0-9_-]{1,64}$/
const PSEUDO = new Set(['plan', 'critic', 'synth'])
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui')
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/graph-layout.mjs': ['graph-layout.mjs', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/fonts/geist-latin.woff2': ['fonts/geist-latin.woff2', 'font/woff2'],
  '/fonts/geist-latin-ext.woff2': ['fonts/geist-latin-ext.woff2', 'font/woff2'],
  '/fonts/geist-mono-latin.woff2': ['fonts/geist-mono-latin.woff2', 'font/woff2'],
  '/fonts/geist-mono-latin-ext.woff2': ['fonts/geist-mono-latin-ext.woff2', 'font/woff2'],
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
// `Mode: <modo>` e `Economy: <preset>` (esta, só em runs a partir da 0.3.0). Lê o começo da transcrição do
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
      return { mode: m[1], economy: e && ECONOMIES.has(e[1]) ? e[1] : undefined }
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

// Cria o leitor de runs de um projectsDir. `scan()` devolve a lista (RunResumo + campos internos
// `dir`, `sig`); o cache guarda o que depende só do journal.
export function createRunIndex(projectsDir) {
  const cache = new Map() // dir → { sig, info | null }
  const projects = new Map() // dir → nome do projeto (fixo depois de achado pelo cwd)

  async function describe(c) {
    const st = statOr(path.join(c.dir, 'journal.jsonl'))
    if (!st) return null
    const sig = `${st.mtimeMs}:${st.size}`
    const hit = cache.get(c.dir)
    if (hit && hit.sig === sig) return hit.info
    let info = null
    if (isGraphEngRun(c.dir)) {
      const { mode, economy } = inferHeader(c.dir)
      let model = null
      try {
        model = await buildModel({ runDir: c.dir, mode, economy })
      } catch {
        /* journal de formato estranho: entra na lista sem nós */
      }
      const nodes = model ? model.nodes : []
      info = {
        terminated: isTerminatedRun(c.dir),
        goal: planGoal(c.dir),
        mode,
        economy,
        done: nodes.filter((n) => n.state.startsWith('pronto')).length,
        total: nodes.length,
        round: model ? model.round : 1,
        nodes: nodes.map((n) => ({ id: n.id, state: n.state, round: n.round })),
        journalMtime: st.mtimeMs,
      }
    }
    cache.set(c.dir, { sig, info })
    return info
  }

  async function scan(now = Date.now()) {
    const all = listAllWfDirs(projectsDir).sort((a, b) => b.mtime - a.mtime)
    const out = []
    const seen = new Set()
    for (const c of all) {
      if (out.length >= RUNS_LIMIT) break
      if (seen.has(c.wf)) continue
      const info = await describe(c)
      if (!info) continue
      seen.add(c.wf)
      const agents = info.terminated ? 0 : agentActivity(c.dir)
      const last = Math.max(info.journalMtime, agents)
      if (!projects.has(c.dir)) projects.set(c.dir, projectOf(projectsDir, c.dir))
      out.push({
        wf: c.wf,
        project: projects.get(c.dir),
        status: info.terminated ? 'terminado' : now - last < ACTIVE_WINDOW_MS ? 'rodando' : 'parada?',
        goal: info.goal,
        done: info.done,
        total: info.total,
        round: info.round,
        mtime: Math.round(last),
        nodes: info.nodes,
        dir: c.dir,
        mode: info.mode,
        economy: info.economy,
        sig: `${cache.get(c.dir).sig}:${agents}`,
      })
    }
    const rank = (r) => (r.status === 'rodando' ? 0 : 1)
    out.sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime)
    return out
  }

  return { scan }
}

const publicRun = ({ dir, sig, mode, economy, ...r }) => r

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

export function createPanelServer({ projectsDir, pollMs = 1000, heartbeatMs = 15000 } = {}) {
  const index = createRunIndex(projectsDir)
  const clients = new Set()
  let pollTimer = null
  let beatTimer = null
  let lastListSig = null
  let runSigs = new Map()
  let polling = false

  const listSig = (runs) => JSON.stringify(runs.map((r) => [r.wf, r.status, r.done, r.total, r.goal, r.round, r.nodes]))

  function broadcast(event, data) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) res.write(chunk)
  }

  async function tick() {
    if (polling) return
    polling = true
    try {
      const runs = await index.scan()
      const sig = listSig(runs)
      if (sig !== lastListSig) {
        lastListSig = sig
        broadcast('runs', { runs: runs.map(publicRun) })
      }
      const next = new Map()
      for (const r of runs) {
        next.set(r.wf, r.sig)
        const prev = runSigs.get(r.wf)
        if (prev !== undefined && prev !== r.sig) broadcast('run', { wf: r.wf })
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
    const runs = await index.scan()
    if (!clients.size) {
      // primeiro cliente: fotografa o estado atual para só avisar mudanças daqui em diante
      lastListSig = listSig(runs)
      runSigs = new Map(runs.map((r) => [r.wf, r.sig]))
    }
    res.write(`event: runs\ndata: ${JSON.stringify({ runs: runs.map(publicRun) })}\n\n`)
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

  async function findListed(wf) {
    const runs = await index.scan()
    return runs.find((r) => r.wf === wf) || null
  }

  async function handle(req, res) {
    const port = server.address() && server.address().port
    const host = String(req.headers.host || '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendError(res, 403, 'Host não permitido')
    if (req.method !== 'GET') return sendError(res, 405, 'só leitura: use GET', { Allow: 'GET' })
    let pathname
    try {
      pathname = new URL(req.url, `http://${HOST}`).pathname
    } catch {
      return sendError(res, 400, 'URL inválida')
    }

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

    if (pathname === '/favicon.ico') return send(res, 204, '')
    const parts = pathname.split('/').slice(1)
    if (parts[0] !== 'api') return sendError(res, 404, 'não encontrado')
    if (parts.length === 2 && parts[1] === 'health') return send(res, 200, { app: 'graph-watch', version: 1 })
    if (parts.length === 2 && parts[1] === 'events') return openEvents(req, res)
    if (parts.length === 2 && parts[1] === 'runs') return send(res, 200, { runs: (await index.scan()).map(publicRun) })

    if (parts[1] === 'runs' && (parts.length === 3 || (parts.length === 5 && parts[3] === 'nodes'))) {
      const wf = parts[2]
      if (!WF_RE.test(wf)) return sendError(res, 400, 'id de run inválido')
      if (parts.length === 5 && !NODE_RE.test(parts[4])) return sendError(res, 400, 'id de nó inválido')
      const run = await findListed(wf)
      if (!run) return sendError(res, 404, `run ${wf} não encontrada`)
      let model
      try {
        model = await buildModel({ runDir: run.dir, mode: run.mode, economy: run.economy })
      } catch (e) {
        if (e instanceof GraphWatchError) return sendError(res, 404, e.message)
        throw e
      }
      if (parts.length === 3) {
        return send(res, 200, { ...model, status: run.status, project: run.project, goal: run.goal, mode: run.mode, economy: run.economy, lastActivity: run.mtime })
      }
      const id = parts[4]
      const node = model.nodes.find((n) => n.id === id)
      if (!node && !PSEUDO.has(id)) return sendError(res, 404, `nó ${id} não existe em ${wf}`)
      const agents = agentsOfNode(run.dir, id, 20)
      if (node) return send(res, 200, { wf, ...node, pseudo: false, agents })
      return send(res, 200, { wf, id, pseudo: true, title: id, state: pseudoState(agents), agents })
    }
    return sendError(res, 404, 'não encontrado')
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) sendError(res, 500, `erro inesperado: ${String((e && e.message) || e)}`)
      else res.end()
    })
  })

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
  const { port = DEFAULT_PORT, projectsDir = path.join(os.homedir(), '.claude', 'projects'), pollMs, heartbeatMs } = opts
  const reused = (p) => ({ url: `http://${HOST}:${p}`, port: p, reused: true, close: async () => {} })
  const busy = () => new GraphWatchError(5, `porta ${port} ocupada por outro programa; use --port <N> ou GRAPH_ENG_PORT=<N>`)
  if (port !== 0) {
    const who = await probePanel(port)
    if (who === 'graph-watch') return reused(port)
    if (who === 'outro') throw busy()
  }
  const server = createPanelServer({ projectsDir, pollMs, heartbeatMs })
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
