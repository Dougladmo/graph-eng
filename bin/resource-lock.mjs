import { execFile as execFileCb } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { localHostIdentity, lookupProcessIdentity as defaultLookup, processIdentity as defaultIdentity } from './process-identity.mjs'

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function createResourceLock({ stateDir, host = localHostIdentity(), processIdentity = defaultIdentity, lookupProcessIdentity = defaultLookup } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new TypeError('stateDir absoluto é obrigatório')
  const owners = new Map()
  let initialized

  async function init() {
    if (initialized) return initialized
    initialized = (async () => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 })
      const lexical = path.resolve(stateDir)
      const lexicalInfo = await lstat(lexical)
      if (!lexicalInfo.isDirectory() || lexicalInfo.isSymbolicLink() || (typeof process.getuid === 'function' && lexicalInfo.uid !== process.getuid())) throw new Error('stateDir precisa ser diretório local confiável do usuário atual')
      await chmod(lexical, 0o700)
      const actual = await realpath(stateDir)
      const info = await lstat(actual)
      if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('stateDir precisa ser diretório local confiável do usuário atual')
      return actual
    })()
    return initialized
  }

  function lockPath(dir, resource) {
    const digest = createHash('sha256').update(`${host}\0${resource}`).digest('hex')
    return path.join(dir, `resource-${digest}.lock`)
  }

  async function acquire({ runId, resource, recoverDead = true } = {}) {
    if (typeof runId !== 'string' || !runId || typeof resource !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(resource)) throw new TypeError('runId e resource válidos são obrigatórios')
    const dir = await init(); const file = lockPath(dir, resource)
    const startIdentity = await processIdentity({ host })
    if (typeof startIdentity !== 'string' || !startIdentity) throw new Error('Identidade do processo indisponível; lock seguro não pode ser criado')
    const value = { schemaVersion: 1, host, resource, runId, nonce: randomUUID(), pid: process.pid, processStartIdentity: startIdentity, acquiredAt: new Date().toISOString() }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, 'wx', 0o600)
        try { await handle.writeFile(`${canonical(value)}\n`); await handle.sync() } finally { await handle.close() }
        owners.set(value.nonce, file)
        // path: onde o lock fica; usado no detalhe do BLOCK quando a remoção é manual.
        return { ...value, path: file }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const existing = await readLock(file)
        if (!validLock(existing, resource, host)) throw Object.assign(new Error('Lock compartilhado inválido; preservado por estado ambíguo'), { code: 'LOCK_INVALID', path: file })
        const status = await lookupProcessIdentity(existing.pid, existing.host)
        // C15 FIX2: pid vivo com startIdentity diferente é pid reutilizado: o dono do lock morreu.
        const reused = status?.status === 'alive' && status.startIdentity !== existing.processStartIdentity
        if (status?.status === 'alive' && !reused) throw Object.assign(new Error(`Recurso ${resource} já está reservado pela run ${existing.runId}`), { code: 'RESOURCE_BUSY', runId: existing.runId })
        if (!reused && status?.status !== 'dead') throw Object.assign(new Error('Dono do lock ambíguo; lock preservado'), { code: 'LOCK_AMBIGUOUS', path: file })
        // C6: com recoverDead:false (workspace) o dono morto não é removido; a remoção é manual.
        if (!recoverDead) throw Object.assign(new Error(`Lock de ${resource} com dono morto (pid ${existing.pid}); remoção manual em ${file}`), { code: 'LOCK_OWNER_DEAD', path: file, pid: existing.pid })
        await recover(file, existing, resource, host)
      }
    }
    throw new Error(`Não foi possível adquirir lock do recurso ${resource}`)
  }

  async function recover(file, observed, resource, lockHost) {
    const gate = `${file}.recover`
    const gateHandle = await open(gate, 'wx', 0o600).catch(error => error.code === 'EEXIST' ? null : Promise.reject(error))
    if (!gateHandle) throw new Error('Outra recuperação do lock está em andamento')
    try {
      const latest = await readLock(file)
      if (latest.nonce !== observed.nonce) return
      const live = await lookupProcessIdentity(latest.pid, latest.host)
      const dead = live?.status === 'dead' || (live?.status === 'alive' && live.startIdentity !== latest.processStartIdentity)
      if (!dead) throw new Error('Dono do lock não foi confirmado morto; lock preservado')
      const quarantine = `${file}.stale-${latest.nonce}`
      await rename(file, quarantine)
      const moved = await readLock(quarantine)
      if (moved.nonce !== latest.nonce) { await rename(quarantine, file); throw new Error('Lock mudou durante recuperação; preservado') }
      await rm(quarantine)
    } finally { await gateHandle.close(); await rm(gate, { force: true }) }
  }

  async function release(token) {
    const file = owners.get(token?.nonce)
    if (!file) throw new Error('Lock não pertence a esta instância')
    const current = await readLock(file)
    if (current.nonce !== token.nonce || current.pid !== token.pid || current.processStartIdentity !== token.processStartIdentity) throw new Error('Lock não pertence ao chamador')
    const status = await lookupProcessIdentity(current.pid, current.host)
    if (status?.status !== 'alive' || status.startIdentity !== current.processStartIdentity) throw new Error('Identidade do processo do lock mudou')
    const tombstone = `${file}.release-${token.nonce}`
    await rename(file, tombstone)
    const moved = await readLock(tombstone)
    if (moved.nonce !== token.nonce) { await rename(tombstone, file); throw new Error('Lock substituído durante release') }
    await rm(tombstone)
    owners.delete(token.nonce)
  }

  return { acquire, release }
}

function validLock(value, resource, host) {
  return value?.schemaVersion === 1 && value.resource === resource && value.host === host && typeof value.runId === 'string' && typeof value.nonce === 'string' && Number.isInteger(value.pid) && value.pid > 0 && typeof value.processStartIdentity === 'string'
}
async function readLock(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { throw Object.assign(new Error(`Lock ilegível; preservado para inspeção: ${error.message}`), { code: 'LOCK_INVALID', path: file }) }
}

const execFile = promisify(execFileCb)

async function defaultGitToplevel(cwd) {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--show-toplevel'], { cwd })
    return stdout.trim() || null
  } catch (error) {
    // Só "não é repositório Git" (exit 128) vira identidade pelo cwd; qualquer outra falha lança (fail-closed).
    if (error.code === 128 && /not a git repository/i.test(String(error.stderr ?? ""))) return null
    throw error
  }
}

// Identidade canônica do workspace: realpath da raiz Git (ou do cwd, fora de Git).
// Pasta inexistente lança ENOENT; não há identidade alternativa.
export async function workspaceResourceOf(cwd, { git = defaultGitToplevel } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('cwd absoluto é obrigatório')
  const realCwd = await realpath(cwd)
  const top = await git(realCwd)
  const root = top ? await realpath(top) : realCwd
  return `workspace-${createHash('sha256').update(root).digest('hex')}`
}
