import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readlink, realpath, mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'

const STATE_MARKER = '.graph-eng-state-root'
const markerText = 'graph-eng trusted run state v2\n'
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const domainHash = (domain, value) => sha(Buffer.from(`graph-eng:v2:${domain}\0${canonical(value)}`))

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)) throw new Error(`Caminho inválido: ${value}`)
  const normalized = value.replaceAll('\\', '/')
  if (normalized.split('/').some(part => part === '..' || part === '')) throw new Error(`Caminho inválido: ${value}`)
  return normalized
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []; const err = []
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git ${args[0]} falhou: ${Buffer.concat(err).toString().trim()}`)))
  })
}

async function fileHash(file, executable = false) {
  const hash = createHash('sha256').update(`file:v2:executable=${Number(executable)}\0`)
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export function createEvidence({ cwd, runDir, emit = () => {}, heavyLock, integrity = null } = {}) {
  if (!cwd || !runDir) throw new TypeError('cwd e runDir são obrigatórios')
  let rootPromise
  const root = () => rootPromise ??= git(cwd, ['rev-parse', '--show-toplevel']).then(value => realpath(path.resolve(value.toString().trim())))

  async function statePath(repo) {
    const lexicalRoot = path.resolve(cwd)
    const lexicalDir = path.resolve(runDir)
    const rel = path.relative(lexicalRoot, lexicalDir)
    if (!rel || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('runDir precisa estar estritamente dentro do workspace')
    let dir = path.resolve(repo, rel)
    await mkdir(dir, { recursive: true })
    const actualDir = await realpath(dir)
    const actualRel = path.relative(repo, actualDir)
    if (actualRel.startsWith(`..${path.sep}`) || actualRel === '..' || path.isAbsolute(actualRel)) throw new Error('runDir escapa do workspace por symlink')
    dir = actualDir
    const marker = path.join(dir, STATE_MARKER)
    try {
      const actual = await readFile(marker, 'utf8')
      if (actual !== markerText) throw new Error('Marcador de runDir não reconhecido')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const handle = await open(marker, 'wx', 0o600).catch(e => e.code === 'EEXIST' ? null : Promise.reject(e))
      if (handle) { await handle.writeFile(markerText); await handle.sync(); await handle.close() }
      if (await readFile(marker, 'utf8') !== markerText) throw new Error('Marcador de runDir não reconhecido')
    }
    return actualDir
  }

  async function treeState(repo, stateDir) {
    const [headBytes, branchBytes, trackedBytes, untrackedBytes] = await Promise.all([
      git(repo, ['rev-parse', 'HEAD']), git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => Buffer.from('(detached)')),
      git(repo, ['ls-files', '-z', '--cached']), git(repo, ['ls-files', '-z', '--others', '--exclude-standard']),
    ])
    const head = headBytes.toString().trim(); const branch = branchBytes.toString().trim()
    const tracked = trackedBytes.toString('utf8').split('\0').filter(Boolean)
    const untracked = untrackedBytes.toString('utf8').split('\0').filter(Boolean)
    const stateRel = path.relative(repo, stateDir).split(path.sep).join('/')
    for (const file of tracked) if (file === stateRel || file.startsWith(`${stateRel}/`)) throw new Error(`runDir contém arquivo rastreado: ${file}`)
    const all = [...new Set([...tracked, ...untracked])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    const files = []
    for (const file of all) {
      const absolute = path.join(repo, file)
      const inState = file === stateRel || file.startsWith(`${stateRel}/`)
      if (inState) continue
      let info
      try { info = await lstat(absolute) } catch (error) {
        if (error.code === 'ENOENT' && tracked.includes(file)) { files.push({ path: file, kind: 'deleted', hash: null }); continue }
        throw error
      }
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute)
        let resolved
        try { resolved = await realpath(absolute) } catch { throw new Error(`Symlink quebrado ou em loop: ${file}`) }
        const rel = path.relative(repo, resolved)
        if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) throw new Error(`Symlink escapa do workspace: ${file}`)
        const targetInfo = await lstat(resolved)
        if (!targetInfo.isFile()) throw new Error(`Symlink não aponta para arquivo: ${file}`)
        const executable = Boolean(targetInfo.mode & 0o111)
        files.push({ path: file, kind: 'symlink', executable, hash: sha(Buffer.from(`symlink\0${target}\0${await fileHash(resolved, executable)}`)) })
      } else if (info.isFile()) {
        const executable = Boolean(info.mode & 0o111)
        files.push({ path: file, kind: 'file', executable, hash: await fileHash(absolute, executable) })
      }
      else throw new Error(`Tipo de arquivo não suportado no manifesto: ${file}`)
    }
    return { head, branch, files }
  }

  async function snapshot(options = {}) {
    const { inputs = [], contracts = [], outputs = [] } = options
    if (Object.hasOwn(options, 'exclude')) throw new Error('Exclusões arbitrárias não são aceitas')
    const repo = await root(); const stateDir = await statePath(repo)
    const before = await treeState(repo, stateDir)
    const manifests = await collectManifests(repo, options)
    const after = await treeState(repo, stateDir)
    if (canonical(before) !== canonical(after)) throw new Error('Workspace mudou durante a coleta do snapshot')
    const value = { ...makeSnapshot(before, manifests), manifestSpecs: cloneSpecs(options) }
    const evidence = await persistEvidence(repo, `snapshot-${value.identity}.json`, value)
    return { ...value, evidencePath: evidence.path, evidenceHash: evidence.hash }
  }

  async function fingerprint(options = {}) {
    if (Object.hasOwn(options, 'exclude')) throw new Error('Exclusões arbitrárias não são aceitas')
    const repo = await root()
    const manifests = await collectManifests(repo, options)
    const identity = domainHash('semantic-node', { inputs: manifests.inputs, contracts: manifests.contracts, outputs: manifests.outputs })
    return { schemaVersion: 2, identity, inputHash: domainHash('inputs', manifests.inputs), contractHash: domainHash('contracts', manifests.contracts), ...manifests }
  }

  function makeSnapshot(tree, manifests) {
    const identity = domainHash('delivery', { files: tree.files, inputs: manifests.inputs, contracts: manifests.contracts, outputs: manifests.outputs, head: tree.head, branch: tree.branch })
    return { schemaVersion: 2, identity, head: tree.head, branch: tree.branch, manifestHash: domainHash('files', tree.files), inputHash: domainHash('inputs', manifests.inputs), contractHash: domainHash('contracts', manifests.contracts), files: tree.files, ...manifests }
  }

  async function collectManifests(repo, options) {
    const specs = cloneSpecs(options)
    const read = async () => Object.fromEntries(await Promise.all(['inputs', 'contracts', 'outputs'].map(async key => [key, await manifest(repo, specs[key])])))
    const first = await read(); const second = await read()
    if (canonical(first) !== canonical(second)) throw new Error('Manifestos mudaram durante a coleta do fingerprint')
    return second
  }

  async function manifest(repo, entries) {
    if (!Array.isArray(entries)) throw new TypeError('Manifesto deve ser uma lista')
    const result = []
    for (const entry of entries) {
      if (typeof entry === 'string') {
        const file = safeRelative(entry); const absolute = path.resolve(repo, file)
        const rel = path.relative(repo, absolute)
        if (rel.startsWith(`..${path.sep}`) || rel === '..') throw new Error(`Caminho escapa do workspace: ${file}`)
        const resolved = await realpath(absolute)
        const resolvedRel = path.relative(repo, resolved)
        if (resolvedRel.startsWith(`..${path.sep}`) || resolvedRel === '..' || path.isAbsolute(resolvedRel)) throw new Error(`Caminho escapa do workspace por symlink: ${file}`)
        const info = await lstat(absolute)
        if (info.isSymbolicLink()) {
          const targetInfo = await lstat(resolved)
          if (!targetInfo.isFile()) throw new Error(`Symlink não aponta para arquivo: ${file}`)
          const executable = Boolean(targetInfo.mode & 0o111)
          result.push({ path: file, kind: 'symlink', executable, hash: sha(Buffer.from(`symlink\0${await readlink(absolute)}\0${await fileHash(resolved, executable)}`)) })
        } else if (info.isFile()) {
          const executable = Boolean(info.mode & 0o111)
          result.push({ path: file, kind: 'file', executable, hash: await fileHash(absolute, executable) })
        }
        else throw new Error(`Entrada precisa ser arquivo: ${file}`)
      } else if (entry && typeof entry === 'object' && typeof entry.name === 'string' && Object.hasOwn(entry, 'value') && entry.value !== undefined) {
        result.push({ name: entry.name, kind: entry.kind ?? 'value', hash: domainHash('declared-input', entry.value) })
      } else throw new TypeError('Entrada declarada inválida')
    }
    return result.sort((a, b) => Buffer.compare(Buffer.from(a.path ?? a.name), Buffer.from(b.path ?? b.name)))
  }

  async function runChecks({ runId, snapshot: expected, checks } = {}) {
    if (!runId || !expected?.identity || !Array.isArray(checks)) throw new TypeError('runId, snapshot e checks são obrigatórios')
    const receipts = []
    for (const check of checks) {
      const startedAt = new Date().toISOString(); const id = randomUUID()
      const before = await snapshotForCheck(expected)
      const receipt = { schemaVersion: 2, id, runId, checkId: check?.id, identity: expected.identity, beforeIdentity: before.identity, afterIdentity: null, command: check?.command, args: check?.args, cwd: null, exitCode: null, signal: null, startedAt, finishedAt: null, stdoutPath: null, stderrPath: null, valid: false }
      try {
        if (before.identity !== expected.identity) throw new Error('Snapshot anterior ao check está desatualizado')
        if (!check || typeof check.id !== 'string' || !check.id || typeof check.command !== 'string' || !check.command || !Array.isArray(check.args) || check.args.some(arg => typeof arg !== 'string')) throw new Error('CheckSpec inválido: command e args[] são obrigatórios')
        const repo = await root(); const cwdPath = await realpath(path.resolve(repo, check.cwd ?? '.'))
        const cwdRel = path.relative(repo, cwdPath)
        if (cwdRel.startsWith(`..${path.sep}`) || cwdRel === '..' || path.isAbsolute(cwdRel)) throw new Error('cwd do check escapa do workspace')
        receipt.cwd = cwdPath
        if (check.heavy) {
          if (!heavyLock) throw new Error('Check pesado exige o lock de recurso compartilhado')
          const lock = await heavyLock.acquire({ runId, resource: 'checks-heavy' })
          try { await execute(check, receipt, cwdPath, repo) } finally { await heavyLock.release(lock) }
        } else await execute(check, receipt, cwdPath, repo)
      } catch (error) { receipt.error = error.message }
      try { const after = await snapshotForCheck(expected); receipt.afterIdentity = after.identity } catch (error) { receipt.error ??= error.message }
      receipt.finishedAt = new Date().toISOString()
      receipt.valid = !receipt.error && receipt.exitCode === 0 && receipt.signal === null && receipt.beforeIdentity === expected.identity && receipt.afterIdentity === expected.identity
      const repo = await root()
      const evidence = await persistEvidence(repo, `receipt-${receipt.id}.json`, receipt)
      receipt.evidencePath = evidence.path; receipt.evidenceHash = evidence.hash
      await emit({ type: 'check.receipt', payload: receipt })
      receipts.push(receipt)
    }
    return receipts
  }

  async function snapshotForCheck(expected) {
    if (!expected.manifestSpecs) throw new Error('Snapshot sem descritores de manifesto não pode ser revalidado')
    return snapshot(expected.manifestSpecs)
  }
  async function execute(check, receipt, cwdPath, repo) {
    const stateDir = await statePath(repo)
    const stdoutPath = path.join(stateDir, `check-${receipt.id}.stdout`); const stderrPath = path.join(stateDir, `check-${receipt.id}.stderr`)
    receipt.stdoutPath = path.relative(repo, stdoutPath).split(path.sep).join('/'); receipt.stderrPath = path.relative(repo, stderrPath).split(path.sep).join('/')
    // C13: stdout/stderr são efêmeros ativos do check: fora da comparação até o close, depois adotados com hash (ou liberados, se não existirem).
    const ephemeralNames = [`check-${receipt.id}.stdout`, `check-${receipt.id}.stderr`]
    if (integrity) await integrity.registerEphemeral(ephemeralNames)
    let out
    try { out = await open(stdoutPath, 'wx', 0o600) }
    catch (error) { if (integrity) await integrity.releaseEphemeral(ephemeralNames); throw error }
    let err
    try { err = await open(stderrPath, 'wx', 0o600) }
    catch (error) {
      await out.close()
      if (integrity) { await rm(stdoutPath, { force: true }); await integrity.releaseEphemeral(ephemeralNames) }
      throw error
    }
    try {
      const timeoutMs = Number.isFinite(check.timeoutMs) && check.timeoutMs > 0 ? check.timeoutMs : 120000
      await new Promise((resolve, reject) => {
        const child = spawn(check.command, check.args, { cwd: cwdPath, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', out.fd, err.fd] })
        let timedOut = false
        let killer
        const killGroup = signal => {
          try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal) }
          catch (error) { if (error.code !== 'ESRCH') receipt.error = `Falha ao encerrar check: ${error.message}` }
        }
        const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); killer = setTimeout(() => killGroup('SIGKILL'), 1500); killer.unref() }, timeoutMs)
        child.on('error', error => { clearTimeout(timer); clearTimeout(killer); reject(error) })
        child.on('close', (code, signal) => { clearTimeout(timer); clearTimeout(killer); receipt.exitCode = code; receipt.signal = signal; if (timedOut) receipt.error ??= `Timeout após ${timeoutMs}ms`; resolve() })
      })
    } finally {
      await out.sync().catch(error => { receipt.error ??= error.message })
      await err?.sync().catch(error => { receipt.error ??= error.message })
      await out.close()
      await err?.close()
      if (integrity) await settleEphemerals(stateDir, ephemeralNames)
    }
  }

  async function settleEphemerals(dir, names) {
    for (const name of names) {
      const bytes = await readFile(path.join(dir, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (bytes) await integrity.adoptEphemeral(name, { bytes })
      else await integrity.releaseEphemeral([name])
    }
  }

  async function verifyArtifact(artifact) {
    if (!artifact?.evidencePath || !artifact.evidenceHash) return false
    const repo = await root(); const stateDir = await statePath(repo)
    const file = path.resolve(repo, artifact.evidencePath)
    const relative = path.relative(stateDir, file)
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false
    try {
      const bytes = await readFile(file)
      const { evidencePath, evidenceHash, ...payload } = artifact
      return sha(bytes) === evidenceHash && bytes.equals(Buffer.from(`${canonical(payload)}\n`))
    } catch { return false }
  }

  async function persistEvidence(repo, name, value) {
    const dir = await statePath(repo); const file = path.join(dir, name)
    const bytes = Buffer.from(`${canonical(value)}\n`); const hash = sha(bytes)
    const writeNew = async () => {
      const handle = await open(file, 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    }
    try {
      // C13: o receipt/evidência é arquivo privado do supervisor; a escrita passa pelo guard (EEXIST volta por rethrow).
      if (integrity) await integrity.trustedWrite({ paths: [name], expect: () => ({ [name]: { bytes } }) }, writeNew)
      else await writeNew()
    } catch (error) {
      if (error.code !== 'EEXIST' || sha(await readFile(file)) !== hash) throw error
    }
    return { path: path.relative(repo, file).split(path.sep).join('/'), hash }
  }

  return { snapshot, fingerprint, runChecks, verifyArtifact }
}

function cloneSpecs(options) {
  const copy = value => Array.isArray(value) ? value.map(copy) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) : value
  return Object.fromEntries(['inputs', 'contracts', 'outputs'].map(key => [key, copy(options[key] ?? [])]))
}
