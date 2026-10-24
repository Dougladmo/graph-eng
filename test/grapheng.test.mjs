import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SAVED_PLAN, executeGrapheng, exitCodeOf, parseGrapheng, readGraphengInvocationFile } from '../bin/grapheng.mjs'

const strange = 'ação "quoted"\n$(touch nope) `echo nope` -- coisa'

async function tempDir(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grapheng-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

// Roda executeGrapheng com host e fluxo falsos e devolve as opções que o fluxo recebeu.
async function run(cwd, invocation, { host = 'claude', flowResult = { flow: 'advisor', status: 'done' } } = {}) {
  const seen = []
  const result = await executeGrapheng({
    invocation, cwd, host,
    hostFactory: options => ({ options }),
    advisorFlowImpl: async options => { seen.push(options); return typeof flowResult === 'function' ? flowResult(options) : flowResult },
  })
  return { options: seen[0], result }
}

test('parser aceita plan e implemente e preserva a tarefa como texto literal', () => {
  assert.deepEqual(parseGrapheng(['plan', strange]), { command: 'plan', task: strange })
  assert.deepEqual(parseGrapheng(['implemente', 'uma', 'tarefa', '--effort', 'max']), { command: 'implemente', task: 'uma tarefa', effort: 'max' })
  assert.deepEqual(parseGrapheng(['implemente']), { command: 'implemente' })
  assert.deepEqual(parseGrapheng(['plan', '--', '--começa-com-hífen']), { command: 'plan', task: '--começa-com-hífen' })
  assert.deepEqual(parseGrapheng(['plan', 'x', '--haiku-max', 'medium']), { command: 'plan', task: 'x', haikuMax: 'medium' })
  assert.deepEqual(parseGrapheng(['implemente', 'x', '--executor', 'haiku']), { command: 'implemente', task: 'x', executor: 'haiku' })
})

test('comandos do motor de grafo (clarify, tasks, init) foram removidos com mensagem que aponta plan e implemente', () => {
  for (const command of ['clarify', 'tasks', 'init']) assert.throws(() => parseGrapheng([command]), /removido na 1\.3\.0; use plan ou implemente/)
  assert.throws(() => parseGrapheng(['implement', 'x']), /use implemente/)
  assert.throws(() => parseGrapheng(['full', 'x']), /use plan ou implemente/)
})

test('parser rejeita tarefa vazia, flags repetidas, removidas, com = e valores fora da lista', () => {
  const cases = [
    [[], /comando desconhecido/],
    [['plan'], /plan exige uma tarefa/],
    [['implemente', ' '], /tarefa vazia/],
    [['plan', 'x', '--effort', 'low', '--effort', 'max'], /--effort repetido/],
    [['plan', 'x', '--effort', 'high'], /low, medium ou max/],
    [['plan', 'x', '--effort=max'], /use --effort max/],
    [['plan', 'x', '--adaptive', 'on'], /--adaptive: opção removida/],
    [['plan', 'x', '--flow', 'advisor'], /--flow: opção removida/],
    [['plan', 'x', '--model', 'opus'], /--model: opção removida/],
    [['plan', 'x', '--nada'], /opção desconhecida/],
    [['implemente', 'x', '--executor', 'opus'], /sonnet ou haiku/],
    [['implemente', 'x', '--haiku-max', 'high'], /low, medium ou off/],
    [['implemente', 'x', '--haiku-max', 'low', '--executor', 'haiku'], /não combina/],
    [['implemente', '--haiku-max', 'medium'], /passe --haiku-max ou --executor no plan/],
  ]
  for (const [argv, message] of cases) assert.throws(() => parseGrapheng(argv), message, JSON.stringify(argv))
})

// v1.3.0: o advisor é o fluxo único. No claude, o padrão é --haiku-max low (benchmark 23/10: 55/55, US$ 1,59).
test('implemente roda o fluxo advisor com --haiku-max low e effort medium por padrão no claude', async t => {
  const cwd = await tempDir(t)
  const { options, result } = await run(cwd, ['implemente', strange])
  assert.equal(result.status, 'done')
  assert.equal(options.task, strange)
  assert.equal(options.hostName, 'claude')
  assert.equal(options.haikuMax, 'low')
  assert.equal(options.effort, 'medium')
  assert.equal(options.planOnly, undefined)
  assert.equal(options.host.options.cwd, cwd)
  assert.equal(options.host.options.advisedExecutorModel, undefined)
  assert.ok(options.runDir.startsWith(path.join(cwd, '.graph-runs')))
  assert.equal(result.runDir, options.runDir)
})

test('--effort, --haiku-max e --executor chegam ao fluxo; codex não roteia', async t => {
  const cwd = await tempDir(t)
  assert.equal((await run(cwd, ['implemente', 'x', '--effort', 'max'])).options.effort, 'max')
  assert.equal((await run(cwd, ['implemente', 'x', '--haiku-max', 'medium'])).options.haikuMax, 'medium')
  assert.equal((await run(cwd, ['implemente', 'x', '--haiku-max', 'off'])).options.haikuMax, undefined)
  const fixed = (await run(cwd, ['implemente', 'x', '--executor', 'sonnet'])).options
  assert.equal(fixed.haikuMax, undefined)
  assert.equal(fixed.host.options.advisedExecutorModel, 'sonnet')
  assert.equal((await run(cwd, ['implemente', 'x'], { host: 'codex' })).options.haikuMax, undefined)
  await assert.rejects(run(cwd, ['implemente', 'x', '--haiku-max', 'low'], { host: 'codex' }), /vale só no host claude/)
  await assert.rejects(run(cwd, ['implemente', 'x', '--executor', 'haiku'], { host: 'codex' }), /vale só no host claude/)
})

test('plan só planeja e salva o plano; implemente sem tarefa executa o plano salvo com o roteamento dele', async t => {
  const cwd = await tempDir(t)
  const plan = { goal: 'g', steps: [{ step: 's1', complexity: 'low' }], doneWhen: ['d'], risks: [] }
  const review = { verdict: 'APPROVE', notes: [] }
  const planned = await run(cwd, ['plan', 'faça o jogo', '--haiku-max', 'medium'], { flowResult: { flow: 'advisor', status: 'planned', plan, review } })
  assert.equal(planned.options.planOnly, true)
  assert.equal(planned.options.haikuMax, 'medium')
  const saved = JSON.parse(await readFile(path.join(cwd, SAVED_PLAN), 'utf8'))
  assert.deepEqual({ ...saved, runId: undefined }, { host: 'claude', task: 'faça o jogo', haikuMax: 'medium', executor: null, runId: undefined, plan, review })
  const { options } = await run(cwd, ['implemente', '--effort', 'low'])
  assert.equal(options.task, 'faça o jogo')
  assert.equal(options.haikuMax, 'medium')
  assert.equal(options.effort, 'low')
  assert.deepEqual(options.planned, { plan, review })
  assert.equal(options.planOnly, undefined)
})

test('plan com --executor salva o modelo fixo e implemente sem tarefa o reaplica', async t => {
  const cwd = await tempDir(t)
  await run(cwd, ['plan', 'x', '--executor', 'haiku'], { flowResult: { status: 'planned', plan: { steps: ['a'] }, review: null } })
  const { options } = await run(cwd, ['implemente'])
  assert.equal(options.host.options.advisedExecutorModel, 'haiku')
  assert.equal(options.haikuMax, undefined)
})

test('plan bloqueado não sobrescreve o plano salvo', async t => {
  const cwd = await tempDir(t)
  await mkdir(path.join(cwd, '.graph-runs'), { recursive: true })
  await writeFile(path.join(cwd, SAVED_PLAN), '{"anterior":true}\n')
  await run(cwd, ['plan', 'x'], { flowResult: { status: 'blocked', feedback: { reason: 'advisor_call_failed' } } })
  assert.equal(await readFile(path.join(cwd, SAVED_PLAN), 'utf8'), '{"anterior":true}\n')
})

test('implemente sem tarefa e sem plano salvo bloqueia com advisor_plan_missing; plano de outro host também bloqueia', async t => {
  const cwd = await tempDir(t)
  const missing = await run(cwd, ['implemente'])
  assert.equal(missing.options, undefined, 'o fluxo não roda')
  assert.equal(missing.result.status, 'blocked')
  assert.equal(missing.result.feedback.reason, 'advisor_plan_missing')
  assert.equal(exitCodeOf(missing.result), 2)
  await mkdir(path.join(cwd, '.graph-runs'), { recursive: true })
  await writeFile(path.join(cwd, SAVED_PLAN), JSON.stringify({ host: 'codex', task: 'x', plan: {}, review: null }))
  assert.equal((await run(cwd, ['implemente'])).result.feedback.reason, 'advisor_plan_host_mismatch')
})

test('arquivo de invocação preserva Unicode e metacaracteres como dados e só aceita host e argv', async t => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'invocation.json')
  await writeFile(file, JSON.stringify({ host: 'codex', argv: ['plan', strange, '--effort', 'medium'] }))
  const envelope = await readGraphengInvocationFile(['--invocation', file])
  assert.deepEqual(envelope.argv, ['plan', strange, '--effort', 'medium'])
  await writeFile(file, JSON.stringify({ host: 'claude', argv: ['plan', 'x'], clarification: {} }))
  await assert.rejects(readGraphengInvocationFile(['--invocation', file]), /chave não permitida no envelope: clarification/)
  await writeFile(file, JSON.stringify({ host: 'outro', argv: ['plan', 'x'] }))
  await assert.rejects(readGraphengInvocationFile(['--invocation', file]), /host confiável/)
  await assert.rejects(readGraphengInvocationFile([file]), /uso: grapheng\.mjs --invocation/)
  await assert.rejects(executeGrapheng({ invocation: ['plan', 'x'], host: 'outro' }), /host confiável obrigatório/)
})

test('exitCodeOf: blocked sai com 2; done e planned saem com 0', () => {
  assert.equal(exitCodeOf({ status: 'blocked' }), 2)
  assert.equal(exitCodeOf({ status: 'done' }), 0)
  assert.equal(exitCodeOf({ status: 'planned' }), 0)
})
