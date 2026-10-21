import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { assertDescendant, validateRegistryEntry, validateRunIdentity } from './run-registry.mjs'

const MARKER = '.graph-eng-state-root'
const MARKER_TEXT = 'graph-eng trusted run state v2\n'
const TERMINAL_STATUSES = new Set(['done', 'blocked', 'needs_clarification', 'plan_only'])

// Leitura estritamente observacional: não adquire nem recupera lease e nunca corrige arquivos.
export async function readRunV2(input) {
  const warnings = []
  try {
    const entry = validateRegistryEntry(input)
    const [cwd, runDir] = await Promise.all([realpath(entry.cwd), realpath(entry.runDir)])
    if (cwd !== entry.cwd || runDir !== entry.runDir) throw new Error('Caminhos registrados deixaram de apontar para as identidades reais')
    assertDescendant(cwd, runDir)
    const signatures = {}
    const readObserved = async name => {
      const file = path.join(runDir, name)
      try {
        let handle
        try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) }
        catch (error) { if (error.code === 'ELOOP') throw new Error(`${name} não é arquivo regular`); throw error }
        try {
          const info = await handle.stat()
          if (!info.isFile()) throw new Error(`${name} não é arquivo regular`)
          const bytes = await handle.readFile()
          signatures[name] = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs ?? BigInt(Math.round(info.mtimeMs * 1e6))}:${createHash('sha256').update(bytes).digest('hex')}`
          return bytes
        } finally { await handle.close() }
      } catch (error) {
        if (error.code === 'ENOENT') { signatures[name] = 'missing'; return null }
        throw error
      }
    }

    // Relê bytes apenas para produzir uma assinatura de cache que também considera lease.
    const marker = await readObserved(MARKER)
    if (!marker || marker.toString('utf8') !== MARKER_TEXT) throw new Error('Marcador da run ausente ou inválido')
    const identityBytes = await readObserved('identity.json')
    const metaBytes = await readObserved('run.meta.json')
    if (!identityBytes || !metaBytes) throw new Error('identity.json ou run.meta.json ausente')
    const { meta } = await validateRunIdentity(cwd, runDir, entry.runId, entry.host, { marker, identity: identityBytes, meta: metaBytes })
    const stateBytes = await readObserved('state.json')
    const journalBytes = await readObserved('journal.jsonl')
    const leaseBytes = await readObserved('lease.json')

    let state = null
    if (stateBytes) {
      state = JSON.parse(stateBytes.toString('utf8'))
      if (!state || typeof state !== 'object' || Array.isArray(state) || state.schemaVersion !== 2 || state.runId !== entry.runId) throw new Error('state.json diverge da identidade da run ou usa schema incompatível')
      if (state.lastSeq !== undefined && (!Number.isInteger(state.lastSeq) || state.lastSeq < 0)) throw new Error('state.json.lastSeq inválido')
    }
    const journal = parseJournal(journalBytes?.toString('utf8') || '', entry.runId)
    if (state?.lastSeq !== undefined && state.lastSeq > journal.lastSeq) throw new Error('state.json aponta para sequência ausente no journal')
    if (journal.partial) warnings.push({ code: 'partial_journal', message: 'Linha final parcial ignorada; a run pode estar incompleta' })

    let leasePresent = false
    if (leaseBytes) {
      leasePresent = true
      const lease = JSON.parse(leaseBytes.toString('utf8'))
      if (lease?.runId !== entry.runId || typeof lease.nonce !== 'string' || !lease.nonce || !Number.isInteger(lease.pid) || lease.pid < 1 || typeof lease.processStartIdentity !== 'string' || !lease.processStartIdentity) {
        warnings.push({ code: 'invalid_lease', message: 'Lease presente, mas não verificável por esta leitura somente observacional' })
      } else warnings.push({ code: 'lease_unverified', message: 'Lease presente; esta leitura não verifica o processo proprietário' })
    }
    if (!['claude', 'codex'].includes(entry.host)) warnings.push({ code: 'unsupported_host', message: `Host ${entry.host} é desconhecido; run disponível somente para leitura` })
    const terminal = terminalFromJournal(journal.events)
    let status = 'unknown'
    let statusReason = leasePresent ? 'lease_owner_unverified' : 'terminal_contract_unsupported'
    if (!terminal) warnings.push({ code: 'terminal_status_unsupported', message: 'Nenhum evento run.finished; status terminal desconhecido' })
    else if (terminal.invalid) warnings.push({ code: 'terminal_status_invalid', message: 'run.finished com status fora do enum; status permanece desconhecido' })
    else if (!terminal.last) warnings.push({ code: 'terminal_not_last', message: 'run.finished não é o último evento; status permanece desconhecido' })
    else if (!leasePresent) { status = terminal.status; statusReason = 'run_finished_event' }
    return {
      run: {
        generation: 'v2', key: createHash('sha256').update(JSON.stringify([cwd, runDir, entry.runId])).digest('hex'),
        runId: entry.runId, cwd, runDir, host: entry.host, task: typeof meta.task === 'string' ? meta.task : null,
        status, statusReason,
        state: projectState(state), events: journal.events.map(projectEvent), eventCount: journal.events.length,
        lastSeq: journal.lastSeq, warnings, actionable: false,
      },
      warnings,
      signatures,
    }
  } catch (error) {
    const warning = { code: 'invalid_v2_run', message: error.message }
    return { run: null, warnings: [...warnings, warning], signatures: {} }
  }
}

// Só run.finished conta como terminal; a decisão exige último evento e status do enum.
function terminalFromJournal(events) {
  const index = events.findLastIndex(event => event.type === 'run.finished')
  if (index === -1) return null
  const status = events[index].payload?.status
  if (!TERMINAL_STATUSES.has(status)) return { invalid: true, last: false }
  return { status, last: index === events.length - 1 }
}

function parseJournal(text, runId) {
  const finalNewline = text.lastIndexOf('\n')
  const partial = text.length > 0 && finalNewline !== text.length - 1
  const validText = partial ? text.slice(0, finalNewline + 1) : text
  const lines = validText.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const events = []
  let seq = 0
  for (const line of lines) {
    if (!line) throw new Error('Journal contém linha vazia/corrompida')
    const event = JSON.parse(line)
    if (!event || typeof event !== 'object' || Array.isArray(event) || event.schemaVersion !== 2 || event.runId !== runId || !Number.isInteger(event.seq) || event.seq !== seq + 1) throw new Error('Journal contém schema, runId ou sequência inconsistente')
    events.push(event)
    seq = event.seq
  }
  return { events, lastSeq: seq, partial }
}

function projectState(state) {
  if (!state) return null
  const feedback = state.feedback && typeof state.feedback === 'object' ? projectFeedback(state.feedback) : null
  return {
    schemaVersion: state.schemaVersion,
    runId: state.runId,
    ...(Number.isInteger(state.lastSeq) ? { lastSeq: state.lastSeq } : {}),
    ...(Number.isInteger(state.planVersion) ? { planVersion: state.planVersion } : {}),
    ...(feedback && Object.keys(feedback).length ? { feedback } : {}),
  }
}

function projectEvent(event) {
  const safe = { schemaVersion: 2, runId: event.runId, seq: event.seq }
  if (typeof event.at === 'string' && event.at.length <= 64 && Number.isFinite(Date.parse(event.at))) safe.at = event.at
  if (safeToken(event.type, 100)) safe.type = event.type
  if (typeof event.agentId === 'string' && /^a[a-f0-9]{16}$/.test(event.agentId)) safe.agentId = event.agentId
  if (typeof event.key === 'string' && /^v2:[a-f0-9]{32}$/.test(event.key)) safe.key = event.key
  for (const key of ['phase', 'nodeId']) if (safeToken(event[key], 160)) safe[key] = event[key]
  if (Number.isSafeInteger(event.planVersion) && event.planVersion > 0) safe.planVersion = event.planVersion
  if (event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)) {
    const payload = {}
    if (safeToken(event.payload.role, 80)) payload.role = event.payload.role
    if (event.type === 'run.finished' && TERMINAL_STATUSES.has(event.payload.status)) payload.status = event.payload.status
    if (event.type === 'control.transition') {
      if (safeToken(event.payload.stage, 100)) payload.stage = event.payload.stage
      if (Number.isSafeInteger(event.payload.previousPlanVersion) && event.payload.previousPlanVersion > 0) payload.previousPlanVersion = event.payload.previousPlanVersion
    }
    if (event.type === 'memory.selected' && typeof event.payload.selectionId === 'string' && /^sel-[a-f0-9]{64}$/.test(event.payload.selectionId)) payload.selectionId = event.payload.selectionId
    if (event.type === 'memory.selected' && typeof event.payload.reused === 'boolean') payload.reused = event.payload.reused
    if (safeToken(event.payload.model, 120)) payload.model = event.payload.model
    if (Object.hasOwn(event.payload, 'requestedModel')) {
      const requestedModel = boundedModel(event.payload.requestedModel)
      if (requestedModel.valid) payload.requestedModel = requestedModel.value
    }
    if (Object.hasOwn(event.payload, 'effectiveModel')) {
      const effectiveModel = boundedModel(event.payload.effectiveModel)
      if (effectiveModel.valid) payload.effectiveModel = effectiveModel.value
    }
    const usage = projectUsage(event.payload.usage)
    if (usage) payload.usage = usage
    if (event.payload.feedback && typeof event.payload.feedback === 'object') {
      const feedback = projectFeedback(event.payload.feedback) || {}
      if (Object.keys(feedback).length) payload.feedback = feedback
    }
    if (typeof event.payload.reason === 'string') payload.reason = shortText(event.payload.reason)
    if (severity(event.payload.severity)) payload.severity = event.payload.severity
    const affectedNodes = stringIds(event.payload.affectedNodes)
    if (affectedNodes) payload.affectedNodes = affectedNodes
    const evidenceIds = stringIds(event.payload.evidenceIds)
    if (evidenceIds) payload.evidenceIds = evidenceIds
    if (safeHash(event.payload.identity)) payload.identity = event.payload.identity
    if (safeToken(event.payload.checkId, 100)) payload.checkId = event.payload.checkId
    if (typeof event.payload.valid === 'boolean') payload.valid = event.payload.valid
    if (Object.keys(payload).length) safe.payload = payload
  }
  const canonicalFeedback = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) && event.payload.feedback
  const aliasFeedback = event.feedback || (event.result && typeof event.result === 'object' && event.result.feedback)
  if (canonicalFeedback || aliasFeedback) {
    const feedback = projectFeedback(canonicalFeedback || aliasFeedback) || {}
    if (Object.keys(feedback).length) safe.feedback = feedback
  }
  return safe
}

function projectFeedback(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const feedback = {}
  if (['APPROVE', 'FIX_LOCAL', 'REPLAN', 'BLOCK', 'DONE'].includes(value.kind)) feedback.kind = value.kind
  if (typeof value.reason === 'string') feedback.reason = shortText(value.reason)
  if (severity(value.severity)) feedback.severity = value.severity
  const affectedNodes = stringIds(value.affectedNodes)
  if (affectedNodes) feedback.affectedNodes = affectedNodes
  const evidenceIds = stringIds(value.evidenceIds)
  if (evidenceIds) feedback.evidenceIds = evidenceIds
  return feedback
}

function projectUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = {}
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'cached_tokens']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) usage[key] = value[key]
  }
  return Object.keys(usage).length ? usage : null
}

function boundedModel(value) {
  if (value === null) return { valid: true, value: null }
  if (safeToken(value, 120)) return { valid: true, value }
  return { valid: false }
}

function stringIds(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some(item => !safeToken(item, 160))) return null
  return [...value]
}
function safeToken(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && /^[\p{L}\p{N}._:/@+-]+$/u.test(value) }
function safeHash(value) { return typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/i.test(value) }
function severity(value) { return ['none', 'low', 'medium', 'high', 'critical'].includes(value) }
function shortText(value) { return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240) }
