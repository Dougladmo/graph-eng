// I1: motor retomável (spec docs/specs/2026-09-28-acoes-no-painel.md, C7 "Args do motor").
// Plano fixo dos casos A-F da spec: R1 -> D1 -> I1, I2, I4; I3 <- I1. I1/I3 em src/a.js, I2 em
// src/b.js, I4 em src/c.js. effort 'high', ceiling 24 (target 17, conferido em cada caso).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, defaultScript } from './helpers/run-workflow.mjs'

const RUN_DIR = '.graph-runs/test'
const BASE = { task: 'tarefa de teste', runDir: RUN_DIR, mode: 'implement', effort: 'high', ceiling: 24, checks: [] }

const plan = {
  goal: 'g',
  complexity: 'moderate',
  mode: 'implement',
  doneWhen: ['ok'],
  effort: { level: 'high', why: 'fixed by user' },
  nodes: [
    { id: 'R1', kind: 'research', title: 'pesquisa', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'design', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'impl 1', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['src/a.js'] },
    { id: 'I2', kind: 'implement', title: 'impl 2', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['src/b.js'] },
    { id: 'I4', kind: 'implement', title: 'impl 4', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['src/c.js'] },
    { id: 'I3', kind: 'implement', title: 'impl 3', brief: 'b', deps: ['I1'], risk: 'low', acceptance: ['a'], files: ['src/a.js'] },
  ],
}

function doneEntry(id, extra) {
  return Object.assign({ summary: 's:' + id, artifact: `${RUN_DIR}/${id}.md`, verified: true, attempts: 1 }, extra)
}

const ALL_DONE = {
  R1: doneEntry('R1'),
  D1: doneEntry('D1'),
  I1: doneEntry('I1', { filesChanged: ['src/a.js'] }),
  I2: doneEntry('I2', { filesChanged: ['src/b.js'] }),
  I4: doneEntry('I4', { filesChanged: ['src/c.js'] }),
  I3: doneEntry('I3', { filesChanged: ['src/a.js'] }),
}

function without(obj, ...keys) {
  const out = Object.assign({}, obj)
  for (const k of keys) delete out[k]
  return out
}

function callsOnly(calls) {
  return calls.filter((c) => !c.startsWith('#'))
}

test('caso A: 5 prontos + 1 refazer gera agentes só para esse 1, mais verify/critic/synth', async () => {
  const args = {
    ...BASE,
    plan,
    resume: {
      id: 'rs-20260928-153012',
      from: ['wf_x'],
      done: without(ALL_DONE, 'I2'),
      rerun: ['I2'],
      dependents: false,
      designReview: { pass: true, attempts: 1 },
    },
  }
  const { result, calls } = await runWorkflow(args, defaultScript())
  assert.deepEqual(callsOnly(calls), ['work:I2', 'verify:I2', 'critic:r1', 'polish:1', 'synth'])
  assert.equal(result.effort.target, 17)
  assert.equal(result.stats.agents, 5)
  assert.deepEqual(result.stats.dropped, [])
  assert.equal(result.resume.id, 'rs-20260928-153012')
  assert.deepEqual(result.resume.ready.sort(), ['D1', 'I1', 'I3', 'I4', 'R1'])
  assert.deepEqual(result.resume.rerun, ['I2'])
  assert.equal(result.resume.designReviewSkipped, true)
  const i1 = result.nodes.find((n) => n.id === 'I1')
  assert.equal(i1.resumed, true)
  const i2 = result.nodes.find((n) => n.id === 'I2')
  assert.equal(i2.resumed, false)
})

test("caso A': done com os 6 nós e rerun=[I2] dá o mesmo resultado (I2 não conta como pronto)", async () => {
  const args = {
    ...BASE,
    plan,
    resume: { id: 'rs-20260928-153012', done: ALL_DONE, rerun: ['I2'], dependents: false, designReview: { pass: true, attempts: 1 } },
  }
  const { calls } = await runWorkflow(args, defaultScript())
  assert.deepEqual(callsOnly(calls), ['work:I2', 'verify:I2', 'critic:r1', 'polish:1', 'synth'])
})

test('caso B: refazer I1 com dependentes leva I3 junto (fecho pelas deps normalizadas)', async () => {
  const args = {
    ...BASE,
    plan,
    resume: { id: 'rs-20260928-153013', done: ALL_DONE, rerun: ['I1'], dependents: true, designReview: { pass: true, attempts: 1 } },
  }
  const { result, calls } = await runWorkflow(args, defaultScript())
  assert.deepEqual(callsOnly(calls).sort(), ['critic:r1', 'polish:1', 'synth', 'verify:I1', 'verify:I3', 'work:I1', 'work:I3'].sort())
  assert.deepEqual(result.resume.rerun.sort(), ['I1', 'I3'])
  assert.equal(result.resume.designReviewSkipped, true)
})

test('caso C: refazer o design D1 roda a revisão do design de novo', async () => {
  const args = {
    ...BASE,
    plan,
    resume: { id: 'rs-20260928-153014', done: ALL_DONE, rerun: ['D1'], dependents: false, designReview: { pass: true, attempts: 1 } },
  }
  const { calls } = await runWorkflow(args, defaultScript())
  assert.deepEqual(callsOnly(calls), ['work:D1', 'verify:D1', 'design-review:r1', 'critic:r1', 'synth'])
})

test('caso D: sem rerun, só os nós que faltam em done rodam (I3 e I4)', async () => {
  const args = {
    ...BASE,
    plan,
    resume: { id: 'rs-20260928-153015', done: without(ALL_DONE, 'I3', 'I4'), rerun: [], dependents: false, designReview: { pass: true, attempts: 1 } },
  }
  const { calls } = await runWorkflow(args, defaultScript())
  const got = callsOnly(calls)
  assert.ok(got.includes('work:I3') && got.includes('verify:I3'))
  assert.ok(got.includes('work:I4') && got.includes('verify:I4'))
  assert.ok(!got.some((c) => c.startsWith('design-review')))
  assert.equal(got.filter((c) => c.startsWith('polish:')).length, 2)
  assert.equal(got.length, 8)
})

test('caso E: sem designReview no resume, a revisão do design roda mesmo com tudo pronto', async () => {
  const args = {
    ...BASE,
    plan,
    resume: { id: 'rs-20260928-153016', done: without(ALL_DONE, 'I2'), rerun: ['I2'], dependents: false },
  }
  const { calls } = await runWorkflow(args, defaultScript())
  assert.deepEqual(callsOnly(calls), ['design-review:r1', 'work:I2', 'verify:I2', 'critic:r1', 'polish:1', 'synth'])
})

test('caso F: resume sem args.plan devolve erro sem gastar agente', async () => {
  const { result, calls } = await runWorkflow({ ...BASE, resume: { id: 'rs-20260928-153017', done: {}, rerun: [] } }, defaultScript())
  assert.ok(result.error)
  assert.equal(callsOnly(calls).length, 0)
})

test('caso F: resume com planOnly devolve erro', async () => {
  const { result, calls } = await runWorkflow({ ...BASE, plan, planOnly: true, resume: { id: 'rs-20260928-153018', done: {}, rerun: [] } }, defaultScript())
  assert.ok(result.error)
  assert.equal(callsOnly(calls).length, 0)
})

test('caso F: resume.id fora da regex devolve erro', async () => {
  const { result, calls } = await runWorkflow({ ...BASE, plan, resume: { id: 'not-an-id', done: {}, rerun: [] } }, defaultScript())
  assert.ok(result.error)
  assert.equal(callsOnly(calls).length, 0)
})

test('caso F: resume.rerun com nó desconhecido devolve erro', async () => {
  const { result, calls } = await runWorkflow({ ...BASE, plan, resume: { id: 'rs-20260928-153019', done: {}, rerun: ['NOPE'] } }, defaultScript())
  assert.ok(result.error)
  assert.equal(callsOnly(calls).length, 0)
})

test('retomada sem nada a refazer não roda work agent de nó pronto', async () => {
  const args = {
    ...BASE,
    plan,
    resume: { id: 'rs-20260928-153020', done: ALL_DONE, rerun: [], dependents: false, designReview: { pass: true, attempts: 1 } },
  }
  const { calls } = await runWorkflow(args, defaultScript())
  const got = callsOnly(calls)
  assert.ok(!got.some((c) => c.startsWith('work:') || c.startsWith('verify:')))
  assert.deepEqual(got, ['critic:r1', 'synth'])
})

test('done com id desconhecido ao plano é ignorado com log, e o nó continua fora de RESULTS prévio', async () => {
  const args = {
    ...BASE,
    plan,
    resume: { id: 'rs-20260928-153021', done: Object.assign({}, without(ALL_DONE, 'I2'), { GHOST: doneEntry('GHOST') }), rerun: ['I2'], dependents: false, designReview: { pass: true, attempts: 1 } },
  }
  const { logs, calls } = await runWorkflow(args, defaultScript())
  assert.ok(logs.some((l) => l.includes('GHOST') && l.includes('desconhecido')))
  assert.deepEqual(callsOnly(calls), ['work:I2', 'verify:I2', 'critic:r1', 'polish:1', 'synth'])
})

test('done com artifact fora do run dir é ignorado, e o nó roda', async () => {
  const args = {
    ...BASE,
    plan,
    resume: {
      id: 'rs-20260928-153022',
      done: Object.assign({}, without(ALL_DONE, 'I2'), { I4: doneEntry('I4', { artifact: '/etc/passwd' }) }),
      rerun: ['I2'],
      dependents: false,
      designReview: { pass: true, attempts: 1 },
    },
  }
  const { logs, calls } = await runWorkflow(args, defaultScript())
  assert.ok(logs.some((l) => l.includes('I4') && l.includes('fora do run dir')))
  const got = callsOnly(calls)
  assert.ok(got.includes('work:I4') && got.includes('verify:I4'))
})
