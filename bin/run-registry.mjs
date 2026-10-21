import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir, realpath, rename, rm, lstat } from 'node:fs/promises'
import path from 'node:path'

const REGISTRY_DIR = 'runs-v2'
const MARKER = '.graph-eng-state-root'
const MARKER_TEXT = 'graph-eng trusted run state v2\n'
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

export function runIdentityHash({ cwd, runDir, runId } = {}) {
  if (typeof cwd !== 'string' || typeof runDir !== 'string' || typeof runId !== 'string') throw new TypeError('cwd, runDir e runId são obrigatórios')
  return createHash('sha256').update(JSON.stringify([cwd, runDir, runId])).digest('hex')
}

export function validateRegistryEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 2) throw new Error('Registro v2 malformado ou schema não suportado')
  if (Object.keys(value).some(key => !['schemaVersion', 'runId', 'runDir', 'cwd', 'host', 'registeredAt'].includes(key))) throw new Error('Registro v2 contém campos não reconhecidos')
  if (!validRunId(value.runId)) throw new Error('Registro v2 contém runId inválido')
  if (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || typeof value.runDir !== 'string' || !path.isAbsolute(value.runDir)) throw new Error('Registro v2 contém caminhos inválidos')
  if (typeof value.host !== 'string' || !value.host || typeof value.registeredAt !== 'string' || !Number.isFinite(Date.parse(value.registeredAt))) throw new Error('Registro v2 contém host ou data inválidos')
  return value
}

export function registryEntryKey(entry) {
  return runIdentityHash({ cwd: entry.cwd, runDir: entry.runDir, runId: entry.runId })
}

// Falhas são resultado explícito para que o chamador possa persistir o aviso na run.
export async function registerRun({ stateDir, cwd, runDir, runId, host, registeredAt = new Date().toISOString() } = {}) {
  try {
    if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir é obrigatório')
    if (!validRunId(runId)) throw new TypeError('runId inválido')
    if (!['claude', 'codex'].includes(host)) throw new TypeError('host precisa ser claude ou codex')
    const realCwd = await realpath(cwd)
    const realRunDir = await realpath(runDir)
    assertDescendant(realCwd, realRunDir)
    await validateRunIdentity(realCwd, realRunDir, runId, host)
    const entry = validateRegistryEntry({ schemaVersion: 2, runId, runDir: realRunDir, cwd: realCwd, host, registeredAt })
    const base = path.resolve(stateDir)
    await mkdir(base, { recursive: true, mode: 0o700 })
    const realBase = await realpath(base)
    const registryDir = path.join(realBase, REGISTRY_DIR)
    await mkdir(registryDir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const dirStat = await lstat(registryDir)
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('Diretório do registry não é um diretório regular')
    await chmod(registryDir, 0o700)
    const finalPath = path.join(registryDir, `${registryEntryKey(entry)}.json`)
    const tempPath = path.join(registryDir, `.${randomUUID()}.tmp`)
    const handle = await open(tempPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${canonical(entry)}\n`)
      await handle.sync()
    } catch (error) {
      await rm(tempPath, { force: true })
      throw error
    } finally { await handle.close() }
    try {
      await rename(tempPath, finalPath)
      const directory = await open(registryDir, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {})
      throw error
    }
    return { registered: true, entry, key: registryEntryKey(entry), path: finalPath }
  } catch (error) {
    return { registered: false, warning: { code: error.code || 'registry_unavailable', message: error.message } }
  }
}

export async function readRunRegistry({ stateDir } = {}) {
  const entries = []
  const warnings = []
  if (typeof stateDir !== 'string' || !stateDir) return { entries, warnings: [{ code: 'registry_unavailable', message: 'stateDir não foi informado' }] }
  let registryDir
  try {
    const realBase = await realpath(path.resolve(stateDir))
    registryDir = path.join(realBase, REGISTRY_DIR)
    const info = await lstat(registryDir)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Diretório do registry não é um diretório regular')
  } catch (error) {
    if (error.code === 'ENOENT') return { entries, warnings }
    return { entries, warnings: [{ code: 'registry_unavailable', message: error.message }] }
  }
  let names
  try { names = await readdir(registryDir) }
  catch (error) { return { entries, warnings: [{ code: 'registry_unavailable', message: error.message }] } }
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    try {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Nome de entrada do registry inválido')
      const file = path.join(registryDir, name)
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Entrada do registry não é arquivo regular')
      const entry = validateRegistryEntry(JSON.parse(await readFile(file, 'utf8')))
      if (name !== `${registryEntryKey(entry)}.json`) throw new Error('Hash da identidade do registry diverge')
      entries.push(entry)
    } catch (error) {
      warnings.push({ code: 'invalid_registry_entry', path: name, message: error.message })
    }
  }
  return { entries, warnings }
}

export async function validateRunIdentity(cwd, runDir, runId, host, documents = {}) {
  assertDescendant(cwd, runDir)
  const marker = documents.marker ?? await readRegularFile(runDir, MARKER)
  if (marker.toString('utf8') !== MARKER_TEXT) throw new Error('Marcador da run ausente ou inválido')
  const identity = JSON.parse((documents.identity ?? await readRegularFile(runDir, 'identity.json')).toString('utf8'))
  if (identity.schemaVersion !== 2 || identity.runId !== runId) throw new Error('identity.json diverge da run')
  const meta = JSON.parse((documents.meta ?? await readRegularFile(runDir, 'run.meta.json')).toString('utf8'))
  if (meta.schemaVersion !== 2 || meta.runId !== runId || meta.host !== host || typeof meta.cwd !== 'string' || typeof meta.runDir !== 'string' || await realpath(meta.cwd) !== cwd || await realpath(meta.runDir) !== runDir) throw new Error('run.meta.json diverge da identidade da run')
  return { identity, meta }
}

async function readRegularFile(dir, name) {
  const file = path.join(dir, name)
  let handle
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) }
  catch (error) { if (error.code === 'ELOOP') throw new Error(`${name} não é arquivo regular`); throw error }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`${name} não é arquivo regular`)
    return await handle.readFile()
  } finally { await handle.close() }
}

export function assertDescendant(cwd, runDir) {
  const relative = path.relative(cwd, runDir)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('runDir precisa ser descendente real do cwd')
}

function validRunId(value) { return typeof value === 'string' && value !== '.' && value !== '..' && RUN_ID.test(value) }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
