import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'

const marker = '.graph-eng-state-root'
const markerText = 'graph-eng trusted run state v2\n'
const identityFile = 'identity.json'
// Caminhos críticos da runDir que o guard de integridade acompanha (run.meta.json é acrescentado pelo runner).
export const TRUSTED_STATE_FILES = [marker, identityFile, 'state.json', 'journal.jsonl', 'lease.json']

// integrity (C12): guard de run-integrity com trustedWrite(spec, op). Sem ele, as escritas são diretas (fixtures e uso avulso).
export function createRunState({ cwd, runDir, runId, processIdentity = () => null, lookupProcessIdentity = async () => ({ status: 'unknown' }), host = process.platform, integrity = null } = {}) {
  if (!cwd || !runDir) throw new TypeError('cwd e runDir são obrigatórios')
  validateRunId(runId)
  let dir = path.resolve(runDir)
  const guarded = (paths, expect, op) => (integrity ? integrity.trustedWrite({ paths, expect }, op) : op())
  const guardedAtomicJson = (name, value) => {
    const bytes = Buffer.from(`${canonical(value)}\n`)
    const tempName = `${name}.${randomUUID()}.tmp`
    return guarded([name, tempName], () => ({ [name]: { bytes }, [tempName]: null }), () => atomicJson(path.join(dir, name), value, path.join(dir, tempName)))
  }
  let initialized
  let eventQueue = Promise.resolve()
  let leaseQueue = Promise.resolve()
  const localOwners = new Set()
  const localControlSeqs = new Set()
  const loadedControlSeqs = new Set()
  const controlCheckpoints = new Map()
  async function init() {
    if (initialized) return initialized
    initialized = (async () => {
      const root = await realpath(cwd)
      const lexicalRelative = path.relative(path.resolve(cwd), path.resolve(runDir))
      const relative = lexicalRelative && !lexicalRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(lexicalRelative) ? path.resolve(root, lexicalRelative) : ''
      const relativeFromRoot = path.relative(root, relative)
      if (!relative || !relativeFromRoot || relativeFromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFromRoot)) throw new Error('runDir precisa estar dentro do workspace')
      dir = relative
      await mkdir(dir, { recursive: true })
      const actual = await realpath(dir)
      const actualRelative = path.relative(root, actual)
      if (actualRelative.startsWith(`..${path.sep}`) || actualRelative === '..' || path.isAbsolute(actualRelative)) throw new Error('runDir escapa do workspace por symlink')
      dir = actual
      const markerPath = path.join(dir, marker)
      try {
        const value = await readFile(markerPath, 'utf8')
        if (value !== markerText) throw new Error('Marcador de estado não reconhecido')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        const file = await open(markerPath, 'wx', 0o600).catch(e => e.code === 'EEXIST' ? null : Promise.reject(e))
        if (file) { await file.writeFile(markerText); await file.sync(); await file.close() }
        if (await readFile(markerPath, 'utf8') !== markerText) throw new Error('Marcador de estado não reconhecido')
      }
      await bindRunIdentity()
      await validateExistingState()
    })()
    return initialized
  }
  const leaseFile = () => path.join(dir, 'lease.json')
  const journalPath = () => path.join(dir, 'journal.jsonl')

  async function bindRunIdentity() {
    const file = path.join(dir, identityFile)
    try {
      const value = JSON.parse(await readFile(file, 'utf8'))
      if (value.schemaVersion !== 2 || value.runId !== runId) throw new Error(`runDir já pertence à run ${value.runId ?? 'desconhecida'}`)
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    for (const name of ['state.json', 'journal.jsonl', 'lease.json']) {
      try { await readFile(path.join(dir, name)); throw new Error(`runDir contém ${name} sem identidade persistente; preservado`) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const value = { schemaVersion: 2, runId }
    const handle = await open(file, 'wx', 0o600).catch(error => error.code === 'EEXIST' ? null : Promise.reject(error))
    if (handle) {
      try { await handle.writeFile(`${canonical(value)}\n`); await handle.sync() } finally { await handle.close() }
    }
    const actual = JSON.parse(await readFile(file, 'utf8'))
    if (actual.schemaVersion !== 2 || actual.runId !== runId) throw new Error(`runDir já pertence à run ${actual.runId ?? 'desconhecida'}`)
  }

  async function validateExistingState() {
    let state = null
    try {
      state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
      if (state.schemaVersion !== 2 || state.runId !== runId) throw new Error('state.json diverge da identidade persistente do runDir')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const journal = await readJournal(journalPath())
    if (journal.events.some(event => event.runId !== runId)) throw new Error('Journal diverge da identidade persistente do runDir')
    if (state && state.lastSeq !== undefined && (!Number.isInteger(state.lastSeq) || state.lastSeq < 0 || state.lastSeq > journal.lastSeq)) throw new Error('state.json aponta para sequência inválida no journal')
    try {
      const lease = JSON.parse(await readFile(path.join(dir, 'lease.json'), 'utf8'))
      if (lease.runId !== runId) throw new Error('Lease diverge da identidade persistente do runDir')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }

  async function acquire(options = {}) {
    await init()
    if (options.runId !== undefined && options.runId !== runId) throw new Error('runId precisa corresponder ao runDir configurado')
    const id = runId
    const file = leaseFile()
    const lease = { runId: id, nonce: randomUUID(), pid: process.pid, processStartIdentity: await processIdentity(), host, acquiredAt: new Date().toISOString() }
    if (typeof lease.processStartIdentity !== 'string' || !lease.processStartIdentity) throw new Error('Identidade de início do processo indisponível; lease seguro não pode ser criado')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeExclusive(file, lease)
        localOwners.add(ownerKey(dir, lease))
        return lease
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const current = await readLease(file)
        if (typeof current.nonce !== 'string' || !current.nonce || !Number.isInteger(current.pid) || current.pid < 1 || typeof current.processStartIdentity !== 'string' || !current.processStartIdentity || typeof current.runId !== 'string') throw new Error('Lease incompleto; preservado por estado ambíguo')
        if (current.runId !== id) throw new Error(`runDir já pertence à run ${current.runId}`)
        const status = normalizeProcessStatus(await lookupProcessIdentity(current.pid, current.host))
        if (status?.status === 'dead' || (status?.status === 'alive' && status.startIdentity !== current.processStartIdentity)) {
          await recover(file, current)
          continue
        }
        if (status?.status === 'alive' && status.startIdentity === current.processStartIdentity) throw new Error(`Run ${id} já está em execução pelo PID ${current.pid}`)
        throw new Error('Estado do processo ambíguo; lease preservado')
      }
    }
    throw new Error(`Não foi possível adquirir lease da run ${id}`)
  }

  async function recover(file, observed) {
    const gate = `${file}.recover`
    let gateFile
    try { gateFile = await open(gate, 'wx', 0o600) } catch (error) { if (error.code === 'EEXIST') throw new Error('Outra recuperação de lease está em andamento'); throw error }
    try {
      const latest = await readLease(file)
      if (latest.nonce !== observed.nonce || latest.pid !== observed.pid || latest.processStartIdentity !== observed.processStartIdentity) return
      const status = normalizeProcessStatus(await lookupProcessIdentity(latest.pid, latest.host))
      if (status?.status === 'alive' && status.startIdentity === latest.processStartIdentity) throw new Error('O dono atual do lease continua vivo')
      if (status?.status !== 'dead' && !(status?.status === 'alive' && status.startIdentity !== latest.processStartIdentity)) throw new Error('Estado do processo ambíguo; lease preservado')
      const quarantine = `${file}.stale-${latest.nonce}`
      await rename(file, quarantine)
      const moved = await readLease(quarantine)
      if (moved.nonce !== latest.nonce) { await rename(quarantine, file); throw new Error('Lease mudou durante recuperação; preservado') }
      await rm(quarantine)
    } finally { await gateFile?.close(); await rm(gate, { force: true }) }
  }

  async function assertOwner(lease) {
    await init()
    if (!localOwners.has(ownerKey(dir, lease))) throw new Error('Lease não pertence a esta instância; ela não o adquiriu')
    let current
    try { current = await readLease(leaseFile()) }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Lease não pertence ao chamador ou já foi liberado'); throw error }
    if (current.nonce !== lease?.nonce || current.pid !== lease.pid || current.processStartIdentity !== lease.processStartIdentity) throw new Error('Lease não pertence ao chamador')
    const status = normalizeProcessStatus(await lookupProcessIdentity(current.pid, current.host))
    if (status?.status !== 'alive' || status.startIdentity !== current.processStartIdentity) throw new Error('Identidade do processo do lease mudou')
    return current
  }
  function leasePathFor(lease) {
    if (validateRunId(lease?.runId) !== runId) throw new Error('Lease não corresponde ao runId deste serviço')
    return leaseFile()
  }

  async function heartbeat(lease) {
    return withLeaseOperation(async () => {
      const current = await assertOwner(lease)
      const next = { ...current, heartbeatAt: new Date().toISOString() }
      await guardedAtomicJson('lease.json', next)
    })
  }

  async function release(lease) {
    return withLeaseOperation(async () => {
      const file = leasePathFor(lease)
      const current = await assertOwner(lease)
      if (current.nonce !== lease.nonce) throw new Error('Nonce do lease mudou')
      const tombstoneName = `lease.json.release-${lease.nonce}`
      const tombstone = path.join(dir, tombstoneName)
      await guarded(['lease.json', tombstoneName], () => ({ 'lease.json': null, [tombstoneName]: null }), async () => {
        await rename(file, tombstone)
        const moved = await readLease(tombstone)
        if (moved.nonce !== lease.nonce) { await rename(tombstone, file); throw new Error('Lease substituído durante release') }
        await rm(tombstone)
      })
      localOwners.delete(ownerKey(dir, lease))
    })
  }

  function withLeaseOperation(operation) {
    const current = leaseQueue.then(operation)
    leaseQueue = current.catch(() => {})
    return current
  }

  async function emit(lease, event) {
    const operation = eventQueue.then(async () => {
      await assertOwner(lease)
      await validateExistingState()
      if (!event || typeof event.type !== 'string' || !event.type) throw new TypeError('Evento precisa de type')
      if (event.runId && event.runId !== lease.runId) throw new Error('Evento pertence a outra run')
      const file = journalPath()
      const journal = await readJournal(file)
      if (journal.partial) throw new Error('Journal termina em linha parcial; execute load(..., { recoverPartial: true }) antes de emitir')
      if (journal.events.some(item => item.runId !== lease.runId)) throw new Error('Journal contém evento de outra run')
      const seq = journal.lastSeq + 1
      const record = { ...event, runId: lease.runId, schemaVersion: 2, seq, at: new Date().toISOString() }
      // O journal esperado é o byte a byte aceito (journal.raw) mais exatamente a linha emitida.
      const line = Buffer.from(`${canonical(record)}\n`)
      const priorBytes = Buffer.from(journal.raw)
      await guarded(['journal.jsonl'], () => ({ 'journal.jsonl': { bytes: Buffer.concat([priorBytes, line]) } }), async () => {
        const handle = await open(file, 'a', 0o600)
        try { await handle.writeFile(line); await handle.sync() } finally { await handle.close() }
      })
      if (record.type === 'control.transition' && record.payload?.checkpoint && record.payload.checkpoint.schemaVersion === 2) {
        localControlSeqs.add(seq)
        controlCheckpoints.set(seq, record.payload.checkpoint)
      }
      return record
    })
    eventQueue = operation.catch(() => {})
    return operation
  }

  async function load(lease, { recoverPartial = false } = {}) {
    await assertOwner(lease)
    const file = journalPath(); const journal = await readJournal(file)
    const warnings = journal.partial ? ['Linha final parcial ignorada; recuperação explícita pendente'] : []
    if (journal.partial && recoverPartial) {
      // FIX C10–C12 (2): a truncagem é escrita do próprio supervisor; o esperado é o prefixo válido dos bytes lidos.
      const validPrefix = Buffer.from(journal.raw).subarray(0, journal.validBytes)
      await guarded(['journal.jsonl'], () => ({ 'journal.jsonl': { bytes: validPrefix } }), async () => {
        const handle = await open(file, 'r+')
        try { await handle.truncate(journal.validBytes); await handle.sync() } finally { await handle.close() }
      })
      warnings.length = 0
    }
    let state = null
    try { state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`state.json ilegível: ${error.message}`) }
    if (state && state.runId !== lease.runId) throw new Error('state.json pertence a outra run')
    if (state && state.schemaVersion !== 2) throw new Error('Versão de state.json incompatível')
    if (state && state.lastSeq !== undefined && !Number.isInteger(state.lastSeq)) throw new Error('state.json.lastSeq inválido')
    const lastSeq = state?.lastSeq ?? 0
    if (lastSeq < 0 || lastSeq > journal.lastSeq) throw new Error('state.json aponta para sequência ausente no journal')
    if (journal.events.some(event => event.runId !== lease.runId)) throw new Error('Journal contém evento de outra run')
    for (const event of journal.events) {
      if (event.type === 'control.transition' && event.payload?.checkpoint && event.payload.checkpoint.schemaVersion === 2) loadedControlSeqs.add(event.seq)
      if (event.type === 'control.transition' && event.payload?.checkpoint && event.payload.checkpoint.schemaVersion === 2) controlCheckpoints.set(event.seq, event.payload.checkpoint)
    }
    const replayEvents = journal.events.filter(event => event.seq > lastSeq)
    return { state, events: journal.events, replayEvents, persistedSeq: lastSeq, appliedSeq: lastSeq, lastSeq: journal.lastSeq, warnings }
  }

  async function writeState(lease, state) {
    await assertOwner(lease)
    await validateExistingState()
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('state precisa ser objeto')
    const current = await readStateValue(lease)
    const seq = state.lastSeq ?? current?.lastSeq ?? 0
    if (!Number.isInteger(seq) || seq < (current?.lastSeq ?? 0) || (seq > (current?.lastSeq ?? 0) && !localControlSeqs.has(seq) && !loadedControlSeqs.has(seq))) {
      throw new Error('state.lastSeq precisa ser uma sequência de checkpoint control.transition carregada ou emitida pelo supervisor')
    }
    if (seq > 0) {
      const checkpoint = controlCheckpoints.get(seq)
      const expected = checkpoint && { ...checkpoint, schemaVersion: 2, runId: lease.runId, lastSeq: seq }
      if (!expected || canonical(expected) !== canonical({ ...state, schemaVersion: 2, runId: lease.runId, lastSeq: seq })) throw new Error('state precisa corresponder integralmente ao checkpoint control.transition daquela seq')
    }
    const value = { ...state, schemaVersion: 2, runId: lease.runId }
    await guardedAtomicJson('state.json', value)
    return value
  }

  async function readStateValue(lease) {
    await assertOwner(lease)
    try { return JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`state.json ilegível: ${error.message}`) }
  }

  return { acquire, heartbeat, release, emit, writeState, load }
}

function validateRunId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) || value === '.' || value === '..') throw new TypeError('runId inválido')
  return value
}
function normalizeProcessStatus(value) {
  if (value?.status === 'dead') return { status: 'dead' }
  if (value?.status === 'alive' && typeof value.startIdentity === 'string' && value.startIdentity.length > 0) return value
  return { status: 'unknown' }
}
function ownerKey(dir, lease) { return `${dir}\0${lease?.runId}\0${lease?.nonce}` }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
async function writeExclusive(file, value) {
  const handle = await open(file, 'wx', 0o600)
  try { await handle.writeFile(`${canonical(value)}\n`); await handle.sync() } catch (error) { await rm(file, { force: true }); throw error } finally { await handle.close() }
}
async function readLease(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') throw error; throw new Error(`Lease ilegível; preservado para inspeção: ${file}`) }
}
async function atomicJson(file, value, temp = `${file}.${randomUUID()}.tmp`) {
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(`${canonical(value)}\n`); await handle.sync() } finally { await handle.close() }
  await rename(temp, file)
  const directory = await open(path.dirname(file), 'r')
  try { await directory.sync() } finally { await directory.close() }
}
async function readJournal(file) {
  let text
  try { text = await readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return { events: [], lastSeq: 0, partial: false, validBytes: 0, raw: '' }; throw error }
  const finalNewline = text.lastIndexOf('\n')
  const partial = finalNewline !== text.length - 1
  const validText = partial ? text.slice(0, finalNewline + 1) : text
  const lines = validText.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let seq = 0
  const events = []
  for (const line of lines) {
    const event = JSON.parse(line)
    if (event.seq !== seq + 1) throw new Error('Sequência de eventos inconsistente')
    seq = event.seq
    events.push(event)
  }
  return { events, lastSeq: seq, partial, validBytes: Buffer.byteLength(validText), raw: text }
}

// Leitura somente de leitura do journal de um runDir (usada por reuso de fases). Não recupera linha parcial.
export async function readJournalFile(runDir) {
  return readJournal(path.join(path.resolve(runDir), 'journal.jsonl'))
}
