// Lado do runner das runs com pipeline (plan / clarify / tasks / implemente): preparo sob lease, rascunhos,
// publicação por estágio com CAS e tombstone. Não conhece o motor: recebe `invoke` e o runtime prontos.
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { canonicalJsonOf, contentHashOf, decidePipelineStages, planningInputsOf, planningKeyOf, questionSetIdOf, readSlot, resolveReuse, sealArtifact, STAGE_BY_STATUS, validateArtifact, workspaceOf, writeSlot } from './phase-artifacts.mjs'
import { readJournalFile } from './run-state.mjs'
import { ENGINE_PATH } from './workflow-source.mjs'

const RESUME_ROLES = ['planner', 'planReviewer', 'designReviewer', 'critic', 'synth', 'executor', 'verifier']
const PIPELINE_CHECK_FNS = ['approveCheckNodes', 'beginCheckWindow', 'endCheckWindow', 'checkWindowDelta', 'beginCheckNode']
const KIND_OF_STAGE = { plan: 'plan', clarify: 'plan', tasks: 'tasks' }
const SUCCESS_STATUS = { plan: ['plan_approved', 'needs_clarification'], clarify: ['needs_clarification'], tasks: ['tasks_approved'] }
const TOMBSTONE_STAGE = { plan: 'plan-artifact-rejected', tasks: 'tasks-rejected' }
export const TOMBSTONE_STAGES = Object.values(TOMBSTONE_STAGE)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// Para o fluxo de erro do runner: o objeto vira o resultado final da run, sem spawn adicional.
export const pipelineStop = result => Object.assign(new Error(result.feedback?.reason || result.status), { pipelineBlock: result })
export const blockOf = (reason, extra = {}) => ({ status: 'blocked', feedback: { kind: 'BLOCK', reason, severity: 'critical', affectedNodes: [], evidenceIds: [] }, ...extra })
export const baseReservedFor = stage => ({ planner: stage === 'implement' ? 0 : 1, planReviewer: 1, designReviewer: 1, critic: 1, synth: 1, executor: 0, verifier: 0 })
export const isReadOnlyStage = (stage, pipelineTo) => stage === 'plan' || stage === 'clarify' || (stage === 'tasks' && pipelineTo !== 'implement')

// Prepara a run com pipeline antes da primeira invocação: workspace inicial, slots, tarefa herdada do plano e decisão de reuso.
// Não escreve na run. Qualquer decisão que não roda estágio sai como pipelineStop.
export async function preparePipeline({ args, runId, runDir, cwd, cwdReal, hostName, models, evidenceFactory, heavyLock, emit, integrity = null }) {
  const pipeline = args.pipeline
  const repo = cwdReal
  const evidence = evidenceFactory({ cwd, runDir, heavyLock, emit, integrity })
  const startWorkspace = workspaceOf(await evidence.snapshot())
  const planSlot = await readSlot({ repo, kind: 'plan' })
  const tasksSlot = await readSlot({ repo, kind: 'tasks' })
  let task = typeof args.task === 'string' && args.task.trim() ? args.task : null
  let context = typeof args.context === 'string' ? args.context : ''
  if (!task) {
    if (pipeline.from === 'plan') throw pipelineStop(blockOf('plan_task_required'))
    if (!planSlot.artifact) throw pipelineStop(blockOf(`plan_missing_or_incompatible:${planSlot.invalid ? 'artifact_invalid' : 'absent'}`))
    task = planSlot.artifact.planningInputs.task
    context = planSlot.artifact.planningInputs.context
  }
  let spec = null
  if (args.spec) {
    try {
      const actual = await realpath(path.resolve(repo, args.spec))
      spec = { path: actual, sha256: sha256(await readFile(actual)) }
    } catch { spec = null }
  }
  const planningInputs = planningInputsOf({
    repo, task, context, spec, acceptedCriteria: Array.isArray(args.doneWhen) ? args.doneWhen : null, host: hostName,
    modelPolicyHash: sha256(canonicalJsonOf(models)), workflowSourceHash: sha256(await readFile(ENGINE_PATH)),
  })
  const planningKey = planningKeyOf(planningInputs)
  const readMeta = async dir => JSON.parse(await readFile(path.join(dir, 'run.meta.json'), 'utf8'))
  const planRes = await resolveReuse({ repo, kind: 'plan', slot: planSlot, planningKey, workspace: startWorkspace, planArtifact: null, readJournal: readJournalFile, readMeta })
  // Tasks só se apoiam em um plano que passou na própria verificação de origem; senão, vale tasks_plan_mismatch.
  const tasksRes = await resolveReuse({ repo, kind: 'tasks', slot: tasksSlot, planningKey, workspace: startWorkspace, planArtifact: planRes.ok ? planSlot.artifact : null, readJournal: readJournalFile, readMeta })
  const clarification = args.clarification ?? null
  if (clarification && pipeline.from !== 'clarify' && pipeline.from !== 'plan') throw pipelineStop(blockOf('clarification_stage_mismatch'))
  const decision = decidePipelineStages({ pipeline, planRes, tasksRes, planSlot, clarification })
  if (decision.action === 'block') throw pipelineStop(blockOf(decision.reason, { ...(decision.clarification ? { clarification: decision.clarification } : {}), ...(decision.next ? { next: decision.next } : {}) }))
  if (decision.action === 'questions') throw pipelineStop({ status: 'needs_clarification', clarification: decision.clarification, next: 'clarify', runId, runDir: path.resolve(cwd, runDir), report: null })
  return {
    runId, task, context, planSlot, tasksSlot, startWorkspace, planningInputs, planningKey, decision,
    planHash: decision.importedPlan?.contentHash ?? null,
    rejected: [...(planRes.rejected || []), ...(tasksRes.rejected || [])],
    startHash: { plan: planSlot.hash, tasks: tasksSlot.hash },
    clarification,
  }
}

// C13: arquivo privado novo do supervisor (wx, 0600). Com guard, o diretório e o arquivo passam pelo guard de integridade; sem guard, escrita direta.
export async function writePrivateNew({ guard = null, runDir, dir, name, bytes }) {
  const rel = `${dir}/${name}`
  const write = () => writeFile(path.join(runDir, rel), bytes, { flag: 'wx', mode: 0o600 })
  if (!guard) {
    await mkdir(path.join(runDir, dir), { recursive: true, mode: 0o700 })
    return write()
  }
  await guard.ensureDir(dir, { mode: 0o700 })
  return guard.trustedWrite({ paths: [rel], expect: () => ({ [rel]: { bytes: Buffer.from(bytes) } }) }, write)
}

// Rascunho de fase: sela, valida e grava em phase-drafts/ antes de devolver o hash. Nunca publica no slot.
export function makePreparePhaseArtifact({ runId, runDir, drafts, getPipelineState, snapshotNow, guard = null }) {
  return async ({ kind, status, content, critic = null, planContentHash } = {}) => {
    const pipelineState = getPipelineState()
    if (!pipelineState) throw new Error('phase_artifact_runtime_unavailable')
    if (!['plan', 'tasks'].includes(kind)) throw new Error('phase_artifact_invalid:kind')
    const now = workspaceOf(await snapshotNow())
    if (now.identity !== pipelineState.startWorkspace.identity) throw pipelineStop(blockOf('workspace_changed_during_stage'))
    if (kind === 'tasks') {
      if (!pipelineState.planHash) throw pipelineStop(blockOf('plan_missing_or_incompatible:absent'))
      if (planContentHash !== undefined && planContentHash !== pipelineState.planHash) throw pipelineStop(blockOf('tasks_plan_mismatch'))
      planContentHash = pipelineState.planHash
    }
    const contentOut = kind === 'plan'
      ? { ...content, questionSetId: content.openQuestions?.length ? questionSetIdOf(content.openQuestions) : null, clarifications: content.clarifications ?? [] }
      : content
    const body = {
      schemaVersion: 1, kind: kind === 'plan' ? 'graph-eng.plan' : 'graph-eng.tasks', status,
      planningKey: pipelineState.planningKey, planningInputs: pipelineState.planningInputs,
      source: { runId, runDir: `.graph-runs/${runId}`, seq: 1 }, workspace: pipelineState.startWorkspace,
      content: contentOut, critic, reason: null, ...(kind === 'tasks' ? { planContentHash } : {}),
    }
    const artifact = sealArtifact(body)
    const valid = validateArtifact(artifact, kind)
    if (!valid.ok) throw new Error(`phase_artifact_invalid:${valid.detail ?? valid.reason}`)
    const name = `${kind}-${artifact.contentHash}.json`
    const bytes = `${canonicalJsonOf(artifact)}\n`
    try {
      await writePrivateNew({ guard, runDir, dir: 'phase-drafts', name, bytes })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if ((await readFile(path.join(runDir, 'phase-drafts', name), 'utf8')) !== bytes) throw pipelineStop(blockOf('phase_draft_conflict'))
    }
    drafts.push({ kind, status, contentHash: artifact.contentHash, artifact })
    return { contentHash: artifact.contentHash, questionSetId: contentOut.questionSetId ?? null }
  }
}

// Aprovação de tasks: o ÚLTIMO voto do planReviewer entre a fronteira do estágio tasks e a transição precisa ser APPROVE.
// Sem fronteira de tasks no journal, nega (fecha por falta de prova, sem valor padrão).
export function tasksReviewApproved(events, transitionSeq) {
  const boundary = events.filter(event => event.type === 'phase.stage.started' && event.payload?.stage === 'tasks' && event.seq < transitionSeq).at(-1)
  if (!boundary) return false
  const votes = events.filter(event => event.type === 'result' && event.seq > boundary.seq && event.seq < transitionSeq && event.payload?.role === 'planReviewer')
  return votes.at(-1)?.result?.feedback?.kind === 'APPROVE'
}

// R10a: fatos que o phase.reuse.resolved grava para reconstruir o pipelineState na retomada, sem resolver o reuso de novo.
const importsOf = decision => ({ plan: decision.importedPlan?.contentHash ?? null, tasks: decision.importedTasks?.contentHash ?? null })
const clarificationHashOf = context => (context ? sha256(canonicalJsonOf(context)) : null)
export function reuseFactsOf(pipelineState) {
  return { planningKey: pipelineState.planningKey, planningInputs: pipelineState.planningInputs, imports: importsOf(pipelineState.decision), clarificationContextHash: clarificationHashOf(pipelineState.decision.clarificationContext) }
}

// Grava os importados em phase-imports/ (wx, 0600), no mesmo molde dos rascunhos. A retomada confere cada um pelo hash do evento.
export async function writePhaseImports({ runDir, pipelineState, guard = null }) {
  const imports = importsOf(pipelineState.decision)
  const clarificationHash = clarificationHashOf(pipelineState.decision.clarificationContext)
  const items = []
  if (imports.plan) items.push([`plan-${imports.plan}.json`, pipelineState.decision.importedPlan])
  if (imports.tasks) items.push([`tasks-${imports.tasks}.json`, pipelineState.decision.importedTasks])
  if (clarificationHash) items.push([`clarification-${clarificationHash}.json`, pipelineState.decision.clarificationContext])
  if (!items.length) return
  for (const [name, value] of items) {
    const bytes = `${canonicalJsonOf(value)}\n`
    try {
      await writePrivateNew({ guard, runDir, dir: 'phase-imports', name, bytes })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if ((await readFile(path.join(runDir, 'phase-imports', name), 'utf8')) !== bytes) throw pipelineStop(blockOf('phase_import_conflict'))
    }
  }
}

// Cópia verificável do artefato publicado (phase-published/, wx, 0600): o journal aponta para ela pelo hash.
export async function writePhasePublished({ runDir, artifact, guard = null }) {
  const name = `${artifact.kind === 'graph-eng.plan' ? 'plan' : 'tasks'}-${artifact.contentHash}.json`
  const bytes = `${canonicalJsonOf(artifact)}\n`
  try {
    await writePrivateNew({ guard, runDir, dir: 'phase-published', name, bytes })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if ((await readFile(path.join(runDir, 'phase-published', name), 'utf8')) !== bytes) throw pipelineStop(blockOf('phase_publish_conflict'))
  }
}

// Reconstrói o pipelineState da retomada a partir do evento e dos importados verificados. Não recalcula a decisão de reuso.
export async function reconstructPipelineState({ runDir, runId, reuse, planningInputs, events = [] }) {
  if (planningKeyOf(planningInputs) !== reuse.planningKey) throw pipelineStop(blockOf('resume_planning_key_changed'))
  const readVerified = async (dir, name, check, reason) => {
    let bytes
    let value
    try {
      bytes = await readFile(path.join(runDir, dir, name), 'utf8')
      value = JSON.parse(bytes)
    } catch { throw pipelineStop(blockOf(reason)) }
    if (`${canonicalJsonOf(value)}\n` !== bytes || !check(value)) throw pipelineStop(blockOf(reason))
    return value
  }
  const readImport = (name, check) => readVerified('phase-imports', name, check, 'resume_phase_import_invalid')
  const artifactCheck = (kind, hash) => value => value.contentHash === hash && contentHashOf(value) === hash && validateArtifact(value, kind).ok
  const plan = reuse.imports.plan ? await readImport(`plan-${reuse.imports.plan}.json`, artifactCheck('plan', reuse.imports.plan)) : null
  const tasks = reuse.imports.tasks ? await readImport(`tasks-${reuse.imports.tasks}.json`, artifactCheck('tasks', reuse.imports.tasks)) : null
  const clarificationContext = reuse.clarificationContextHash ? await readImport(`clarification-${reuse.clarificationContextHash}.json`, value => clarificationHashOf(value) === reuse.clarificationContextHash) : null
  // planHash: o journal é a fonte. Último plan publicado com CAS ok; sem publicação, vale o importado.
  const publishedPlan = events.filter(event => event.type === 'phase.artifact.published' && event.payload?.kind === 'plan' && event.payload?.casOk === true).at(-1)
  let planHash = plan?.contentHash ?? null
  if (publishedPlan) {
    const hash = publishedPlan.payload.contentHash
    planHash = (await readVerified('phase-published', `plan-${hash}.json`, artifactCheck('plan', hash), 'resume_phase_published_invalid')).contentHash
  }
  return {
    runId, planningKey: reuse.planningKey, planningInputs: reuse.planningInputs, startWorkspace: reuse.startWorkspace, startHash: reuse.startHash,
    rejected: reuse.rejected ?? [], planHash,
    decision: { stages: [...reuse.decided.stages], pipelineTo: reuse.decided.pipelineTo ?? null, importedPlan: plan, importedTasks: tasks, clarificationContext },
  }
}

// Carry da próxima invocação: último checkpoint da run mais os budget.call posteriores (gasto continua contado).
export async function readCarryFromJournal(runDir, integrity = null) {
  // C12: leitura decisória do próprio journal sob lock só depois de assertIntegrity.
  if (integrity) await integrity.assertIntegrity()
  const journal = await readJournalFile(runDir)
  const events = journal.events
  const lastCp = events.filter(event => event.type === 'control.transition' && event.payload?.checkpoint).at(-1)
  if (!lastCp) throw pipelineStop(blockOf('stage_carry_missing'))
  const cp = lastCp.payload.checkpoint
  let usedByRole = { ...cp.ledger.usedByRole }
  let tokenUsageByRole = { ...cp.ledger.tokenUsageByRole }
  let counters = { ...cp.control.counters }
  const lastBudget = events.filter(event => event.seq > lastCp.seq && event.type === 'budget.call').at(-1)
  if (lastBudget?.payload?.ledger) {
    const ledger = lastBudget.payload.ledger
    usedByRole = { ...ledger.usedByRole }
    tokenUsageByRole = { ...ledger.tokenUsageByRole }
    counters = { localRepairsUsed: ledger.localRepairsUsed, structuralReplansUsed: ledger.structuralReplansUsed }
  }
  return { counters, usedByRole, limitsByRole: { ...cp.ledger.limitsByRole }, tokenUsageByRole, history: cp.control.history, seenPairs: cp.control.seenPairs, planVersion: cp.planVersion }
}

// R10c (caso A): publica na retomada o rascunho aprovado da fronteira corrente. O rascunho é conferido pelo hash da aprovação;
// sem phase.artifact.published casOk desse hash, grava no slot com CAS a partir do hash inicial da run (slot já gravado por esta run não é regravado).
// R10d: rascunho de fase lido do disco e conferido pelo hash da aprovação (bytes canônicos, hash e forma válidos); senão, resume_phase_draft_invalid.
export async function loadVerifiedDraft({ runDir, kind, hash }) {
  let draft = null
  try {
    const bytes = await readFile(path.join(runDir, 'phase-drafts', `${kind}-${hash}.json`), 'utf8')
    draft = JSON.parse(bytes)
    if (`${canonicalJsonOf(draft)}\n` !== bytes) draft = null
  } catch { draft = null }
  if (!draft || draft.contentHash !== hash || contentHashOf(draft) !== hash || !validateArtifact(draft, kind).ok) throw pipelineStop(blockOf('resume_phase_draft_invalid'))
  return draft
}

// critic R10: publicação idempotente de um hash já aprovado. Se o journal tem phase.artifact.published casOk desse hash, não regrava nada:
// só confere que o slot ainda tem o mesmo hash (slot trocado por outra run bloqueia). Senão, grava com CAS a partir do hash inicial (slot já
// gravado por esta run não é regravado) e registra o evento. Devolve { ok, write? }.
export async function publishIdempotent({ kind, artifact, startHash, runId, runDir, repo, emit, events, guard = null }) {
  const hash = artifact.contentHash
  const slot = await readSlot({ repo, kind })
  const journalPublished = events.some(event => event.type === 'phase.artifact.published' && event.payload?.kind === kind && event.payload?.casOk === true && event.payload?.contentHash === hash)
  if (journalPublished) return slot.artifact?.contentHash === hash ? { ok: true } : { ok: false, write: { reason: 'artifact_slot_changed' } }
  const alreadyInSlot = slot.artifact?.contentHash === hash && slot.artifact?.source?.runId === runId
  if (!alreadyInSlot) {
    const write = await writeSlot({ repo, kind, artifact, expectedPrevContentHash: startHash })
    if (!write.published) return { ok: false, write }
  }
  await writePhasePublished({ runDir, artifact, guard })
  await emit({ type: 'phase.artifact.published', phase: 'Prepare', payload: { kind, contentHash: hash, slotPrevHash: startHash, casOk: true } })
  return { ok: true }
}

export async function publishResumedApproval({ approval, pipelineState, runId, runDir, repo, emit, events, guard = null }) {
  const kind = approval.stage === 'plan-artifact-approved' ? 'plan' : 'tasks'
  const hash = approval.contentHash
  const draft = await loadVerifiedDraft({ runDir, kind, hash })
  const artifact = sealArtifact({ ...draft, source: { runId, runDir: `.graph-runs/${runId}`, seq: approval.seq } })
  if (artifact.contentHash !== hash) throw pipelineStop(blockOf('resume_phase_draft_invalid'))
  const outcome = await publishIdempotent({ kind, artifact, startHash: pipelineState.startHash[kind], runId, runDir, repo, emit, events, guard })
  if (!outcome.ok) throw pipelineStop(blockOf(outcome.write.reason, { ...(outcome.write.detail ? { detail: outcome.write.detail } : {}) }))
  return artifact
}

// Executa os estágios decididos, um por invocação do mesmo motor, publicando cada um logo depois da invocação.
// resume (R10c, caso A): { startIndex, approval, nextStage, events } publica a aprovação da fronteira corrente e segue do próximo estágio.
export async function runPipelineStages({ invoke, runtime, args, checks, checkContract, pipelineState, drafts, runId, runDir, repo, emit, resume = null, integrity = null }) {
  const { stages, pipelineTo } = { stages: pipelineState.decision.stages, pipelineTo: pipelineState.decision.pipelineTo }
  const { startHash } = pipelineState
  let importedPlan = pipelineState.decision.importedPlan ?? null
  let importedTasks = pipelineState.decision.importedTasks ?? null
  const clarificationContext = pipelineState.decision.clarificationContext ?? null
  const baseArgs = { ...args }
  delete baseArgs.clarification
  // Retomada de estágio: o motor só recebe resume quando há checkpoint; aqui cada estágio é fresco com carry.
  delete baseArgs.resume
  const reuse = { decided: { stages, pipelineTo }, rejected: pipelineState.rejected }
  const runDirRel = `.graph-runs/${runId}`

  // critic R10: hashes aprovados que o resume já trouxe (resumeStageApproved) da invocação corrente.
  let resumedHashes = new Set()
  const publish = async (stage, stageTo, result, draftsFrom) => {
    const kind = KIND_OF_STAGE[stage]
    if (!kind) return { proceed: true }
    const success = SUCCESS_STATUS[stage].includes(result?.status)
    const draft = drafts.slice(draftsFrom).filter(item => item.kind === kind).at(-1)
    if (integrity) await integrity.assertIntegrity()
    const journal = await readJournalFile(runDir)
    const transition = draft
      ? journal.events.filter(event => event.type === 'control.transition' && event.payload?.stage === STAGE_BY_STATUS[kind][draft.status] && event.payload?.contentHash === draft.contentHash).at(-1)
      : null
    if (transition && kind === 'tasks') {
      if (!tasksReviewApproved(journal.events, transition.seq)) return { proceed: false, stopResult: blockOf('tasks_review_missing') }
    }
    if (transition && resumedHashes.has(draft.contentHash)) {
      // critic R10: hash vindo de resumeStageApproved (a aprovação já estava no journal): publicação idempotente, sem segundo evento.
      const artifact = sealArtifact({ ...draft.artifact, source: { runId, runDir: runDirRel, seq: transition.seq } })
      const outcome = await publishIdempotent({ kind, artifact, startHash: startHash[kind], runId, runDir, repo, emit, events: journal.events, guard: integrity })
      if (!outcome.ok) return publishFailure(stage, stageTo, result, outcome.write)
      return { proceed: result.status !== 'needs_clarification', published: artifact }
    }
    if (transition) {
      const artifact = sealArtifact({ ...draft.artifact, source: { runId, runDir: runDirRel, seq: transition.seq } })
      const write = await writeSlot({ repo, kind, artifact, expectedPrevContentHash: startHash[kind] })
      await writePhasePublished({ runDir, artifact, guard: integrity })
      await emit({ type: 'phase.artifact.published', phase: 'Prepare', payload: { kind, contentHash: artifact.contentHash, slotPrevHash: startHash[kind], casOk: write.published === true } })
      if (!write.published) return publishFailure(stage, stageTo, result, write)
      return { proceed: result.status !== 'needs_clarification', published: artifact }
    }
    // clarify nunca grava tombstone: sem rascunho com transição, o plano aprovado continua valendo.
    if (stage === 'clarify') return { proceed: false, stopResult: result }
    // tasks de one-shot que terminou em done sem transição: não rebaixa o DONE nem o slot (D6).
    if (stage === 'tasks' && stageTo === 'implement' && result?.status === 'done') return { proceed: false, stopResult: result, rejected: [{ kind: 'tasks', reason: 'phase_transition_missing' }] }
    // Estágio sem rascunho aprovado com transição: tombstone do slot (a aprovação anterior deixa de valer).
    const reason = String((success ? 'phase_transition_missing' : result?.feedback?.reason || result?.status || 'stage_not_approved')).slice(0, 500)
    const body = {
      schemaVersion: 1, kind: kind === 'plan' ? 'graph-eng.plan' : 'graph-eng.tasks', status: 'rejected',
      planningKey: pipelineState.planningKey, planningInputs: pipelineState.planningInputs, workspace: pipelineState.startWorkspace, reason,
      ...(kind === 'tasks' ? { planContentHash: pipelineState.planHash } : {}),
    }
    const event = await emit({ type: 'control.transition', phase: 'Prepare', payload: { stage: TOMBSTONE_STAGE[kind], contentHash: contentHashOf(body), reason } })
    const artifact = sealArtifact({ ...body, source: { runId, runDir: runDirRel, seq: event.seq } })
    const write = await writeSlot({ repo, kind, artifact, expectedPrevContentHash: startHash[kind] })
    if (!write.published) return publishFailure(stage, stageTo, result, write)
    return { proceed: false, stopResult: result }
  }

  const publishFailure = (stage, stageTo, result, write) => {
    // Pós-DONE de one-shot: falha de publicar tasks não rebaixa o DONE; registra em phaseArtifacts.rejected (D6).
    if (stage === 'tasks' && stageTo === 'implement' && result?.status === 'done') return { proceed: false, stopResult: result, rejected: [{ kind: 'tasks', reason: write.reason }] }
    return { proceed: false, stopResult: blockOf(write.reason, { ...(write.detail ? { detail: write.detail } : {}) }) }
  }

  let last = null
  let published = []
  let rejected = []
  let startIndex = 0
  // R10d: casos B e C reinvocam o estágio da fronteira corrente (startIndex), sem nova fronteira; só a primeira iteração é reentrada.
  const reentry = resume?.case === 'B' || resume?.case === 'C' ? resume : null
  if (reentry) startIndex = reentry.startIndex
  else if (resume) {
    const approvedStage = resume.approval.stage === 'plan-artifact-approved' ? 'plan' : 'tasks'
    const artifact = await publishResumedApproval({ approval: resume.approval, pipelineState, runId, runDir, repo, emit, events: resume.events, guard: integrity })
    if (artifact.kind === 'graph-eng.plan') pipelineState.planHash = artifact.contentHash
    published = [{ kind: artifact.kind, contentHash: artifact.contentHash }]
    if (artifact.kind === 'graph-eng.plan') importedPlan = artifact
    if (artifact.kind === 'graph-eng.tasks') importedTasks = artifact
    startIndex = resume.startIndex
    if (startIndex >= stages.length) return { status: SUCCESS_STATUS[approvedStage][0], reuse, phaseArtifacts: { published, rejected } }
  }
  for (let index = startIndex; index < stages.length; index++) {
    const stage = stages[index]
    const stageTo = stage === 'tasks' ? pipelineTo : null
    const entering = index === startIndex && reentry ? reentry : null
    const carry = entering ? (entering.case === 'C' ? entering.carry : null) : index === 0 ? null : await readCarryFromJournal(runDir, integrity)
    if (carry) {
      for (const role of RESUME_ROLES) {
        if (carry.limitsByRole[role] - carry.usedByRole[role] < baseReservedFor(stage)[role]) throw pipelineStop(blockOf(`stage_budget_exhausted:${role}`))
      }
    }
    resumedHashes = new Set(Object.values(entering?.resumeStageApproved || {}).map(item => item.contentHash))
    const draftsFrom = drafts.length
    // R10d, caso B com aprovação (tasks->implement): o rascunho aprovado volta para a lista, para o publish achar a transição já gravada no journal.
    if (entering?.case === 'B') {
      for (const [kind, approval] of Object.entries(entering.resumeStageApproved || {})) {
        const draft = await loadVerifiedDraft({ runDir, kind, hash: approval.contentHash })
        drafts.push({ kind, status: draft.status, contentHash: approval.contentHash, artifact: draft })
      }
    }
    if (!entering) await emit({ type: 'phase.stage.started', phase: 'Prepare', payload: { index: index + 1, stage, pipelineTo: stageTo, carry, baseReservedByRole: baseReservedFor(stage) } })
    // resumeCheckpoint é explícito em toda invocação: a runtime herda o do runGraph, e só o estágio reinvocado no caso B pode recebê-lo.
    const stageRuntime = {
      ...runtime, stageCarry: carry,
      resumeCheckpoint: entering?.case === 'B' ? entering.checkpoint : null,
      resumeAppliedSeq: entering?.case === 'B' ? entering.resumeAppliedSeq : 0,
      resumeStageApproved: entering?.case === 'B' ? entering.resumeStageApproved : null,
      ...(isReadOnlyStage(stage, stageTo) ? Object.fromEntries(PIPELINE_CHECK_FNS.map(name => [name, undefined])) : {}),
    }
    // R11: estágio só de leitura (plan, clarify, tasks->plan) não recebe CheckSpec nem checkContract; o que executa (tasks->implement, implement) recebe os originais.
    const readOnly = isReadOnlyStage(stage, stageTo)
    const stageArgs = {
      ...baseArgs, checks: readOnly ? [] : checks, ...(checkContract && !readOnly ? { checkContract } : {}),
      // baseArgs herda checkContract da run; o estágio só de leitura não o recebe.
      ...(readOnly ? { checkContract: undefined } : {}),
      stage, pipelineTo: stageTo,
      importedPlan: importedPlan ? importedPlan.content : null,
      importedTasks: importedTasks ? importedTasks.content : null,
      // M7: a aprovação do plano importado (critic) vai junto; o clarify a reaproveita para publicar as perguntas.
      importedPlanCritic: importedPlan?.critic ?? null,
      clarificationContext,
      ...(stage === 'implement' ? { plan: { goal: importedPlan.content.goal, doneWhen: importedPlan.content.doneWhen, assumptions: importedPlan.content.assumptions, nodes: importedTasks.content.nodes, effort: { level: args.effort || 'medium', why: 'tasks importado' }, complexity: 'moderate', mode: 'implement' } } : {}),
    }
    last = await invoke(stageArgs, stageRuntime)
    const outcome = await publish(stage, stageTo, last, draftsFrom)
    if (outcome.rejected) rejected = [...rejected, ...outcome.rejected]
    if (outcome.published) {
      if (outcome.published.kind === 'graph-eng.plan') pipelineState.planHash = outcome.published.contentHash
      published = [...published, { kind: outcome.published.kind, contentHash: outcome.published.contentHash }]
      if (outcome.published.kind === 'graph-eng.plan' || outcome.published.kind === 'plan') importedPlan = outcome.published
      if (outcome.published.kind === 'tasks' || outcome.published.kind === 'graph-eng.tasks') importedTasks = outcome.published
    }
    if (!outcome.proceed) {
      return { ...(outcome.stopResult ?? last), reuse, ...(rejected.length || published.length ? { phaseArtifacts: { published, rejected } } : {}) }
    }
  }
  return { ...last, reuse, ...(rejected.length || published.length ? { phaseArtifacts: { published, rejected } } : {}) }
}

export { PIPELINE_CHECK_FNS, RESUME_ROLES }
