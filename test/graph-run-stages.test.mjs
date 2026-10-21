import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { defaultScript, runGraphScripted, withScriptedCriticEvidence } from './helpers/run-workflow.mjs'
import { runGraph } from '../bin/graph-run.mjs'
import { canonicalJsonOf, contentHashOf, planningInputsOf, planningKeyOf, questionSetIdOf, readSlot, sealArtifact, STAGE_BY_STATUS, verifySource, workspaceIdentityOf, writeSlot } from '../bin/phase-artifacts.mjs'
import { createResourceLock, workspaceResourceOf } from '../bin/resource-lock.mjs'
import { createRunState, readJournalFile } from '../bin/run-state.mjs'
import { ENGINE_PATH } from '../bin/workflow-source.mjs'
// D-E1: o dataDir padrão vem de GRAPH_ENG_STATE_DIR; os testes usam um diretório por processo para não tocar o estado real do usuário.
process.env.GRAPH_ENG_STATE_DIR ??= path.join(os.tmpdir(), `graph-eng-test-datadir-${process.pid}`)

// Espelha MODELS.claude de bin/graph-run.mjs: a chave de planejamento depende desta política.
const MODELS_CLAUDE = { planner: 'opus', planReviewer: 'opus', designReviewer: 'opus', executor: 'haiku', verifier: 'haiku', critic: 'opus', synth: 'haiku' }
const RUN_ID = 'grapheng-test-run'
const SRC_RUN = 'grapheng-src'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const WS = workspaceIdentityOf({ head: 'h1', files: [] })
const Q1 = [{ id: 'Q1', text: 'Qual banco?', options: ['pg', 'sqlite'] }]

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'graph-run-stages-')))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const snap = { current: { head: 'h1', files: [] } }
  const evidenceFactory = () => ({ snapshot: async () => ({ ...snap.current }), fingerprint: async () => ({ identity: 'fp' }), runChecks: async () => [], verifyArtifact: async () => true })
  return { cwd, snap, evidenceFactory, stateDir: path.join(cwd, 'state') }
}

const hostStub = () => ({ capabilities: () => ({ host: 'claude', readOnlyEnforced: true }), spawn: async () => { throw new Error('spawn não esperado nos testes de estágio') }, wait: async () => ({}) })

function inputsFor(repo, task = 'tarefa', context = '') {
  return readFile(ENGINE_PATH).then(bytes => planningInputsOf({ repo, task, context, spec: null, acceptedCriteria: null, host: 'claude', modelPolicyHash: sha(canonicalJsonOf(MODELS_CLAUDE)), workflowSourceHash: sha(bytes) }))
}

// Grava a run de origem (meta v2 + journal com as transições) e os slots, para o reuso encontrar.
async function seedSlots(fx, { plan = 'approved', tasks = false, task = 'tarefa' } = {}) {
  const inputs = await inputsFor(fx.cwd, task)
  const runDir = `.graph-runs/${SRC_RUN}`
  const events = []
  let planSealed = null
  if (plan) {
    const status = plan
    const content = { goal: 'meta', doneWhen: ['pronto'], assumptions: [], risks: [], researchNodes: [], research: [], openQuestions: [], questionSetId: null, clarifications: [] }
    if (status === 'needs_clarification') { content.openQuestions = Q1; content.questionSetId = questionSetIdOf(Q1) }
    const body = { schemaVersion: 1, kind: 'graph-eng.plan', status, planningKey: planningKeyOf(inputs), planningInputs: inputs, workspace: { head: 'h1', identity: WS }, content, critic: { kind: 'APPROVE', evidenceIds: [] }, reason: null }
    events.push({ stage: STAGE_BY_STATUS.plan[status], contentHash: contentHashOf(body) })
    planSealed = sealArtifact({ ...body, source: { runId: SRC_RUN, runDir, seq: events.length } })
  }
  let tasksSealed = null
  if (tasks) {
    const body = { schemaVersion: 1, kind: 'graph-eng.tasks', status: 'approved', planningKey: planningKeyOf(inputs), planningInputs: inputs, workspace: { head: 'h1', identity: WS }, content: { nodes: [{ id: 'T1', kind: 'implement', deps: [] }] }, planContentHash: planSealed.contentHash, reason: null }
    events.push({ stage: 'tasks-approved', contentHash: contentHashOf(body) })
    tasksSealed = sealArtifact({ ...body, source: { runId: SRC_RUN, runDir, seq: events.length } })
  }
  await mkdir(path.join(fx.cwd, runDir), { recursive: true })
  await writeFile(path.join(fx.cwd, runDir, 'run.meta.json'), JSON.stringify({ schemaVersion: 2, runId: SRC_RUN, host: 'claude', cwd: fx.cwd }))
  await writeFile(path.join(fx.cwd, runDir, 'journal.jsonl'), events.map((item, index) => JSON.stringify({ schemaVersion: 2, runId: SRC_RUN, seq: index + 1, type: 'control.transition', phase: 'Plan', payload: { stage: item.stage, contentHash: item.contentHash }, at: '2026-10-19T00:00:00.000Z' })).join('\n') + '\n')
  if (planSealed) await writeSlot({ repo: fx.cwd, kind: 'plan', artifact: planSealed, expectedPrevContentHash: null })
  if (tasksSealed) await writeSlot({ repo: fx.cwd, kind: 'tasks', artifact: tasksSealed, expectedPrevContentHash: null })
  return { plan: planSealed, tasks: tasksSealed }
}

async function run(fx, { args, script = async () => ({ status: 'blocked', feedback: { kind: 'BLOCK', reason: 'stub', severity: 'critical', affectedNodes: [], evidenceIds: [] } }), stateFactory } = {}) {
  const calls = []
  const workflowCompiler = async () => async (stageArgs, _agent, _a, _b, _c, _budget, runtime) => {
    calls.push({ args: stageArgs, runtime })
    return script(stageArgs, runtime)
  }
  const result = await runGraph({ hostName: 'claude', cwd: fx.cwd, stateDir: fx.stateDir, args: { runId: RUN_ID, runDir: `.graph-runs/${RUN_ID}`, task: 'tarefa', ...args }, hostFactory: hostStub, evidenceFactory: fx.evidenceFactory, workflowCompiler, stateFactory })
  return { result, calls }
}

async function journalOf(fx, runId = RUN_ID) {
  return (await readJournalFile(path.join(fx.cwd, '.graph-runs', runId))).events
}

const approvedContent = goal => ({ goal, doneWhen: ['pronto'], assumptions: [], risks: [], researchNodes: [], research: [], openQuestions: [], clarifications: [] })

async function approvePlan(runtime, goal = 'meta') {
  const prepared = await runtime.preparePhaseArtifact({ kind: 'plan', status: 'approved', content: approvedContent(goal), critic: { kind: 'APPROVE', evidenceIds: [] } })
  await runtime.emit({ type: 'control.transition', phase: 'Plan', payload: { stage: 'plan-artifact-approved', contentHash: prepared.contentHash } })
  return prepared
}

// Checkpoint do estágio plan: a invocação seguinte herda o carry dele (o motor real sempre grava um).
async function checkpointPlan(runtime) {
  await runtime.emit({ type: 'control.transition', phase: 'Plan', payload: { stage: 'plan-approved', checkpoint: checkpoint() } })
}

// review: voto APPROVE da revisão forte gravado no journal antes da transição (regra: vem do journal, nunca de artifact.critic).
async function approveTasks(runtime, planContentHash, { review = true } = {}) {
  const prepared = await runtime.preparePhaseArtifact({ kind: 'tasks', status: 'approved', content: { nodes: [{ id: 'T1', kind: 'implement', deps: [] }] }, planContentHash })
  if (review) await runtime.emit({ type: 'result', phase: 'Plan', payload: { role: 'planReviewer', label: 'plan-review:tasks' }, result: { feedback: { kind: 'APPROVE', reason: 'ok', severity: 'none', affectedNodes: [], evidenceIds: [] } } })
  await runtime.emit({ type: 'control.transition', phase: 'Plan', payload: { stage: 'tasks-approved', contentHash: prepared.contentHash } })
  return prepared
}

function checkpoint({ planner = 1, localRepairsUsed = 0 } = {}) {
  const roles = ['planner', 'planReviewer', 'designReviewer', 'critic', 'synth', 'executor', 'verifier']
  const zero = Object.fromEntries(roles.map(role => [role, 0]))
  const limits = { planner: 5, planReviewer: 5, designReviewer: 5, critic: 5, synth: 3, executor: 0, verifier: 0 }
  return { schemaVersion: 2, planVersion: 1, plan: { goal: 'g', complexity: 'moderate', doneWhen: ['pronto'], effort: { level: 'medium', why: 'teste' }, nodes: [] }, ledger: { usedByRole: { ...zero, planner }, reservedByRole: zero, limitsByRole: limits, tokenUsageByRole: Object.fromEntries(roles.map(role => [role, null])), localRepairsUsed, structuralReplansUsed: 0 }, control: { stage: 'plan-approved', counters: { localRepairsUsed, structuralReplansUsed: 0 }, history: [], seenPairs: [] } }
}

// ---------- R3: decisão de reuso sob lease ----------

test('R3 reuso escolhe implement quando tasks aprovado é compatível (uma invocação, sem planner)', async t => {
  const fx = await fixture(t)
  await seedSlots(fx, { plan: 'approved', tasks: true })
  const { result, calls } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async () => ({ status: 'done' }) })
  assert.equal(result.status, 'done', JSON.stringify(result))
  assert.deepEqual(calls.map(call => call.args.stage), ['implement'])
  const reuse = (await journalOf(fx)).find(event => event.type === 'phase.reuse.resolved')
  assert.deepEqual(reuse.payload.decided, { stages: ['implement'], pipelineTo: null })
  assert.deepEqual(reuse.payload.rejected, [])
})

test('R3 workspace alterado rejeita reuso com workspace_changed e decide plan+tasks, nos dois motivos na ordem', async t => {
  const fx = await fixture(t)
  await seedSlots(fx, { plan: 'approved', tasks: true })
  fx.snap.current = { head: 'h2', files: [] }
  const { calls } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } } })
  assert.deepEqual(calls.map(call => call.args.stage), ['plan'])
  const reuse = (await journalOf(fx)).find(event => event.type === 'phase.reuse.resolved')
  assert.deepEqual(reuse.payload.decided, { stages: ['plan', 'tasks'], pipelineTo: 'implement' })
  assert.deepEqual(reuse.payload.rejected.map(item => [item.kind, item.reason]), [['plan', 'workspace_changed'], ['tasks', 'workspace_changed']])
})

test('R3 needs_clarification em implemente bloqueia com perguntas e não invoca o workflow', async t => {
  const fx = await fixture(t)
  await seedSlots(fx, { plan: 'needs_clarification' })
  const { result, calls } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } } })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'needs_clarification')
  assert.equal(result.next, 'clarify')
  assert.deepEqual(result.clarification, { questionSetId: questionSetIdOf(Q1), questions: Q1 })
  assert.equal(calls.length, 0)
})

test('R3 tasks sem plano aprovado bloqueia com plan_missing_or_incompatible:absent sem spawn', async t => {
  const fx = await fixture(t)
  const { result, calls } = await run(fx, { args: { pipeline: { from: 'tasks', to: 'tasks' } } })
  assert.equal(result.feedback.reason, 'plan_missing_or_incompatible:absent')
  assert.equal(calls.length, 0)
})

test('R3 clarify com questionSetId velho bloqueia com clarification_stale', async t => {
  const fx = await fixture(t)
  await seedSlots(fx, { plan: 'needs_clarification' })
  const { result, calls } = await run(fx, { args: { pipeline: { from: 'clarify', to: 'clarify' }, clarification: { questionSetId: 'a'.repeat(64), answers: [{ questionId: 'Q1', answer: 'pg' }] } } })
  assert.equal(result.feedback.reason, 'clarification_stale')
  assert.equal(calls.length, 0)
})

// ---------- R4: rascunho de fase ----------

test('R4 preparePhaseArtifact recusa workspace alterado durante o estágio', async t => {
  const fx = await fixture(t)
  const { result } = await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' } }, script: async (stageArgs, runtime) => {
    fx.snap.current = { head: 'h2', files: [] }
    await runtime.preparePhaseArtifact({ kind: 'plan', status: 'approved', content: approvedContent('x'), critic: { kind: 'APPROVE', evidenceIds: [] } })
    return { status: 'plan_approved' }
  } })
  assert.equal(result.feedback.reason, 'workspace_changed_during_stage')
})

test('R4 rascunho persistido tem contentHashOf igual ao hash devolvido', async t => {
  const fx = await fixture(t)
  let prepared
  await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' } }, script: async (stageArgs, runtime) => {
    prepared = await approvePlan(runtime, 'rascunho')
    return { status: 'plan_approved' }
  } })
  const file = path.join(fx.cwd, '.graph-runs', RUN_ID, 'phase-drafts', `plan-${prepared.contentHash}.json`)
  const persisted = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(persisted.contentHash, prepared.contentHash)
  assert.equal(contentHashOf(persisted), prepared.contentHash)
})

// ---------- R5: laço de estágios e carry ----------

test('R5 one-shot invoca plan e depois tasks, e o carry da segunda vem do checkpoint da primeira', async t => {
  const fx = await fixture(t)
  const { result, calls } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') {
      await runtime.emit({ type: 'control.transition', phase: 'Plan', payload: { stage: 'plan-approved', checkpoint: checkpoint({ planner: 1, localRepairsUsed: 1 }) } })
      await approvePlan(runtime)
      return { status: 'plan_approved' }
    }
    await approveTasks(runtime, (await readSlot({ repo: fx.cwd, kind: 'plan' })).hash)
    return { status: 'blocked', feedback: { kind: 'BLOCK', reason: 'fim_do_teste', severity: 'critical', affectedNodes: [], evidenceIds: [] } }
  } })
  assert.deepEqual(calls.map(call => call.args.stage), ['plan', 'tasks'])
  assert.equal(calls[0].runtime.stageCarry, null)
  assert.equal(calls[1].runtime.stageCarry.counters.localRepairsUsed, 1)
  assert.equal(calls[1].runtime.stageCarry.usedByRole.planner, 1)
  assert.equal(calls[1].args.importedPlan.goal, 'meta')
  assert.equal(result.reuse.decided.pipelineTo, 'implement')
})

test('R5 fronteira 2 registra carry igual ao último checkpoint mais budget.call posteriores', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') {
      await runtime.emit({ type: 'control.transition', phase: 'Plan', payload: { stage: 'plan-approved', checkpoint: checkpoint({ planner: 1 }) } })
      await runtime.emit({ type: 'budget.call', phase: 'Plan', payload: { role: 'planner', label: 'plan', ledger: { ...checkpoint({ planner: 2 }).ledger, localRepairsUsed: 0, structuralReplansUsed: 0 } } })
      await approvePlan(runtime)
      return { status: 'plan_approved' }
    }
    await approveTasks(runtime, (await readSlot({ repo: fx.cwd, kind: 'plan' })).hash)
    return { status: 'blocked', feedback: { kind: 'BLOCK', reason: 'fim', severity: 'critical', affectedNodes: [], evidenceIds: [] } }
  } })
  const started = (await journalOf(fx)).filter(event => event.type === 'phase.stage.started')
  assert.deepEqual(started.map(event => event.payload.index), [1, 2])
  assert.equal(started[0].payload.carry, null)
  assert.equal(started[1].payload.carry.usedByRole.planner, 2)
  assert.equal(started[1].payload.carry.planVersion, 1)
})

test('R5 planner esgotado antes da invocação 2 bloqueia com stage_budget_exhausted:planner', async t => {
  const fx = await fixture(t)
  const { result, calls } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    const full = checkpoint({ planner: 5 })
    full.ledger.limitsByRole.planner = 5
    await runtime.emit({ type: 'control.transition', phase: 'Plan', payload: { stage: 'plan-approved', checkpoint: { ...full, ledger: { ...full.ledger, usedByRole: { ...full.ledger.usedByRole, planner: 5 } } } } })
    await approvePlan(runtime)
    return { status: 'plan_approved' }
  } })
  assert.equal(result.feedback.reason, 'stage_budget_exhausted:planner')
  assert.equal(calls.length, 1)
})

// FIX C10–C12 (1): journal adulterado entre a invocação 1 e a 2 não chega à leitura do carry nem à invocação 2.
test('journal adulterado entre a invocação 1 e a 2 bloqueia run_integrity_violation antes da invocação 2', async t => {
  const fx = await fixture(t)
  const journal = path.join(fx.cwd, '.graph-runs', RUN_ID, 'journal.jsonl')
  let tampered = null
  const stateFactory = input => {
    const state = createRunState(input)
    return { ...state, emit: async (lease, event) => {
      const record = await state.emit(lease, event)
      // Logo depois da publicação do plano (fim da invocação 1), antes de readCarryFromJournal da invocação 2.
      if (!tampered && event.type === 'phase.artifact.published' && event.payload?.kind === 'plan') {
        const forged = `${JSON.stringify({ schemaVersion: 2, runId: RUN_ID, seq: record.seq + 1, type: 'control.transition', phase: 'Plan', payload: { stage: 'plan-approved', contentHash: sha('forjado') }, at: '2026-10-19T00:00:00.000Z' })}\n`
        await writeFile(journal, `${await readFile(journal, 'utf8')}${forged}`)
        tampered = await readFile(journal, 'utf8')
      }
      return record
    } }
  }
  const { result, calls } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, stateFactory, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') {
      await runtime.emit(PLAN_CHECKPOINT_STUB())
      await approvePlan(runtime)
      return { status: 'plan_approved' }
    }
    return { status: 'blocked', feedback: { kind: 'BLOCK', reason: 'invocacao_2_nao_deveria_rodar', severity: 'critical', affectedNodes: [], evidenceIds: [] } }
  } })
  assert.ok(tampered, 'a adulteração precisa ter acontecido entre as invocações')
  assert.deepEqual(calls.map(call => call.args.stage), ['plan'], 'a invocação 2 não pode acontecer')
  assert.equal(result.feedback?.reason, 'run_integrity_violation', JSON.stringify(result))
  assert.equal(await readFile(journal, 'utf8'), tampered)
})

// FIX C10–C12 (2): a truncagem do recoverPartial passa pelo guard; retomada com linha parcial não dá falso positivo de integridade.
test('C12 FIX2: resume com recoverPartial trunca a linha parcial sem falso positivo de integridade', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') {
      await runtime.emit({ type: 'control.transition', phase: 'Plan', planVersion: 1, payload: { stage: 'plan-approved', checkpoint: checkpointR10d(await originalGuardsOf(fx)) } })
      await approvePlan(runtime)
      return { status: 'plan_approved' }
    }
    throw new Error('queda simulada antes de qualquer gasto do tasks')
  } })
  const journal = path.join(fx.cwd, '.graph-runs', RUN_ID, 'journal.jsonl')
  const partialLine = `{"schemaVersion":2,"runId":"${RUN_ID}","seq":`
  await writeFile(journal, `${await readFile(journal, 'utf8')}${partialLine}`)
  const { result, calls } = await run(fx, { args: { resume: { requestedRerunIds: [], recoverPartial: true } }, script: async () => ({ status: 'done' }) })
  assert.notEqual(result.feedback?.reason, 'run_integrity_violation', JSON.stringify(result))
  assert.deepEqual(calls.map(call => call.args.stage), ['tasks'], JSON.stringify(result))
  assert.ok(!(await readFile(journal, 'utf8')).includes(partialLine), 'a linha parcial precisa ter sido truncada')
})

// C13: rascunho de fase e arquivo privado novo passam pelo guard; a checagem tree entre as invocações pega os dois.
test('C13: rascunho de fase adulterado entre invocação 1 e 2 bloqueia antes do carry', async t => {
  const fx = await fixture(t)
  let draft = null
  const { result, calls } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') {
      await runtime.emit(PLAN_CHECKPOINT_STUB())
      const prepared = await approvePlan(runtime)
      draft = path.join(fx.cwd, '.graph-runs', RUN_ID, 'phase-drafts', `plan-${prepared.contentHash}.json`)
      await writeFile(draft, '{"tampered":true}\n')
      return { status: 'plan_approved' }
    }
    return { status: 'blocked', feedback: { kind: 'BLOCK', reason: 'invocacao_2_nao_deveria_rodar', severity: 'critical', affectedNodes: [], evidenceIds: [] } }
  } })
  assert.ok(draft, 'o rascunho precisa existir')
  assert.deepEqual(calls.map(call => call.args.stage), ['plan'], 'a invocação 2 não pode acontecer')
  assert.equal(result.feedback?.reason, 'run_integrity_violation', JSON.stringify(result))
  assert.equal(await readFile(draft, 'utf8'), '{"tampered":true}\n')
})

test('C13: arquivo privado novo não declarado bloqueia no ponto de checagem tree', async t => {
  const fx = await fixture(t)
  const rogue = path.join(fx.cwd, '.graph-runs', RUN_ID, 'phase-drafts', 'rogue.json')
  const { result, calls } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') {
      await runtime.emit(PLAN_CHECKPOINT_STUB())
      await approvePlan(runtime)
      // Dentro de phase-drafts/, fora da listagem da raiz: só a checagem tree enxerga.
      await writeFile(rogue, 'não declarado\n')
      return { status: 'plan_approved' }
    }
    return { status: 'blocked', feedback: { kind: 'BLOCK', reason: 'invocacao_2_nao_deveria_rodar', severity: 'critical', affectedNodes: [], evidenceIds: [] } }
  } })
  assert.deepEqual(calls.map(call => call.args.stage), ['plan'], 'a invocação 2 não pode acontecer')
  assert.equal(result.feedback?.reason, 'run_integrity_violation', JSON.stringify(result))
  assert.ok(result.paths?.includes('phase-drafts/rogue.json'), JSON.stringify(result.paths))
})

// ---------- R6: publicação por estágio e tombstone ----------

test('R6 plan aprovado publica plan.json verificável pela origem', async t => {
  const fx = await fixture(t)
  const { result } = await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' }, task: 'tarefa' }, script: async (stageArgs, runtime) => {
    await approvePlan(runtime, 'publicado')
    return { status: 'plan_approved' }
  } })
  assert.equal(result.status, 'plan_approved')
  const slot = await readSlot({ repo: fx.cwd, kind: 'plan' })
  assert.equal(slot.artifact.status, 'approved')
  assert.equal(slot.artifact.content.goal, 'publicado')
  const ok = await verifySource({ repo: fx.cwd, artifact: slot.artifact, readJournal: readJournalFile, readMeta: async dir => JSON.parse(await readFile(path.join(dir, 'run.meta.json'), 'utf8')) })
  assert.deepEqual(ok, { ok: true })
})

test('R6 slot trocado por outra run durante o estágio dá artifact_slot_changed e mantém o slot alheio', async t => {
  const fx = await fixture(t)
  const alien = await seedSlots(fx, { plan: 'approved' })
  let other
  const { result } = await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' }, task: 'outra' }, script: async (stageArgs, runtime) => {
    const current = await readSlot({ repo: fx.cwd, kind: 'plan' })
    other = sealArtifact({ ...alien.plan, content: { ...alien.plan.content, goal: 'trocado' } })
    await writeSlot({ repo: fx.cwd, kind: 'plan', artifact: other, expectedPrevContentHash: current.hash })
    await approvePlan(runtime, 'nova')
    return { status: 'plan_approved' }
  } })
  assert.equal(result.feedback.reason, 'artifact_slot_changed')
  // o slot continua com o que a outra run gravou; a run atual não sobrescreve
  const slot = await readSlot({ repo: fx.cwd, kind: 'plan' })
  assert.equal(slot.artifact.contentHash, other.contentHash)
  assert.notEqual(slot.artifact.contentHash, alien.plan.contentHash)
})

test('R6 estágio plan reprovado grava tombstone verificável pela origem', async t => {
  const fx = await fixture(t)
  const { result } = await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' }, task: 'tarefa' }, script: async () => ({ status: 'blocked', feedback: { kind: 'BLOCK', reason: 'critic_rejeitou', severity: 'critical', affectedNodes: [], evidenceIds: [] } }) })
  assert.equal(result.status, 'blocked')
  const slot = await readSlot({ repo: fx.cwd, kind: 'plan' })
  assert.equal(slot.artifact.status, 'rejected')
  assert.equal(slot.artifact.reason, 'critic_rejeitou')
  const ok = await verifySource({ repo: fx.cwd, artifact: slot.artifact, readJournal: readJournalFile, readMeta: async dir => JSON.parse(await readFile(path.join(dir, 'run.meta.json'), 'utf8')) })
  assert.deepEqual(ok, { ok: true })
})

test('R6 one-shot com plan aprovado e tasks reprovado publica plan e tombstone de tasks', async t => {
  const fx = await fixture(t)
  const { result } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') { await checkpointPlan(runtime); await approvePlan(runtime); return { status: 'plan_approved' } }
    return { status: 'blocked', feedback: { kind: 'BLOCK', reason: 'tasks_sem_dag', severity: 'critical', affectedNodes: [], evidenceIds: [] } }
  } })
  assert.equal(result.status, 'blocked')
  const plan = await readSlot({ repo: fx.cwd, kind: 'plan' })
  const tasks = await readSlot({ repo: fx.cwd, kind: 'tasks' })
  assert.equal(plan.artifact.status, 'approved')
  assert.equal(tasks.artifact.status, 'rejected')
  assert.equal(tasks.artifact.planContentHash, plan.artifact.contentHash)
  const readMeta = async dir => JSON.parse(await readFile(path.join(dir, 'run.meta.json'), 'utf8'))
  assert.deepEqual(await verifySource({ repo: fx.cwd, artifact: tasks.artifact, readJournal: readJournalFile, readMeta }), { ok: true })
})

test('R6 queda na invocação 2 deixa plan.json já publicado', async t => {
  const fx = await fixture(t)
  const { result } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') { await checkpointPlan(runtime); await approvePlan(runtime); return { status: 'plan_approved' } }
    throw new Error('queda simulada na invocação 2')
  } })
  assert.equal(result.status, 'blocked')
  const plan = await readSlot({ repo: fx.cwd, kind: 'plan' })
  assert.equal(plan.artifact.status, 'approved')
})

// ---------- R7: rótulo clarify usa o papel planner ----------

test('R7 label clarify pede o modelo do planner', async t => {
  const fx = await fixture(t)
  const requests = []
  const host = { capabilities: () => ({ host: 'claude', readOnlyEnforced: true }), spawn: async request => { requests.push(request); return { request } }, wait: async handle => ({ output: { ok: true }, requestedModel: handle.request.model, effectiveModel: handle.request.model }) }
  const workflowCompiler = async () => async (stageArgs, agent) => { await agent('pergunte', { label: 'clarify' }); return { status: 'needs_clarification' } }
  await runGraph({ hostName: 'claude', cwd: fx.cwd, stateDir: fx.stateDir, args: { runId: 'clarify-label', runDir: '.graph-runs/clarify-label', task: 'tarefa', planOnly: true, checks: [] }, hostFactory: () => host, evidenceFactory: fx.evidenceFactory, workflowCompiler })
  const clarifyRequest = requests.find(request => request.label === 'clarify')
  assert.ok(clarifyRequest, 'agente clarify não foi chamado')
  assert.equal(clarifyRequest.role, 'planner')
  assert.equal(clarifyRequest.model, MODELS_CLAUDE.planner)
  const started = (await readJournalFile(path.join(fx.cwd, '.graph-runs', 'clarify-label'))).events.find(event => event.type === 'started' && event.label === 'clarify')
  assert.equal(started.phase, 'Plan')
  assert.equal(started.payload.requestedModel, MODELS_CLAUDE.planner)
})

// ---------- A: correções do critic R0–R9a ----------

test('A1 tasks aprovado no one-shot continua publicado mesmo quando o motor termina em done (sem tombstone)', async t => {
  const fx = await fixture(t)
  const { result } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') { await checkpointPlan(runtime); await approvePlan(runtime); return { status: 'plan_approved' } }
    await approveTasks(runtime, (await readSlot({ repo: fx.cwd, kind: 'plan' })).hash)
    return { status: 'done' }
  } })
  assert.equal(result.status, 'done')
  assert.equal((await readSlot({ repo: fx.cwd, kind: 'tasks' })).artifact.status, 'approved')
})

test('A2 clarify que não gera perguntas (nothing_to_clarify) não grava tombstone no plano aprovado', async t => {
  const fx = await fixture(t)
  const seeded = await seedSlots(fx, { plan: 'approved' })
  const { result, calls } = await run(fx, { args: { pipeline: { from: 'clarify', to: 'clarify' } }, script: async () => ({ status: 'nothing_to_clarify' }) })
  assert.equal(calls.length, 1)
  assert.equal(result.status, 'nothing_to_clarify')
  const slot = await readSlot({ repo: fx.cwd, kind: 'plan' })
  assert.equal(slot.artifact.status, 'approved')
  assert.equal(slot.artifact.contentHash, seeded.plan.contentHash)
})

test('A2 clarify bloqueado não grava tombstone no plano aprovado', async t => {
  const fx = await fixture(t)
  const seeded = await seedSlots(fx, { plan: 'approved' })
  await run(fx, { args: { pipeline: { from: 'clarify', to: 'clarify' } }, script: async () => ({ status: 'blocked', feedback: { kind: 'BLOCK', reason: 'modelo_indisponivel', severity: 'critical', affectedNodes: [], evidenceIds: [] } }) })
  const slot = await readSlot({ repo: fx.cwd, kind: 'plan' })
  assert.equal(slot.artifact.status, 'approved')
  assert.equal(slot.artifact.contentHash, seeded.plan.contentHash)
})

test('A3 clarify com respostas replaneja com o plano atual em importedPlan', async t => {
  const fx = await fixture(t)
  await seedSlots(fx, { plan: 'needs_clarification' })
  const { calls } = await run(fx, { args: { pipeline: { from: 'clarify', to: 'clarify' }, clarification: { questionSetId: questionSetIdOf(Q1), answers: [{ questionId: 'Q1', answer: 'pg' }] } } })
  assert.equal(calls[0].args.stage, 'plan')
  assert.equal(calls[0].args.importedPlan.goal, 'meta')
  assert.equal(calls[0].args.clarificationContext.answers[0].answer, 'pg')
})

test('A4 tasks com planContentHash divergente do plano publicado vira tasks_plan_mismatch', async t => {
  const fx = await fixture(t)
  const { result } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') { await checkpointPlan(runtime); await approvePlan(runtime); return { status: 'plan_approved' } }
    await runtime.preparePhaseArtifact({ kind: 'tasks', status: 'approved', content: { nodes: [{ id: 'T1', kind: 'implement', deps: [] }] }, planContentHash: 'f'.repeat(64) })
    return { status: 'done' }
  } })
  assert.equal(result.feedback.reason, 'tasks_plan_mismatch')
})

// M7: o clarify recebe a aprovação (critic) do plano importado; o artefato de perguntas precisa dela para ser válido.
test('M7 clarify recebe o critic do plano importado (importedPlanCritic), sem o qual o artefato de perguntas não valida', async t => {
  const fx = await fixture(t)
  await seedSlots(fx, { plan: 'approved' })
  const { calls } = await run(fx, { args: { pipeline: { from: 'clarify', to: 'clarify' } } })
  assert.equal(calls[0].args.stage, 'clarify')
  assert.deepEqual(calls[0].args.importedPlanCritic, { kind: 'APPROVE', evidenceIds: [] })
})

// ---------- C: testes faltantes ----------

test('C baseReservedByRole do estágio implement reserva planner 0 (reuso direto)', async t => {
  const fx = await fixture(t)
  await seedSlots(fx, { plan: 'approved', tasks: true })
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async () => ({ status: 'done' }) })
  const started = (await journalOf(fx)).find(event => event.type === 'phase.stage.started')
  assert.equal(started.payload.stage, 'implement')
  assert.equal(started.payload.baseReservedByRole.planner, 0)
})

test('C rascunho com o mesmo hash e bytes diferentes não é sobrescrito: phase_draft_conflict', async t => {
  const fx = await fixture(t)
  const inputs = await inputsFor(fx.cwd)
  const content = { ...approvedContent('conflito'), questionSetId: null }
  const body = { schemaVersion: 1, kind: 'graph-eng.plan', status: 'approved', planningKey: planningKeyOf(inputs), planningInputs: inputs, workspace: { head: 'h1', identity: WS }, content, critic: { kind: 'APPROVE', evidenceIds: [] }, reason: null }
  const dir = path.join(fx.cwd, '.graph-runs', RUN_ID, 'phase-drafts')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `plan-${contentHashOf(body)}.json`)
  await writeFile(file, 'bytes adulterados\n')
  const { result } = await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' } }, script: async (stageArgs, runtime) => {
    await runtime.preparePhaseArtifact({ kind: 'plan', status: 'approved', content: approvedContent('conflito'), critic: { kind: 'APPROVE', evidenceIds: [] } })
    return { status: 'plan_approved' }
  } })
  assert.equal(result.feedback.reason, 'phase_draft_conflict')
  assert.equal(await readFile(file, 'utf8'), 'bytes adulterados\n')
})

test('C estágios só de leitura recebem runtime sem funções de check (implement mantém)', async t => {
  const fx = await fixture(t)
  const pkg = JSON.stringify({ scripts: { test: 'node --test' } })
  await writeFile(path.join(fx.cwd, 'package.json'), pkg)
  const { NODE_CHECK_MAPPING_HASH, NODE_CHECK_POLICY_ID } = await import('../bin/node-check-policy.mjs')
  const checkSpec = { id: 'node-test', command: process.execPath, args: ['--test', '--test-concurrency=2'], cwd: '.', timeoutMs: 1_800_000, heavy: true }
  const seen = []
  const args = { runId: 'checks-run', runDir: '.graph-runs/checks-run', task: 'tarefa', pipeline: { from: 'plan', to: 'plan' }, checks: [checkSpec], checkContract: { path: 'package.json', sha256: sha(Buffer.from(pkg)), source: 'scripts.test=node --test' }, nodeCheckPolicy: { id: NODE_CHECK_POLICY_ID, mappingHash: NODE_CHECK_MAPPING_HASH, adapter: 'node-test-v1', concurrency: 2 } }
  await runGraph({ hostName: 'claude', cwd: fx.cwd, stateDir: fx.stateDir, args, hostFactory: hostStub, evidenceFactory: fx.evidenceFactory, workflowCompiler: async () => async (stageArgs, _a, _b, _c, _d, _e, runtime) => { seen.push([stageArgs.stage, typeof runtime.approveCheckNodes]); return { status: 'plan_approved' } } })
  assert.deepEqual(seen, [['plan', 'undefined']])
})

// R11: one-shot com checks. O estágio plan (só de leitura) não recebe CheckSpec nem checkContract; o tasks->implement recebe os originais.
test('R11 one-shot auto>implement com checks: plan recebe checks vazios sem checkContract, tasks->implement recebe os originais', async t => {
  const fx = await fixture(t)
  const pkg = JSON.stringify({ scripts: { test: 'node --test' } })
  await writeFile(path.join(fx.cwd, 'package.json'), pkg)
  const { NODE_CHECK_MAPPING_HASH, NODE_CHECK_POLICY_ID } = await import('../bin/node-check-policy.mjs')
  const checkSpec = { id: 'node-test', command: process.execPath, args: ['--test', '--test-concurrency=2'], cwd: '.', timeoutMs: 1_800_000, heavy: true }
  const checkContract = { path: 'package.json', sha256: sha(Buffer.from(pkg)), source: 'scripts.test=node --test' }
  const nodeCheckPolicy = { id: NODE_CHECK_POLICY_ID, mappingHash: NODE_CHECK_MAPPING_HASH, adapter: 'node-test-v1', concurrency: 2 }
  const { result, calls } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' }, checks: [checkSpec], checkContract, nodeCheckPolicy }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') { await checkpointPlan(runtime); await approvePlan(runtime); return { status: 'plan_approved' } }
    await approveTasks(runtime, (await readSlot({ repo: fx.cwd, kind: 'plan' })).hash)
    return { status: 'tasks_approved' }
  } })
  assert.deepEqual(calls.map(call => call.args.stage), ['plan', 'tasks'], JSON.stringify(result))
  assert.deepEqual(calls[0].args.checks, [])
  assert.equal(calls[0].args.checkContract, undefined)
  assert.equal(calls[1].args.pipelineTo, 'implement')
  assert.deepEqual(calls[1].args.checks, [checkSpec])
  assert.deepEqual(calls[1].args.checkContract, checkContract)
})

// R11 (motor real): one-shot auto>implement com checks numa run só não bloqueia no plan (plan->tasks->implement, implement com checks reais).
test('R11 one-shot auto>implement com checks reais não bloqueia no plan e chega ao implement', async t => {
  const { result, calls } = await runGraphScripted(t, { args: { runId: 'r11-oneshot', runDir: '.graph-runs/r11-oneshot', effort: 'medium', pipeline: { from: 'auto', to: 'implement' } }, script: e2eScript })
  assert.notEqual(result.feedback?.reason, 'trusted_check_policy_missing', JSON.stringify(result).slice(0, 400))
  assert.notEqual(result.feedback?.reason, 'runtime_check_policy_unavailable', JSON.stringify(result).slice(0, 400))
  assert.ok(calls.includes('plan-review:r1'), JSON.stringify(calls))
  assert.ok(calls.includes('work:I1'), JSON.stringify({ calls, status: result.status, feedback: result.feedback, reuse: result.reuse }))
})

// Item 2b: one-shot auto>implement numa run só (motor real, host roteirizado). A fronteira 2 carrega o último checkpoint do plan,
// os contadores não diminuem, o planVersion do tasks é carry + 1 e o status final é done.
test('one-shot auto>implement numa run só: carry da fronteira 2 igual ao último checkpoint do plan, contadores não diminuem, planVersion = carry + 1, done', async t => {
  const { result, events } = await runGraphScripted(t, { args: { runId: 'r11-carry', runDir: '.graph-runs/r11-carry', effort: 'medium', pipeline: { from: 'auto', to: 'implement' } }, script: e2eScript })
  assert.equal(result.status, 'done', JSON.stringify(result).slice(0, 400))
  const boundary = events.find(event => event.type === 'phase.stage.started' && event.payload?.stage === 'tasks')
  assert.ok(boundary?.payload?.carry, JSON.stringify(events.map(event => event.type)).slice(0, 400))
  const carry = boundary.payload.carry
  const lastPlanCheckpoint = events.filter(event => event.seq < boundary.seq && event.payload?.checkpoint).at(-1).payload.checkpoint
  assert.equal(carry.planVersion, lastPlanCheckpoint.planVersion)
  assert.deepEqual(carry.usedByRole, lastPlanCheckpoint.ledger.usedByRole)
  assert.deepEqual(carry.limitsByRole, lastPlanCheckpoint.ledger.limitsByRole)
  assert.deepEqual(carry.counters, lastPlanCheckpoint.control.counters)
  const stageCheckpoints = events.filter(event => event.seq > boundary.seq && event.payload?.checkpoint).map(event => event.payload.checkpoint)
  assert.ok(stageCheckpoints.length > 0)
  for (const cp of stageCheckpoints) {
    assert.equal(cp.planVersion, carry.planVersion + 1)
    for (const role of Object.keys(carry.usedByRole)) assert.ok(cp.ledger.usedByRole[role] >= carry.usedByRole[role], `${role} diminuiu: ${cp.ledger.usedByRole[role]} < ${carry.usedByRole[role]}`)
    assert.ok(cp.control.counters.localRepairsUsed >= carry.counters.localRepairsUsed)
    assert.ok(cp.control.counters.structuralReplansUsed >= carry.counters.structuralReplansUsed)
  }
})

test('R-tasks transição tasks-approved sem voto APPROVE no journal não publica e vira BLOCK tasks_review_missing', async t => {
  const fx = await fixture(t)
  const { result } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') { await checkpointPlan(runtime); await approvePlan(runtime); return { status: 'plan_approved' } }
    await approveTasks(runtime, (await readSlot({ repo: fx.cwd, kind: 'plan' })).hash, { review: false })
    return { status: 'tasks_approved' }
  } })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'tasks_review_missing')
  assert.equal((await readSlot({ repo: fx.cwd, kind: 'tasks' })).hash, null)
})

// FIX 4 (critic checkpoint M1p/M2/M3/R9b): o último voto do planReviewer antes da transição decide a aprovação de tasks.
test('FIX4 APPROVE antigo seguido de REPLAN do planReviewer não publica tasks (tasks_review_missing)', async t => {
  const fx = await fixture(t)
  const { result } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') { await checkpointPlan(runtime); await approvePlan(runtime); return { status: 'plan_approved' } }
    const planHash = (await readSlot({ repo: fx.cwd, kind: 'plan' })).hash
    const prepared = await runtime.preparePhaseArtifact({ kind: 'tasks', status: 'approved', content: { nodes: [{ id: 'T1', kind: 'implement', deps: [] }] }, planContentHash: planHash })
    await runtime.emit({ type: 'result', phase: 'Plan', payload: { role: 'planReviewer', label: 'plan-review:tasks' }, result: { feedback: { kind: 'APPROVE', reason: 'ok', severity: 'none', affectedNodes: [], evidenceIds: [] } } })
    await runtime.emit({ type: 'result', phase: 'Plan', payload: { role: 'planReviewer', label: 'plan-review:tasks:r2' }, result: { feedback: { kind: 'REPLAN', reason: 'mudou', severity: 'high', affectedNodes: [], evidenceIds: [] } } })
    await runtime.emit({ type: 'control.transition', phase: 'Plan', payload: { stage: 'tasks-approved', contentHash: prepared.contentHash } })
    return { status: 'tasks_approved' }
  } })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'tasks_review_missing')
  assert.equal((await readSlot({ repo: fx.cwd, kind: 'tasks' })).hash, null)
})

test('FIX4 APPROVE do planReviewer do estágio plan não vale para tasks (tasks_review_missing)', async t => {
  const fx = await fixture(t)
  const { result } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') {
      await checkpointPlan(runtime)
      await approvePlan(runtime)
      await runtime.emit({ type: 'result', phase: 'Plan', payload: { role: 'planReviewer', label: 'plan-review:r1' }, result: { feedback: { kind: 'APPROVE', reason: 'ok', severity: 'none', affectedNodes: [], evidenceIds: [] } } })
      return { status: 'plan_approved' }
    }
    await approveTasks(runtime, (await readSlot({ repo: fx.cwd, kind: 'plan' })).artifact.contentHash, { review: false })
    return { status: 'tasks_approved' }
  } })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'tasks_review_missing')
})

test('FIX4 tasksReviewApproved: sem fronteira de tasks nega, mesmo com APPROVE solto no journal', async () => {
  const { tasksReviewApproved } = await import('../bin/phase-pipeline.mjs')
  const events = [
    { seq: 1, type: 'result', payload: { role: 'planReviewer' }, result: { feedback: { kind: 'APPROVE' } } },
    { seq: 2, type: 'control.transition', payload: { stage: 'tasks-approved', contentHash: 'x' } },
  ]
  assert.equal(tasksReviewApproved(events, 2), false)
})

test('FIX4 tasksReviewApproved: último voto antes da transição precisa ser APPROVE', async () => {
  const { tasksReviewApproved } = await import('../bin/phase-pipeline.mjs')
  const vote = (seq, kind) => ({ seq, type: 'result', payload: { role: 'planReviewer' }, result: { feedback: { kind } } })
  const boundary = { seq: 1, type: 'phase.stage.started', payload: { stage: 'tasks', index: 2 } }
  const transition = seq => ({ seq, type: 'control.transition', payload: { stage: 'tasks-approved', contentHash: 'x' } })
  assert.equal(tasksReviewApproved([boundary, vote(2, 'APPROVE'), transition(3)], 3), true)
  assert.equal(tasksReviewApproved([boundary, vote(2, 'APPROVE'), vote(3, 'REPLAN'), transition(4)], 4), false)
  assert.equal(tasksReviewApproved([boundary, vote(2, 'REPLAN'), vote(3, 'APPROVE'), transition(4)], 4), true)
})

// R10a (critic R10): reuse.resolved grava planningKey e imports; os importados ficam em phase-imports/ e são verificados na retomada.
test('R10a reuse.resolved grava planningKey, planningInputs e imports, e phase-imports/ guarda os importados (0600)', async t => {
  const fx = await fixture(t)
  const planSealed = (await seedSlots(fx, { plan: 'approved', tasks: true })).tasks
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async () => ({ status: 'done' }) })
  const reuse = (await journalOf(fx)).find(event => event.type === 'phase.reuse.resolved').payload
  const inputs = await inputsFor(fx.cwd)
  assert.equal(reuse.planningKey, planningKeyOf(inputs))
  assert.deepEqual(reuse.planningInputs, inputs)
  assert.equal(reuse.imports.tasks, planSealed.contentHash)
  assert.equal(typeof reuse.imports.plan, 'string')
  assert.equal(reuse.clarificationContextHash, null)
  const file = path.join(fx.cwd, '.graph-runs', RUN_ID, 'phase-imports', `tasks-${planSealed.contentHash}.json`)
  assert.equal((await readFile(file, 'utf8')).trimEnd(), canonicalJsonOf(planSealed))
  assert.equal((await import('node:fs')).statSync(file).mode & 0o777, 0o600)
})

test('R10a import adulterado bloqueia a retomada: resume_phase_import_invalid', async t => {
  const fx = await fixture(t)
  const planSealed = (await seedSlots(fx, { plan: 'approved', tasks: true })).tasks
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async () => ({ status: 'done' }) })
  const reuse = (await journalOf(fx)).find(event => event.type === 'phase.reuse.resolved').payload
  const runDir = path.join(fx.cwd, '.graph-runs', RUN_ID)
  const file = path.join(runDir, 'phase-imports', `tasks-${planSealed.contentHash}.json`)
  await writeFile(file, canonicalJsonOf({ ...planSealed, content: { nodes: [] } }) + '\n')
  const { reconstructPipelineState } = await import('../bin/phase-pipeline.mjs')
  await assert.rejects(() => reconstructPipelineState({ runDir, runId: RUN_ID, reuse, planningInputs: reuse.planningInputs }), err => err.pipelineBlock?.feedback?.reason === 'resume_phase_import_invalid')
})

test('R10a tarefa trocada na retomada bloqueia resume_planning_key_changed', async t => {
  const fx = await fixture(t)
  await seedSlots(fx, { plan: 'approved', tasks: true })
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async () => ({ status: 'done' }) })
  const reuse = (await journalOf(fx)).find(event => event.type === 'phase.reuse.resolved').payload
  const runDir = path.join(fx.cwd, '.graph-runs', RUN_ID)
  const { reconstructPipelineState } = await import('../bin/phase-pipeline.mjs')
  const changed = await inputsFor(fx.cwd, 'outra tarefa')
  await assert.rejects(() => reconstructPipelineState({ runDir, runId: RUN_ID, reuse, planningInputs: changed }), err => err.pipelineBlock?.feedback?.reason === 'resume_planning_key_changed')
})

// Decisão do coordenador (planHash pós-publicação): o journal é a fonte. Cada publicação grava cópia verificável e evento phase.artifact.published.
test('planHash pós-publicação: publish grava phase-published/ (0600) e phase.artifact.published com casOk', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' } }, script: async (stageArgs, runtime) => {
    await checkpointPlan(runtime)
    await approvePlan(runtime)
    return { status: 'plan_approved' }
  } })
  const published = (await journalOf(fx)).find(event => event.type === 'phase.artifact.published')
  assert.equal(published.payload.kind, 'plan')
  assert.equal(published.payload.casOk, true)
  assert.equal(published.payload.contentHash, (await readSlot({ repo: fx.cwd, kind: 'plan' })).hash)
  const file = path.join(fx.cwd, '.graph-runs', RUN_ID, 'phase-published', `plan-${published.payload.contentHash}.json`)
  assert.equal((await import('node:fs')).statSync(file).mode & 0o777, 0o600)
})

test('planHash pós-publicação: reconstrução usa o último publicado do journal; cópia adulterada -> resume_phase_published_invalid', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' } }, script: async (stageArgs, runtime) => {
    await checkpointPlan(runtime)
    await approvePlan(runtime)
    return { status: 'plan_approved' }
  } })
  const events = await journalOf(fx)
  const reuse = events.find(event => event.type === 'phase.reuse.resolved').payload
  const published = events.find(event => event.type === 'phase.artifact.published')
  const runDir = path.join(fx.cwd, '.graph-runs', RUN_ID)
  const { reconstructPipelineState } = await import('../bin/phase-pipeline.mjs')
  const state = await reconstructPipelineState({ runDir, runId: RUN_ID, reuse, planningInputs: reuse.planningInputs, events })
  assert.equal(state.planHash, published.payload.contentHash)
  const file = path.join(runDir, 'phase-published', `plan-${published.payload.contentHash}.json`)
  await writeFile(file, (await readFile(file, 'utf8')).replace('"status":"approved"', '"status":"rejected"'))
  await assert.rejects(() => reconstructPipelineState({ runDir, runId: RUN_ID, reuse, planningInputs: reuse.planningInputs, events }), err => err.pipelineBlock?.feedback?.reason === 'resume_phase_published_invalid')
})

// R10b: retomada de run com pipeline pelo runGraph. Só D/E e a pendência dos casos A, B e C saem daqui.
test('R10b retomada com tombstone do próprio runner depois da fronteira devolve resume_stage_rejected sem reinvocar', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' } } })
  const beforeResume = await journalOf(fx)
  assert.equal(beforeResume.at(-1).type, 'run.finished')
  assert.equal(beforeResume.at(-2).payload.stage, 'plan-artifact-rejected')
  const { result, calls } = await run(fx, { args: { resume: { requestedRerunIds: [] } } })
  assert.equal(result.feedback.reason, 'resume_stage_rejected')
  assert.equal(calls.length, 0)
})

// R10d: o caso C saiu da pendência; a retomada reinvoca o estágio (sem gasto, sem carry).
test('R10b retomada de estágio só de leitura sem gasto (caso C) reinvoca o estágio, sem pendência (R10d)', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' } }, script: async () => { throw new Error('queda simulada antes de qualquer gasto') } })
  assert.equal((await journalOf(fx)).some(e => e.type === 'control.transition'), false)
  const { result, calls } = await run(fx, { args: { resume: { requestedRerunIds: [] } } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.stage, 'plan')
  assert.ok(result, 'a retomada devolve um resultado')
})

test('R10b retomada com workspace alterado em estágio só de leitura bloqueia workspace_changed_during_stage', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' } }, script: async () => { throw new Error('queda simulada antes de qualquer gasto') } })
  fx.snap.current = { head: 'h2', files: [] }
  const { result, calls } = await run(fx, { args: { resume: { requestedRerunIds: [] } } })
  assert.equal(result.feedback.reason, 'workspace_changed_during_stage')
  assert.equal(calls.length, 0)
})

// R10c: caso A pelo runGraph. A primeira run aprova o plano (checkpoint + aprovação) e cai antes de o runner publicar.
// Checkpoint com o originalGuards real da run, para passar na validação do resume.
function planCheckpointFor(originalGuards) {
  const roles = ['planner', 'planReviewer', 'designReviewer', 'critic', 'synth', 'executor', 'verifier']
  const zero = Object.fromEntries(roles.map(role => [role, 0]))
  const limits = { planner: 5, planReviewer: 5, designReviewer: 5, critic: 5, synth: 3, executor: 0, verifier: 0 }
  const reserved = { planner: 1, planReviewer: 1, designReviewer: 1, critic: 1, synth: 1, executor: 0, verifier: 0 }
  const plan = { goal: 'meta', complexity: 'moderate', mode: 'research', doneWhen: ['pronto'], effort: { level: 'medium', why: 'teste' }, nodes: [{ id: 'R', kind: 'research', deps: [], title: 'R', brief: 'b', acceptance: ['ok'], files: [], inputs: [], outputs: [] }] }
  return {
    schemaVersion: 2, planVersion: 1, plan, originalGuards,
    budgetPolicy: { id: 'graph-eng-budget-v2', effort: 'medium', mode: 'research', maxNodes: 6, maxLocalRepairs: 2, maxStructuralReplans: 2, allocation: null },
    ledger: { usedByRole: zero, reservedByRole: reserved, limitsByRole: limits, tokenUsageByRole: Object.fromEntries(roles.map(role => [role, null])), localRepairsUsed: 0, structuralReplansUsed: 0 },
    control: { stage: 'plan-approved', pipelineStage: 'plan', counters: { localRepairsUsed: 0, structuralReplansUsed: 0 }, history: [], seenPairs: [] },
    nodeRecords: [], approvals: { planReview: { kind: 'APPROVE' } },
  }
}

const planApprovedThenCrash = fx => async (stageArgs, runtime) => {
  const meta = JSON.parse(await readFile(path.join(fx.cwd, '.graph-runs', RUN_ID, 'run.meta.json'), 'utf8'))
  await runtime.emit({ type: 'control.transition', phase: 'Plan', planVersion: 1, payload: { stage: 'plan-approved', checkpoint: planCheckpointFor(meta.originalGuards) } })
  await approvePlan(runtime)
  throw new Error('queda simulada depois da aprovação do plano')
}

test('R10c retomada com plano aprovado e sem fronteira 2 inicia tasks sem chamar o planner do plano', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: planApprovedThenCrash(fx) })
  // A primeira chamada de tasks fica fechada pelo FIRST_CALL_BY_STAGE.tasks = null até o M8; este motor fake não gasta nada.
  const { calls } = await run(fx, { args: { resume: { requestedRerunIds: [] } }, script: async () => { throw new Error('fim do teste: tasks invocado') } })
  assert.deepEqual(calls.map(call => call.args.stage), ['tasks'])
  assert.equal(Object.hasOwn(calls[0].args, 'resume'), false)
  const events = await journalOf(fx)
  assert.deepEqual(events.filter(event => event.type === 'phase.stage.started').map(event => event.payload.stage), ['plan', 'tasks'])
  const approval = events.find(event => event.type === 'control.transition' && event.payload?.stage === 'plan-artifact-approved')
  const published = events.find(event => event.type === 'phase.artifact.published')
  assert.equal(published.payload.contentHash, approval.payload.contentHash)
  assert.equal(published.payload.casOk, true)
  assert.equal((await readSlot({ repo: fx.cwd, kind: 'plan' })).hash, approval.payload.contentHash)
})

test('R10c rascunho aprovado adulterado bloqueia resume_phase_draft_invalid sem invocar estágio', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: planApprovedThenCrash(fx) })
  const approval = (await journalOf(fx)).find(event => event.type === 'control.transition' && event.payload?.stage === 'plan-artifact-approved')
  await writeFile(path.join(fx.cwd, '.graph-runs', RUN_ID, 'phase-drafts', `plan-${approval.payload.contentHash}.json`), 'bytes adulterados\n')
  const { result, calls } = await run(fx, { args: { resume: { requestedRerunIds: [] } } })
  assert.equal(result.feedback.reason, 'resume_phase_draft_invalid')
  assert.equal(calls.length, 0)
})

test('R10c aprovação já publicada por esta run não é regravada no slot nem publicada de novo', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' } }, script: async (stageArgs, runtime) => { await approvePlan(runtime); return { status: 'plan_approved' } } })
  const before = await readSlot({ repo: fx.cwd, kind: 'plan' })
  const { result, calls } = await run(fx, { args: { resume: { requestedRerunIds: [] } } })
  assert.equal(calls.length, 0)
  assert.equal(result.status, 'plan_approved')
  assert.equal((await journalOf(fx)).filter(event => event.type === 'phase.artifact.published').length, 1)
  assert.equal((await readSlot({ repo: fx.cwd, kind: 'plan' })).hash, before.hash)
})

test('R10c rascunho com conteúdo trocado e hash antigo (JSON canônico válido) bloqueia resume_phase_draft_invalid', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: planApprovedThenCrash(fx) })
  const approval = (await journalOf(fx)).find(event => event.type === 'control.transition' && event.payload?.stage === 'plan-artifact-approved')
  const file = path.join(fx.cwd, '.graph-runs', RUN_ID, 'phase-drafts', `plan-${approval.payload.contentHash}.json`)
  const draft = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, canonicalJsonOf({ ...draft, content: { ...draft.content, goal: 'trocado' } }) + '\n')
  const { result, calls } = await run(fx, { args: { resume: { requestedRerunIds: [] } } })
  assert.equal(result.feedback.reason, 'resume_phase_draft_invalid')
  assert.equal(calls.length, 0)
})

// R10d: re-entrada do mesmo estágio (casos B e C) pelo runGraph real, com motor fake. Checkpoint com o originalGuards real da run.
const ROLES_R10D = ['planner', 'planReviewer', 'designReviewer', 'critic', 'synth', 'executor', 'verifier']
const zeroR10d = () => Object.fromEntries(ROLES_R10D.map(role => [role, 0]))
const LIMITS_R10D = { planner: 5, planReviewer: 5, designReviewer: 5, critic: 5, synth: 3, executor: 0, verifier: 0 }
const ledgerR10d = ({ usedPlanner = 0, reservedPlanner = 0, localRepairsUsed = 0 } = {}) => ({
  usedByRole: { ...zeroR10d(), planner: usedPlanner },
  reservedByRole: { ...zeroR10d(), planner: reservedPlanner, planReviewer: 1, designReviewer: 1, critic: 1, synth: 1 },
  limitsByRole: LIMITS_R10D, tokenUsageByRole: Object.fromEntries(ROLES_R10D.map(role => [role, null])), localRepairsUsed, structuralReplansUsed: 0,
})
// Checkpoint de 'plan-approved' com o estágio pedido; o ledger reflete o que a run já gastou até ele.
function checkpointR10d(originalGuards, { pipelineStage = 'plan', usedPlanner = 0, reservedPlanner = 1, localRepairsUsed = 0 } = {}) {
  const cp = planCheckpointFor(originalGuards)
  cp.control.pipelineStage = pipelineStage
  cp.control.counters.localRepairsUsed = localRepairsUsed
  cp.ledger = ledgerR10d({ usedPlanner, reservedPlanner, localRepairsUsed })
  return cp
}
const originalGuardsOf = async fx => JSON.parse(await readFile(path.join(fx.cwd, '.graph-runs', RUN_ID, 'run.meta.json'), 'utf8')).originalGuards
const stageStartedOf = events => events.filter(event => event.type === 'phase.stage.started')

test('R10d caso B: queda depois do checkpoint do plano reinvoca plan com resumeCheckpoint, sem nova fronteira e com o gasto já feito', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' } }, script: async (stageArgs, runtime) => {
    await runtime.emit({ type: 'budget.call', phase: 'Plan', payload: { role: 'planner', label: 'plan', ledger: ledgerR10d({ usedPlanner: 1, reservedPlanner: 0 }) } })
    await runtime.emit({ type: 'control.transition', phase: 'Plan', planVersion: 1, payload: { stage: 'plan-approved', checkpoint: checkpointR10d(await originalGuardsOf(fx), { usedPlanner: 1, reservedPlanner: 0 }) } })
    await runtime.emit({ type: 'budget.call', phase: 'Plan', payload: { role: 'planner', label: 'plan', ledger: { ...ledgerR10d({ usedPlanner: 2, reservedPlanner: 0, localRepairsUsed: 1 }) } } })
    throw new Error('queda simulada depois do checkpoint')
  } })
  const { result, calls } = await run(fx, { args: { resume: { requestedRerunIds: [] } }, script: async (stageArgs, runtime) => {
    await approvePlan(runtime)
    return { status: 'plan_approved' }
  } })
  assert.deepEqual(calls.map(call => call.args.stage), ['plan'])
  assert.equal(calls[0].runtime.stageCarry, null)
  // A chamada já feita conta: o ledger do checkpoint reinvocado tem o gasto posterior e os contadores não diminuem.
  assert.equal(calls[0].runtime.resumeCheckpoint.ledger.usedByRole.planner, 2)
  assert.equal(calls[0].runtime.resumeCheckpoint.control.counters.localRepairsUsed, 1)
  assert.equal(calls[0].runtime.resumeCheckpoint.control.pipelineStage, 'plan')
  assert.equal(stageStartedOf(await journalOf(fx)).length, 1)
  assert.equal(result.status, 'plan_approved', JSON.stringify(result))
})

test('R10d caso B no meio do tasks: queda depois do checkpoint reinvoca tasks com resumeCheckpoint e não emite fronteira', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') { await runtime.emit({ type: "control.transition", phase: "Plan", planVersion: 1, payload: { stage: "plan-approved", checkpoint: checkpointR10d(await originalGuardsOf(fx)) } }); await approvePlan(runtime); return { status: 'plan_approved' } }
    await runtime.emit({ type: 'control.transition', phase: 'Plan', planVersion: 1, payload: { stage: 'plan-approved', checkpoint: checkpointR10d(await originalGuardsOf(fx), { pipelineStage: 'tasks', reservedPlanner: 1 }) } })
    throw new Error('queda simulada depois do checkpoint do tasks')
  } })
  const { calls } = await run(fx, { args: { resume: { requestedRerunIds: [] } }, script: async () => ({ status: 'done' }) })
  assert.deepEqual(calls.map(call => call.args.stage), ['tasks'])
  assert.equal(calls[0].runtime.resumeCheckpoint.control.pipelineStage, 'tasks')
  assert.equal(calls[0].runtime.stageCarry, null)
  assert.deepEqual(stageStartedOf(await journalOf(fx)).map(event => event.payload.stage), ['plan', 'tasks'])
})

test('R10d caso C: queda antes de qualquer gasto reinvoca plan sem carry (estágio 1) e publica o plano', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' } }, script: async () => { throw new Error('queda simulada antes de qualquer gasto') } })
  const { result, calls } = await run(fx, { args: { resume: { requestedRerunIds: [] } }, script: async (stageArgs, runtime) => { await approvePlan(runtime); return { status: 'plan_approved' } } })
  assert.deepEqual(calls.map(call => call.args.stage), ['plan'])
  assert.equal(calls[0].runtime.stageCarry, null)
  assert.equal(calls[0].runtime.resumeCheckpoint, null)
  assert.equal(result.status, 'plan_approved', JSON.stringify(result))
  assert.equal(stageStartedOf(await journalOf(fx)).length, 1)
})

test('R10d caso C no estágio 2: fronteira sem gasto reinvoca tasks com o carry gravado na fronteira, sem nova fronteira', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') { await runtime.emit({ type: "control.transition", phase: "Plan", planVersion: 1, payload: { stage: "plan-approved", checkpoint: checkpointR10d(await originalGuardsOf(fx)) } }); await approvePlan(runtime); return { status: 'plan_approved' } }
    throw new Error('queda simulada antes de qualquer gasto do tasks')
  } })
  const boundary = stageStartedOf(await journalOf(fx)).at(-1)
  const { calls } = await run(fx, { args: { resume: { requestedRerunIds: [] } }, script: async () => ({ status: 'done' }) })
  assert.deepEqual(calls.map(call => call.args.stage), ['tasks'])
  assert.deepEqual(calls[0].runtime.stageCarry, boundary.payload.carry)
  assert.equal(calls[0].runtime.resumeCheckpoint, null)
  assert.equal(stageStartedOf(await journalOf(fx)).length, 2)
})

test('R10d caso B com tasks->implement: checkpoint depois da aprovação reinvoca tasks com resumeStageApproved e publica o rascunho aprovado', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') { await runtime.emit({ type: "control.transition", phase: "Plan", planVersion: 1, payload: { stage: "plan-approved", checkpoint: checkpointR10d(await originalGuardsOf(fx)) } }); await approvePlan(runtime); return { status: 'plan_approved' } }
    const prepared = await approveTasks(runtime, (await readSlot({ repo: fx.cwd, kind: 'plan' })).hash)
    await runtime.emit({ type: 'control.transition', phase: 'Plan', planVersion: 1, payload: { stage: 'plan-approved', checkpoint: checkpointR10d(await originalGuardsOf(fx), { pipelineStage: 'tasks', reservedPlanner: 1 }) } })
    throw new Error(`queda simulada depois da aprovação de tasks ${prepared.contentHash}`)
  } })
  const approval = (await journalOf(fx)).find(event => event.type === 'control.transition' && event.payload?.stage === 'tasks-approved')
  const { calls, result } = await run(fx, { args: { resume: { requestedRerunIds: [] } }, script: async () => ({ status: 'done' }) })
  assert.deepEqual(calls.map(call => call.args.stage), ['tasks'])
  assert.deepEqual(calls[0].runtime.resumeStageApproved.tasks, { seq: approval.seq, contentHash: approval.payload.contentHash })
  assert.equal(calls[0].runtime.resumeCheckpoint.control.pipelineStage, 'tasks')
  const published = (await journalOf(fx)).filter(event => event.type === 'phase.artifact.published' && event.payload.kind === 'tasks')
  assert.equal(published.length, 1)
  assert.equal(published[0].payload.contentHash, approval.payload.contentHash)
  assert.equal((await readSlot({ repo: fx.cwd, kind: 'tasks' })).hash, approval.payload.contentHash, JSON.stringify(result))
})

// R10d ponta a ponta (runGraph real, motor fake): A, B e C retomam; chamadas já feitas contam (sem crédito) e contadores não diminuem.
test('R10d ponta a ponta: A, B e C retomam pelo runGraph; chamadas já feitas contam e contadores nunca diminuem', async t => {
  // A: plano aprovado com checkpoint, queda antes de publicar; tasks inicia sem chamar o planner do plano.
  const fxA = await fixture(t)
  await run(fxA, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: planApprovedThenCrash(fxA) })
  const a = await run(fxA, { args: { resume: { requestedRerunIds: [] } }, script: async () => { throw new Error('fim do teste: tasks invocado') } })
  assert.deepEqual(a.calls.map(call => call.args.stage), ['tasks'])
  assert.equal(a.calls[0].runtime.stageCarry.planVersion, 1)

  // B: duas chamadas do planner (uma antes e uma depois do checkpoint); a retomada vê as duas, com contadores que não voltam.
  const fxB = await fixture(t)
  await run(fxB, { args: { pipeline: { from: 'plan', to: 'plan' } }, script: async (stageArgs, runtime) => {
    const guards = await originalGuardsOf(fxB)
    await runtime.emit({ type: 'budget.call', phase: 'Plan', payload: { role: 'planner', label: 'plan', ledger: ledgerR10d({ usedPlanner: 1, reservedPlanner: 0 }) } })
    await runtime.emit({ type: 'control.transition', phase: 'Plan', planVersion: 1, payload: { stage: 'plan-approved', checkpoint: checkpointR10d(guards, { usedPlanner: 1, reservedPlanner: 0 }) } })
    await runtime.emit({ type: 'budget.call', phase: 'Plan', payload: { role: 'planner', label: 'plan', ledger: ledgerR10d({ usedPlanner: 2, reservedPlanner: 0, localRepairsUsed: 1 }) } })
    throw new Error('queda simulada depois do checkpoint')
  } })
  const callsBefore = (await journalOf(fxB)).filter(event => event.type === 'budget.call').length
  const b = await run(fxB, { args: { resume: { requestedRerunIds: [] } }, script: async (stageArgs, runtime) => { await approvePlan(runtime); return { status: 'plan_approved' } } })
  assert.deepEqual(b.calls.map(call => call.args.stage), ['plan'])
  const resumed = b.calls[0].runtime.resumeCheckpoint
  assert.equal(resumed.ledger.usedByRole.planner, 2, 'a chamada feita depois do checkpoint conta: sem crédito')
  assert.equal(resumed.ledger.reservedByRole.planner, 0)
  assert.equal(resumed.control.counters.localRepairsUsed, 1, 'contador do journal não diminui')
  assert.equal((await journalOf(fxB)).filter(event => event.type === 'budget.call').length, callsBefore, 'a retomada não grava gasto novo')
  assert.equal(b.result.status, 'plan_approved', JSON.stringify(b.result))

  // C: queda antes de qualquer gasto; a retomada reinvoca o plano do zero, sem carry e sem nova fronteira.
  const fxC = await fixture(t)
  await run(fxC, { args: { pipeline: { from: 'plan', to: 'plan' } }, script: async () => { throw new Error('queda antes de qualquer gasto') } })
  const c = await run(fxC, { args: { resume: { requestedRerunIds: [] } }, script: async (stageArgs, runtime) => { await approvePlan(runtime); return { status: 'plan_approved' } } })
  assert.deepEqual(c.calls.map(call => call.args.stage), ['plan'])
  assert.equal(c.calls[0].runtime.stageCarry, null)
  assert.equal(c.result.status, 'plan_approved', JSON.stringify(c.result))
  assert.equal(stageStartedOf(await journalOf(fxC)).length, 1)
})

// critic R10: tasks aprovado, publicado e com checkpoint depois da aprovação; a run termina done (a queda simulada vem depois da publicação).
const tasksPublishedThenDone = fx => async (stageArgs, runtime) => {
  if (stageArgs.stage === 'plan') { await runtime.emit({ type: 'control.transition', phase: 'Plan', planVersion: 1, payload: { stage: 'plan-approved', checkpoint: checkpointR10d(await originalGuardsOf(fx)) } }); await approvePlan(runtime); return { status: 'plan_approved' } }
  await approveTasks(runtime, (await readSlot({ repo: fx.cwd, kind: 'plan' })).hash)
  await runtime.emit({ type: 'control.transition', phase: 'Plan', planVersion: 1, payload: { stage: 'plan-approved', checkpoint: checkpointR10d(await originalGuardsOf(fx), { pipelineStage: 'tasks', reservedPlanner: 1 }) } })
  return { status: 'done' }
}

test('critic R10 tasks->implement que termina done publica o tasks e não vira phaseArtifacts.rejected', async t => {
  const fx = await fixture(t)
  const first = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: tasksPublishedThenDone(fx) })
  assert.equal(first.result.status, 'done', JSON.stringify(first.result))
  assert.deepEqual(first.result.phaseArtifacts.rejected, [])
  assert.equal((await journalOf(fx)).filter(event => event.type === 'phase.artifact.published' && event.payload.kind === 'tasks').length, 1)
})

test('critic R10 queda depois de publicar tasks no caso B: a retomada não bloqueia, não publica de novo e não rejeita', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: tasksPublishedThenDone(fx) })
  const { calls, result } = await run(fx, { args: { resume: { requestedRerunIds: [] } }, script: async () => ({ status: 'done' }) })
  assert.deepEqual(calls.map(call => call.args.stage), ['tasks'])
  assert.equal(calls[0].runtime.resumeStageApproved.tasks.contentHash, (await readSlot({ repo: fx.cwd, kind: 'tasks' })).hash)
  assert.equal(result.status, 'done', JSON.stringify(result))
  assert.deepEqual(result.phaseArtifacts.rejected, [])
  assert.equal((await journalOf(fx)).filter(event => event.type === 'phase.artifact.published' && event.payload.kind === 'tasks').length, 1)
})

test('critic R10 slot de outra run bloqueia a retomada do caso B: artifact_slot_changed, slot alheio mantido, sem segundo publicado', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: tasksPublishedThenDone(fx) })
  const current = await readSlot({ repo: fx.cwd, kind: 'tasks' })
  const other = sealArtifact({ ...current.artifact, content: { nodes: [{ id: 'Z', kind: 'implement', deps: [] }] } })
  assert.equal((await writeSlot({ repo: fx.cwd, kind: 'tasks', artifact: other, expectedPrevContentHash: current.hash })).published, true)
  const { result } = await run(fx, { args: { resume: { requestedRerunIds: [] } }, script: async () => ({ status: 'done' }) })
  assert.deepEqual(result.phaseArtifacts.rejected.map(item => item.reason), ['artifact_slot_changed'])
  assert.equal((await readSlot({ repo: fx.cwd, kind: 'tasks' })).hash, other.contentHash)
  assert.equal((await journalOf(fx)).filter(event => event.type === 'phase.artifact.published' && event.payload.kind === 'tasks').length, 1)
})

// I2-lite (critic checkpoint M1/M4/M5/M6): motor real com agentes roteirizados. Plan aprovado, queda logo depois
// da aprovação (journal cortado na transição, slot não gravado) e a retomada pelo runner cai no caso A sem chamar critic.
const PLAN_I2 = { goal: 'i2', complexity: 'moderate', mode: 'research', doneWhen: ['ok'], effort: { level: 'medium', why: 'teste' }, nodes: [{ id: 'R1', kind: 'research', title: 'R1', brief: 'pesquisar', deps: [], risk: 'low', acceptance: ['fonte'], files: [], inputs: [], outputs: [] }] }

async function runScriptedPlan(fx, args, script, calls) {
  const host = {
    capabilities: () => ({ host: 'claude', readOnlyEnforced: true, structuredOutput: true }),
    spawn: async request => ({ request }),
    wait: async ({ request }) => {
      calls.push(request.label)
      const output = withScriptedCriticEvidence(request.label, await script(request.label, request.prompt, request), request.prompt)
      return { output, requestedModel: request.model, effectiveModel: request.model, usage: null }
    },
  }
  // Evidência com identidade (o motor real exige snapshot verificável para chegar ao critic).
  const evidence = () => ({ snapshot: async () => ({ head: 'h1', files: [], schemaVersion: 2, identity: 'i2-identity', evidencePath: 'test/snapshot.json', evidenceHash: 'i2-snapshot-hash' }), fingerprint: async () => ({ schemaVersion: 2, identity: 'i2-node' }), runChecks: async () => [], verifyArtifact: async () => true })
  return runGraph({ hostName: 'claude', cwd: fx.cwd, stateDir: fx.stateDir, args: { task: 'tarefa', ...args }, hostFactory: () => host, evidenceFactory: evidence })
}

test('I2-lite: plan real aprovado, queda depois da aprovação, retomada cai no caso A sem chamar critic', async t => {
  const fx = await fixture(t)
  const args = { runId: 'i2-run', runDir: '.graph-runs/i2-run', mode: 'research', pipeline: { from: 'plan', to: 'plan' }, checks: [] }
  const firstCalls = []
  const first = await runScriptedPlan(fx, args, defaultScript({ plan: PLAN_I2 }), firstCalls)
  assert.equal(first.status, 'plan_approved', JSON.stringify(first).slice(0, 600))
  // Queda simulada logo depois da aprovação: o journal para na transição e o slot publicado não chegou a ser gravado.
  const journalPath = path.join(fx.cwd, '.graph-runs', 'i2-run', 'journal.jsonl')
  const lines = (await readFile(journalPath, 'utf8')).trim().split('\n')
  const cut = lines.findIndex(line => JSON.parse(line).payload?.stage === 'plan-artifact-approved')
  assert.ok(cut >= 0, lines.join('\n'))
  const approvalHash = JSON.parse(lines[cut]).payload.contentHash
  await writeFile(journalPath, lines.slice(0, cut + 1).join('\n') + '\n')
  await rm(path.join(fx.cwd, '.graph-runs', 'artifacts', 'plan.json'), { force: true })
  const resumeCalls = []
  const resumed = await runScriptedPlan(fx, { ...args, resume: { requestedRerunIds: [] } }, async label => { throw new Error(`fim do teste: ${label} invocado na retomada`) }, resumeCalls)
  assert.deepEqual(resumeCalls, [], "a retomada do caso A não pode chamar nenhum agente")
  assert.equal(resumed.status, "plan_approved", JSON.stringify(resumed))
  assert.equal((await readSlot({ repo: fx.cwd, kind: 'plan' })).hash, approvalHash)
})

// E2E (M7–M9): plan -> tasks -> implement pelo runner real, em três invocações sobre o mesmo repo (reuso do pipeline).
// Plan e tasks rodam sem checks (estágios só de leitura); implement roda com checks reais (fixture B5). O host roteia pelo papel do prompt.
const TASKS_E2E = { goal: 'i2', complexity: 'moderate', mode: 'implement', doneWhen: ['ok'], effort: { level: 'medium', why: 'teste' }, nodes: [
  { id: 'D1', kind: 'design', title: 'design', brief: 'd', deps: [], files: [], inputs: [], outputs: [], risk: 'low', acceptance: ['decisão'] },
  { id: 'I1', kind: 'implement', title: 'implementação', brief: 'i', deps: ['D1'], files: ['src/a.js'], inputs: ['src/a.js'], outputs: ['src/a.js'], risk: 'low', acceptance: ['ok'] },
] }
const e2eScript = async (label, prompt, opts) => (label === 'plan' && prompt.includes('## Role: task decomposer') ? TASKS_E2E : defaultScript({ plan: PLAN_I2 })(label, prompt, opts))

test('E2E plan -> tasks -> implement: plan e tasks aprovados sem checkpoint, tasks sem execução, implement só com plan-review e checks reais', async t => {
  const first = await runGraphScripted(t, { args: { runId: 'e2e-plan', runDir: '.graph-runs/e2e-plan', effort: 'medium', checks: [], pipeline: { from: 'plan', to: 'plan' }, checkContract: undefined, nodeCheckPolicy: undefined }, script: e2eScript })
  assert.equal(first.result.status, 'plan_approved', JSON.stringify(first.result).slice(0, 400))
  const planApproval = first.events.find(event => event.type === 'control.transition' && event.payload?.stage === 'plan-artifact-approved')
  assert.ok(planApproval, JSON.stringify(first.events.map(event => event.type)).slice(0, 400))
  assert.equal(Object.hasOwn(planApproval.payload, 'checkpoint'), false)

  const tasks = await runGraphScripted(t, { fixture: first.fixture, args: { runId: 'e2e-tasks', runDir: '.graph-runs/e2e-tasks', effort: 'medium', checks: [], pipeline: { from: 'tasks', to: 'tasks' }, checkContract: undefined, nodeCheckPolicy: undefined }, script: e2eScript })
  assert.equal(tasks.result.status, 'tasks_approved', JSON.stringify(tasks.result).slice(0, 400))
  const tasksApproval = tasks.events.find(event => event.type === 'control.transition' && event.payload?.stage === 'tasks-approved')
  assert.ok(tasksApproval, JSON.stringify(tasks.calls))
  assert.equal(Object.hasOwn(tasksApproval.payload, 'checkpoint'), false)
  assert.deepEqual(tasks.calls.filter(label => label.startsWith('work:')), [], JSON.stringify(tasks.calls))
  assert.deepEqual(tasks.events.filter(event => event.type === 'phase.stage.started').map(event => event.payload.stage), ['tasks'])

  const implement = await runGraphScripted(t, { fixture: first.fixture, args: { runId: 'e2e-implement', runDir: '.graph-runs/e2e-implement', effort: 'medium', pipeline: { from: 'auto', to: 'implement' } }, script: e2eScript })
  assert.deepEqual(implement.events.filter(event => event.type === 'phase.stage.started').map(event => event.payload.stage), ['implement'], JSON.stringify(implement.calls))
  assert.equal(implement.calls[0], 'plan-review:r1', JSON.stringify(implement.calls))
  assert.equal(implement.calls.filter(label => label === 'plan').length, 0, JSON.stringify(implement.calls))
  assert.ok(implement.calls.includes('work:I1'), JSON.stringify(implement.calls))
  assert.ok(implement.events.some(event => event.type === 'checks.selection.completed'), JSON.stringify(implement.events.map(event => event.type)).slice(0, 600))
  // Item 2a: o implement termina em done, com critic DONE e checks finais da mesma entrega (identidade do finalEvidence).
  assert.equal(implement.result.status, 'done', JSON.stringify(implement.result).slice(0, 400))
  assert.equal(implement.result.critic?.feedback?.kind, 'DONE', JSON.stringify(implement.result.critic).slice(0, 400))
  const criticStage = implement.events.find(event => event.type === 'control.transition' && event.payload?.stage === 'critic-reviewed')
  assert.ok(criticStage, JSON.stringify(implement.events.map(event => event.type)).slice(0, 400))
  const approvals = criticStage.payload.checkpoint.approvals
  const finalEvidence = implement.result.finalEvidence
  assert.equal(approvals.critic.feedback.kind, 'DONE')
  assert.equal(approvals.critic.finalEvidence.identity, finalEvidence.identity)
  assert.equal(approvals.finalChecks.selection.hash, finalEvidence.selection.hash)
  assert.deepEqual(approvals.finalChecks.selection.checkIds, ['node-test'])
  assert.deepEqual(approvals.finalChecks.receiptIds, finalEvidence.receiptIds)
  assert.equal(approvals.finalChecks.selection.coverage, 'complete')
  const published = await readSlot({ repo: first.cwd, kind: 'tasks' })
  assert.equal(published.artifact?.status, 'approved')
  assert.equal(published.artifact?.contentHash, tasksApproval.payload.contentHash)
})

// ---------- C3: lock de workspace pelas invocações 3D, pausas e saídas ----------

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

// Run concorrente no mesmo cwd: o workflow nunca roda se o lock de workspace já estiver tomado.
async function probeRun(fx, { runId, ...args }) {
  const calls = []
  const workflowCompiler = async () => async stageArgs => { calls.push(stageArgs.stage); return { status: 'blocked', feedback: { kind: 'BLOCK', reason: 'probe_stub', severity: 'critical', affectedNodes: [], evidenceIds: [] } } }
  const result = await runGraph({ hostName: 'claude', cwd: fx.cwd, stateDir: fx.stateDir, args: { task: 'outra', runId, runDir: `.graph-runs/${runId}`, ...args }, hostFactory: hostStub, evidenceFactory: fx.evidenceFactory, workflowCompiler })
  return { result, calls }
}

const PLAN_CHECKPOINT_STUB = () => ({ type: 'control.transition', phase: 'Plan', payload: { stage: 'plan-approved', checkpoint: checkpoint({ planner: 1, localRepairsUsed: 1 }) } })

test('C3 one-shot segura o workspace entre a invocação 1 e a 2: outra run no mesmo cwd recebe workspace_busy', { timeout: 20_000 }, async t => {
  const fx = await fixture(t)
  const probe = {}
  const stateFactory = input => {
    const state = createRunState(input)
    return { ...state, emit: async (lease, event) => {
      const record = await state.emit(lease, event)
      if (!probe.result && event.type === 'phase.stage.started' && event.payload?.index === 2) probe.result = await probeRun(fx, { runId: 'probe-entre', pipeline: { from: 'auto', to: 'implement' } })
      return record
    } }
  }
  const { calls } = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, stateFactory, script: async (stageArgs, runtime) => {
    if (stageArgs.stage === 'plan') {
      await runtime.emit(PLAN_CHECKPOINT_STUB())
      await approvePlan(runtime)
      return { status: 'plan_approved' }
    }
    await approveTasks(runtime, (await readSlot({ repo: fx.cwd, kind: 'plan' })).hash)
    return { status: 'blocked', feedback: { kind: 'BLOCK', reason: 'fim_do_teste', severity: 'critical', affectedNodes: [], evidenceIds: [] } }
  } })
  assert.deepEqual(calls.map(call => call.args.stage), ['plan', 'tasks'], 'a segunda invocação precisa ter rodado')
  assert.ok(probe.result, 'a sonda precisa ter sido disparada na fronteira 2')
  assert.equal(probe.result.result.feedback?.reason, 'workspace_busy', JSON.stringify(probe.result.result))
  assert.equal(probe.result.calls.length, 0)
})

test('C3 plan só de leitura e one-shot concorrentes no mesmo repo se bloqueiam nos dois sentidos', { timeout: 20_000 }, async t => {
  const fx = await fixture(t)
  const gateA = deferred()
  const startedA = deferred()
  t.after(() => gateA.resolve())
  const pausedA = run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } }, script: async () => { startedA.resolve(); await gateA.promise; return { status: 'plan_approved' } } })
  await startedA.promise
  const probePlan = await probeRun(fx, { runId: 'probe-plan', pipeline: { from: 'plan', to: 'plan' } })
  assert.equal(probePlan.result.feedback?.reason, 'workspace_busy', 'plan concorrente com one-shot aberto')
  assert.equal(probePlan.calls.length, 0)
  gateA.resolve()
  await pausedA

  const gateB = deferred()
  const startedB = deferred()
  t.after(() => gateB.resolve())
  const pausedB = run(fx, { args: { runId: 'two-b', runDir: '.graph-runs/two-b', pipeline: { from: 'plan', to: 'plan' } }, script: async () => { startedB.resolve(); await gateB.promise; return { status: 'plan_approved' } } })
  await startedB.promise
  const probeOneShot = await probeRun(fx, { runId: 'probe-oneshot', pipeline: { from: 'auto', to: 'implement' } })
  assert.equal(probeOneShot.result.feedback?.reason, 'workspace_busy', 'one-shot concorrente com plan aberto')
  assert.equal(probeOneShot.calls.length, 0)
  gateB.resolve()
  await pausedB
})

test('C3 run pausada na síntese final segura o workspace contra writer concorrente', { timeout: 20_000 }, async t => {
  const fx = await fixture(t)
  const gate = deferred()
  const started = deferred()
  t.after(() => gate.resolve())
  const finalHost = {
    capabilities: () => ({ host: 'claude', readOnlyEnforced: true, structuredOutput: true }),
    spawn: async request => ({ request }),
    wait: async handle => {
      const label = handle.request.label || ''
      const none = { severity: 'none', affectedNodes: [], evidenceIds: [] }
      let output
      if (label.startsWith('plan-review:')) output = { feedback: { kind: 'APPROVE', reason: 'stub', ...none } }
      else if (label === 'synth') { started.resolve(); await gate.promise; output = { summary: 'ok', humanGate: [] } }
      else output = { status: 'done', summary: label, confidence: 'high', checks: [] }
      return { output, requestedModel: handle.request.model, effectiveModel: handle.request.model, usage: null }
    },
  }
  const paused = runGraph({ hostName: 'claude', cwd: fx.cwd, stateDir: fx.stateDir, hostFactory: () => finalHost, evidenceFactory: fx.evidenceFactory,
    args: { runId: 'final-pausado', runDir: '.graph-runs/final-pausado', task: 'final', mode: 'research', effort: 'low', plan: { goal: 'g', complexity: 'moderate', mode: 'research', doneWhen: ['ok'], nodes: [], effort: { level: 'low', why: 'teste' } } } })
  await started.promise
  const probe = await probeRun(fx, { runId: 'probe-final', pipeline: { from: 'auto', to: 'implement' } })
  assert.equal(probe.result.feedback?.reason, 'workspace_busy')
  assert.equal(probe.calls.length, 0)
  gate.resolve()
  await paused
})

test('C3 saída por pipelineStop solta o workspace: a mesma situação repetida não vê busy', async t => {
  const fx = await fixture(t)
  await seedSlots(fx, { plan: 'needs_clarification' })
  const first = await run(fx, { args: { pipeline: { from: 'auto', to: 'implement' } } })
  assert.equal(first.result.feedback.reason, 'needs_clarification')
  const second = await probeRun(fx, { runId: 'stop-b', pipeline: { from: 'auto', to: 'implement' } })
  assert.notEqual(second.result.feedback?.reason, 'workspace_busy', JSON.stringify(second.result))
})

test('C3 retomada repega o workspace antes de ler journal e lease', async t => {
  const fx = await fixture(t)
  await run(fx, { args: { pipeline: { from: 'plan', to: 'plan' } }, script: async () => { throw new Error('queda simulada antes de qualquer gasto') } })
  const holder = createResourceLock({ stateDir: fx.stateDir })
  const token = await holder.acquire({ runId: 'holder-ws', resource: await workspaceResourceOf(fx.cwd) })
  let loads = 0
  const stateFactory = input => {
    const state = createRunState(input)
    return { ...state, load: async (lease, options) => { loads += 1; return state.load(lease, options) } }
  }
  try {
    const { result, calls } = await run(fx, { args: { resume: { requestedRerunIds: [] } }, stateFactory })
    assert.equal(result.feedback?.reason, 'workspace_busy', JSON.stringify(result))
    assert.equal(loads, 0, 'nenhuma leitura de journal antes de ter o workspace')
    assert.equal(calls.length, 0)
  } finally {
    await holder.release(token)
  }
})
