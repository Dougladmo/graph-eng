import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, mkdir, open, readdir, realpath, rm, lstat, rename } from 'node:fs/promises'
import path from 'node:path'

const RECORD_KEYS = ['schemaVersion', 'kind', 'repoId', 'topic', 'summary', 'scope', 'source', 'validity']
const KINDS = new Set(['decision', 'contract', 'evidence', 'failure', 'version'])
const ARTIFACT_KINDS = new Set(['decision', 'contract', 'receipt', 'snapshot', 'feedback'])
const ROLE_KINDS = {
  planner: new Set(['decision', 'contract', 'failure', 'version']),
  // R-E9a 3E: evidence de nó (receipt da fase node) entra no worker; a consulta já exige nodeId e contrato.
  worker: new Set(['decision', 'contract', 'failure', 'evidence']),
  critic: new Set(['evidence', 'failure', 'version', 'decision']),
}
const ROLE_LIMITS = {
  planner: { count: 8, bytes: 12 * 1024 },
  worker: { count: 4, bytes: 6 * 1024 },
  critic: { count: 8, bytes: 12 * 1024 },
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/**
 * Private, append-only memory for one canonical repository. resolveSource is a
 * trusted supervisor callback; this module never accepts a source filesystem path.
 * Event references use { id: `${runId}:${eventSeq}`, runId, eventSeq, hash,
 * identity: { runId, eventSeq }, kind: 'event' } so the supervisor can resolve
 * the exact persisted event without this module assuming an event payload schema.
 */
export async function createRunMemory({ rootDir, repoRoot, resolveSource } = {}) {
  if (typeof rootDir !== 'string' || !rootDir) throw new TypeError('rootDir é obrigatório')
  if (typeof repoRoot !== 'string' || !repoRoot) throw new TypeError('repoRoot é obrigatório')
  if (typeof resolveSource !== 'function') throw new TypeError('resolveSource confiável é obrigatório')

  const repo = await realpath(repoRoot)
  const repoId = sha(Buffer.from(repo))
  await mkdir(path.resolve(rootDir), { recursive: true, mode: 0o700 })
  const root = await realpath(path.resolve(rootDir))
  await chmod(root, 0o700)
  const recordsDir = path.join(root, 'records')
  const selectionsDir = path.join(root, 'selections')
  await ensurePrivateDir(recordsDir)
  await ensurePrivateDir(selectionsDir)
  let indexQueue = Promise.resolve()

  async function register(input) {
    const record = validateRecord(input, repoId)
    try {
      await verifySources(record, resolveSource)
    } catch (error) {
      return { registered: false, diagnostic: { code: 'invalid_source', message: error.message } }
    }

    const hash = digestRecord(record)
    const id = `mem-${hash}`
    const envelope = { schemaVersion: 1, id, hash, record }
    const created = await persistExclusive(recordsDir, `${hash}.json`, envelope)
    const projection = indexQueue.then(writeIndex)
    indexQueue = projection.catch(() => {})
    await projection
    return { id, hash, created }
  }

  async function select(input) {
    const query = normalizeQuery(input, repoId)
    const loaded = await readRecords()
    const omissions = [...loaded.omissions]
    const validSources = new Set()
    for (const entry of loaded.records) {
      try { await verifySources(entry.record, resolveSource); validSources.add(entry.id) }
      catch (error) { omissions.push({ id: entry.id, reason: `fonte inválida: ${error.message}` }) }
    }
    const candidates = []
    for (const entry of loaded.records) {
      if (entry.record.repoId !== query.repoId) continue
      if (!ROLE_KINDS[query.role].has(entry.record.kind)) continue
      if (!validSources.has(entry.id) || !fingerprintsCompatible(entry.record, query)) continue
      const relevance = relevanceRank(entry.record, query)
      if (relevance === null) continue
      candidates.push({ ...entry, relevance })
    }
    const candidateIds = new Set(candidates.map(entry => entry.id))
    const superseded = new Set()
    for (const entry of candidates) {
      for (const oldId of entry.record.validity.supersedes) if (candidateIds.has(oldId)) superseded.add(oldId)
    }
    const selectedCandidates = candidates
      .filter(entry => !superseded.has(entry.id))
      .sort((a, b) => a.relevance - b.relevance || a.id.localeCompare(b.id))

    const limit = ROLE_LIMITS[query.role]
    const records = []
    let used = 0
    for (const candidate of selectedCandidates) {
      const size = Buffer.byteLength(canonical(candidate.record))
      if (records.length >= limit.count || used + size > limit.bytes) {
        omissions.push({ id: candidate.id, reason: records.length >= limit.count ? 'limite de quantidade' : 'limite de tamanho' })
        continue
      }
      records.push({ id: candidate.id, hash: candidate.hash, record: candidate.record })
      used += size
    }
    omissions.sort((a, b) => String(a.id).localeCompare(String(b.id)) || a.reason.localeCompare(b.reason))
    const selection = {
      schemaVersion: 1,
      selectionId: selectionDigest(query, records, omissions),
      query,
      records,
      omissions,
    }
    await persistExclusive(selectionsDir, `${selection.selectionId}.json`, selection)
    return selection
  }

  async function verifySelection(selection) {
    try {
      validateSelectionShape(selection, repoId)
      const selectionFile = await readStoredJson(selectionsDir, `${selection.selectionId}.json`)
      if (canonical(selectionFile) !== canonical(selection)) return invalid('seleção diverge do snapshot persistido')
      if (selection.selectionId !== selectionDigest(selection.query, selection.records, selection.omissions)) return invalid('hash da seleção diverge')
      for (const item of selection.records) {
        const saved = await readRecord(item.id)
        if (!saved || saved.hash !== item.hash || canonical(saved.record) !== canonical(item.record)) return invalid(`registro alterado ou ausente: ${item.id}`)
        await verifySources(saved.record, resolveSource)
      }
      return { valid: true, selectionId: selection.selectionId, diagnostics: [] }
    } catch (error) {
      return invalid(error.message)
    }
  }

  async function writeIndex() {
    await writeAtomic(path.join(root, 'INDEX.md'), await indexText())
  }

  async function indexText() {
    const loaded = await readRecords()
    const valid = []
    for (const item of loaded.records) {
      try { await verifySources(item.record, resolveSource); valid.push(item) } catch { /* projeção ignora fonte indisponível */ }
    }
    const rows = valid.map(({ id, record }) => {
      const scope = [...record.scope.nodeIds, ...record.scope.paths, ...record.scope.contracts.map(c => c.id)].join(', ') || 'escopo explícito indisponível'
      return `| ${escapeCell(record.kind)} | ${escapeCell(record.topic)} | ${escapeCell(record.source.runId)} | ${escapeCell(record.source.planVersion)} | ${escapeCell(scope)} | ${id} | REPORT.md da run ${escapeCell(record.source.runId)} |`
    })
    return ['# INDEX de memória', '', '| Tipo | Assunto | Run | Versão | Escopo | ID | REPORT |', '| --- | --- | --- | --- | --- | --- | --- |', ...rows, ''].join('\n')
  }

  async function readRecords() {
    const records = []; const omissions = []
    for (const name of (await readdir(recordsDir)).sort()) {
      if (!name.endsWith('.json')) continue
      try {
        const envelope = await readStoredJson(recordsDir, name)
        const record = validateRecord(envelope.record, repoId)
        const hash = digestRecord(record)
        const id = `mem-${hash}`
        if (name !== `${hash}.json` || envelope.id !== id || envelope.hash !== hash || envelope.schemaVersion !== 1) throw new Error('envelope ou hash divergente')
        records.push({ id, hash, record })
      } catch (error) { omissions.push({ id: name, reason: `registro inválido: ${error.message}` }) }
    }
    return { records, omissions }
  }

  async function readRecord(id) {
    if (!/^mem-[a-f0-9]{64}$/.test(id)) return null
    const name = `${id.slice(4)}.json`
    try {
      const envelope = await readStoredJson(recordsDir, name)
      const record = validateRecord(envelope.record, repoId)
      const hash = digestRecord(record)
      if (envelope.schemaVersion !== 1 || envelope.id !== id || envelope.hash !== hash || id !== `mem-${hash}`) return null
      return { id, hash, record }
    } catch { return null }
  }

  async function verifySources(record, resolver) {
    const eventRef = {
      id: `${record.source.runId}:${record.source.eventSeq}`,
      runId: record.source.runId,
      eventSeq: record.source.eventSeq,
      hash: record.source.eventHash,
      identity: { runId: record.source.runId, eventSeq: record.source.eventSeq },
      kind: 'event',
    }
    await resolveVerified(eventRef, resolver, true)
    for (const ref of record.source.artifactRefs) await resolveVerified(ref, resolver)
  }

  // E10: lê a seleção persistida pelo id (sem validar; quem decide é verifySelection).
  async function readSelection(selectionId) {
    if (typeof selectionId !== 'string' || !/^sel-[a-f0-9]{64}$/.test(selectionId)) return null
    try { return await readStoredJson(selectionsDir, `${selectionId}.json`) }
    catch { return null }
  }

  return { repoId, register, select, verifySelection, readSelection, renderIndex: indexText }
}

async function resolveVerified(ref, resolver, event = false) {
  let resolved
  try { resolved = await resolver(ref) }
  catch { throw new Error(`fonte ${ref.id} não resolvida`) }
  if (!resolved || resolved.verified !== true || !(Buffer.isBuffer(resolved.bytes) || resolved.bytes instanceof Uint8Array)) throw new Error(`fonte ${ref.id} não está verificada`)
  if (sha(resolved.bytes) !== ref.hash) throw new Error(`hash da fonte ${ref.id} diverge`)
  if (canonical(resolved.identity) !== canonical(ref.identity)) throw new Error(`identidade da fonte ${ref.id} diverge`)
  if (event && !Buffer.from(resolved.bytes).length) throw new Error(`evento persistido ${ref.id} está vazio`)
}

function validateRecord(value, expectedRepoId) {
  exact(value, RECORD_KEYS, 'registro')
  if (value.schemaVersion !== 1 || !KINDS.has(value.kind)) throw new Error('schemaVersion ou kind inválido')
  if (value.repoId !== expectedRepoId) throw new Error('repoId não corresponde ao repositório canônico')
  string(value.topic, 'topic', 1, 160); string(value.summary, 'summary', 1, 2048)
  if (Buffer.byteLength(value.summary, 'utf8') > 2048) throw new Error('summary excede 2 KiB UTF-8')
  if (value.kind === 'decision' && !value.source?.artifactRefs?.some(ref => ref.kind === 'decision')) throw new Error('decision exige referência de artefato de decisão versionado')
  exact(value.scope, ['nodeIds', 'paths', 'contracts'], 'scope')
  const nodeIds = stringList(value.scope.nodeIds, 64, 'scope.nodeIds')
  exactArray(value.scope.paths, 32, 'scope.paths')
  const paths = value.scope.paths.map(canonicalRepoPath)
  if (paths.length > 32) throw new Error('scope.paths excede 32 itens')
  unique(paths, 'scope.paths')
  exactArray(value.scope.contracts, 16, 'scope.contracts')
  const contracts = value.scope.contracts.map(item => {
    exact(item, ['id', 'fingerprint'], 'scope.contracts[]')
    return { id: string(item.id, 'contract.id', 1, 160), fingerprint: hashString(item.fingerprint, 'contract.fingerprint') }
  }).sort((a, b) => a.id.localeCompare(b.id) || a.fingerprint.localeCompare(b.fingerprint))
  unique(contracts.map(item => `${item.id}\0${item.fingerprint}`), 'scope.contracts')

  exact(value.source, ['runId', 'planVersion', 'eventSeq', 'eventHash', 'artifactRefs'], 'source')
  string(value.source.runId, 'source.runId', 1, 128, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  string(value.source.planVersion, 'source.planVersion', 1, 160)
  if (!Number.isSafeInteger(value.source.eventSeq) || value.source.eventSeq < 1) throw new Error('source.eventSeq precisa ser inteiro positivo')
  const eventHash = hashString(value.source.eventHash, 'source.eventHash')
  exactArray(value.source.artifactRefs, 16, 'source.artifactRefs')
  if (!value.source.artifactRefs.length) throw new Error('source.artifactRefs não pode ser vazio')
  const artifactRefs = value.source.artifactRefs.map(ref => {
    exact(ref, ['id', 'hash', 'identity', 'kind'], 'source.artifactRefs[]')
    if (!ARTIFACT_KINDS.has(ref.kind)) throw new Error('kind de artifactRef inválido')
    return {
      id: string(ref.id, 'artifact.id', 1, 256),
      hash: hashString(ref.hash, 'artifact.hash'),
      identity: string(ref.identity, 'artifact.identity', 1, 256),
      kind: ref.kind,
    }
  }).sort((a, b) => a.id.localeCompare(b.id))
  unique(artifactRefs.map(ref => ref.id), 'source.artifactRefs')

  exact(value.validity, ['inputFingerprints', 'supersedes'], 'validity')
  const inputFingerprints = hashList(value.validity.inputFingerprints, 16, 'validity.inputFingerprints')
  exactArray(value.validity.supersedes, 16, 'validity.supersedes')
  const supersedes = value.validity.supersedes.map(id => {
    if (typeof id !== 'string' || !/^mem-[a-f0-9]{64}$/.test(id)) throw new Error('validity.supersedes contém ID inválido')
    return id
  }).sort()
  if (supersedes.length > 16) throw new Error('validity.supersedes excede 16 itens')
  unique(supersedes, 'validity.supersedes')

  const record = {
    schemaVersion: 1, kind: value.kind, repoId: value.repoId, topic: value.topic, summary: value.summary,
    scope: { nodeIds, paths: paths.sort(), contracts },
    source: { runId: value.source.runId, planVersion: value.source.planVersion, eventSeq: value.source.eventSeq, eventHash, artifactRefs },
    validity: { inputFingerprints, supersedes },
  }
  const bytes = Buffer.from(canonical(record))
  if (bytes.length > 16 * 1024) throw new Error('registro excede 16 KiB')
  return record
}

function normalizeQuery(value, repoId) {
  exact(value, ['role', 'repoId', 'nodeId', 'paths', 'contracts', 'inputFingerprints', 'kinds'], 'query', true)
  if (!['planner', 'worker', 'critic'].includes(value.role)) throw new Error('role precisa ser planner, worker ou critic')
  if (value.repoId !== repoId) throw new Error('repoId da consulta não corresponde ao repositório canônico')
  const nodeId = value.nodeId === undefined ? undefined : string(value.nodeId, 'nodeId', 1, 160)
  const requestedPaths = value.paths ?? []
  exactArray(requestedPaths, 32, 'paths')
  const paths = requestedPaths.map(canonicalRepoPath).sort()
  if (paths.length > 32) throw new Error('paths excede 32 itens')
  unique(paths, 'paths')
  const requestedContracts = value.contracts ?? []
  exactArray(requestedContracts, 16, 'contracts')
  const contracts = requestedContracts.map(item => {
    exact(item, ['id', 'fingerprint'], 'contracts[]')
    return { id: string(item.id, 'contract.id', 1, 160), fingerprint: hashString(item.fingerprint, 'contract.fingerprint') }
  }).sort((a, b) => a.id.localeCompare(b.id) || a.fingerprint.localeCompare(b.fingerprint))
  if (contracts.length > 16) throw new Error('contracts excede 16 itens')
  unique(contracts.map(item => `${item.id}\0${item.fingerprint}`), 'contracts')
  const inputFingerprints = hashList(value.inputFingerprints ?? [], 16, 'inputFingerprints')
  if (value.kinds !== undefined && !Array.isArray(value.kinds)) throw new Error('kinds precisa ser lista')
  if (value.kinds !== undefined) exactArray(value.kinds, KINDS.size, 'kinds')
  const kinds = value.kinds === undefined ? undefined : [...new Set(value.kinds)]
  if (kinds && (kinds.length > KINDS.size || kinds.some(kind => !KINDS.has(kind)))) throw new Error('kinds contém valor inválido')
  return { role: value.role, repoId, ...(nodeId === undefined ? {} : { nodeId }), paths, contracts, inputFingerprints, ...(kinds ? { kinds: kinds.sort() } : {}) }
}

function validateSelectionShape(value, repoId) {
  exact(value, ['schemaVersion', 'selectionId', 'query', 'records', 'omissions'], 'selection')
  if (value.schemaVersion !== 1 || !/^sel-[a-f0-9]{64}$/.test(value.selectionId)) throw new Error('identidade da seleção inválida')
  const query = normalizeQuery(value.query, repoId)
  if (canonical(query) !== canonical(value.query)) throw new Error('query da seleção não está canônica')
  if (!Array.isArray(value.records) || !Array.isArray(value.omissions)) throw new Error('records ou omissions inválidos')
  for (const item of value.records) {
    exact(item, ['id', 'hash', 'record'], 'selection.records[]')
    if (typeof item.id !== 'string' || !/^mem-[a-f0-9]{64}$/.test(item.id)) throw new Error('ID de registro inválido na seleção')
    hashString(item.hash, 'selection.records[].hash')
    validateRecord(item.record, repoId)
  }
  for (const item of value.omissions) {
    exact(item, ['id', 'reason'], 'selection.omissions[]')
    string(item.id, 'omission.id', 1, 256); string(item.reason, 'omission.reason', 1, 512)
  }
}

function relevanceRank(record, query) {
  if (query.kinds && !query.kinds.includes(record.kind)) return null
  const scopes = record.scope
  const contractRank = scopes.contracts.some(saved => query.contracts.some(asked => asked.id === saved.id && asked.fingerprint === saved.fingerprint))
  // R-E9a 3E: evidence de nó só chega ao worker pelo contrato; o casamento só por nodeId não basta.
  if (query.role === 'worker' && record.kind === 'evidence' && !contractRank) return null
  const nodeRank = Boolean(query.nodeId && scopes.nodeIds.includes(query.nodeId))
  const pathRank = scopes.paths.some(saved => query.paths.some(asked => pathsIntersect(saved, asked)))
  if (!contractRank && !nodeRank && !pathRank) return null
  return contractRank ? 0 : nodeRank ? 1 : 2
}

function fingerprintsCompatible(record, query) {
  return record.validity.inputFingerprints.every(fp => query.inputFingerprints.includes(fp))
    && record.scope.contracts.every(saved => {
      const asked = query.contracts.find(item => item.id === saved.id)
      return !asked || asked.fingerprint === saved.fingerprint
    })
}

function pathsIntersect(a, b) { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) }
function digestRecord(record) { return sha(Buffer.from(`graph-eng:memory:v1\0${canonical(record)}`)) }
function selectionDigest(query, records, omissions) { return `sel-${sha(Buffer.from(canonical({ query, records: records.map(({ id, hash }) => ({ id, hash })), omissions })))}` }
function invalid(message) { return { valid: false, diagnostics: [{ code: 'invalid_selection', message }] } }

async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Diretório privado inválido: ${dir}`)
  await chmod(dir, 0o700)
}

async function persistExclusive(dir, name, value) {
  const bytes = Buffer.from(`${canonical(value)}\n`)
  const final = path.join(dir, name)
  const temp = path.join(dir, `.${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() }
  catch (error) { await rm(temp, { force: true }); throw error }
  finally { await handle.close() }
  try {
    await link(temp, final)
    const dirHandle = await open(dir, 'r')
    try { await dirHandle.sync() } finally { await dirHandle.close() }
    return true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const old = await readStoredJson(dir, name)
    if (canonical(old) !== canonical(value)) throw new Error(`Colisão de persistência em ${name}`)
    return false
  } finally { await rm(temp, { force: true }) }
}

async function writeAtomic(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(text); await handle.sync() } catch (error) { await rm(temp, { force: true }); throw error } finally { await handle.close() }
  await rename(temp, file)
  const dir = await open(path.dirname(file), 'r')
  try { await dir.sync() } finally { await dir.close() }
}

async function readStoredJson(dir, name) {
  if (path.basename(name) !== name) throw new Error('Nome de arquivo inválido')
  const file = path.join(dir, name)
  let handle
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) }
  catch (error) { if (error.code === 'ELOOP') throw new Error('Arquivo não pode ser symlink'); throw error }
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Arquivo não é regular')
    return JSON.parse(await handle.readFile('utf8'))
  } finally { await handle.close() }
}

function canonicalRepoPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.posix.isAbsolute(value.replaceAll('\\', '/')) || /^[a-zA-Z]:/.test(value)) throw new Error(`Caminho de repositório inválido: ${value}`)
  const normalized = value.replaceAll('\\', '/')
  if (normalized.split('/').includes('..')) throw new Error(`Caminho de repositório escapa da raiz: ${value}`)
  const result = path.posix.normalize(normalized)
  if (!result || result === '.' || result.startsWith('../')) throw new Error(`Caminho de repositório inválido: ${value}`)
  return result
}

function exact(value, keys, label, optional = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} precisa ser objeto`)
  const allowed = new Set(keys)
  if (Object.keys(value).some(key => !allowed.has(key)) || (!optional && keys.some(key => !Object.hasOwn(value, key)))) throw new Error(`${label} contém campos ausentes ou não reconhecidos`)
}
function exactArray(value, max, label) { if (!Array.isArray(value) || value.length > max) throw new Error(`${label} precisa ser lista de até ${max} itens`) }
function stringList(value, max, label) {
  exactArray(value, max, label)
  const result = value.map(item => string(item, label, 1, 160)).sort()
  unique(result, label)
  return result
}
function hashList(value, max, label) {
  exactArray(value, max, label)
  const result = value.map(item => hashString(item, label)).sort()
  unique(result, label)
  return result
}
function hashString(value, label) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} precisa ser SHA-256 hexadecimal`); return value }
function string(value, label, min, max, pattern) {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\0') || (pattern && !pattern.test(value))) throw new Error(`${label} inválido`)
  return value
}
function unique(values, label) { if (new Set(values).size !== values.length) throw new Error(`${label} contém duplicatas`) }
function escapeCell(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ')
}

/**
 * Seção Markdown da memória para o REPORT. Função pura: não lê disco nem fontes.
 * IDs, hashes e textos de célula são escapados; o resumo cru só aparece dentro de
 * bloco de código cuja cerca é maior que qualquer sequência de crases do conteúdo.
 */
export function renderReportSection({ produced = [], selections = [] } = {}) {
  const lines = ['## Memória', '', '### Registros produzidos', '']
  if (!produced.length) lines.push('Nenhum registro produzido nesta run.', '')
  else {
    lines.push('| Tipo | Assunto | ID | Hash |', '| --- | --- | --- | --- |')
    for (const item of produced) lines.push(`| ${escapeCell(item.kind)} | ${escapeCell(item.topic)} | ${escapeCell(item.id)} | ${escapeCell(item.hash)} |`)
    lines.push('')
    for (const item of produced) {
      const body = String(item.summary ?? '')
      const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1))
      lines.push(`Resumo de ${escapeCell(item.id)}:`, fence, body, fence, '')
    }
  }
  lines.push('### Seleções', '')
  if (!selections.length) lines.push('Nenhuma seleção nesta run.', '')
  for (const selection of selections) {
    lines.push(`#### ${escapeCell(selection.role)} (${escapeCell(selection.selectionId)})`, '')
    if (!selection.records.length) lines.push('Nenhum registro selecionado.', '')
    else {
      lines.push('| ID | Hash |', '| --- | --- |')
      for (const item of selection.records) lines.push(`| ${escapeCell(item.id)} | ${escapeCell(item.hash)} |`)
      lines.push('')
    }
    if (selection.omissions.length) {
      lines.push('| Omitido | Motivo |', '| --- | --- |')
      for (const item of selection.omissions) lines.push(`| ${escapeCell(item.id)} | ${escapeCell(item.reason)} |`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

function longestBacktickRun(text) {
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return longest
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
