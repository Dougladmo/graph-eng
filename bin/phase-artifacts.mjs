// Artefatos persistidos por fase (plan e tasks): identidade, hash de conteúdo, slot único com CAS e reuso verificado.
// Funções puras, com I/O injetável. Não importa o motor nem o runner.
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { localHostIdentity, lookupProcessIdentity as defaultLookupProcessIdentity, processIdentity as defaultProcessIdentity } from './process-identity.mjs'

export const SLOT_KINDS = ['plan', 'tasks']
export const STAGE_BY_STATUS = {
  plan: { approved: 'plan-artifact-approved', needs_clarification: 'plan-needs-clarification', rejected: 'plan-artifact-rejected' },
  tasks: { approved: 'tasks-approved', rejected: 'tasks-rejected' },
}
const KIND_BY_SLOT = { plan: 'graph-eng.plan', tasks: 'graph-eng.tasks' }
const STATUSES_BY_SLOT = { plan: ['approved', 'needs_clarification', 'rejected'], tasks: ['approved', 'rejected'] }
const MAX_ARTIFACT_BYTES = 1024 * 1024
const HEX64 = /^[a-f0-9]{64}$/
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const LOCK_NAME = '.slot.lock'

function canonicalJson(value) {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string': return JSON.stringify(value)
    case 'boolean': return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: número não finito')
      return JSON.stringify(value)
    case 'object': break
    default: throw new TypeError(`canonicalJson: tipo não suportado (${typeof value})`)
  }
  if (Array.isArray(value)) return `[${Array.from(value, item => canonicalJson(item)).join(',')}]`
  if (!isPlainObject(value)) throw new TypeError('canonicalJson: objeto não simples')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

const sha256 = text => createHash('sha256').update(text).digest('hex')
const domainHash = (domain, value) => sha256(`${domain}\u0000${canonicalJson(value)}`)
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const isHex64 = value => typeof value === 'string' && HEX64.test(value)
const isText = (value, max) => typeof value === 'string' && value.length <= max
const isStrings = value => Array.isArray(value) && value.every(item => typeof item === 'string')
const runDirOf = runId => `.graph-runs/${runId}`
const runDirOk = source => isPlainObject(source) && typeof source.runId === 'string' && RUN_ID.test(source.runId) && source.runDir === runDirOf(source.runId)

function assertSlotKind(kind) {
  if (!SLOT_KINDS.includes(kind)) throw new TypeError('kind precisa ser plan ou tasks')
}

export function planningInputsOf({ repo, task, context, spec = null, acceptedCriteria = null, host, modelPolicyHash, workflowSourceHash, realpath = realpathSync }) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) throw new TypeError('repo precisa ser caminho absoluto')
  if (typeof task !== 'string' || !task.length) throw new TypeError('tarefa vazia')
  if (typeof context !== 'string') throw new TypeError('context precisa ser texto')
  if (spec !== null && (!isPlainObject(spec) || typeof spec.path !== 'string' || !isHex64(spec.sha256))) throw new TypeError('spec inválida')
  if (acceptedCriteria !== null && !isStrings(acceptedCriteria)) throw new TypeError('acceptedCriteria inválido')
  if (!['claude', 'codex'].includes(host)) throw new TypeError('host inválido')
  if (!isHex64(modelPolicyHash) || !isHex64(workflowSourceHash)) throw new TypeError('hash de política ou motor inválido')
  return {
    schemaVersion: 1, algorithm: 'graph-eng-phases-v1', repo: realpath(repo), task, context,
    spec: spec ? { path: spec.path, sha256: spec.sha256 } : null,
    acceptedCriteria, host, modelPolicyHash, workflowSourceHash,
  }
}

export function planningKeyOf(inputs) {
  return domainHash('graph-eng:planning:v1', inputs)
}

export function workspaceIdentityOf(snapshot) {
  if (!isPlainObject(snapshot) || typeof snapshot.head !== 'string' || !Array.isArray(snapshot.files)) throw new TypeError('snapshot sem head ou files')
  const files = snapshot.files
    .map(file => {
      if (!isPlainObject(file) || typeof file.path !== 'string') throw new TypeError('snapshot com arquivo sem path')
      return file
    })
    .filter(file => !file.path.startsWith('.graph-runs/'))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return domainHash('graph-eng:phase-workspace:v1', { head: snapshot.head, files })
}

export function workspaceOf(snapshot) {
  return { head: snapshot.head, identity: workspaceIdentityOf(snapshot) }
}

export function questionSetIdOf(openQuestions) {
  return sha256(canonicalJson(openQuestions))
}

export function contentHashOf(artifact) {
  const body = { kind: artifact.kind, status: artifact.status, planningKey: artifact.planningKey, planningInputs: artifact.planningInputs, workspace: artifact.workspace }
  if (artifact.content !== undefined) body.content = artifact.content
  if (artifact.planContentHash !== undefined) body.planContentHash = artifact.planContentHash
  return domainHash('graph-eng:phase-artifact:v1', body)
}

export function sealArtifact(obj) {
  const body = { ...obj }
  delete body.contentHash
  return { ...body, contentHash: contentHashOf(body) }
}

function validateContent(kind, status, content) {
  if (!isPlainObject(content)) return 'content'
  if (kind === 'tasks') {
    if (!Array.isArray(content.nodes) || (status === 'approved' && !content.nodes.length)) return 'content.nodes'
    if (content.nodes.some(node => !isPlainObject(node) || typeof node.id !== 'string' || !['design', 'implement'].includes(node.kind) || !isStrings(node.deps))) return 'content.nodes'
    return null
  }
  if (!isText(content.goal, 2000) || !isStrings(content.doneWhen) || !isStrings(content.assumptions) || !isStrings(content.risks) || !isStrings(content.researchNodes)) return 'content.plan'
  if (!Array.isArray(content.research) || content.research.some(item => !isPlainObject(item) || typeof item.nodeId !== 'string' || typeof item.summary !== 'string' || !isStrings(item.findings))) return 'content.research'
  if (!Array.isArray(content.openQuestions) || content.openQuestions.length > 5) return 'content.openQuestions'
  const ids = new Set()
  for (const question of content.openQuestions) {
    if (!isPlainObject(question) || !/^Q[1-5]$/.test(question.id) || ids.has(question.id) || !isText(question.text, 300)) return 'content.openQuestions'
    if (question.options !== undefined && (!isStrings(question.options) || question.options.length < 2 || question.options.length > 5)) return 'content.openQuestions'
    ids.add(question.id)
  }
  if (status === 'approved' && content.openQuestions.length) return 'approved_with_questions'
  if (status === 'needs_clarification' && !content.openQuestions.length) return 'needs_clarification_without_questions'
  const expectedSetId = content.openQuestions.length ? questionSetIdOf(content.openQuestions) : null
  if (content.questionSetId !== expectedSetId) return 'questionSetId'
  if (!Array.isArray(content.clarifications) || content.clarifications.some(item => !isPlainObject(item) || typeof item.questionId !== 'string' || typeof item.text !== 'string' || !(typeof item.answer === 'string' || item.answer === null) || typeof item.skipped !== 'boolean')) return 'content.clarifications'
  return null
}

export function validateArtifact(artifact, kind) {
  assertSlotKind(kind)
  const bad = detail => ({ ok: false, reason: 'artifact_invalid', detail })
  if (!isPlainObject(artifact)) return bad('objeto')
  let size
  try { size = Buffer.byteLength(canonicalJson(artifact)) } catch { return bad('canonico') }
  if (size > MAX_ARTIFACT_BYTES) return { ok: false, reason: `${kind}_artifact_too_large`, detail: String(size) }
  if (artifact.schemaVersion !== 1 || artifact.kind !== KIND_BY_SLOT[kind]) return bad('schema_ou_kind')
  if (!STATUSES_BY_SLOT[kind].includes(artifact.status)) return bad('status')
  if (!isHex64(artifact.planningKey) || !isPlainObject(artifact.planningInputs)) return bad('planningKey')
  const inputs = artifact.planningInputs
  if (inputs.schemaVersion !== 1 || inputs.algorithm !== 'graph-eng-phases-v1' || !['claude', 'codex'].includes(inputs.host)) return bad('planningInputs')
  if (planningKeyOf(inputs) !== artifact.planningKey) return bad('planningKey_mismatch')
  if (!isPlainObject(artifact.source) || !runDirOk(artifact.source) || !Number.isSafeInteger(artifact.source.seq) || artifact.source.seq < 1) return bad('source')
  if (!isPlainObject(artifact.workspace) || typeof artifact.workspace.head !== 'string' || !isHex64(artifact.workspace.identity)) return bad('workspace')
  if (artifact.status === 'rejected') {
    if (artifact.content !== undefined || typeof artifact.reason !== 'string' || !artifact.reason || artifact.reason.length > 500) return bad('tombstone')
  } else {
    if (artifact.reason !== undefined && artifact.reason !== null) return bad('reason')
    if (artifact.content === undefined) return bad('content')
    const problem = validateContent(kind, artifact.status, artifact.content)
    if (problem) return bad(problem)
  }
  if (kind === 'plan' && artifact.status !== 'rejected') {
    if (!isPlainObject(artifact.critic) || artifact.critic.kind !== 'APPROVE' || !isStrings(artifact.critic.evidenceIds)) return bad('critic')
  } else if (artifact.critic !== undefined && artifact.critic !== null) {
    return bad('critic')
  }
  if (kind === 'tasks' && !isHex64(artifact.planContentHash)) return bad('planContentHash')
  if (kind === 'plan' && artifact.planContentHash !== undefined) return bad('planContentHash')
  if (artifact.contentHash !== contentHashOf(artifact)) return bad('contentHash')
  return { ok: true }
}

function slotPath(repo, kind) {
  return path.join(repo, '.graph-runs', 'artifacts', `${kind}.json`)
}

// hash: null se ausente; contentHash se é artefato válido; "invalid:<sha256 dos bytes>" se o slot existe mas não é artefato válido.
// Assim um slot corrompido só é sobrescrito por quem leu exatamente aqueles bytes.
export async function readSlot({ repo, kind }) {
  assertSlotKind(kind)
  let bytes
  try {
    bytes = await readFile(slotPath(repo, kind))
  } catch (error) {
    if (error?.code === 'ENOENT') return { artifact: null, invalid: false, hash: null }
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    parsed = undefined
  }
  if (parsed !== undefined && validateArtifact(parsed, kind).ok) return { artifact: parsed, invalid: false, hash: parsed.contentHash }
  return { artifact: null, invalid: true, hash: `invalid:${sha256(bytes)}` }
}

async function lockDetail(lock) {
  let pid = 'desconhecido'
  try {
    pid = String(JSON.parse(await readFile(lock, 'utf8')).pid ?? pid)
  } catch {
    // lock sem JSON legível: mantém o pid desconhecido
  }
  return `lock ${lock} com pid ${pid}; se esse processo não existe mais, remova o lock manualmente e tente de novo`
}

async function readLockRecord(lock) {
  try {
    const parsed = JSON.parse(await readFile(lock, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function releaseLock(lock, token) {
  try {
    const text = await readFile(lock, 'utf8')
    if (text.includes(token)) await unlink(lock)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

// Órfão só com prova: mesmo host, identidade de início gravada e (processo morto ou pid reutilizado com outra identidade).
// Qualquer dúvida (unknown, lock ilegível, sem identidade gravada) preserva o lock.
async function lockIsOrphan(record, { host, lookupProcessIdentity }) {
  if (!record || record.host !== host || typeof record.processStartIdentity !== 'string' || !record.processStartIdentity || !Number.isInteger(record.pid)) return false
  const status = await lookupProcessIdentity(record.pid, record.host)
  if (status?.status === 'dead') return true
  return status?.status === 'alive' && typeof status.startIdentity === 'string' && status.startIdentity !== record.processStartIdentity
}

// Quarentena no padrão de resource-lock: gate <lock>.recover com wx, confere o token observado e renomeia para <lock>.stale-<token>.
async function quarantineLock(lock, observed, opts) {
  const gate = `${lock}.recover`
  let gateHandle
  try {
    gateHandle = await open(gate, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
  try {
    const latest = await readLockRecord(lock)
    if (!latest || latest.token !== observed.token) return false
    if (!(await lockIsOrphan(latest, opts))) return false
    await rename(lock, `${lock}.stale-${observed.token}`)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  } finally {
    await gateHandle.close()
    await rm(gate, { force: true })
  }
}

// Publica o slot com compare-and-swap sob lock exclusivo e curto. Falha fechado: nunca espera o lock.
export async function writeSlot({ repo, kind, artifact, expectedPrevContentHash, processIdentity = defaultProcessIdentity, lookupProcessIdentity = defaultLookupProcessIdentity }) {
  assertSlotKind(kind)
  const prevOk = expectedPrevContentHash === null || (typeof expectedPrevContentHash === 'string' && /^(invalid:)?[a-f0-9]{64}$/.test(expectedPrevContentHash))
  if (!prevOk) throw new TypeError('expectedPrevContentHash precisa ser hash, invalid:<hash> ou null')
  const valid = validateArtifact(artifact, kind)
  if (!valid.ok) throw new Error(`${valid.reason}: ${valid.detail}`)
  const dir = path.join(repo, '.graph-runs', 'artifacts')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const lock = path.join(dir, LOCK_NAME)
  const token = randomUUID()
  const host = localHostIdentity()
  let startIdentity = null
  try {
    startIdentity = await processIdentity({ host })
  } catch {
    startIdentity = null // sem identidade, o lock não será tratado como órfão por ninguém
  }
  const lockRecord = { schemaVersion: 1, pid: process.pid, host, processStartIdentity: typeof startIdentity === 'string' ? startIdentity : null, token, startedAt: new Date().toISOString() }
  const orphanOpts = { host, lookupProcessIdentity }
  let lockHandle = null
  let recovered = false
  for (;;) {
    try {
      lockHandle = await open(lock, 'wx', 0o600)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const observed = await readLockRecord(lock)
      if (recovered || !observed || typeof observed.token !== 'string' || !(await lockIsOrphan(observed, orphanOpts)) || !(await quarantineLock(lock, observed, orphanOpts))) {
        return { published: false, reason: 'artifact_slot_locked', detail: await lockDetail(lock) }
      }
      recovered = true
    }
  }
  let tmp = null
  try {
    await lockHandle.writeFile(`${JSON.stringify(lockRecord)}\n`)
    await lockHandle.sync()
    await lockHandle.close()
    lockHandle = null
    const current = await readSlot({ repo, kind })
    if (current.hash !== expectedPrevContentHash) return { published: false, reason: 'artifact_slot_changed' }
    const target = slotPath(repo, kind)
    tmp = `${target}.${token}.tmp`
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, target)
    tmp = null
    const dirHandle = await open(dir, 'r')
    try {
      await dirHandle.sync()
    } finally {
      await dirHandle.close()
    }
    return { published: true, contentHash: artifact.contentHash }
  } finally {
    if (lockHandle) await lockHandle.close()
    if (tmp) await rm(tmp, { force: true })
    await releaseLock(lock, token)
  }
}

// Confere se o artefato aponta para um estágio aprovado de verdade na run de origem (meta v2 + journal íntegro + hash).
export async function verifySource({ repo, artifact, readJournal, readMeta }) {
  const fail = detail => ({ ok: false, reason: 'source_unverified', detail })
  if (!isPlainObject(artifact) || !runDirOk(artifact.source)) return fail('source')
  const kindName = artifact.kind === 'graph-eng.tasks' ? 'tasks' : 'plan'
  const expectedStage = STAGE_BY_STATUS[kindName]?.[artifact.status]
  if (!expectedStage) return fail('stage_unknown')
  const src = artifact.source
  let meta
  let journal
  try {
    const runDir = path.join(repo, src.runDir)
    meta = await readMeta(runDir)
    journal = await readJournal(runDir)
  } catch {
    return fail('io')
  }
  if (!isPlainObject(meta) || meta.schemaVersion !== 2) return fail('meta_not_v2')
  if (meta.runId !== src.runId) return fail('meta_run_mismatch')
  if (meta.host !== artifact.planningInputs.host) return fail('meta_host_mismatch')
  if (meta.cwd !== artifact.planningInputs.repo) return fail('meta_cwd_mismatch')
  if (!journal || journal.partial) return fail('journal_partial')
  const event = (Array.isArray(journal.events) ? journal.events : []).find(item => item?.seq === src.seq)
  if (!event) return fail('seq_missing')
  if (event.type !== 'control.transition' || event.runId !== src.runId) return fail('event_not_transition')
  if (event.payload?.stage !== expectedStage) return fail('stage_mismatch')
  if (event.payload?.contentHash !== contentHashOf(artifact)) return fail('content_hash_mismatch')
  return { ok: true }
}

// Ordem fixa de motivos. O primeiro que falha vai em rejected[0]. "absent" significa só que não há slot.
export async function resolveReuse({ repo, kind, slot, planningKey, workspace, planArtifact, readJournal, readMeta }) {
  assertSlotKind(kind)
  const reject = (reason, detail) => ({ ok: false, artifact: null, rejected: [{ kind, reason, ...(detail !== undefined ? { detail } : {}) }] })
  if (slot?.invalid) return reject('artifact_invalid', 'json')
  const artifact = slot?.artifact ?? null
  if (!artifact) return reject('absent')
  const valid = validateArtifact(artifact, kind)
  if (!valid.ok) return reject(valid.reason, valid.detail)
  if (artifact.planningKey !== planningKey) return reject('task_changed')
  const source = await verifySource({ repo, artifact, readJournal, readMeta })
  if (!source.ok) return reject('source_unverified', source.detail)
  if (artifact.workspace.identity !== workspace?.identity) return reject('workspace_changed')
  if (artifact.status !== 'approved') return reject(`not_approved:${artifact.status}`)
  if (kind === 'tasks' && (!planArtifact || planArtifact.contentHash !== artifact.planContentHash)) return reject('tasks_plan_mismatch')
  return { ok: true, artifact, rejected: [] }
}

// Decide os estágios de uma run com pipeline a partir dos reusos já resolvidos (ordem e motivos vêm de resolveReuse).
// Não toca em disco nem chama o motor: devolve run (estágios), block (BLOCK com motivo) ou questions (perguntas sem chamada).
export function decidePipelineStages({ pipeline, planRes, tasksRes = null, planSlot = null, clarification = null }) {
  const planReason = planRes?.rejected?.[0]?.reason ?? null
  const planPending = planReason === 'not_approved:needs_clarification'
  const planMissing = () => ({ action: 'block', reason: `plan_missing_or_incompatible:${planReason ?? 'approved_without_questions'}` })
  const questions = () => ({ questionSetId: planSlot.artifact.content.questionSetId, questions: planSlot.artifact.content.openQuestions })
  const run = (stages, extra = {}) => ({ action: 'run', stages, pipelineTo: extra.pipelineTo ?? null, importedPlan: extra.importedPlan ?? null, importedTasks: extra.importedTasks ?? null, clarificationContext: extra.clarificationContext ?? null })
  const answered = () => {
    if (!planPending) return planMissing()
    if (clarification.questionSetId !== planSlot.artifact.content.questionSetId) return { action: 'block', reason: 'clarification_stale' }
    const expected = planSlot.artifact.content.openQuestions.map(item => item.id).sort().join(',')
    const received = clarification.answers.map(item => item.questionId).sort().join(',')
    if (expected !== received) return { action: 'block', reason: 'clarification_incomplete' }
    return run(['plan'], { importedPlan: planSlot.artifact, clarificationContext: { questions: planSlot.artifact.content.openQuestions, answers: clarification.answers } })
  }
  if (pipeline.from === 'auto') {
    if (tasksRes?.ok) return run(['implement'], { importedTasks: tasksRes.artifact, importedPlan: planSlot.artifact })
    if (planRes?.ok) return run(['tasks'], { pipelineTo: 'implement', importedPlan: planRes.artifact })
    if (planPending) return { action: 'block', reason: 'needs_clarification', clarification: questions(), next: 'clarify' }
    return run(['plan', 'tasks'], { pipelineTo: 'implement' })
  }
  if (pipeline.from === 'tasks') {
    if (planRes?.ok) return run(['tasks'], { pipelineTo: 'tasks', importedPlan: planRes.artifact })
    if (planPending) return { action: 'block', reason: 'needs_clarification', clarification: questions(), next: 'clarify' }
    return planMissing()
  }
  if (pipeline.from === 'clarify') {
    if (!clarification) {
      if (planPending) return { action: 'questions', clarification: questions() }
      if (planRes?.ok) return run(['clarify'], { importedPlan: planRes.artifact })
      return planMissing()
    }
    return answered()
  }
  // plan -> plan: planejamento novo; com respostas, as perguntas do slot entram como dado.
  if (clarification) return answered()
  return run(['plan'])
}

export { canonicalJson as canonicalJsonOf }
