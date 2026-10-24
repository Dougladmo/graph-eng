import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ADVISOR_MAX_CALLS, countAdvisorCalls, executorPrompt, gateCommands, routeSteps, runAdvisorFlow, splitCost } from '../bin/advisor-flow.mjs'

async function tempDir(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'advisor-flow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const usage = (model, costUSD) => ({ [model]: { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 50, costUSD } })

// Host fake: registra cada pedido e responde por papel. executorOutputs é a fila das sessões do executor.
function fakeHost({ review = { verdict: 'APPROVE', notes: [] }, executorOutputs = [{ status: 'DONE', summary: 'feito' }], plan = { goal: 'g', steps: ['s1'], doneWhen: ['d1'], risks: [] } } = {}) {
  const requests = []
  let session = 0
  return {
    requests,
    spawn: async request => { requests.push(request); return { request } },
    wait: async ({ request }) => {
      if (request.role === 'planner') return { output: plan, usage: usage('claude-sonnet-5-5', 0.1) }
      if (request.role === 'planReviewer') return { output: review, usage: usage('claude-opus-5-5', 0.2) }
      session++
      return { output: executorOutputs[Math.min(session, executorOutputs.length) - 1], usage: { ...usage('claude-sonnet-5-5', 1), ...usage('claude-opus-5-5', 0.3) }, sessionId: `s${session}` }
    },
  }
}
const GATE = [{ id: 'test', command: 'npm', args: ['test'] }, { id: 'build', command: 'npm', args: ['run', 'build'] }]
const passing = async () => ({ pass: true, results: [] })

test('fluxo advisor: 1 planner, 1 revisão e 1 sessão do executor com Bash só no gate, terminando no gate externo', async t => {
  const cwd = await tempDir(t)
  const host = fakeHost({ review: { verdict: 'REVISE', notes: ['ligar o main.jsx'] } })
  const gateCalls = []
  const result = await runAdvisorFlow({ host, cwd, task: 'faça o jogo', runDir: path.join(cwd, 'run'), gate: GATE, runGateImpl: async (dir, checks) => { gateCalls.push(checks); return { pass: true, results: [] } }, countAdvisor: async () => 2 })
  assert.equal(result.status, 'done')
  // REVISE não abre nova rodada: as notas vão direto ao executor.
  assert.deepEqual(host.requests.map(r => r.role), ['planner', 'planReviewer', 'advisedExecutor'])
  const exec = host.requests[2]
  assert.deepEqual(exec.allowCommands, ['npm test', 'npm run build'])
  assert.match(exec.prompt, /ligar o main\.jsx/)
  assert.match(exec.prompt, /at most 3 time/)
  assert.ok(exec.timeoutMs >= 45 * 60_000)
  assert.equal(host.requests[0].readOnly, true)
  assert.equal(host.requests[1].readOnly, true)
  assert.equal(gateCalls.length, 1)
  assert.equal(result.advisorCalls, 2)
  const saved = JSON.parse(await readFile(path.join(cwd, 'run', 'advisor-run.json'), 'utf8'))
  assert.equal(saved.status, 'done')
  assert.equal(Math.round(saved.cost.costUSD * 100), 160)
})

test('gate reprovado reabre o executor com a saída do gate e o saldo do advisor; esgotadas as sessões, BLOCK', async t => {
  const cwd = await tempDir(t)
  const host = fakeHost()
  const failing = async () => ({ pass: false, results: [{ id: 'build', command: 'npm run build', exitCode: 1, outputTail: 'main.jsx: erro de import' }] })
  const result = await runAdvisorFlow({ host, cwd, task: 't', gate: GATE, runGateImpl: failing, countAdvisor: async () => 2, maxExecutorSessions: 2 })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'advisor_gate_failed')
  const sessions = host.requests.filter(r => r.role === 'advisedExecutor')
  assert.equal(sessions.length, 2)
  assert.match(sessions[1].prompt, /main\.jsx: erro de import/)
  assert.match(sessions[1].prompt, /at most 1 time/)
  assert.equal(result.advisorCalls, 4)
})

test('advisor esgotado: a sessão seguinte é proibida de chamar o advisor', () => {
  const prompt = executorPrompt({ task: 't', plan: {}, review: null, commands: ['npm test'], advisorLeft: 0 })
  assert.match(prompt, /do not call the advisor tool/)
  assert.doesNotMatch(prompt, /at most/)
})

test('executor BLOCKED com gate verde não vira DONE', async t => {
  const cwd = await tempDir(t)
  const result = await runAdvisorFlow({ host: fakeHost({ executorOutputs: [{ status: 'BLOCKED', summary: 'UI incompleta' }] }), cwd, task: 't', gate: GATE, runGateImpl: passing, countAdvisor: async () => 0 })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'advisor_executor_blocked')
})

test('sem script de test não há gate: o fluxo bloqueia antes de qualquer chamada', async t => {
  const cwd = await tempDir(t)
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }))
  const host = fakeHost()
  const result = await runAdvisorFlow({ host, cwd, task: 't', runGateImpl: passing })
  assert.equal(result.feedback.reason, 'advisor_gate_missing_test')
  assert.equal(host.requests.length, 0)
})

test('falha de chamada vira BLOCK advisor_call_failed com o custo da chamada que falhou', async t => {
  const cwd = await tempDir(t)
  const host = fakeHost()
  host.wait = async () => { throw Object.assign(new Error('caiu'), { code: 'TIMEOUT', usage: usage('claude-sonnet-5-5', 0.5) }) }
  const result = await runAdvisorFlow({ host, cwd, task: 't', gate: GATE, runGateImpl: passing })
  assert.equal(result.feedback.reason, 'advisor_call_failed')
  assert.equal(result.exception.code, 'TIMEOUT')
  assert.equal(result.cost.costUSD, 0.5)
})

test('gateCommands usa os scripts test e build do package.json', () => {
  assert.deepEqual(gateCommands({ scripts: { test: 'node --test', build: 'vite build', dev: 'vite' } }), GATE)
  assert.deepEqual(gateCommands({ scripts: { test: 'node --test' } }), [GATE[0]])
  assert.deepEqual(gateCommands({}), [])
})

test('countAdvisorCalls conta ids distintos de server_tool_use advisor na transcrição da sessão', async t => {
  const projectsDir = await tempDir(t)
  await mkdir(path.join(projectsDir, '-tmp-ws'))
  const row = (id, name = 'advisor') => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'server_tool_use', id, name, input: {} }] } })
  // O Claude Code grava a mesma mensagem mais de uma vez enquanto ela chega: o id repetido conta uma vez.
  await writeFile(path.join(projectsDir, '-tmp-ws', 'abc-1.jsonl'), [row('a'), row('a'), row('b'), row('c', 'web_search'), 'não é json', ''].join('\n'))
  assert.equal(await countAdvisorCalls('abc-1', { projectsDir }), 2)
  assert.equal(await countAdvisorCalls('outra', { projectsDir }), null)
  assert.equal(await countAdvisorCalls('../x', { projectsDir }), null)
})

test('splitCost divide o custo em entrada, escrita e leitura de cache e saída, somando o custo do CLI', () => {
  // Opus 5.5: US$ 4/M de entrada. 1000 entrada + 1000 escrita (2x) + 10000 leitura (0,1x) + 100 saída (5x) = 4500 un.
  const cost = splitCost([{ role: 'advisedExecutor', usage: { 'claude-opus-5-5': { inputTokens: 1000, cacheCreationInputTokens: 1000, cacheReadInputTokens: 10000, outputTokens: 100, costUSD: 0.018 } } }])
  assert.equal(cost.costUSD, 0.018)
  assert.ok(Math.abs(cost.input - 0.004) < 1e-9)
  assert.ok(Math.abs(cost.cacheWrite - 0.008) < 1e-9)
  assert.ok(Math.abs(cost.cacheRead - 0.004) < 1e-9)
  assert.ok(Math.abs(cost.output - 0.002) < 1e-9)
  assert.equal(cost.byRole.advisedExecutor, 0.018)
  assert.equal(ADVISOR_MAX_CALLS, 3)
})

// Roteamento por complexidade (benchmark 23/10): o planner marca cada passo; passos até --haiku-max vão para o Haiku,
// o resto fica no Sonnet. Passos seguidos do mesmo modelo viram uma sessão; o reparo do gate fica no Sonnet.
const routedPlan = { goal: 'g', doneWhen: ['d1'], risks: [], steps: [
  { step: 'tabela de blocos', complexity: 'low' },
  { step: 'ruído', complexity: 'medium' },
  { step: 'física', complexity: 'high' },
  { step: 'CSS do HUD', complexity: 'low' },
  { step: 'ligar o main.jsx', complexity: 'low' },
] }

test('routeSteps agrupa passos seguidos do mesmo modelo, com Haiku até o nível pedido', () => {
  assert.deepEqual(routeSteps(routedPlan.steps, 'medium'), [{ model: 'haiku', from: 1, to: 2 }, { model: 'sonnet', from: 3, to: 3 }, { model: 'haiku', from: 4, to: 5 }])
  assert.deepEqual(routeSteps(routedPlan.steps, 'low'), [{ model: 'haiku', from: 1, to: 1 }, { model: 'sonnet', from: 2, to: 3 }, { model: 'haiku', from: 4, to: 5 }])
  // Complexidade ausente ou inválida fica no Sonnet.
  assert.deepEqual(routeSteps([{ step: 'x' }, { step: 'y', complexity: 'trivial' }], 'medium'), [{ model: 'sonnet', from: 1, to: 2 }])
})

test('fluxo advisor roteado: planner marca complexidade, uma sessão por trecho com o modelo do trecho e o saldo do advisor compartilhado', async t => {
  const cwd = await tempDir(t)
  const host = fakeHost({ plan: routedPlan })
  const result = await runAdvisorFlow({ host, cwd, task: 't', gate: GATE, runGateImpl: passing, countAdvisor: async () => 1, haikuMax: 'medium' })
  assert.equal(result.status, 'done')
  const planner = host.requests.find(r => r.role === 'planner')
  assert.deepEqual(planner.schema.properties.steps.items.properties.complexity.enum, ['low', 'medium', 'high'])
  assert.match(planner.prompt, /complexity/)
  const sessions = host.requests.filter(r => r.role === 'advisedExecutor')
  assert.deepEqual(sessions.map(r => r.executorModel), ['haiku', 'sonnet', 'haiku'])
  assert.match(sessions[0].prompt, /steps 1–2 of 5/)
  assert.match(sessions[1].prompt, /steps 3–3 of 5/)
  assert.match(sessions[2].prompt, /at most 1 time/)
  assert.deepEqual(result.sessions.map(s => [s.model, s.from, s.to]), [['haiku', 1, 2], ['sonnet', 3, 3], ['haiku', 4, 5]])
  assert.equal(result.haikuMax, 'medium')
  assert.equal(result.advisorCalls, 3)
})

test('fluxo advisor roteado: gate reprovado vai para uma sessão de reparo inteira no Sonnet', async t => {
  const cwd = await tempDir(t)
  const host = fakeHost({ plan: routedPlan })
  let gates = 0
  const gate = async () => (++gates === 1 ? { pass: false, results: [{ id: 'test', command: 'npm test', exitCode: 1, outputTail: 'física falhou' }] } : { pass: true, results: [] })
  const result = await runAdvisorFlow({ host, cwd, task: 't', gate: GATE, runGateImpl: gate, countAdvisor: async () => 0, haikuMax: 'low' })
  assert.equal(result.status, 'done')
  const sessions = host.requests.filter(r => r.role === 'advisedExecutor')
  assert.equal(sessions.length, 4)
  assert.equal(sessions[3].executorModel, 'sonnet')
  assert.match(sessions[3].prompt, /física falhou/)
  assert.doesNotMatch(sessions[3].prompt, /Your part/)
})

test('planOnly (comando plan): planner e revisão, sem executor nem gate, com o roteamento de cada passo', async t => {
  const cwd = await tempDir(t)
  const host = fakeHost({ plan: routedPlan })
  let gates = 0
  const result = await runAdvisorFlow({ host, cwd, task: 't', gate: GATE, runGateImpl: async () => { gates++; return { pass: true, results: [] } }, haikuMax: 'low', planOnly: true, runDir: path.join(cwd, 'run') })
  assert.equal(result.status, 'planned')
  assert.deepEqual(host.requests.map(r => r.role), ['planner', 'planReviewer'])
  assert.equal(gates, 0)
  assert.deepEqual(result.routing, [{ model: 'haiku', from: 1, to: 1 }, { model: 'sonnet', from: 2, to: 3 }, { model: 'haiku', from: 4, to: 5 }])
  assert.equal(JSON.parse(await readFile(path.join(cwd, 'run', 'advisor-run.json'), 'utf8')).status, 'planned')
})

test('planned (implemente sem tarefa): pula planner e revisão e executa o plano recebido com as notas da revisão', async t => {
  const cwd = await tempDir(t)
  const host = fakeHost()
  const planned = { plan: routedPlan, review: { verdict: 'REVISE', notes: ['testar a física com dt grande'] } }
  const result = await runAdvisorFlow({ host, cwd, task: 't', gate: GATE, runGateImpl: passing, countAdvisor: async () => 0, haikuMax: 'low', planned })
  assert.equal(result.status, 'done')
  assert.deepEqual(host.requests.map(r => r.role), ['advisedExecutor', 'advisedExecutor', 'advisedExecutor'])
  assert.match(host.requests[0].prompt, /testar a física com dt grande/)
  assert.deepEqual(host.requests.map(r => r.executorModel), ['haiku', 'sonnet', 'haiku'])
})

test('effort chega a todas as chamadas do fluxo', async t => {
  const cwd = await tempDir(t)
  const host = fakeHost()
  await runAdvisorFlow({ host, cwd, task: 't', gate: GATE, runGateImpl: passing, countAdvisor: async () => 0, effort: 'max' })
  assert.deepEqual(host.requests.map(r => r.effort), ['max', 'max', 'max'])
})
