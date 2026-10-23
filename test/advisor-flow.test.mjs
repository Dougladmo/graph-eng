import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ADVISOR_MAX_CALLS, countAdvisorCalls, executorPrompt, gateCommands, runAdvisorFlow, splitCost } from '../bin/advisor-flow.mjs'
import { executeGrapheng, parseGrapheng } from '../bin/grapheng.mjs'

async function tempDir(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'advisor-flow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const usage = (model, costUSD) => ({ [model]: { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 50, costUSD } })

// Host fake: registra cada pedido e responde por papel. executorOutputs é a fila das sessões do executor.
function fakeHost({ review = { verdict: 'APPROVE', notes: [] }, executorOutputs = [{ status: 'DONE', summary: 'feito' }] } = {}) {
  const requests = []
  let session = 0
  return {
    requests,
    spawn: async request => { requests.push(request); return { request } },
    wait: async ({ request }) => {
      if (request.role === 'planner') return { output: { goal: 'g', steps: ['s1'], doneWhen: ['d1'], risks: [] }, usage: usage('claude-sonnet-5-5', 0.1) }
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

test('--flow advisor só vale com implemente e tarefa; graph é o padrão e não aparece no parse', () => {
  assert.deepEqual(parseGrapheng(['implemente', 'faça', '--flow', 'advisor']), { command: 'implemente', task: 'faça', flow: 'advisor' })
  assert.deepEqual(parseGrapheng(['implemente', 'faça', '--flow', 'graph']), { command: 'implemente', task: 'faça' })
  assert.throws(() => parseGrapheng(['plan', 'x', '--flow', 'advisor']), /só vale com implemente/)
  assert.throws(() => parseGrapheng(['implemente', '--flow', 'advisor']), /exige a tarefa/)
  assert.throws(() => parseGrapheng(['implemente', 'x', '--flow', 'outro']), /graph ou advisor/)
  assert.throws(() => parseGrapheng(['implemente', 'x', '--flow=advisor']), /não é aceito/)
})

test('--executor haiku troca o modelo do executor contínuo e só vale com --flow advisor', async t => {
  assert.deepEqual(parseGrapheng(['implemente', 'faça', '--flow', 'advisor', '--executor', 'haiku']), { command: 'implemente', task: 'faça', flow: 'advisor', executor: 'haiku' })
  assert.throws(() => parseGrapheng(['implemente', 'faça', '--executor', 'haiku']), /só vale com --flow advisor/)
  assert.throws(() => parseGrapheng(['implemente', 'faça', '--flow', 'advisor', '--executor', 'opus']), /sonnet ou haiku/)
  assert.throws(() => parseGrapheng(['implemente', 'faça', '--flow', 'advisor', '--executor', 'haiku', '--executor', 'haiku']), /repetido/)
  const cwd = await tempDir(t)
  const seen = []
  await executeGrapheng({
    invocation: ['implemente', 'faça o jogo', '--flow', 'advisor', '--executor', 'haiku'], cwd, host: 'claude',
    configImpl: async () => ({ effort: 'medium', effortSource: 'default' }),
    hostFactory: options => ({ options }),
    advisorFlowImpl: async options => { seen.push(options); return { flow: 'advisor', status: 'done' } },
  })
  assert.equal(seen[0].host.options.advisedExecutorModel, 'haiku')
})

test('executeGrapheng com --flow advisor roda o fluxo advisor e não o motor de grafo', async t => {
  const cwd = await tempDir(t)
  const seen = []
  const result = await executeGrapheng({
    invocation: ['implemente', 'faça o jogo', '--flow', 'advisor'], cwd, host: 'claude',
    configImpl: async () => ({ effort: 'medium', effortSource: 'default' }),
    runGraphImpl: async () => { throw new Error('não deveria rodar o grafo') },
    hostFactory: options => ({ options }),
    advisorFlowImpl: async options => { seen.push(options); return { flow: 'advisor', status: 'done' } },
  })
  assert.equal(result.status, 'done')
  assert.equal(seen[0].task, 'faça o jogo')
  assert.equal(seen[0].hostName, 'claude')
  assert.equal(seen[0].host.options.cwd, cwd)
  assert.ok(seen[0].runDir.startsWith(path.join(cwd, '.graph-runs')))
})
