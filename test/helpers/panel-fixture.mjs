// Montagem de runs do graph-eng em dirs temporários, para os testes do painel com ações (spec
// docs/specs/2026-09-28-acoes-no-painel.md, C10-C12; D3 §8.1). Usado por test/ui-server-actions.test.mjs e
// pelo e2e do I8. Nada aqui lê nem grava em ~/.claude: todo caminho vem do chamador.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { ensurePanel } from '../../bin/ui-server.mjs'
import { writeHeartbeat } from '../../bin/requests.mjs'

// Sessões com a forma de uuid (SESSION_RE): só elas dão dona e sinal de vida (C3).
export const SESS = {
  a: 'aaaaaaaa-0000-4000-8000-000000000001',
  b: 'bbbbbbbb-0000-4000-8000-000000000002',
  c: 'cccccccc-0000-4000-8000-000000000003',
}
export const SLUG = '-exemplo-acoes'

// Plano de 4 nós: A → B → C e A → D.
export const PLAN = {
  goal: 'Objetivo inventado da run de ações.',
  complexity: 'moderate',
  doneWhen: ['critério inventado'],
  assumptions: [],
  nodes: [
    { id: 'A', title: 'Pesquisa inventada', kind: 'research', brief: 'Achar A.', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'B', title: 'Mudança inventada B', kind: 'implement', brief: 'Fazer B.', deps: ['A'], risk: 'low', acceptance: ['b'] },
    { id: 'C', title: 'Mudança inventada C', kind: 'implement', brief: 'Fazer C.', deps: ['B'], risk: 'low', acceptance: ['c'] },
    { id: 'D', title: 'Mudança inventada D', kind: 'implement', brief: 'Fazer D.', deps: ['A'], risk: 'low', acceptance: ['d'] },
  ],
  questions: [],
}

const line = (o) => JSON.stringify(o) + '\n'
let agentSeq = 0
const nextId = () => `act${String(++agentSeq).padStart(5, '0')}bbbbbbbbbbb`

// Uma execução (wf) de uma run. kind:
//   'plan'        só o plano (planOnly)
//   'running'     A pronto, B com o work aberto (rodando se `ageSec` é pequeno)
//   'stopped'     igual a running, com tudo parado há `ageSec` (padrão 3600 s)
//   'interrupted' igual a stopped, com a última linha do agente aberto = `[Request interrupted by user]`
//   'done'        os 4 nós prontos, crítica e síntese
// `runDir` vira a linha `Run dir (paper trail): …` do prompt (omitido = sem a linha). `plan` troca o plano.
export function addRun(projectsDir, { slug = SLUG, session = SESS.a, wf, runId, runDir, kind = 'running', ageSec, plan = PLAN } = {}) {
  const age = ageSec ?? (kind === 'running' ? 2 : kind === 'done' || kind === 'plan' ? 60 : 3600)
  const dir = path.join(projectsDir, slug, session, 'subagents', 'workflows', wf)
  fs.mkdirSync(dir, { recursive: true })
  const header = [runId ? `# Graph run ${runId}` : null, 'Task: tarefa inventada', runDir ? `Run dir (paper trail): ${runDir}` : null, 'Mode: implement', 'Economy: balanced', ''].filter((l) => l !== null).join('\n')
  const cwd = `/exemplo/${slug.replace(/^-/, '')}`
  const ev = [{ type: 'launched' }]
  const agent = (label, phase, result, lastLine) => {
    const id = nextId()
    const first = label === 'plan' ? { type: 'user', cwd, message: { role: 'user', content: header } } : { type: 'user', cwd, message: { role: 'user', content: `${header}\n${label}` } }
    const lines = [first, lastLine || { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }]
    fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), lines.map(line).join(''))
    ev.push({ type: 'started', key: `v2:${id}`, agentId: id, label, phase })
    if (result !== undefined) ev.push({ type: 'result', key: `v2:${id}`, agentId: id, result })
  }
  const work = (n) => ({ status: 'done', summary: `feito ${n}`, confidence: 'high', artifact: `<run dir>/${n}.md`, checks: [] })
  const pass = { pass: true, confidence: 'high', blocking: [] }

  agent('plan', 'Plan', plan)
  if (kind !== 'plan') {
    agent('work:A', 'Execute', work('A'))
    agent('verify:A', 'Verify', pass)
    if (kind === 'done') {
      for (const n of ['B', 'C', 'D']) {
        agent(`work:${n}`, 'Execute', work(n))
        agent(`verify:${n}`, 'Verify', pass)
      }
      agent('critic:r1', 'Critic', { done: true, gaps: [] })
      agent('synth', 'Synthesize', { status: 'done', summary: 'fim', confidence: 'high', artifact: '<run dir>/REPORT.md' })
    } else {
      const interrupted = kind === 'interrupted' ? { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } } : undefined
      agent('work:B', 'Execute', undefined, interrupted)
    }
  }
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), ev.map(line).join(''))
  touch(dir, age)
  return dir
}

// Põe o mtime de tudo em `dir` (sem descer) a `ageSec` segundos atrás.
export function touch(dir, ageSec) {
  const t = new Date(Date.now() - ageSec * 1000)
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), t, t)
}

// Pasta de artefatos `<parent>/<runId>` com os arquivos pedidos (nome → texto).
export function mkRunDir(parent, runId, files = { 'plan.md': '# plano\n' }) {
  const d = path.join(parent, runId)
  fs.mkdirSync(d, { recursive: true })
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text)
  return d
}

// Sinal de vida de um watcher (C3), com o pid deste processo (vivo). `beatAt`/`exitedAt` em ms.
export function writeListener(stateDir, { session, project = SLUG, wf = null, beatAt = Date.now(), exitedAt = null, pid = process.pid } = {}) {
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString())
  return writeHeartbeat(stateDir, { session, project, pid, wf, mode: 'run', startedAt: iso(beatAt), beatAt: iso(beatAt), exitedAt: iso(exitedAt) })
}

export function request(port, method, p, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (text += d))
      res.on('end', () => {
        let json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          /* resposta que não é JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json })
      })
    })
    req.on('error', reject)
    if (Array.isArray(body)) {
      for (const chunk of body) req.write(chunk)
      req.end()
    } else req.end(body)
  })
}

// Um mundo isolado em tmp: projectsDir, repo com .graph-runs, stateDir, home e graph-runs global, e um
// painel em porta efêmera com relógio injetável (`W.clock.t`, ms; null = relógio real).
export async function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-eng-acoes-')))
  const projectsDir = path.join(root, 'projects')
  const stateDir = path.join(root, 'state')
  const home = path.join(root, 'home')
  const graphRunsHome = path.join(root, 'graph-runs')
  const graphRuns = path.join(root, 'repo', '.graph-runs')
  for (const d of [projectsDir, stateDir, home, graphRunsHome, graphRuns]) fs.mkdirSync(d, { recursive: true })
  const configPath = path.join(stateDir, 'config.json')
  const clock = { t: null }
  const now = () => (clock.t === null ? Date.now() : clock.t)
  const panel = await ensurePanel({ port: 0, projectsDir, pollMs: 100, configPath, stateDir, graphRunsHome, home, now })
  const port = panel.port
  const origin = `http://127.0.0.1:${port}`
  const post = (p, body, headers = {}) => request(port, 'POST', p, { Origin: origin, 'Content-Type': 'application/json', ...headers }, typeof body === 'string' ? body : JSON.stringify(body))
  const get = (p, headers = {}) => request(port, 'GET', p, headers)
  const close = async () => {
    await panel.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
  return { root, projectsDir, stateDir, home, graphRunsHome, graphRuns, configPath, clock, now, panel, port, origin, post, get, close }
}
