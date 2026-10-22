import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runGraph } from '../bin/graph-run.mjs'
// D-E1: o dataDir padrão vem de GRAPH_ENG_STATE_DIR; os testes usam um diretório por processo para não tocar o estado real do usuário.
process.env.GRAPH_ENG_STATE_DIR ??= path.join(os.tmpdir(), `graph-eng-test-datadir-${process.pid}`)

function fakeHostFactory() {
  return () => { throw new Error('host não deve iniciar') }
}

function stableEvidenceFactory() {
  return { snapshot: async () => ({ identity: 'stable-snapshot', files: [] }), fingerprint: async () => ({ identity: 'semantic-fingerprint' }), runChecks: async () => [], verifyArtifact: async () => true }
}

async function tempRepo(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'graph-run-pipeline-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  return cwd
}

const base = { runId: 'pipe-run', runDir: '.graph-runs/pipe-run', task: 'tarefa' }

test('pipeline fora dos pares permitidos bloqueia antes de iniciar host', async t => {
  const cwd = await tempRepo(t)
  const result = await runGraph({ hostName: 'claude', cwd, stateDir: path.join(cwd, 'state'), args: { ...base, pipeline: { from: 'plan', to: 'implement' } }, hostFactory: fakeHostFactory() })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'pipeline_invalid')
})

test('pipeline com plan ou planOnly do chamador bloqueia antes de iniciar host', async t => {
  const cwd = await tempRepo(t)
  const withPlanOnly = await runGraph({ hostName: 'claude', cwd, stateDir: path.join(cwd, 'state'), args: { ...base, pipeline: { from: 'auto', to: 'implement' }, planOnly: true }, hostFactory: fakeHostFactory() })
  assert.equal(withPlanOnly.feedback.reason, 'pipeline_caller_plan_forbidden')
  const withPlan = await runGraph({ hostName: 'claude', cwd, stateDir: path.join(cwd, 'state'), args: { ...base, pipeline: { from: 'auto', to: 'implement' }, plan: { goal: 'g' } }, hostFactory: fakeHostFactory() })
  assert.equal(withPlan.feedback.reason, 'pipeline_caller_plan_forbidden')
})

test('chave interna de estágio vinda do chamador bloqueia antes de iniciar host', async t => {
  const cwd = await tempRepo(t)
  for (const key of ['stage', 'pipelineTo', 'importedPlan', 'importedTasks', 'clarificationContext', 'stageCarry', 'planReviewDeferred']) {
    const result = await runGraph({ hostName: 'claude', cwd, stateDir: path.join(cwd, 'state'), args: { ...base, pipeline: { from: 'auto', to: 'implement' }, [key]: {} }, hostFactory: fakeHostFactory() })
    assert.equal(result.feedback.reason, 'internal_arg_forbidden', key)
  }
})

test('pipeline exige runDir igual a .graph-runs/<runId>', async t => {
  const cwd = await tempRepo(t)
  const result = await runGraph({ hostName: 'claude', cwd, stateDir: path.join(cwd, 'state'), args: { ...base, runDir: 'runs/pipe-run', pipeline: { from: 'auto', to: 'implement' } }, hostFactory: fakeHostFactory() })
  assert.equal(result.feedback.reason, 'pipeline_run_dir_invalid')
})

test('resume com pipeline diferente do original bloqueia com resume_guard_changed:pipeline', async t => {
  const cwd = await tempRepo(t)
  const runDir = path.join(cwd, '.graph-runs', 'pipe-run')
  await mkdir(runDir, { recursive: true })
  const originalArgs = { task: 'tarefa', mode: 'implement', planOnly: false, effort: 'medium', planProvided: false }
  await writeFile(path.join(runDir, 'run.meta.json'), JSON.stringify({ schemaVersion: 2, runId: 'pipe-run', host: 'claude', originalArgs, originalGuards: { schemaVersion: 2, runId: 'pipe-run' } }))
  const result = await runGraph({ hostName: 'claude', cwd, stateDir: path.join(cwd, 'state'), args: { runId: 'pipe-run', runDir: '.graph-runs/pipe-run', resume: { requestedRerunIds: [] }, pipeline: { from: 'auto', to: 'implement' } }, hostFactory: fakeHostFactory() })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'resume_guard_changed:pipeline')
})

test('run legada sem pipeline grava guards e args sem a chave pipeline', async t => {
  const cwd = await tempRepo(t)
  const result = await runGraph({
    hostName: 'codex', cwd, stateDir: path.join(cwd, 'state'), evidenceFactory: stableEvidenceFactory,
    args: { task: 'legado', mode: 'research', effort: 'low', planOnly: true, runId: 'legacy-run', runDir: 'runs/legacy-run', plan: { goal: 'g', complexity: 'moderate', mode: 'research', doneWhen: ['ok'], nodes: [], effort: { level: 'low', why: 'teste' } } },
    hostFactory: () => ({ capabilities: () => ({ host: 'codex', readOnlyEnforced: true }), spawn: async request => ({ request }), wait: async handle => ({ output: handle.request.label?.startsWith('plan-review:') ? { feedback: { kind: 'APPROVE', reason: 'ok', severity: 'none', affectedNodes: [], evidenceIds: [] } } : {}, requestedModel: handle.request.model, effectiveModel: handle.request.model }) }),
  })
  assert.equal(result.planOnly, true)
  const meta = JSON.parse(await readFile(path.join(cwd, 'runs/legacy-run', 'run.meta.json'), 'utf8'))
  assert.equal(Object.hasOwn(meta.originalArgs, 'pipeline'), false)
  assert.equal(Object.hasOwn(meta.originalGuards, 'pipeline'), false)
})

test('R9a validateResumeJournal é exportado e devolve orçamento inicial zerado para journal sem eventos', async () => {
  const { validateResumeJournal } = await import('../bin/graph-run.mjs')
  const result = validateResumeJournal({ events: [], runId: 'r', originalGuards: { acceptedCriteria: null }, originalArgs: { planProvided: false, effort: 'medium' } })
  assert.equal(result.historicCounters.localRepairsUsed, 0)
  assert.equal(result.historicLedger.reservedByRole.planner, 1)
  assert.equal(result.historicLedger.limitsByRole.planner, 5)
  assert.equal(result.activeAllocation, null)
})

// Fluxo adaptativo: o tier é decidido pela triagem do runner; o chamador só liga ou desliga o adaptive.
test('tier vindo do chamador bloqueia com internal_arg_forbidden, com ou sem pipeline', async t => {
  const cwd = await tempRepo(t)
  for (const args of [{ ...base, pipeline: { from: 'auto', to: 'implement' }, tier: 'fast' }, { ...base, tier: 'fast' }]) {
    const result = await runGraph({ hostName: 'claude', cwd, stateDir: path.join(cwd, 'state'), args, hostFactory: fakeHostFactory() })
    assert.equal(result.feedback.reason, 'internal_arg_forbidden')
  }
})

test('adaptive fora de on/off bloqueia com invalid_adaptive', async t => {
  const cwd = await tempRepo(t)
  const result = await runGraph({ hostName: 'claude', cwd, stateDir: path.join(cwd, 'state'), args: { ...base, pipeline: { from: 'auto', to: 'implement' }, adaptive: 'sim' }, hostFactory: fakeHostFactory() })
  assert.equal(result.feedback.reason, 'invalid_adaptive')
})

test('resume que liga ou desliga o adaptive (arg ou ambiente) bloqueia com resume_adaptive_changed, nos dois sentidos', async t => {
  const cwd = await tempRepo(t)
  const runDir = path.join(cwd, '.graph-runs', 'pipe-run')
  await mkdir(runDir, { recursive: true })
  const pipeline = { from: 'auto', to: 'implement' }
  const writeMeta = adaptive => writeFile(path.join(runDir, 'run.meta.json'), JSON.stringify({ schemaVersion: 2, runId: 'pipe-run', host: 'claude', originalArgs: { task: 'tarefa', mode: 'implement', planOnly: false, effort: 'medium', planProvided: false, pipeline, ...(adaptive ? { adaptive } : {}) }, originalGuards: { schemaVersion: 2, runId: 'pipe-run' } }))
  const resume = (extra = {}, env = {}) => runGraph({ hostName: 'claude', cwd, stateDir: path.join(cwd, 'state'), env, args: { runId: 'pipe-run', runDir: '.graph-runs/pipe-run', resume: { requestedRerunIds: [] }, ...extra }, hostFactory: fakeHostFactory() })
  await writeMeta('on')
  assert.equal((await resume({ adaptive: 'off' })).feedback.reason, 'resume_adaptive_changed')
  assert.equal((await resume({}, { GRAPH_ENG_ADAPTIVE: 'off' })).feedback.reason, 'resume_adaptive_changed')
  await writeMeta('off')
  assert.equal((await resume({ adaptive: 'on' })).feedback.reason, 'resume_adaptive_changed')
  // Run anterior ao adaptativo (sem a chave) conta como off.
  await writeMeta(undefined)
  assert.equal((await resume({}, { GRAPH_ENG_ADAPTIVE: 'on' })).feedback.reason, 'resume_adaptive_changed')
})
