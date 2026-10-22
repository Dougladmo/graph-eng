import assert from 'node:assert/strict'
import test from 'node:test'
import { runWorkflow, defaultScript, criticDoneFromPrompt } from './helpers/run-workflow.mjs'
import { allocateBudget } from '../bin/budget-policy.mjs'
import { questionSetIdOf } from '../bin/phase-artifacts.mjs'

// M1/M2: o motor aceita A.stage (vindo só do runner de pipeline) e marca o checkpoint com
// pipelineStage apenas nessas runs. Runs legadas (sem stage) mantêm o checkpoint de hoje.
const PLAN = {
  goal: 'estágio de pipeline', complexity: 'simple', mode: 'research',
  doneWhen: ['ok'], effort: { level: 'medium', why: 'teste' },
  nodes: [{ id: 'R', kind: 'research', title: 'R', brief: 'pesquisar', deps: [], risk: 'low', acceptance: ['fonte'], files: [], inputs: [], outputs: [] }],
}

function runtimeWithEvents(events, prepared = []) {
  let seq = 0
  return {
    // Espelha makePreparePhaseArtifact: o questionSetId vem do próprio rascunho selado.
    preparePhaseArtifact: async input => { prepared.push(input); return { contentHash: `hash-plan-${prepared.length}`, status: input.status, questionSetId: input.content?.openQuestions?.length ? questionSetIdOf(input.content.openQuestions) : null } },
    host: 'test',
    models: { planner: 'test-strong', planReviewer: 'test-strong', designReviewer: 'test-strong', executor: 'test-cheap', verifier: 'test-cheap', critic: 'test-strong', synth: 'test-cheap' },
    capabilities: { checks: true, fingerprint: true, readOnlyEnforced: true },
    snapshot: async () => ({ schemaVersion: 2, identity: 'test-delivery-identity', evidencePath: 'test/snapshot.json', evidenceHash: 'test-snapshot-hash', manifestSpecs: {} }),
    fingerprint: async () => ({ schemaVersion: 2, identity: 'test-node-identity' }),
    runChecks: async ({ snapshot, checks }) => checks.map((check, index) => ({ schemaVersion: 2, id: `test-receipt-${index}`, runId: 'test-run', checkId: check.id, identity: snapshot.identity, valid: true, evidencePath: `test/receipt-${index}.json`, evidenceHash: `test-receipt-hash-${index}` })),
    verifyArtifact: async artifact => Boolean(artifact?.evidencePath && artifact?.evidenceHash),
    emit: async event => { const record = { ...event, seq: ++seq }; events.push(record); return record },
    saveState: async value => value,
    // C9: fixture do backup do polish feito pelo supervisor (só refs; o runner real grava os bytes).
    backupPolishArea: async ({ files }) => ({ backupDir: '.graph-runs/test/polish-backups/fake', files: files.map(file => ({ path: file, kind: 'file', executable: false, sha256: 'a'.repeat(64), backupPath: `.graph-runs/test/polish-backups/fake/${file}` })) }),
  }
}

async function run(args) {
  const events = []
  const { result, calls } = await runWorkflow({ task: 'marcar estágio', mode: 'research', effort: 'max', plan: PLAN, ...args }, defaultScript(), { runtime: runtimeWithEvents(events) })
  return { result, calls, events }
}

test('run de pipeline (stage definido) marca o checkpoint com pipelineStage', async () => {
  const { events } = await run({ stage: 'plan' })
  const checkpoint = events.filter(event => event.type === 'control.transition').at(-1).payload.checkpoint
  assert.equal(checkpoint.control.pipelineStage, 'plan', JSON.stringify(checkpoint.control))
})

test('run legada (sem stage) não ganha pipelineStage no checkpoint', async () => {
  const { events } = await run({})
  const checkpoint = events.filter(event => event.type === 'control.transition').at(-1).payload.checkpoint
  assert.equal('pipelineStage' in checkpoint.control, false, JSON.stringify(checkpoint.control))
})

test('stage fora da lista de estágios é recusado antes de qualquer nó rodar', async () => {
  const { result, calls } = await run({ stage: 'deploy' })
  assert.match(JSON.stringify(result), /stage_invalid/)
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), [], JSON.stringify(calls))
})

test('one-shot: carry do estágio anterior semeia planVersion, replan estrutural e usedByRole sem diminuir; o pool local recomeça', async () => {
  const events = []
  const zeros = { planner: 0, planReviewer: 0, designReviewer: 0, critic: 0, synth: 0, executor: 0, verifier: 0 }
  const stageCarry = {
    planVersion: 3, counters: { localRepairsUsed: 1, structuralReplansUsed: 1 }, usedByRole: { ...zeros, planner: 2 },
    limitsByRole: { planner: 5, planReviewer: 5, designReviewer: 5, critic: 5, synth: 3, executor: 0, verifier: 0 },
    tokenUsageByRole: Object.fromEntries(Object.keys(zeros).map(role => [role, null])), history: [], seenPairs: [],
  }
  await runWorkflow({ task: 'carry', mode: 'research', effort: 'max', plan: PLAN, stage: 'tasks' }, defaultScript(), { runtime: { ...runtimeWithEvents(events), stageCarry } })
  const checkpoints = events.filter(event => event.type === 'control.transition' && event.payload?.checkpoint).map(event => event.payload.checkpoint)
  assert.ok(checkpoints.length > 0)
  assert.equal(checkpoints[0].planVersion, 4, JSON.stringify(checkpoints[0].planVersion))
  for (const cp of checkpoints) {
    assert.ok(cp.planVersion >= 4)
    assert.ok(cp.ledger.usedByRole.planner >= 2, JSON.stringify(cp.ledger.usedByRole))
    assert.equal(cp.control.counters.localRepairsUsed, 0, 'pool de reparos locais é do estágio')
    assert.ok(cp.control.counters.structuralReplansUsed >= 1)
  }
})

// R10d (M-R1): na retomada, o estágio do checkpoint tem de ser o STAGE da invocação; divergência recusa antes de qualquer spawn.
async function checkpointFromStage(stage) {
  const { events } = await run({ stage })
  return events.filter(event => event.type === 'control.transition' && event.payload?.checkpoint).at(-1).payload.checkpoint
}

async function resumeAt(checkpoint, args) {
  return runWorkflow({ task: 'retomada de estágio', mode: 'research', effort: 'max', plan: PLAN, ...args }, defaultScript(), { runtime: { ...runtimeWithEvents([]), resumeCheckpoint: checkpoint, resumeId: 'rs-20261019-000000' } })
}

test('M-R1 checkpoint de plan retomado em tasks devolve stage_resume_mismatch sem gastar', async () => {
  const checkpoint = await checkpointFromStage('plan')
  const { result, calls } = await resumeAt(checkpoint, { stage: 'tasks' })
  assert.match(JSON.stringify(result), /stage_resume_mismatch/)
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), [], JSON.stringify(calls))
})

test('M-R1 checkpoint com pipelineStage retomado em run legada (sem stage) devolve stage_resume_mismatch', async () => {
  const checkpoint = await checkpointFromStage('plan')
  const { result, calls } = await resumeAt(checkpoint, {})
  assert.match(JSON.stringify(result), /stage_resume_mismatch/)
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), [], JSON.stringify(calls))
})

test('M-R1 checkpoint legado (sem pipelineStage) retomado com stage devolve stage_resume_mismatch', async () => {
  const { events } = await run({})
  const checkpoint = events.filter(event => event.type === 'control.transition' && event.payload?.checkpoint).at(-1).payload.checkpoint
  const { result, calls } = await resumeAt(checkpoint, { stage: 'plan' })
  assert.match(JSON.stringify(result), /stage_resume_mismatch/)
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), [], JSON.stringify(calls))
})

test('M-R1 mesmo estágio na retomada não é recusado pelo gate', async () => {
  const checkpoint = await checkpointFromStage('plan')
  const { result } = await resumeAt(checkpoint, { stage: 'plan' })
  assert.doesNotMatch(JSON.stringify(result), /stage_resume_mismatch/)
})

// M1/M4/M5/M6: estágio plan (research only, critério próprio, FIX_LOCAL/REPLAN de research, saída com artefato).
function research(id) {
  return { id, kind: 'research', title: id, brief: 'pesquisar', deps: [], risk: 'low', acceptance: ['fonte'], files: [], inputs: [], outputs: [] }
}
const PLAN_R = { goal: 'estágio plan', complexity: 'simple', mode: 'research', doneWhen: ['ok'], effort: { level: 'max', why: 'teste' }, nodes: [research('R1'), research('R2')] }
const BLOCKING = { kind: 'FIX_LOCAL', reason: 'falta fonte', severity: 'medium', affectedNodes: ['R1'], evidenceIds: [] }

// Saídas do critic em ordem; depois de esgotadas, o padrão (DONE válido).
function criticScript(outputs, plan = PLAN_R) {
  const base = defaultScript({ plan })
  const prompts = []
  let n = 0
  const script = async (label, prompt, opts) => {
    if (label.startsWith('critic:')) { prompts.push(prompt); const out = outputs[n++]; if (out) return out; return { feedback: { kind: 'DONE', reason: 'ok', severity: 'none', affectedNodes: [], evidenceIds: [] }, done: true, assessment: 'ok', gaps: [], ...criticDoneFromPrompt(prompt) } }
    return base(label, prompt, opts)
  }
  return { script, prompts }
}

async function stageRun(args, { script = criticScript([]).script, runtime, events = [], prepared = [] } = {}) {
  const rt = runtime ?? runtimeWithEvents(events, prepared)
  const { result, calls, logs } = await runWorkflow({ task: 'estágio plan', mode: 'research', effort: 'max', plan: PLAN_R, stage: 'plan', ...args }, script, { runtime: rt })
  return { result, calls: calls.filter(label => !label.startsWith('#')), logs, events, prepared }
}

const transitions = events => events.filter(event => event.type === 'control.transition').map(event => event.payload.stage)

test('M1 stage plan força mode research mesmo com mode implement pedido', async () => {
  const { logs } = await stageRun({ mode: 'implement' })
  assert.ok(logs.some(line => line === 'modo: research -> research'), JSON.stringify(logs))
})

test('M1 stage plan com planOnly bloqueia stage_plan_only_conflict sem spawn', async () => {
  const { result, calls } = await stageRun({ planOnly: true })
  assert.match(JSON.stringify(result), /stage_plan_only_conflict/)
  assert.deepEqual(calls, [], JSON.stringify(calls))
})

test('M1 stage plan sem preparePhaseArtifact bloqueia phase_artifact_runtime_unavailable sem spawn', async () => {
  const { preparePhaseArtifact, ...withoutPrepare } = runtimeWithEvents([])
  const { result, calls } = await stageRun({}, { runtime: withoutPrepare })
  assert.match(JSON.stringify(result), /phase_artifact_runtime_unavailable/)
  assert.deepEqual(calls, [], JSON.stringify(calls))
})

test('M4 plan: schema do estágio tem risks e até 5 perguntas, e o prompt carrega Q/A e plano importado como dado', async () => {
  const prompts = []
  const base = defaultScript()
  const script = async (label, prompt, opts) => { if (label === 'plan') prompts.push({ prompt, schema: opts.schema }); return base(label, prompt, opts) }
  await stageRun({ plan: null, importedPlan: { goal: 'PLANO_ANTIGO_456' }, clarificationContext: { answers: ['MARCADOR_QA_123'] } }, { script })
  const [first] = prompts
  assert.ok(first, 'planner não foi chamado')
  assert.ok(first.schema.properties.risks, JSON.stringify(Object.keys(first.schema.properties)))
  assert.equal(first.schema.properties.questions.maxItems, 5)
  assert.match(first.prompt, /Return only research nodes/)
  assert.match(first.prompt, /MARCADOR_QA_123/)
  assert.match(first.prompt, /PLANO_ANTIGO_456/)
})

test('M4 plan: critic julga os critérios de suficiência da research, não o doneWhen do usuário', async () => {
  const { script, prompts } = criticScript([])
  await stageRun({}, { script })
  assert.ok(prompts.length >= 1)
  assert.match(prompts[0], /Every risk listed in the plan/)
})

// A2: sem shell de agente (Claude), nenhum prompt exige comando; com shell (Codex), o baseline por worktree continua.
const shellRuntime = agentShell => ({ ...runtimeWithEvents([]), capabilities: { checks: true, fingerprint: true, readOnlyEnforced: true, transport: { agentShell } } })

test('A2 sem agentShell: planner não exige comandos e o worker de pesquisa não recebe instrução de shell', async () => {
  const prompts = {}
  const base = defaultScript({ plan: PLAN_R })
  const script = async (label, prompt, opts) => { if (label === 'plan' || label.startsWith('work:')) prompts[label] ??= prompt; return base(label, prompt, opts) }
  await stageRun({ plan: null }, { script })
  assert.match(prompts.plan ?? '', /never require a node to run commands/)
  assert.ok(prompts['work:R1'], JSON.stringify(Object.keys(prompts)))
  assert.doesNotMatch(prompts['work:R1'], /git worktree/)
  assert.doesNotMatch(prompts['work:R1'], /run the fastest relevant check/)
  assert.match(prompts['work:R1'], /You cannot run commands/)
})

test('A2 com agentShell:true: o baseline por git worktree e a checagem rápida do implement continuam no prompt', async () => {
  const prompts = {}
  const base = defaultScript({ plan: PLAN_R })
  const script = async (label, prompt, opts) => { if (label.startsWith('work:')) prompts[label] ??= prompt; return base(label, prompt, opts) }
  await stageRun({}, { script, runtime: shellRuntime(true) })
  assert.match(prompts['work:R1'], /git worktree add --detach/)
  assert.doesNotMatch(prompts['work:R1'], /You cannot run commands/)
})

test('A2 critic do estágio plan julga o critério de status done de todo nó de pesquisa', async () => {
  const { script, prompts } = criticScript([])
  await stageRun({}, { script })
  assert.match(prompts[0] ?? '', /Every research node finished with status done; a partial or blocked node is an unmet criterion/)
})

test('A2 critic DONE com pesquisa partial ainda bloqueia plan_stage_research_incomplete', async () => {
  const base = defaultScript({ plan: PLAN_R })
  const { script: critic } = criticScript([])
  const script = async (label, prompt, opts) => {
    if (label === 'work:R1') return { ...(await base(label, prompt, opts)), status: 'partial' }
    return critic(label, prompt, opts)
  }
  const { result } = await stageRun({}, { script })
  assert.match(JSON.stringify(result), /plan_stage_research_incomplete/, JSON.stringify(result).slice(0, 400))
})

test('M4 plan: nó que não é research depois da revisão bloqueia plan_stage_non_research_node sem executar', async () => {
  const bad = { ...research('I1'), kind: 'implement', files: ['src/a.js'] }
  const base = defaultScript({ plan: { ...PLAN_R, nodes: [research('R1'), bad] } })
  const { result, calls } = await stageRun({ plan: null }, { script: base })
  assert.match(JSON.stringify(result), /plan_stage_non_research_node/)
  assert.equal(calls.filter(label => label.startsWith('work:')).length, 0, JSON.stringify(calls))
})

test('M5 critic FIX_LOCAL de research refaz só o nó afetado e emite critic-fix-complete', async () => {
  const events = []
  const { script } = criticScript([{ feedback: BLOCKING, done: false, assessment: 'falta', gaps: [] }])
  const { result, calls } = await stageRun({}, { script, events })
  assert.equal(calls.filter(label => label === 'work:R1').length, 2, JSON.stringify(calls))
  assert.equal(calls.filter(label => label === 'work:R2').length, 1, JSON.stringify(calls))
  const fix = events.filter(event => event.type === 'control.transition' && event.payload.stage === 'critic-fix-complete')
  assert.equal(fix.length, 1, JSON.stringify(transitions(events)))
  assert.deepEqual(fix[0].payload.targets, ['R1'])
  assert.equal(result.status, 'plan_approved', JSON.stringify(result))
})

// Regressão (benchmark real Claude 7df4, 21/10/2026): o critic pediu FIX_LOCAL em R2 duas vezes com o mesmo motivo e a run
// bloqueou com no_progress_feedback_loop. O R2 refeito recebia o mesmo prompt, sem o motivo do critic.
test('M5 regressão: o nó refeito por FIX_LOCAL do critic recebe o motivo do critic no prompt', async () => {
  const fix = { ...BLOCKING, reason: 'feche a pergunta sobre o glob como não bloqueante e termine done' }
  const prompts = []
  const { script: critic } = criticScript([{ feedback: fix, done: false, assessment: 'falta', gaps: [] }])
  const script = async (label, prompt, opts) => { if (label === 'work:R1') prompts.push(prompt); return critic(label, prompt, opts) }
  await stageRun({}, { script })
  assert.equal(prompts.length, 2)
  assert.doesNotMatch(prompts[0], /feche a pergunta sobre o glob/)
  assert.match(prompts[1], /critic/i)
  assert.match(prompts[1], /feche a pergunta sobre o glob como não bloqueante e termine done/)
})

// Regressão (mesmo benchmark): o planner exigiu "citar a doc do Node (URL)" e o host Claude não tem web. Sem agentWeb, o
// planner não pode pedir fonte externa e a pesquisa não manda usar WebFetch/WebSearch.
test('sem agentWeb: planner não exige fonte externa e o worker de pesquisa não manda usar web', async () => {
  const prompts = {}
  const base = defaultScript({ plan: PLAN_R })
  const script = async (label, prompt, opts) => { if (label === 'plan' || label.startsWith('work:')) prompts[label] ??= prompt; return base(label, prompt, opts) }
  await stageRun({ plan: null }, { script })
  assert.match(prompts.plan ?? '', /no web access/i)
  assert.doesNotMatch(prompts['work:R1'], /WebFetch|WebSearch/)
  assert.match(prompts['work:R1'], /no web access/i)
  const web = {}
  const webScript = async (label, prompt, opts) => { if (label.startsWith('work:')) web[label] ??= prompt; return base(label, prompt, opts) }
  await stageRun({}, { script: webScript, runtime: { ...shellRuntime(false), capabilities: { checks: true, fingerprint: true, readOnlyEnforced: true, transport: { agentShell: false, agentWeb: true } } } })
  assert.match(web['work:R1'], /WebFetch/)
})

// Planner que devolve um plano diferente a cada chamada (um replan igual cai em plan_no_progress).
function variantPlanScript(criticOutputs) {
  let version = 0
  const { script: critic } = criticScript(criticOutputs)
  return async (label, prompt, opts) => {
    if (label === 'plan') { version++; return { ...PLAN_R, nodes: [{ ...research('R1'), brief: 'pesquisar v' + version }, research('R2')] } }
    return critic(label, prompt, opts)
  }
}

test('M5 REPLAN do critic chama o planner de novo e segue até a aprovação', async () => {
  const replan = { kind: 'REPLAN', reason: 'plano incompleto', severity: 'high', affectedNodes: ['R1'], evidenceIds: [] }
  const script = variantPlanScript([{ feedback: replan, done: false, assessment: 'x', gaps: [] }])
  const { result, calls } = await stageRun({}, { script })
  assert.equal(calls.filter(label => label === 'plan').length, 1, JSON.stringify(calls))
  assert.equal(result.status, 'plan_approved', JSON.stringify(result))
})

test('M5 terceiro REPLAN bloqueia com structural_replan_budget_exhausted', async () => {
  const replan = reason => ({ feedback: { kind: 'REPLAN', reason, severity: 'high', affectedNodes: ['R1'], evidenceIds: [] }, done: false, assessment: 'x', gaps: [] })
  const script = variantPlanScript([replan('r1'), replan('r2'), replan('r3')])
  const { result, calls } = await stageRun({}, { script })
  assert.equal(calls.filter(label => label === 'plan').length, 2, JSON.stringify(calls))
  assert.equal(result.feedback?.reason, 'structural_replan_budget_exhausted', JSON.stringify(result))
  assert.notEqual(result.status, 'done')
})

test('M6 run to:plan com critic DONE não tem status done nem done-approved', async () => {
  const { result, events } = await stageRun({})
  assert.equal(result.status, 'plan_approved', JSON.stringify(result))
  assert.equal(transitions(events).includes('done-approved'), false, JSON.stringify(transitions(events)))
})

test('M6 plan aprovado publica o artefato e grava plan-artifact-approved com o contentHash devolvido', async () => {
  const { prepared, events } = await stageRun({})
  assert.equal(prepared.length, 1)
  assert.equal(prepared[0].kind, 'plan')
  assert.equal(prepared[0].status, 'approved')
  assert.ok(Array.isArray(prepared[0].critic.evidenceIds) && prepared[0].critic.evidenceIds.length > 0)
  const approved = events.filter(event => event.type === 'control.transition' && event.payload.stage === 'plan-artifact-approved')
  assert.equal(approved.length, 1, JSON.stringify(transitions(events)))
  assert.equal(approved[0].payload.contentHash, 'hash-plan-1')
})

test('plan seguido de tasks (planReviewDeferred) não gasta revisão própria e ainda publica o plano', async () => {
  // Regressão (xadrez, 21/10): o implemente revisava o plano no estágio plan e de novo no tasks, com o modelo forte.
  const { result, calls, events, prepared } = await stageRun({ planReviewDeferred: true })
  assert.equal(result.status, 'plan_approved', JSON.stringify(result))
  assert.equal(calls.some(label => label.startsWith('plan-review')), false, JSON.stringify(calls))
  const approved = events.filter(event => event.type === 'control.transition' && event.payload.stage === 'plan-approved')
  assert.equal(approved.length, 1, JSON.stringify(transitions(events)))
  assert.equal(approved[0].payload.feedback.reason, 'plan_review_deferred_to_tasks_stage')
  assert.equal(prepared.length, 1)
})

test('plan sozinho (sem planReviewDeferred) mantém a revisão do plano', async () => {
  const { calls } = await stageRun({})
  assert.ok(calls.includes('plan-review:r1'), JSON.stringify(calls))
})

test('M6 plano com perguntas devolve needs_clarification com até 5 perguntas', async () => {
  const questions = [{ id: 'Q1', text: 'Qual banco?' }, { id: 'Q2', text: 'Qual prazo?' }]
  const { script } = criticScript([], { ...PLAN_R, questions })
  const { result, events, prepared } = await stageRun({ plan: null }, { script })
  assert.equal(result.status, 'needs_clarification', JSON.stringify(result))
  assert.equal(result.clarification.questions.length, 2)
  assert.equal(prepared[0].status, 'needs_clarification')
  assert.ok(transitions(events).includes('plan-needs-clarification'))
})

test('M6 workspace alterado durante plan bloqueia e não publica', async () => {
  const events = []
  const runtime = { ...runtimeWithEvents(events), preparePhaseArtifact: async () => { throw new Error('workspace_changed_during_stage') } }
  const { result } = await stageRun({}, { runtime, events })
  assert.equal(result.feedback?.reason, 'workspace_changed_during_stage', JSON.stringify(result))
  assert.equal(transitions(events).includes('plan-artifact-approved'), false)
})

test('M6 com resumeStageApproved.plan não publica de novo nem repete a transição', async () => {
  const events = []
  const prepared = []
  const runtime = { ...runtimeWithEvents(events, prepared), resumeStageApproved: { plan: { contentHash: 'hash-plan-1' } } }
  const { result } = await stageRun({}, { runtime })
  assert.equal(prepared.length, 0, JSON.stringify(prepared))
  assert.equal(transitions(events).includes('plan-artifact-approved'), false)
  assert.equal(result.status, 'plan_approved', JSON.stringify(result))
})

// Orçamento real do estágio com executor/verifier fixados; o resto segue o allocateBudget real.
function budgetRuntime(events, limits, prepared = []) {
  return {
    ...runtimeWithEvents(events, prepared),
    allocateBudget: input => {
      const out = allocateBudget(input)
      return input.reason === 'initial' ? { ...out, limitsByRole: { ...out.limitsByRole, ...limits } } : out
    },
  }
}

test('M6 plan-artifact-approved do motor real não carrega checkpoint', async () => {
  const { events } = await stageRun({})
  const approved = events.filter(event => event.type === 'control.transition' && event.payload.stage === 'plan-artifact-approved')
  assert.equal(approved.length, 1, JSON.stringify(transitions(events)))
  assert.equal(Object.hasOwn(approved[0].payload, 'checkpoint'), false, JSON.stringify(Object.keys(approved[0].payload)))
})

test('M6 needs_clarification devolve questionSetId igual a questionSetIdOf(perguntas)', async () => {
  const questions = [{ id: 'Q1', text: 'Qual banco?' }, { id: 'Q2', text: 'Qual prazo?' }]
  const { script } = criticScript([], { ...PLAN_R, questions })
  const { result } = await stageRun({ plan: null }, { script })
  assert.equal(result.status, 'needs_clarification', JSON.stringify(result))
  assert.equal(result.clarification.questionSetId, questionSetIdOf(questions), JSON.stringify(result.clarification))
})

test('M5 FIX_LOCAL sem orçamento bloqueia sem consumir reparo nem emitir critic-fix-complete', async () => {
  const events = []
  // executor/verifier cobrem só a primeira pesquisa de R1 e R2; o reparo precisaria de mais.
  const runtime = budgetRuntime(events, { executor: 2, verifier: 4 })
  const { script } = criticScript([{ feedback: BLOCKING, done: false, assessment: 'falta', gaps: [] }])
  const { calls } = await stageRun({}, { script, runtime, events })
  const reviewed = events.filter(event => event.type === 'control.transition' && event.payload.stage === 'critic-reviewed')
  assert.ok(reviewed.some(event => event.payload.feedback?.reason === 'critic_fix_scope_or_budget_invalid'), JSON.stringify(reviewed.map(event => event.payload.feedback)))
  assert.equal(calls.filter(label => label === 'work:R1').length, 1, JSON.stringify(calls))
  assert.equal(transitions(events).includes('critic-fix-complete'), false, JSON.stringify(transitions(events)))
  const checkpoints = events.filter(event => event.payload?.checkpoint).map(event => event.payload.checkpoint)
  assert.equal(checkpoints.at(-1).control.counters.localRepairsUsed, 0, JSON.stringify(checkpoints.at(-1).control))
})

test('M6 research pulada não publica (plan_stage_research_incomplete)', async () => {
  const events = []
  const prepared = []
  // R2 não termina (status blocked) e o critic devolve DONE: o plano não pode sair publicado sem a pesquisa completa.
  const { script: critic } = criticScript([])
  const script = async (label, prompt, opts) => (label === 'work:R2' ? { status: 'blocked', summary: 'fonte indisponível', confidence: 'low', checks: [] } : critic(label, prompt, opts))
  const { result } = await stageRun({}, { script, events, prepared })
  assert.equal(result.feedback?.reason, 'plan_stage_research_incomplete', JSON.stringify(result))
  assert.equal(prepared.length, 0, JSON.stringify(prepared.map(item => item.status)))
  assert.equal(transitions(events).includes('plan-artifact-approved'), false, JSON.stringify(transitions(events)))
})

// M7/M8/M9 (critic checkpoint M1/M4/M5/M6): clarify e tasks saem por emitStageDecision (sem checkpoint); implement reaproveita tasks.
const IMPORTED = { goal: 'estágio de tasks', doneWhen: ['ok'], assumptions: [], risks: [], researchNodes: ['R1'], research: [{ nodeId: 'R1', summary: 'pesquisa ok', findings: [] }], openQuestions: [], questionSetId: null, clarifications: null }
const IMPORTED_CRITIC = { kind: 'APPROVE', evidenceIds: ['criterion-1'] }
const DESIGN = { id: 'D1', kind: 'design', title: 'D1', brief: 'desenhar', deps: [], risk: 'low', acceptance: ['ok'], files: ['src/a.js'], inputs: [], outputs: [] }
const IMPL = { id: 'I1', kind: 'implement', title: 'I1', brief: 'implementar', deps: ['D1'], risk: 'low', acceptance: ['ok'], files: ['src/a.js'], inputs: [], outputs: [] }
const TASKS_PLAN = { goal: 'estágio de tasks', complexity: 'moderate', mode: 'implement', doneWhen: ['ok'], effort: { level: 'max', why: 'teste' }, nodes: [DESIGN, IMPL] }
const QUESTIONS = [{ id: 'Q1', text: 'Qual banco?' }]

async function stageClarifyRun(args, { script, events = [], prepared = [], runtime } = {}) {
  const rt = runtime ?? runtimeWithEvents(events, prepared)
  const base = defaultScript()
  const run = script ?? (async (label, prompt, opts) => (label === 'clarify' ? { questions: QUESTIONS } : base(label, prompt, opts)))
  const { result, calls } = await runWorkflow({ task: 'estágio clarify', mode: 'research', effort: 'max', checks: [], stage: 'clarify', importedPlan: IMPORTED, importedPlanCritic: IMPORTED_CRITIC, ...args }, run, { runtime: rt })
  return { result, calls: calls.filter(label => !label.startsWith('#')), events, prepared }
}

async function stageTasksRun(args, { script, events = [], prepared = [], runtime } = {}) {
  const rt = runtime ?? runtimeWithEvents(events, prepared)
  const base = defaultScript()
  const run = script ?? (async (label, prompt, opts) => (label === 'plan' ? TASKS_PLAN : base(label, prompt, opts)))
  const { result, calls, logs } = await runWorkflow({ task: 'estágio tasks', mode: 'implement', effort: 'max', checks: [], stage: 'tasks', pipelineTo: 'tasks', importedPlan: IMPORTED, importedPlanCritic: IMPORTED_CRITIC, ...args }, run, { runtime: rt })
  return { result, calls: calls.filter(label => !label.startsWith('#')), logs, events, prepared }
}

test('M7 clarify faz exatamente 1 chamada forte e zero executor', async () => {
  const { result, calls } = await stageClarifyRun({})
  assert.deepEqual(calls, ['clarify'], JSON.stringify(calls))
  assert.equal(result.status, 'needs_clarification', JSON.stringify(result))
})

test('M7 clarify sem perguntas devolve nothing_to_clarify sem artefato nem transição', async () => {
  const events = []
  const prepared = []
  const { result } = await stageClarifyRun({}, { script: async (label, prompt, opts) => (label === 'clarify' ? { questions: [] } : defaultScript()(label, prompt, opts)), events, prepared })
  assert.equal(result.status, 'nothing_to_clarify', JSON.stringify(result))
  assert.equal(prepared.length, 0)
  assert.deepEqual(transitions(events), [])
})

test('M7 clarify que falha bloqueia e não diz que não há perguntas', async () => {
  const { result } = await stageClarifyRun({}, { script: async (label, prompt, opts) => (label === 'clarify' ? null : defaultScript()(label, prompt, opts)) })
  assert.equal(result.status, 'blocked', JSON.stringify(result))
  assert.notEqual(result.status, 'nothing_to_clarify')
})

test('M7 clarify com perguntas publica needs_clarification com o critic do plano e grava plan-needs-clarification sem checkpoint', async () => {
  const events = []
  const prepared = []
  const { result } = await stageClarifyRun({}, { events, prepared })
  assert.equal(prepared.length, 1, JSON.stringify(prepared))
  assert.equal(prepared[0].kind, 'plan')
  assert.equal(prepared[0].status, 'needs_clarification')
  assert.deepEqual(prepared[0].critic, IMPORTED_CRITIC)
  const decision = events.filter(event => event.type === 'control.transition' && event.payload.stage === 'plan-needs-clarification')
  assert.equal(decision.length, 1, JSON.stringify(transitions(events)))
  assert.equal(Object.hasOwn(decision[0].payload, 'checkpoint'), false)
  assert.equal(result.clarification.questionSetId, questionSetIdOf(QUESTIONS), JSON.stringify(result))
})

test('M7 clarify sem modelo forte bloqueia sem nenhuma chamada substituta', async () => {
  const runtime = { ...runtimeWithEvents([]), models: { executor: 'test-cheap', verifier: 'test-cheap', critic: 'test-strong' } }
  const { result, calls } = await stageClarifyRun({}, { runtime })
  assert.equal(result.feedback?.reason, 'clarify_strong_model_unavailable', JSON.stringify(result))
  assert.deepEqual(calls, [], JSON.stringify(calls))
})

test('M8 tasks: zero executor, publica tasks e grava tasks-approved sem checkpoint', async () => {
  const events = []
  const prepared = []
  const { result, calls } = await stageTasksRun({}, { events, prepared })
  assert.equal(result.status, 'tasks_approved', JSON.stringify(result))
  assert.deepEqual(calls, ['plan', 'plan-review:r1'], JSON.stringify(calls))
  assert.equal(prepared.length, 1, JSON.stringify(prepared))
  assert.equal(prepared[0].kind, 'tasks')
  assert.equal(prepared[0].status, 'approved')
  const decision = events.filter(event => event.type === 'control.transition' && event.payload.stage === 'tasks-approved')
  assert.equal(decision.length, 1, JSON.stringify(transitions(events)))
  assert.equal(Object.hasOwn(decision[0].payload, 'checkpoint'), false)
})

test('M8 tasks: nó de pesquisa depois da revisão bloqueia tasks_stage_kind_invalid sem executor', async () => {
  const research = { ...DESIGN, id: 'R9', kind: 'research', files: [] }
  const events = []
  const { result, calls } = await stageTasksRun({}, { script: async (label, prompt, opts) => (label === 'plan' ? { ...TASKS_PLAN, nodes: [research, { ...IMPL, deps: ['R9'] }] } : defaultScript()(label, prompt, opts)), events })
  assert.equal(result.feedback?.reason, 'tasks_stage_kind_invalid', JSON.stringify(result))
  assert.equal(calls.filter(label => label.startsWith('work:')).length, 0, JSON.stringify(calls))
  assert.equal(transitions(events).includes('tasks-approved'), false)
})

test('M8 tasks: retomada com tasks-approved já no journal não publica de novo nem repete a transição', async () => {
  const events = []
  const prepared = []
  const runtime = { ...runtimeWithEvents(events, prepared), resumeStageApproved: { tasks: { seq: 3, contentHash: 'hash-tasks-x' } } }
  const { result } = await stageTasksRun({}, { runtime, events, prepared })
  assert.equal(prepared.length, 0, JSON.stringify(prepared))
  assert.equal(transitions(events).includes('tasks-approved'), false)
  assert.equal(result.status, 'tasks_approved', JSON.stringify(result))
})

test('M9 implement com tasks importado: zero label plan, uma plan-review e checks reais', async () => {
  const check = { id: 'node-check', command: 'node', args: ['-e', '0'] }
  const { calls, result } = await stageRun({ stage: 'implement', mode: 'implement', checks: [check], plan: { ...PLAN_R, mode: 'implement', nodes: [DESIGN, IMPL] } }, { script: defaultScript({ plan: TASKS_PLAN }) })
  assert.equal(calls.filter(label => label === 'plan').length, 0, JSON.stringify(calls))
  assert.equal(calls.filter(label => label.startsWith('plan-review')).length, 1, JSON.stringify(calls))
  assert.equal(calls[0], 'plan-review:r1', JSON.stringify(calls))
  assert.ok(calls.some(label => label.startsWith('work:')), JSON.stringify(calls))
  assert.doesNotMatch(JSON.stringify(result), /required_checks|runtime_evidence_unavailable/)
})

test('M9 critic REPLAN com replan estrutural herdado do carry já no limite 2 bloqueia sem planner', async () => {
  const stageCarry = { planVersion: 1, counters: { localRepairsUsed: 0, structuralReplansUsed: 2 }, usedByRole: { planner: 0, planReviewer: 1, designReviewer: 0, critic: 0, synth: 0, executor: 0, verifier: 0 }, limitsByRole: { planner: 5, planReviewer: 5, designReviewer: 5, critic: 5, synth: 3, executor: 0, verifier: 0 }, tokenUsageByRole: {}, history: [], seenPairs: [] }
  const replan = { feedback: { kind: 'REPLAN', reason: 'plano incompleto', severity: 'high', affectedNodes: ['R1'], evidenceIds: [] }, done: false, assessment: 'x', gaps: [] }
  const { script } = criticScript([replan])
  const { result, calls } = await stageRun({}, { script, runtime: { ...runtimeWithEvents([]), stageCarry } })
  assert.equal(result.feedback?.reason, 'structural_replan_budget_exhausted', JSON.stringify(result))
  assert.equal(calls.filter(label => label === 'plan').length, 0, JSON.stringify(calls))
})

test('estágio novo tem o próprio pool de 2 reparos locais mesmo com o estágio anterior esgotado (benchmark Minecraft run 4)', async () => {
  // Run 4: crítica e revisões do plano gastaram os 2 reparos e o estágio seguinte herdava o pool vazio.
  const stageCarry = { planVersion: 1, counters: { localRepairsUsed: 2, structuralReplansUsed: 1 }, usedByRole: { planner: 0, planReviewer: 1, designReviewer: 0, critic: 0, synth: 0, executor: 0, verifier: 0 }, limitsByRole: { planner: 5, planReviewer: 5, designReviewer: 5, critic: 5, synth: 3, executor: 0, verifier: 0 }, tokenUsageByRole: {}, history: [], seenPairs: [] }
  const fix = { feedback: { kind: 'FIX_LOCAL', reason: 'refazer R1 com evidência', severity: 'high', affectedNodes: ['R1'], evidenceIds: [] }, done: false, assessment: 'x', gaps: [] }
  const { script } = criticScript([fix])
  const events = []
  const { result, calls } = await stageRun({}, { script, events, runtime: { ...runtimeWithEvents(events), stageCarry } })
  assert.notEqual(result.feedback?.reason, 'local_repair_budget_exhausted', JSON.stringify({ result, calls }).slice(0, 1500))
  assert.ok(transitions(events).includes('critic-fix-complete'), JSON.stringify({ transitions: transitions(events), calls }))
  const last = events.filter(event => event.type === 'control.transition' && event.payload?.checkpoint).at(-1).payload.checkpoint
  assert.deepEqual(last.control.counters, { localRepairsUsed: 1, structuralReplansUsed: 1 }, 'pool local é do estágio; replan estrutural continua herdado')
})

test('M9 checkpoint da run de reuso começa com planner e contadores zerados', async () => {
  const events = []
  await stageRun({ stage: 'implement', mode: 'implement', checks: [{ id: 'node-check', command: 'node', args: ['-e', '0'] }], plan: { ...PLAN_R, mode: 'implement', nodes: [DESIGN, IMPL] } }, { script: defaultScript({ plan: TASKS_PLAN }), events })
  const first = events.find(event => event.type === 'control.transition' && event.payload?.checkpoint)?.payload.checkpoint
  assert.ok(first, JSON.stringify(transitions(events)))
  assert.equal(first.ledger.usedByRole.planner, 0)
  assert.deepEqual(first.control.counters, { localRepairsUsed: 0, structuralReplansUsed: 0 })
})

test('M5 plan-review FIX_LOCAL sem orçamento do planner não consome reparo local nem grava feedback', async () => {
  const events = []
  const stageCarry = { planVersion: 1, counters: { localRepairsUsed: 0, structuralReplansUsed: 0 }, usedByRole: { planner: 5, planReviewer: 0, designReviewer: 0, critic: 0, synth: 0, executor: 0, verifier: 0 }, limitsByRole: { planner: 5, planReviewer: 5, designReviewer: 5, critic: 5, synth: 3, executor: 0, verifier: 0 }, tokenUsageByRole: {}, history: [], seenPairs: [] }
  const fix = { feedback: { kind: 'FIX_LOCAL', reason: 'falta fonte', severity: 'medium', affectedNodes: ['R1'], evidenceIds: [] } }
  const base = defaultScript({ plan: PLAN_R })
  const script = async (label, prompt, opts) => (label === 'plan-review:r1' ? fix : base(label, prompt, opts))
  const { result } = await stageRun({}, { script, runtime: { ...runtimeWithEvents(events), stageCarry } })
  assert.equal(result.feedback?.reason, 'plan_gate_budget_exhausted', JSON.stringify(result))
  assert.equal(transitions(events).includes('feedback-dispatch'), false, JSON.stringify(transitions(events)))
})

test('M5 REPLAN do critic sem orçamento do planner não consome replan estrutural nem grava feedback', async () => {
  const events = []
  const stageCarry = { planVersion: 1, counters: { localRepairsUsed: 0, structuralReplansUsed: 0 }, usedByRole: { planner: 5, planReviewer: 0, designReviewer: 0, critic: 0, synth: 0, executor: 0, verifier: 0 }, limitsByRole: { planner: 5, planReviewer: 5, designReviewer: 5, critic: 5, synth: 3, executor: 0, verifier: 0 }, tokenUsageByRole: {}, history: [], seenPairs: [] }
  const replan = { feedback: { kind: 'REPLAN', reason: 'plano incompleto', severity: 'high', affectedNodes: ['R1'], evidenceIds: [] }, done: false, assessment: 'x', gaps: [] }
  const { script } = criticScript([replan])
  const { result } = await stageRun({}, { script, events, runtime: { ...runtimeWithEvents(events), stageCarry } })
  assert.equal(result.feedback?.reason, 'plan_gate_budget_exhausted', JSON.stringify(result))
  assert.equal(transitions(events).includes('feedback-dispatch'), false, JSON.stringify(transitions(events)))
})

test('M5 FIX_LOCAL do critic em implement sem orçamento do executor não consome reparo local nem grava feedback', async () => {
  const events = []
  // Executor cobre só o trabalho inicial (D1, I1) e a polida; o reparo de I1 não tem chamada de executor sobrando.
  const runtime = budgetRuntime(events, { executor: 3, verifier: 20 })
  const check = { id: 'node-check', command: 'node', args: ['-e', '0'] }
  const base = defaultScript({ plan: TASKS_PLAN })
  let criticCalls = 0
  const script = async (label, prompt, opts) => {
    if (label === 'critic:r1' && criticCalls++ === 0) return { feedback: { kind: 'FIX_LOCAL', reason: 'ajustar I1', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] }, done: false, assessment: 'falta', gaps: [] }
    return base(label, prompt, opts)
  }
  const { calls } = await stageRun({ stage: 'implement', mode: 'implement', checks: [check], plan: { ...PLAN_R, mode: 'implement', nodes: [DESIGN, IMPL] } }, { script, runtime, events })
  assert.equal(calls.filter(label => label === 'repair:I1').length, 0, JSON.stringify(calls))
  const checkpoints = events.filter(event => event.payload?.checkpoint).map(event => event.payload.checkpoint)
  assert.equal(events.filter(event => event.type === 'control.transition' && event.payload.stage === 'feedback-dispatch').length, 0, JSON.stringify(transitions(events)))
  assert.equal(checkpoints.at(-1).control.counters.localRepairsUsed, 0, JSON.stringify(checkpoints.at(-1).control))
})

test('M8 tasks: o decompositor recebe o plano importado como dado e o doneWhen travado', async () => {
  const prompts = []
  const base = defaultScript()
  const script = async (label, prompt, opts) => { if (label === 'plan') prompts.push(prompt); return label === 'plan' ? TASKS_PLAN : base(label, prompt, opts) }
  await stageTasksRun({}, { script })
  assert.equal(prompts.length, 1, JSON.stringify(prompts.length))
  assert.match(prompts[0], /## Role: task decomposer/)
  assert.match(prompts[0], /Approved plan \(data\)/)
  assert.match(prompts[0], /doneWhen is fixed by the approved plan; return it verbatim: \["ok"\]/)
  assert.match(prompts[0], /estágio de tasks/)
})

// Regressão (benchmark faturamento, 21/10): o decompositor pôs o diretório "data/" em inputs e a run bloqueou com invalid_dag.
// O planner completo tinha a regra de manifesto; o prompt do decompositor não.
test('M8 tasks: o decompositor recebe a regra de manifesto (um arquivo por entrada, sem diretório)', async () => {
  const prompts = []
  const base = defaultScript()
  const script = async (label, prompt, opts) => { if (label === 'plan') prompts.push(prompt); return label === 'plan' ? TASKS_PLAN : base(label, prompt, opts) }
  await stageTasksRun({}, { script })
  assert.match(prompts[0], /`files`, `inputs` and `outputs` are machine manifests: each entry is ONE repo-relative file path/)
  assert.match(prompts[0], /never a directory/)
})
