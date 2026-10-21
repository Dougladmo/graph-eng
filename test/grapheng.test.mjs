import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseGrapheng, executeGrapheng, discoverChecks, readGraphengInvocationFile, validateClarificationAnswers } from '../bin/grapheng.mjs'
import { NODE_CHECK_MAPPING_HASH, NODE_CHECK_POLICY_ID } from '../bin/node-check-policy.mjs'

const strange = 'ação "quoted"\n$(touch nope) `echo nope` -- coisa'

test('parser aceita os três comandos e preserva tarefa como texto literal', () => {
  assert.deepEqual(parseGrapheng(['plan', strange]), { command: 'plan', task: strange })
  assert.deepEqual(parseGrapheng(['implemente', 'uma', 'tarefa', '--effort', 'max']), { command: 'implemente', task: 'uma tarefa', effort: 'max' })
  assert.deepEqual(parseGrapheng(['init']), { command: 'init' })
  assert.deepEqual(parseGrapheng(['plan', '--', '--começa-com-hífen']), { command: 'plan', task: '--começa-com-hífen' })
})

test('parser rejeita tarefas vazias, comandos desconhecidos, flags repetidas/removidas', () => {
  for (const argv of [[], ['full', 'x'], ['plan'], ['implemente', ' '], ['plan', 'x', '--effort', 'low', '--effort', 'max'], ['plan', 'x', '--effort', 'high'], ['plan', 'x', '--ceiling', '20'], ['plan', 'x', '--economy', 'lean'], ['plan', 'x', '--model', 'opus'], ['init', 'x'], ['init', '--effort', 'medium']]) {
    assert.throws(() => parseGrapheng(argv))
  }
})

test('arquivo de invocação do wrapper preserva Unicode e metacaracteres como dados até runGraph', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grapheng-invocation-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'invocation.json')
  await writeFile(file, JSON.stringify({ host: 'codex', argv: ['plan', strange, '--effort', 'medium'] }))
  const envelope = await readGraphengInvocationFile(['--invocation', file])
  let captured
  await executeGrapheng({
    invocation: envelope.argv,
    host: envelope.host,
    cwd: dir,
    configImpl: async effort => ({ effort, effortSource: 'flag' }),
    runGraphImpl: async call => { captured = call; return { planOnly: true } },
  })
  assert.equal(captured.hostName, 'codex')
  assert.equal(captured.args.task, strange)
  assert.deepEqual(captured.args.pipeline, { from: 'plan', to: 'plan' })
  assert.equal('planOnly' in captured.args, false)
})

test('driver chama runGraph uma vez com host confiável, args mínimos e task intacta', async () => {
  const calls = []
  const result = await executeGrapheng({
    invocation: ['implemente', strange, '--effort', 'low'], cwd: '/repo', host: 'codex',
    configImpl: async flag => ({ effort: flag || 'medium', effortSource: flag ? 'flag' : 'config' }),
    discoverChecksImpl: async () => ({ checks: [{ id: 't', command: '/node', args: ['--test'], cwd: '.' }], checkContract: { path: 'package.json', sha256: 'a'.repeat(64) }, nodeCheckPolicy: { id: NODE_CHECK_POLICY_ID, mappingHash: NODE_CHECK_MAPPING_HASH, adapter: 'node-test-v1', concurrency: 2 } }),
    runGraphImpl: async call => { calls.push(call); return { status: 'done' } },
  })
  assert.equal(result.status, 'done')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].hostName, 'codex')
  assert.equal(calls[0].args.task, strange)
  assert.equal(calls[0].args.mode, 'implement')
  assert.deepEqual(calls[0].args.pipeline, { from: 'auto', to: 'implement' })
  assert.equal('planOnly' in calls[0].args, false)
  assert.equal(calls[0].args.effort, 'low')
  assert.deepEqual(calls[0].args.checkContract, { path: 'package.json', sha256: 'a'.repeat(64) })
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['checkContract', 'checks', 'context', 'effort', 'effortSource', 'mode', 'nodeCheckPolicy', 'pipeline', 'runDir', 'runId', 'task'].sort())
  assert.deepEqual(calls[0].args.nodeCheckPolicy, { id: NODE_CHECK_POLICY_ID, mappingHash: NODE_CHECK_MAPPING_HASH, adapter: 'node-test-v1', concurrency: 2 })
  assert.equal(path.isAbsolute(calls[0].args.runDir), false)
  assert.equal(calls[0].cwd, '/repo')
})

test('plan usa esforço configurado quando flag não veio e nunca recebe planOnly', async () => {
  let captured
  await executeGrapheng({ invocation: ['plan', strange], cwd: '/repo', host: 'claude', configImpl: async () => ({ effort: 'medium', effortSource: 'config' }), runGraphImpl: async call => { captured = call; return { status: 'done' } } })
  assert.equal('planOnly' in captured.args, false)
  assert.equal(captured.args.effort, 'medium')
  assert.deepEqual(captured.args.checks, [])
})

test('init não executa runGraph e recusa host ausente ou ambíguo', async () => {
  let runnerCalls = 0
  const result = await executeGrapheng({ invocation: ['init'], host: 'claude', startPanelImpl: async () => ({ status: 'started', url: 'http://127.0.0.1:4491' }), runGraphImpl: async () => { runnerCalls++ } })
  assert.deepEqual(result, { status: 'started', url: 'http://127.0.0.1:4491' })
  assert.equal(runnerCalls, 0)
  await assert.rejects(executeGrapheng({ invocation: ['plan', 'x'] }), /host confiável obrigatório/)
  await assert.rejects(executeGrapheng({ invocation: ['plan', 'x'], host: 'unknown' }), /host confiável obrigatório/)
})

test('check mapeia apenas node --test para argv sem shell e concorrência limitada', async () => {
  const result = await discoverChecks('/repo', { packageReader: async () => JSON.stringify({ scripts: { test: 'node --test' } }) })
  assert.equal(result.checks.length, 1)
  assert.equal(result.checks[0].command, process.execPath)
  assert.deepEqual(result.checks[0].args, ['--test', '--test-concurrency=2'])
  assert.equal(result.checks[0].cwd, '.')
  assert.equal(result.checks[0].heavy, true)
  assert.equal(result.checkContract.path, 'package.json')
  assert.match(result.checkContract.sha256, /^[a-f0-9]{64}$/)
  assert.equal(result.checkContract.source, 'scripts.test=node --test')
  assert.deepEqual(result.nodeCheckPolicy, { id: NODE_CHECK_POLICY_ID, mappingHash: NODE_CHECK_MAPPING_HASH, adapter: 'node-test-v1', concurrency: 2 })
})

test('script desconhecido e caminhos de teste inseguros bloqueiam descoberta', async () => {
  const unknown = await discoverChecks('/repo', { packageReader: async () => JSON.stringify({ scripts: { test: 'npm run test:ci' } }) })
  assert.match(unknown.block, /Execução ainda suportada apenas para Node com scripts\.test exatamente node --test/)
  const invalid = await discoverChecks('/repo', { packageReader: async () => JSON.stringify({ scripts: { test: 'node --test' } }), affectedTests: ['../outside.test.mjs'] })
  assert.match(invalid.block, /política confiável do supervisor/)
})

test('descoberta bloqueada não chama runner para implementação', async () => {
  let called = false
  const result = await executeGrapheng({ invocation: ['implemente', 'tarefa'], cwd: '/repo', host: 'claude', configImpl: async () => ({ effort: 'medium', effortSource: 'default' }), discoverChecksImpl: async () => ({ block: 'não há mapeamento' }), runGraphImpl: async () => { called = true } })
  assert.equal(called, false)
  assert.equal(result.status, 'blocked')
})

const SET_ID = 'a'.repeat(64)
const REMOVED_FLAGS = ['--ceiling', '--economy', '--width', '--model', '--planner-model', '--reviewer-model', '--executor-model', '--max-rounds', '--max-repairs', '--plan-gate', '--lean', '--high', '--manual', '--auto', '--max-agents']
const INTERNAL_FLAGS = ['--stage', '--pipeline', '--plan', '--plan-only', '--from', '--to', '--reuse', '--no-reuse', '--run-dir', '--run-id', '--resume', '--mode', '--checks', '--context', '--spec', '--done-when', '--host', '--answers']
const VALID_ENVELOPE_CLARIFICATION = { questionSetId: SET_ID, answers: [{ questionId: 'Q1', answer: 'pg' }, { questionId: 'Q2', skipped: true }] }

test('parser aceita os cinco comandos, tarefa opcional só em implemente e esforço aceito e ignorado em clarify/tasks', () => {
  assert.deepEqual(parseGrapheng(['plan', 'x']), { command: 'plan', task: 'x' })
  assert.deepEqual(parseGrapheng(['clarify']), { command: 'clarify' })
  assert.deepEqual(parseGrapheng(['clarify', '--effort', 'low']), { command: 'clarify', effort: 'low' })
  assert.deepEqual(parseGrapheng(['tasks']), { command: 'tasks' })
  assert.deepEqual(parseGrapheng(['tasks', '--effort', 'max']), { command: 'tasks', effort: 'max' })
  assert.deepEqual(parseGrapheng(['implemente']), { command: 'implemente' })
  assert.deepEqual(parseGrapheng(['implemente', '--effort', 'max']), { command: 'implemente', effort: 'max' })
  assert.deepEqual(parseGrapheng(['init']), { command: 'init' })
})

test('parser recusa tarefa em clarify e tasks com a mensagem de uso fixa', () => {
  for (const command of ['clarify', 'tasks']) {
    assert.throws(() => parseGrapheng([command, 'tarefa']), /clarify\/tasks usam o plano aprovado do workspace; não recebem tarefa/)
  }
  assert.throws(() => parseGrapheng(['clarify', '--', 'x']), /não recebem tarefa/)
})

test('parser recusa comandos antigos e internos como comando público', () => {
  assert.throws(() => parseGrapheng(['full', 'x']), /comando desconhecido/)
  assert.throws(() => parseGrapheng(['research', 'x']), /comando desconhecido/)
  assert.throws(() => parseGrapheng(['retomar']), /comando desconhecido/)
  assert.throws(() => parseGrapheng(['refazer']), /comando desconhecido/)
  assert.throws(() => parseGrapheng(['parar']), /comando desconhecido/)
  assert.throws(() => parseGrapheng(['implement', 'x']), /use implemente/)
})

test('parser recusa todo knob removido e todo knob interno, inclusive na forma com igual', () => {
  for (const flag of REMOVED_FLAGS) {
    assert.throws(() => parseGrapheng(['plan', 'x', flag, 'v']), /opção removida/, flag)
    assert.throws(() => parseGrapheng(['plan', 'x', `${flag}=v`]), /opção removida/, flag)
  }
  for (const flag of INTERNAL_FLAGS) {
    assert.throws(() => parseGrapheng(['plan', 'x', flag, 'v']), /opção interna, não pública/, flag)
    assert.throws(() => parseGrapheng(['implemente', `${flag}=v`]), /opção interna, não pública/, flag)
  }
  assert.deepEqual(parseGrapheng(['plan', '--', '--model']), { command: 'plan', task: '--model' })
})

test('--effort só aceita forma separada, uma vez, com valor válido', () => {
  assert.throws(() => parseGrapheng(['plan', 'x', '--effort=max']), /--effort max/)
  assert.throws(() => parseGrapheng(['plan', 'x', '--effort']), /--effort aceita somente/)
  assert.throws(() => parseGrapheng(['init', '--effort', 'max']), /init não recebe/)
  assert.throws(() => parseGrapheng(['clarify', '--effort', 'low', '--effort', 'max']), /--effort repetido/)
})

test('envelope aceita só host, argv e clarification, e clarification só vale com clarify', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grapheng-envelope-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const read = async value => {
    const file = path.join(dir, `invocation-${Math.random().toString(16).slice(2)}.json`)
    await writeFile(file, JSON.stringify(value))
    return readGraphengInvocationFile(['--invocation', file])
  }
  for (const extra of [{ plan: true }, { stage: 'plan' }, { resume: true }, { pipeline: { from: 'plan', to: 'plan' } }, { planOnly: true }]) {
    await assert.rejects(read({ host: 'claude', argv: ['plan', 'x'], ...extra }), /chave não permitida/)
  }
  await assert.rejects(read({ host: 'claude', argv: ['plan', 'x'], clarification: VALID_ENVELOPE_CLARIFICATION }), /clarification só vale com clarify/)
  await assert.rejects(read({ host: 'claude', argv: ['clarify'], clarification: { questionSetId: 'nope', answers: [] } }), /questionSetId/)
  const ok = await read({ host: 'claude', argv: ['clarify'], clarification: VALID_ENVELOPE_CLARIFICATION })
  assert.deepEqual(ok.clarification, VALID_ENVELOPE_CLARIFICATION)
})

test('respostas de clarify são validadas por forma e recusadas fora do contrato', () => {
  assert.doesNotThrow(() => validateClarificationAnswers({ questionSetId: SET_ID, answers: [{ questionId: 'Q1', answer: 'pg' }] }))
  assert.doesNotThrow(() => validateClarificationAnswers({ questionSetId: SET_ID, answers: [{ questionId: 'Q1', answer: 'a'.repeat(500) }, { questionId: 'Q2', skipped: true }] }))
  assert.doesNotThrow(() => validateClarificationAnswers({ questionSetId: SET_ID, answers: [{ questionId: 'Q1', answer: 'linha 1\nlinha 2' }] }))
  const cases = [
    [{ questionSetId: 'nope', answers: [{ questionId: 'Q1', answer: 'x' }] }, /questionSetId/],
    [{ questionSetId: SET_ID, answers: [{ questionId: 'Q1', answer: 'x' }], extra: 1 }, /campo não permitido/],
    [{ questionSetId: SET_ID, answers: [] }, /answers precisa ter de 1 a 5 itens/],
    [{ questionSetId: SET_ID, answers: [{ questionId: 'Q6', answer: 'x' }] }, /questionId/],
    [{ questionSetId: SET_ID, answers: [{ questionId: 'Q1', answer: 'x' }, { questionId: 'Q1', answer: 'y' }] }, /duplicado/],
    [{ questionSetId: SET_ID, answers: [{ questionId: 'Q1' }] }, /resposta ou skipped:true/],
    [{ questionSetId: SET_ID, answers: [{ questionId: 'Q1', answer: 'x', skipped: true }] }, /skipped/],
    [{ questionSetId: SET_ID, answers: [{ questionId: 'Q1', answer: 'x', extra: 1 }] }, /campo não permitido/],
    [{ questionSetId: SET_ID, answers: [{ questionId: 'Q1', answer: 'a'.repeat(501) }] }, /500 caracteres/],
    [{ questionSetId: SET_ID, answers: [{ questionId: 'Q1', answer: 'linha\tcom tab' }] }, /caractere de controle/],
    [{ questionSetId: SET_ID, answers: [{ questionId: 'Q1', answer: 'linha\rcr' }] }, /caractere de controle/],
    [{ questionSetId: SET_ID, answers: [{ questionId: 'Q1', answer: '   ' }] }, /resposta vazia/],
  ]
  for (const [value, pattern] of cases) assert.throws(() => validateClarificationAnswers(value), pattern, JSON.stringify(value))
})

test('cada comando gera exatamente um runGraph com o pipeline certo e sem knobs internos', async () => {
  const calls = []
  const common = {
    cwd: '/repo', host: 'claude',
    configImpl: async effort => ({ effort: effort || 'medium', effortSource: 'config' }),
    discoverChecksImpl: async () => ({ checks: [{ id: 'node-test' }], checkContract: { path: 'package.json', sha256: 'a'.repeat(64) }, nodeCheckPolicy: { id: NODE_CHECK_POLICY_ID, mappingHash: NODE_CHECK_MAPPING_HASH, adapter: 'node-test-v1', concurrency: 2 } }),
    runGraphImpl: async call => { calls.push(call); return { status: 'done' } },
  }
  const expectations = [
    [['plan', 'x'], { from: 'plan', to: 'plan' }, 0],
    [['clarify'], { from: 'clarify', to: 'clarify' }, 0],
    [['tasks', '--effort', 'max'], { from: 'tasks', to: 'tasks' }, 0],
    [['implemente', 'x'], { from: 'auto', to: 'implement' }, 1],
    [['implemente'], { from: 'auto', to: 'implement' }, 1],
  ]
  for (const [invocation, pipeline, checks] of expectations) {
    calls.length = 0
    await executeGrapheng({ ...common, invocation })
    assert.equal(calls.length, 1, invocation.join(' '))
    assert.deepEqual(calls[0].args.pipeline, pipeline, invocation.join(' '))
    assert.equal('planOnly' in calls[0].args, false, invocation.join(' '))
    assert.equal(calls[0].args.checks.length, checks, invocation.join(' '))
    assert.equal(calls[0].args.runDir, path.join('.graph-runs', calls[0].args.runId))
  }
  calls.length = 0
  await executeGrapheng({ ...common, invocation: ['implemente'] })
  assert.equal('task' in calls[0].args, false)
})

test('clarify repassa as respostas validadas ao runner e não inventa resposta', async () => {
  const calls = []
  const answers = { questionSetId: SET_ID, answers: [{ questionId: 'Q1', answer: 'pg' }] }
  const common = { host: 'claude', cwd: '/repo', configImpl: async () => ({ effort: 'medium', effortSource: 'default' }), runGraphImpl: async call => { calls.push(call); return { status: 'done' } } }
  await executeGrapheng({ ...common, invocation: ['clarify'], clarification: answers })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args.clarification, answers)
  assert.deepEqual(calls[0].args.pipeline, { from: 'clarify', to: 'clarify' })
  await executeGrapheng({ ...common, invocation: ['clarify'] })
  assert.equal('clarification' in calls[1].args, false)
  await assert.rejects(executeGrapheng({ ...common, invocation: ['clarify'], clarification: { questionSetId: 'x', answers: [] } }), /questionSetId/)
  await assert.rejects(executeGrapheng({ ...common, invocation: ['plan', 'x'], clarification: answers }), /clarification só vale com clarify/)
  assert.equal(calls.length, 2)
})

test('implemente sem tarefa passa ao runner sem task e descobre checks uma vez', async () => {
  const calls = []
  let discovered = 0
  await executeGrapheng({
    invocation: ['implemente'], cwd: '/repo', host: 'claude',
    configImpl: async () => ({ effort: 'medium', effortSource: 'default' }),
    discoverChecksImpl: async () => { discovered++; return { checks: [{ id: 'node-test' }], checkContract: { path: 'package.json', sha256: 'a'.repeat(64) } } },
    runGraphImpl: async call => { calls.push(call); return { status: 'done' } },
  })
  assert.equal(discovered, 1)
  assert.equal(calls.length, 1)
  assert.equal('task' in calls[0].args, false)
  assert.deepEqual(calls[0].args.pipeline, { from: 'auto', to: 'implement' })
})
