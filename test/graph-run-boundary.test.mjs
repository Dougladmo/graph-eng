import assert from 'node:assert/strict'
import test from 'node:test'
import { allocateBudget, normalizeBudgetNodes } from '../bin/budget-policy.mjs'
import { resumePipelineDispatch, validateResumeJournal } from '../bin/graph-run.mjs'

// R9b: validador de fronteira de estágio (phase.stage.started) com journals sintéticos.
const RUN = 'boundary-run'
const ROLES = ['planner', 'planReviewer', 'designReviewer', 'critic', 'synth', 'executor', 'verifier']
const LIMITS = { planner: 5, planReviewer: 5, designReviewer: 5, critic: 5, synth: 3, executor: 0, verifier: 0 }
const zeros = () => Object.fromEntries(ROLES.map(role => [role, 0]))
const base = stage => ({ planner: stage === 'implement' ? 0 : 1, planReviewer: 1, designReviewer: 1, critic: 1, synth: 1, executor: 0, verifier: 0 })
const guards = { runId: RUN, task: 't', mode: 'research', effort: 'medium', checks: [], doneWhen: ['ok'], acceptedCriteria: null }
const originalArgs = { mode: 'research', effort: 'medium', planProvided: false, pipeline: { from: 'auto', to: 'implement' } }
const legacyArgs = { mode: 'research', effort: 'medium', planProvided: false }

const ev = (seq, type, payload, planVersion = 1) => ({ schemaVersion: 2, runId: RUN, seq, type, planVersion, payload })
// Decisão de reuso (uma por run com pipeline), gravada antes da fronteira 1. Seq 0 para não deslocar os seqs dos demais eventos.
const reuse = (stages = ['plan', 'tasks'], pipelineTo = 'implement', seq = 0) => ev(seq, 'phase.reuse.resolved', { pipeline: originalArgs.pipeline, decided: { stages, pipelineTo }, rejected: [], startWorkspace: {}, startHash: {} })
// Fronteira do estágio: pipelineTo só existe no estágio tasks (espelha runPipelineStages).
const boundary = (seq, index, stage, carry = null) => ev(seq, 'phase.stage.started', { index, stage, pipelineTo: stage === 'tasks' ? 'implement' : null, carry, baseReservedByRole: base(stage) })
const budgetCall = (seq, role, usedByRole, reservedByRole, localRepairsUsed = 0) => ev(seq, 'budget.call', { role, ledger: { usedByRole, reservedByRole, limitsByRole: LIMITS, localRepairsUsed, structuralReplansUsed: 0 } })
const carryOf = (planVersion, usedByRole, localRepairsUsed = 0) => ({ planVersion, counters: { localRepairsUsed, structuralReplansUsed: 0 }, usedByRole, limitsByRole: LIMITS, tokenUsageByRole: {}, history: [], seenPairs: [] })

const PLAN = { goal: 'g', complexity: 'moderate', mode: 'research', doneWhen: ['ok'], effort: { level: 'medium', why: 'teste' }, nodes: [{ id: 'R', kind: 'research', deps: [], title: 'R', brief: 'b', acceptance: ['ok'], files: [], inputs: [], outputs: [] }] }

// Checkpoint de 'plan-approved' sem alocação (pré-alocação do plano), gravado depois da fronteira do plano.
function planCheckpoint({ seq = 0, planVersion = 1, usedByRole = zeros(), reservedByRole = base('plan'), localRepairsUsed = 0 } = {}) {
  return ev(seq, 'control.transition', { stage: 'plan-approved', checkpoint: {
    schemaVersion: 2, planVersion, plan: PLAN, originalGuards: guards,
    budgetPolicy: { id: 'graph-eng-budget-v2', effort: 'medium', mode: 'research', maxNodes: 6, maxLocalRepairs: 2, maxStructuralReplans: 2, allocation: null },
    ledger: { usedByRole, reservedByRole, limitsByRole: LIMITS, tokenUsageByRole: Object.fromEntries(ROLES.map(role => [role, null])), localRepairsUsed, structuralReplansUsed: 0 },
    control: { stage: 'plan-approved', pipelineStage: 'plan', counters: { localRepairsUsed, structuralReplansUsed: 0 }, history: [], seenPairs: [] },
    nodeRecords: [], approvals: { planReview: { kind: 'APPROVE' } },
  } }, planVersion)
}

// Checkpoint de 'budget-policy-approved' com alocação inicial, como o motor grava na fronteira tasks.
function tasksCheckpoint({ planVersion, pipelineStage = 'tasks', usedByRole = zeros(), baseReserved = base('tasks') }) {
  const nodes = normalizeBudgetNodes({ list: PLAN.nodes, mode: 'research', rails: true, existingIds: [], researchImported: true }).nodes
  const allocated = allocateBudget({ planVersion, reason: 'initial', mode: 'research', effort: 'medium', nodes, pendingNodeIds: nodes.map(node => node.id), localRepairsUsed: 0, structuralReplansUsed: 0, usedByRole, baseLimitsByRole: LIMITS, baseReservedByRole: baseReserved })
  return {
    schemaVersion: 2, planVersion, plan: PLAN, originalGuards: guards,
    budgetPolicy: { id: 'graph-eng-budget-v2', effort: 'medium', mode: 'research', maxNodes: 6, maxLocalRepairs: 2, maxStructuralReplans: 2, allocation: allocated.allocation },
    ledger: { usedByRole, reservedByRole: allocated.reservedByRole, limitsByRole: allocated.limitsByRole, tokenUsageByRole: Object.fromEntries(ROLES.map(role => [role, null])), localRepairsUsed: 0, structuralReplansUsed: 0 },
    control: { stage: 'budget-policy-approved', pipelineStage, counters: { localRepairsUsed: 0, structuralReplansUsed: 0 }, history: [], seenPairs: [] },
    nodeRecords: [], approvals: { planReview: { kind: 'APPROVE' } },
  }
}

test('fronteira 2 com carry igual ao histórico passa e zera a reserva do estágio anterior', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), budgetCall(2, 'planner', { ...zeros(), planner: 1 }, { ...base('plan'), planner: 0 }), planCheckpoint({ seq: 3, usedByRole: { ...zeros(), planner: 1 }, reservedByRole: { ...base('plan'), planner: 0 } }), approvalOf(4, 'plan-artifact-approved'), boundary(5, 2, 'tasks', carryOf(1, { ...zeros(), planner: 1 }))]
  const result = validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs })
  assert.equal(result.historicLedger.reservedByRole.planner, 1)
  assert.equal(result.activeAllocation, null)
})

test('fronteira com carry divergente do histórico invalida', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), budgetCall(2, 'planner', { ...zeros(), planner: 1 }, { ...base('plan'), planner: 0 }), planCheckpoint({ seq: 3, usedByRole: { ...zeros(), planner: 1 }, reservedByRole: { ...base('plan'), planner: 0 } }), approvalOf(4, 'plan-artifact-approved'), boundary(5, 2, 'tasks', carryOf(1, zeros()))]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_carry_mismatch:5/)
})

test('contador menor na fronteira 2 que o do journal invalida (nada diminui)', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), budgetCall(2, 'planner', { ...zeros(), planner: 1 }, { ...base('plan'), planner: 0 }, 1), planCheckpoint({ seq: 3, usedByRole: { ...zeros(), planner: 1 }, reservedByRole: { ...base('plan'), planner: 0 }, localRepairsUsed: 1 }), approvalOf(4, 'plan-artifact-approved'), boundary(5, 2, 'tasks', carryOf(1, { ...zeros(), planner: 1 }, 0))]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_carry_mismatch:5/)
})

test('fronteira com índice não sequencial invalida', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), boundary(2, 3, 'tasks', carryOf(1, zeros()))]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_boundary_invalid:2:index/)
})

test('reserva do estágio anterior não volta depois da fronteira: a fronteira zera o que sobrou (implement tem planner 0)', () => {
  const events = [
    reuse(['implement'], null),
    boundary(1, 1, 'implement'),
    budgetCall(2, 'planReviewer', { ...zeros(), planReviewer: 1 }, { planner: 0, planReviewer: 0, designReviewer: 1, critic: 1, synth: 1, executor: 0, verifier: 0 }),
  ]
  const result = validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs })
  assert.equal(result.historicLedger.reservedByRole.planner, 0)
})

test('initial na invocação 2 exige planVersion igual à base do estágio', () => {
  const carry = carryOf(1, zeros())
  const events = [reuse(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), approvalOf(3, 'plan-artifact-approved'), boundary(4, 2, 'tasks', carry), ev(5, 'control.transition', { stage: 'budget-policy-approved', checkpoint: tasksCheckpoint({ planVersion: 1 }) }, 1)]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_budget_allocation_reason_invalid:5/)
  const valid = [reuse(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), approvalOf(3, 'plan-artifact-approved'), boundary(4, 2, 'tasks', carry), ev(5, 'control.transition', { stage: 'budget-policy-approved', checkpoint: tasksCheckpoint({ planVersion: 2 }) }, 2)]
  assert.doesNotThrow(() => validateResumeJournal({ events: valid, runId: RUN, originalGuards: guards, originalArgs }))
})

test('checkpoint com pipelineStage diferente da fronteira invalida', () => {
  const carry = carryOf(1, zeros())
  const events = [reuse(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), approvalOf(3, 'plan-artifact-approved'), boundary(4, 2, 'tasks', carry), ev(5, 'control.transition', { stage: 'budget-policy-approved', checkpoint: tasksCheckpoint({ planVersion: 2, pipelineStage: 'plan' }) }, 2)]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_control_checkpoint_invalid:5:pipeline_stage/)
})

test('tombstone sem checkpoint é aceito depois da fronteira', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), ev(2, 'control.transition', { stage: 'plan-artifact-rejected', contentHash: 'x', reason: 'teste' })]
  assert.doesNotThrow(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }))
})

test('run com pipeline sem fronteira antes do primeiro budget.call é recusada', () => {
  const events = [budgetCall(1, 'planner', { ...zeros(), planner: 1 }, { ...base('plan'), planner: 0 })]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_boundary_missing:1/)
})

test('journal legado sem fronteira valida igual a antes', () => {
  const events = [budgetCall(1, 'planner', { ...zeros(), planner: 1 }, { ...base('plan'), planner: 0 })]
  const result = validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs: legacyArgs })
  assert.equal(result.historicLedger.usedByRole.planner, 1)
})

// ---------- FIX 1–3 do critic (checkpoint M1p/M2/M3/R9b) ----------

test('FIX1 phase.stage.started em run legada (sem pipeline) é recusado', () => {
  const events = [boundary(1, 1, 'plan')]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs: legacyArgs }), /resume_stage_boundary_unexpected:1/)
})

test('FIX2 fronteira com estágio diferente do decidido invalida', () => {
  const events = [reuse(['plan', 'tasks']), boundary(1, 1, 'tasks')]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_boundary_invalid:1:decided/)
})

test('FIX2 fronteira com pipelineTo diferente do decidido invalida', () => {
  const events = [reuse(['plan', 'tasks']), ev(1, 'phase.stage.started', { index: 1, stage: 'plan', pipelineTo: 'implement', carry: null, baseReservedByRole: base('plan') })]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_boundary_invalid:1:pipeline_to/)
})

test('FIX2 terceira fronteira, além dos estágios decididos, invalida', () => {
  const events = [
    reuse(['plan', 'tasks']),
    boundary(1, 1, 'plan'),
    planCheckpoint({ seq: 2 }),
    approvalOf(3, 'plan-artifact-approved'), boundary(4, 2, 'tasks', carryOf(1, zeros())),
    boundary(5, 3, 'implement', carryOf(1, zeros())),
  ]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_boundary_invalid:5:decided/)
})

test('FIX2 fronteira sem phase.reuse.resolved antes invalida', () => {
  const events = [boundary(1, 1, 'plan')]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_reuse_missing:1/)
})

test('FIX2 phase.reuse.resolved duplicado invalida', () => {
  const events = [reuse(['plan', 'tasks'], 'implement', 0), reuse(['plan', 'tasks'], 'implement', 1), boundary(2, 1, 'plan')]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_reuse_invalid:1/)
})

test('FIX2 phase.reuse.resolved com pipeline diferente do originalArgs invalida', () => {
  const wrong = { ...reuse(), payload: { ...reuse().payload, pipeline: { from: 'plan', to: 'plan' } } }
  const events = [wrong, boundary(1, 1, 'plan')]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_reuse_invalid:0/)
})

test('FIX3 fronteira 2 sem checkpoint desde a fronteira 1 invalida', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), budgetCall(2, 'planner', { ...zeros(), planner: 1 }, { ...base('plan'), planner: 0 }), boundary(3, 2, 'tasks', carryOf(1, { ...zeros(), planner: 1 }))]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_carry_missing:3/)
})

test('FIX3 carry com planVersion diferente do último checkpoint invalida', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2, planVersion: 1 }), approvalOf(3, 'plan-artifact-approved'), boundary(4, 2, 'tasks', carryOf(2, zeros()))]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_carry_mismatch:4/)
})

// R9c: o validador devolve o que o despacho da retomada precisa (estágio, fronteira, decisão, último checkpoint e aprovações).
const H = 'a'.repeat(64)
const K = 'b'.repeat(64)

test('R9c validador devolve estágio, fronteira, decisão, último checkpoint e aprovações (aprovação sem checkpoint é aceita)', () => {
  const vote = ev(5, 'result', { role: 'planReviewer', label: 'plan-review:tasks' })
  vote.result = { feedback: { kind: 'APPROVE', reason: 'ok', severity: 'none', affectedNodes: [], evidenceIds: [] } }
  const events = [reuse(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), ev(3, 'control.transition', { stage: 'plan-artifact-approved', contentHash: H }), boundary(4, 2, 'tasks', carryOf(1, zeros())), vote, ev(6, 'control.transition', { stage: 'tasks-approved', contentHash: K })]
  const result = validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs })
  assert.equal(result.stageIndex, 2)
  assert.equal(result.boundaryStage, 'tasks')
  assert.deepEqual(result.decided, { stages: ['plan', 'tasks'], pipelineTo: 'implement' })
  assert.deepEqual(result.lastCheckpoint, { seq: 2, planVersion: 1, stage: 'plan-approved', pipelineStage: 'plan' })
  assert.deepEqual(result.stageApprovals, [{ seq: 3, stage: 'plan-artifact-approved', contentHash: H }, { seq: 6, stage: 'tasks-approved', contentHash: K }])
})

test('R9c aprovação sem contentHash válido invalida', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), ev(2, 'control.transition', { stage: 'plan-artifact-approved', contentHash: 'x' })]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_approval_invalid:2/)
})

// A1/A2 (critic R10): aprovação e tombstone sem checkpoint são decisões de estágio; precisam casar com a fronteira.
const approvalOf = (seq, stage, contentHash = H) => ev(seq, 'control.transition', { stage, contentHash })
const voteOf = (seq, kind = 'APPROVE') => { const item = ev(seq, 'result', { role: 'planReviewer', label: 'plan-review' }); item.result = { feedback: { kind, reason: 'x', severity: 'none', affectedNodes: [], evidenceIds: [] } }; return item }

test('A1 aprovação sem checkpoint em run legada é recusada', () => {
  const events = [approvalOf(1, 'plan-artifact-approved')]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs: legacyArgs }), /resume_stage_approval_unexpected:1/)
})

test('A1 tasks-approved em fronteira plan é recusada', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), approvalOf(2, 'tasks-approved', K)]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_approval_unexpected:2/)
})

test('A1 segunda aprovação na mesma fronteira é recusada', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), approvalOf(2, 'plan-artifact-approved'), approvalOf(3, 'plan-artifact-approved')]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_approval_unexpected:3/)
})

test('A1 plan-needs-clarification em fronteira clarify é aceita e entra em stageApprovals', () => {
  const clarifyArgs = { ...originalArgs, pipeline: { from: 'clarify', to: 'clarify' } }
  // critic R10: decisão só de clarify (plan+clarify não é aceita); a fronteira clarify é a primeira, sem carry.
  const clarifyReuse = { ...reuse(['clarify'], null), payload: { ...reuse().payload, pipeline: clarifyArgs.pipeline, decided: { stages: ['clarify'], pipelineTo: null } } }
  const events = [clarifyReuse, boundary(1, 1, 'clarify'), approvalOf(2, 'plan-needs-clarification')]
  const result = validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs: clarifyArgs })
  assert.deepEqual(result.stageApprovals.map(item => item.seq), [2])
})

test('A2 tasks-approved sem voto APPROVE no journal invalida a retomada', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), approvalOf(3, 'plan-artifact-approved'), boundary(4, 2, 'tasks', carryOf(1, zeros())), approvalOf(5, 'tasks-approved', K)]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_approval_invalid:5:review/)
})

// R10b: despacho do resume com pipeline (gate puro sobre o journal). Casos A, B e C resumem (R10c/R10d); D e E bloqueiam.
const callOf = (seq, role, label, usedByRole, reservedByRole) => ev(seq, 'budget.call', { role, label, ledger: { usedByRole, reservedByRole, limitsByRole: LIMITS, localRepairsUsed: 0, structuralReplansUsed: 0 } })
const reuseWith = (startWorkspace, stages = ['plan'], pipelineTo = null) => ev(0, 'phase.reuse.resolved', { pipeline: originalArgs.pipeline, decided: { stages, pipelineTo }, rejected: [], startWorkspace, startHash: {} })
const reuseClarify = () => reuse(['plan', 'tasks'], 'implement')
const dispatch = (events, currentWorkspace = {}) => resumePipelineDispatch({ events, runId: RUN, originalGuards: guards, originalArgs, currentWorkspace })

test('R10b caso D: budget.call depois da fronteira sem checkpoint bloqueia resume_stage_checkpoint_missing', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), callOf(2, 'planner', 'plan', { ...zeros(), planner: 1 }, { ...base('plan'), planner: 0 })]
  const result = dispatch(events)
  assert.equal(result.case, 'D')
  assert.equal(result.reason, 'resume_stage_checkpoint_missing')
})

test('R10b caso E: tombstone depois da fronteira devolve resume_stage_rejected', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), ev(2, 'control.transition', { stage: 'plan-artifact-rejected', contentHash: H, reason: 'teste' })]
  const result = dispatch(events)
  assert.equal(result.case, 'E')
  assert.equal(result.reason, 'resume_stage_rejected')
})

// R10d: as pendências de B e C saíram do despacho (B reinvoca com checkpoint; C reinvoca com carry). Continua sem gasto.
test('R10b casos B e C despacham sem bloqueio (R10d), sem gastar nada', () => {
  assert.equal(dispatch([reuse(), boundary(1, 1, 'plan')]).case, 'C')
  assert.equal(dispatch([reuse(), boundary(1, 1, 'plan')]).reason, null)
  assert.equal(dispatch([reuse(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 })]).case, 'B')
  assert.equal(dispatch([reuse(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 })]).reason, null)
})

test('R10b usa o último checkpoint do R9c, não a última transição: aprovação sem checkpoint no fim cai em A com lastCheckpoint da fronteira', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), ev(3, 'control.transition', { stage: 'plan-artifact-approved', contentHash: H })]
  const result = dispatch(events)
  assert.equal(result.case, 'A')
  assert.equal(result.lastCheckpoint.seq, 2)
  assert.equal(result.reason, null)
})

// R10c, caso A: aprovação do estágio corrente. O motor continua fora daqui; só o despacho.
test('R10c caso A devolve a aprovação e o próximo estágio decidido, sem bloqueio', () => {
  const events = [reuse(['plan', 'tasks'], 'implement'), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), approvalOf(3, 'plan-artifact-approved', H)]
  const result = dispatch(events)
  assert.equal(result.case, 'A')
  assert.equal(result.reason, null)
  assert.equal(result.approval.seq, 3)
  assert.equal(result.approval.contentHash, H)
  assert.equal(result.nextStage, 'tasks')
})

test('R10c caso A com próximo estágio exige checkpoint depois da fronteira (carry): sem ele, resume_stage_carry_missing', () => {
  const events = [reuse(['plan', 'tasks'], 'implement'), boundary(1, 1, 'plan'), approvalOf(2, 'plan-artifact-approved', H)]
  assert.equal(dispatch(events).reason, 'resume_stage_carry_missing')
})

test('R10c caso A sem próximo estágio decidido não exige carry (fim do pipeline)', () => {
  const events = [reuse(['plan'], null), boundary(1, 1, 'plan'), approvalOf(2, 'plan-artifact-approved', H)]
  const result = dispatch(events)
  assert.equal(result.case, 'A')
  assert.equal(result.reason, null)
  assert.equal(result.nextStage, null)
})

// R10d: a pendência virou fechamento explícito (o live para no needs_clarification; a retomada não tem esse resultado sem reinvocar).
test('R10c aprovação plan-needs-clarification fica fechada (resume_needs_clarification_unsupported)', () => {
  const events = [reuse(['clarify'], null), boundary(1, 1, 'clarify'), approvalOf(2, 'plan-needs-clarification', H)]
  assert.equal(dispatch(events).reason, 'resume_needs_clarification_unsupported')
})

test('R10c tasks com pipelineTo implement e checkpoint depois da aprovação despacha B com a aprovação (R10d)', () => {
  const vote = ev(2, 'result', { role: 'planReviewer', label: 'plan-review:tasks' })
  vote.result = { feedback: { kind: 'APPROVE', reason: 'ok', severity: 'none', affectedNodes: [], evidenceIds: [] } }
  const events = [reuse(['tasks'], 'implement'), boundary(1, 1, 'tasks'), vote, approvalOf(3, 'tasks-approved', K), ev(4, 'control.transition', { stage: 'budget-policy-approved', checkpoint: tasksCheckpoint({ planVersion: 1 }) }, 1)]
  const result = dispatch(events)
  assert.equal(result.case, 'B')
  assert.equal(result.reason, null)
  assert.deepEqual(result.resumeStageApproved, { tasks: { seq: 3, contentHash: K } })
})

test('R10c caso A em estágio só de leitura com workspace diferente bloqueia workspace_changed_during_stage', () => {
  const events = [{ ...reuseWith({ head: 'h1' }, ['plan', 'tasks'], 'implement') }, boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), approvalOf(3, 'plan-artifact-approved', H)]
  assert.equal(dispatch(events, { head: 'h2' }).reason, 'workspace_changed_during_stage')
  assert.equal(dispatch(events, { head: 'h1' }).reason, null)
})

// R10b (escopo): intent antes da fronteira corrente não entra no despacho; o mesmo intent depois da fronteira bloqueia.
test('R10b intent sem resolução antes da fronteira corrente não bloqueia a retomada', () => {
  const intent = ev(2, 'result', { stage: 'node-fix-intent', nodeId: 'R', checkpoint: null })
  const events = [reuseClarify(), boundary(1, 1, 'plan'), intent, planCheckpoint({ seq: 3 }), approvalOf(4, 'plan-artifact-approved'), boundary(5, 2, 'tasks', carryOf(1, zeros()))]
  assert.equal(dispatch(events).reason, null)
  assert.equal(dispatch(events).case, 'C')
})

test('R10b intent sem resolução depois da fronteira corrente bloqueia resume_pending_control_intent', () => {
  const intent = ev(5, 'result', { stage: 'node-fix-intent', nodeId: 'R', checkpoint: null })
  const events = [reuseClarify(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), approvalOf(3, 'plan-artifact-approved'), boundary(4, 2, 'tasks', carryOf(1, zeros())), intent]
  assert.equal(dispatch(events).reason, 'resume_pending_control_intent:node-fix-intent:5')
})

test('R10b primeira chamada do estágio 2 com rótulo errado bloqueia por fronteira', () => {
  const events = [reuseClarify(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), approvalOf(3, 'plan-artifact-approved'), boundary(4, 2, 'tasks', carryOf(1, zeros())), callOf(5, 'planReviewer', 'plan-review:r1', { ...zeros(), planReviewer: 1 }, { ...base('tasks'), planReviewer: 0 })]
  assert.equal(dispatch(events).reason, 'resume_initial_plan_origin_mismatch:tasks')
})

// critic R10: o estágio 2 agora é tasks (decisão aceita [plan,tasks]); a primeira chamada de tasks com rótulo de plan é recusada por origem.
// Trava que qualquer chamada na fronteira tasks bloqueia por origem.
test('R10b primeira chamada de tasks com rótulo diferente de plan bloqueia por origem', () => {
  const events = [reuseClarify(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), approvalOf(3, 'plan-artifact-approved'), boundary(4, 2, 'tasks', carryOf(1, zeros())), callOf(5, 'planner', 'tasks', { ...zeros(), planner: 1 }, { ...base('tasks'), planner: 0 })]
  assert.equal(dispatch(events).reason, 'resume_initial_plan_origin_mismatch:tasks')
})

test('R10b voto FIX_LOCAL do estágio 1 sem resolução não bloqueia a retomada no estágio 2 (escopo pela fronteira corrente)', () => {
  const vote = ev(2, 'result', { stage: 'critic-reviewed', feedback: { kind: 'FIX_LOCAL', reason: 'x', severity: 'low', affectedNodes: [], evidenceIds: [] } })
  const events = [reuseClarify(), boundary(1, 1, 'plan'), vote, planCheckpoint({ seq: 3 }), approvalOf(4, 'plan-artifact-approved'), boundary(5, 2, 'tasks', carryOf(1, zeros()))]
  assert.equal(dispatch(events).reason, null)
  assert.equal(dispatch(events).case, 'C')
})

test('R10b voto FIX_LOCAL sem resolução na fronteira corrente bloqueia resume_pending_critic_vote', () => {
  const vote = ev(5, 'result', { stage: 'critic-reviewed', feedback: { kind: 'FIX_LOCAL', reason: 'x', severity: 'low', affectedNodes: [], evidenceIds: [] } })
  const events = [reuseClarify(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), approvalOf(3, 'plan-artifact-approved'), boundary(4, 2, 'tasks', carryOf(1, zeros())), vote]
  assert.equal(dispatch(events).reason, 'resume_pending_critic_vote:FIX_LOCAL:5')
})

test('R10b handle iniciado no estágio 1 e não terminado bloqueia mesmo com fronteira 2 (handles no journal inteiro)', () => {
  const started = { ...ev(1, 'started', {}), agentId: 'a1' }
  const events = [reuseClarify(), started, boundary(2, 1, 'plan'), planCheckpoint({ seq: 3 }), approvalOf(4, 'plan-artifact-approved'), boundary(5, 2, 'tasks', carryOf(1, zeros()))]
  assert.equal(dispatch(events).reason, 'resume_inflight_agent_ambiguous:a1')
})


test('R10b failed CLEANUP_FAILED ou drainUnproven não fecha handle no despacho de pipeline', () => {
  const started = { ...ev(1, 'started', {}), agentId: 'a1' }
  const prefix = [reuseClarify(), started, boundary(2, 1, 'plan'), planCheckpoint({ seq: 3 }), approvalOf(4, 'plan-artifact-approved'), boundary(5, 2, 'tasks', carryOf(1, zeros()))]
  const cleanupFailed = { ...ev(6, 'failed', { role: 'executor', drainUnproven: true }), agentId: 'a1', error: { code: 'CLEANUP_FAILED', message: 'sem prova' } }
  const drainFlag = { ...ev(6, 'failed', { role: 'executor', drainUnproven: true }), agentId: 'a1', error: { code: 'CANCELLED', message: 'cancelado' } }
  for (const terminal of [cleanupFailed, drainFlag]) assert.equal(dispatch([...prefix, terminal]).reason, 'resume_inflight_agent_ambiguous:a1')
  const ordinary = { ...ev(6, 'failed', { role: 'executor' }), agentId: 'a1', error: { code: 'CLI_FAILED', message: 'falha comum' } }
  assert.notEqual(dispatch([...prefix, ordinary]).reason, 'resume_inflight_agent_ambiguous:a1')
})

test('R10b estágio só de leitura com workspace diferente do início bloqueia workspace_changed_during_stage', () => {
  const events = [reuseWith({ head: 'h1' }), boundary(1, 1, 'plan')]
  assert.equal(dispatch(events, { head: 'h1' }).reason, null)
  assert.equal(dispatch(events, { head: 'h2' }).reason, 'workspace_changed_during_stage')
})

// critic R10: tasks->implement sem aprovação depois da fronteira só retoma com o workspace do início (nada foi gravado ainda).
test('critic R10 tasks->implement sem tasks-approved depois da fronteira: workspace diferente bloqueia workspace_changed_during_stage', () => {
  const events = [reuseWith({ head: 'h1' }, ['tasks'], 'implement'), boundary(1, 1, 'tasks')]
  assert.equal(dispatch(events, { head: 'h2' }).reason, 'workspace_changed_during_stage')
  assert.equal(dispatch(events, { head: 'h1' }).reason, null)
})

// critic R10: com aprovação e checkpoint depois dela, o estágio já gravou: o workspace não entra no despacho (caso B).
test('critic R10 tasks->implement com tasks-approved e checkpoint depois: workspace diferente não bloqueia e despacha B', () => {
  const vote = ev(2, 'result', { role: 'planReviewer', label: 'plan-review:tasks' })
  vote.result = { feedback: { kind: 'APPROVE', reason: 'ok', severity: 'none', affectedNodes: [], evidenceIds: [] } }
  const events = [reuseWith({ head: 'h1' }, ['tasks'], 'implement'), boundary(1, 1, 'tasks'), vote, approvalOf(3, 'tasks-approved', K), ev(4, 'control.transition', { stage: 'budget-policy-approved', checkpoint: tasksCheckpoint({ planVersion: 1 }) }, 1)]
  const result = dispatch(events, { head: 'h2' })
  assert.equal(result.case, 'B')
  assert.equal(result.reason, null)
})

// critic R10: fronteira N+1 exige aprovação do estágio N entre as duas fronteiras.
test('critic R10 fronteira 2 sem aprovação do estágio 1 é recusada: resume_stage_boundary_invalid:unapproved', () => {
  const events = [reuse(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), boundary(3, 2, 'tasks', carryOf(1, zeros()))]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_boundary_invalid:3:unapproved/)
})

// critic R10: decisão fora das aceitas (ex.: plan+clarify, que o runner nunca grava) é recusada.
test('critic R10 decisão plan+clarify (não gravada pelo runner) é recusada como reuse_invalid', () => {
  const events = [reuse(['plan', 'clarify'], null), boundary(1, 1, 'plan')]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_reuse_invalid:0/)
})

test('R10b journal sem fronteira 1 é recusado: resume_stage_boundary_missing', () => {
  assert.equal(dispatch([reuse()]).reason, 'resume_stage_boundary_missing')
})

test('R10b primeira chamada do estágio implement exige planReviewer plan-review:r1 da tabela fixa', () => {
  const events = [reuse(['implement'], null), boundary(1, 1, 'implement'), callOf(2, 'planner', 'plan', { ...zeros(), planner: 1 }, { ...base('implement'), planner: 0 })]
  assert.equal(dispatch(events).reason, 'resume_initial_plan_origin_mismatch:implement')
})

test('R10b retomada no estágio tasks chama primeiro o rótulo certo (planner, plan)', () => {
  // planVersion do estágio tasks = carry.planVersion + 1 (carry com planVersion 1).
  const tasksCp = tasksCheckpoint({ planVersion: 2, usedByRole: { ...zeros(), planner: 1 }, baseReserved: { ...base('tasks'), planner: 0 } })
  const events = [reuse(['plan', 'tasks'], 'implement'), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), approvalOf(3, 'plan-artifact-approved'), boundary(4, 2, 'tasks', carryOf(1, zeros())), callOf(5, 'planner', 'plan', { ...zeros(), planner: 1 }, { ...base('tasks'), planner: 0 }), ev(6, 'control.transition', { stage: 'budget-policy-approved', checkpoint: tasksCp }, 2)]
  // Origem certa: a chamada passa pela tabela; com o checkpoint de tasks depois dela, a retomada cai no caso B sem bloqueio.
  const result = dispatch(events)
  assert.equal(result.case, 'B')
  assert.equal(result.reason, null)
})

// R10d: casos B e C do despacho (sem pending). B = checkpoint depois da fronteira sem aprovação; C = fronteira sem gasto nem checkpoint.
test('R10d caso B: checkpoint depois da fronteira sem aprovação devolve B com o checkpoint, sem bloqueio', () => {
  const result = dispatch([reuse(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 })])
  assert.equal(result.case, 'B')
  assert.equal(result.reason, null)
  assert.equal(result.checkpoint.planVersion, 1)
  assert.equal(result.checkpoint.control.pipelineStage, 'plan')
})

test('R10d caso C: fronteira de estágio 2 sem gasto nem checkpoint devolve C com o carry gravado na fronteira', () => {
  const carry = carryOf(1, zeros())
  const result = dispatch([reuse(), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), approvalOf(3, 'plan-artifact-approved'), boundary(4, 2, 'tasks', carry)])
  assert.equal(result.case, 'C')
  assert.equal(result.reason, null)
  assert.deepEqual(result.carry, carry)
  assert.equal(result.startIndex, 1)
})

// R11: one-shot com checks. O checkpoint do plan grava originalGuards com os CheckSpec da run; o estágio de leitura não os recebe, mas a retomada valida.
test('R11 retomada caso B no plan de uma one-shot com checks valida', () => {
  const spec = { id: 'node-test', command: 'node', args: ['--test'], cwd: '.', timeoutMs: 1000, heavy: true }
  const withChecks = { ...guards, checks: [spec] }
  const checkpoint = planCheckpoint({ seq: 2 })
  checkpoint.payload.checkpoint.originalGuards = withChecks
  const result = resumePipelineDispatch({ events: [reuse(), boundary(1, 1, 'plan'), checkpoint], runId: RUN, originalGuards: withChecks, originalArgs: { ...originalArgs, checks: [spec] }, currentWorkspace: {} })
  assert.equal(result.case, 'B')
  assert.equal(result.reason, null)
  assert.equal(result.checkpoint.planVersion, 1)
})

test('R10d caso C no estágio 1 devolve carry null e startIndex 0', () => {
  const result = dispatch([reuse(), boundary(1, 1, 'plan')])
  assert.equal(result.case, 'C')
  assert.equal(result.carry, null)
  assert.equal(result.startIndex, 0)
})

test('R10d caso B com tasks->implement e checkpoint depois da aprovação devolve B com a aprovação em resumeStageApproved', () => {
  const vote = ev(2, 'result', { role: 'planReviewer', label: 'plan-review:tasks' })
  vote.result = { feedback: { kind: 'APPROVE', reason: 'ok', severity: 'none', affectedNodes: [], evidenceIds: [] } }
  const events = [reuse(['tasks'], 'implement'), boundary(1, 1, 'tasks'), vote, approvalOf(3, 'tasks-approved', K), ev(4, 'control.transition', { stage: 'budget-policy-approved', checkpoint: tasksCheckpoint({ planVersion: 1 }) }, 1)]
  const result = dispatch(events)
  assert.equal(result.case, 'B')
  assert.equal(result.reason, null)
  assert.deepEqual(result.resumeStageApproved, { tasks: { seq: 3, contentHash: K } })
})

test('R10d plan-needs-clarification em A fica fechado com resume_needs_clarification_unsupported (sem contrato para devolver o status)', () => {
  const events = [reuse(['plan', 'tasks'], 'implement'), boundary(1, 1, 'plan'), planCheckpoint({ seq: 2 }), approvalOf(3, 'plan-needs-clarification', H)]
  const result = dispatch(events)
  assert.equal(result.case, null)
  assert.equal(result.reason, 'resume_needs_clarification_unsupported')
})

test('aprovação com checkpoint invalida a retomada (resume_stage_approval_invalid:<seq>:checkpoint)', () => {
  const approval = approvalOf(3, 'plan-artifact-approved')
  const withCheckpoint = { ...approval, payload: { ...approval.payload, checkpoint: planCheckpoint({ seq: 2 }).payload.checkpoint } }
  const events = [reuse(), boundary(1, 1, 'plan'), withCheckpoint]
  assert.throws(() => validateResumeJournal({ events, runId: RUN, originalGuards: guards, originalArgs }), /resume_stage_approval_invalid:3:checkpoint/)
})
