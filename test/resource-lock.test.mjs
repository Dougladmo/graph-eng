import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createResourceLock, workspaceResourceOf } from '../bin/resource-lock.mjs'

const execFileAsync = promisify(execFile)

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'graph-resource-lock-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const processIdentity = async () => 'test:process:1'
  const lookupProcessIdentity = async () => ({ status: 'alive', startIdentity: 'test:process:1' })
  return { stateDir, processIdentity, lookupProcessIdentity }
}

test('locks por recurso e host são compartilhados entre runs', async t => {
  const config = await fixture(t)
  const first = createResourceLock(config)
  const second = createResourceLock(config)
  const token = await first.acquire({ runId: 'run-a', resource: 'checks-heavy' })
  await assert.rejects(second.acquire({ runId: 'run-b', resource: 'checks-heavy' }), /já está reservado/)
  await first.release(token)
  const next = await second.acquire({ runId: 'run-b', resource: 'checks-heavy' })
  await second.release(next)
  assert.equal((await readdir(config.stateDir)).length, 0)
})

test('lock de outro recurso é independente e nonce limita o release ao dono', async t => {
  const config = await fixture(t)
  const owner = createResourceLock(config)
  const other = createResourceLock(config)
  const one = await owner.acquire({ runId: 'run-a', resource: 'checks-heavy' })
  const two = await other.acquire({ runId: 'run-b', resource: 'other' })
  await assert.rejects(other.release(one), /não pertence/)
  await owner.release(one)
  await other.release(two)
})

test('lock só é recuperado quando lookup confirma processo morto', async t => {
  const config = await fixture(t)
  const host = 'test-host'
  const resource = 'checks-heavy'
  const digest = createHash('sha256').update(`${host}\0${resource}`).digest('hex')
  const stalePath = path.join(config.stateDir, `resource-${digest}.lock`)
  await writeFile(stalePath, JSON.stringify({ schemaVersion: 1, host, resource, runId: 'run-old', nonce: 'stale', pid: 99999991, processStartIdentity: 'stale', acquiredAt: new Date().toISOString() }))
  const deadLookup = async pid => pid === 99999991 ? { status: 'dead' } : { status: 'alive', startIdentity: 'test:process:1' }
  const recovering = createResourceLock({ ...config, host, lookupProcessIdentity: deadLookup })
  const fresh = await recovering.acquire({ runId: 'run-new', resource })
  await recovering.release(fresh)
  assert.deepEqual(await readdir(config.stateDir), [])

  const ambiguousDir = await mkdtemp(path.join(os.tmpdir(), 'graph-resource-lock-ambiguous-'))
  t.after(() => rm(ambiguousDir, { recursive: true, force: true }))
  const unknownPath = path.join(ambiguousDir, `resource-${digest}.lock`)
  await writeFile(unknownPath, JSON.stringify({ schemaVersion: 1, host, resource, runId: 'run-old', nonce: 'unknown', pid: 99999992, processStartIdentity: 'unknown', acquiredAt: new Date().toISOString() }))
  const contender = createResourceLock({ ...config, host, stateDir: ambiguousDir, lookupProcessIdentity: async () => ({ status: 'unknown', reason: 'inconclusivo' }) })
  await assert.rejects(contender.acquire({ runId: 'run-new', resource }), /ambíguo/)
  assert.ok((await readFile(unknownPath, 'utf8')).includes('unknown'))
})

test('stateDir deve ser absoluto', () => {
  assert.throws(() => createResourceLock({ stateDir: 'relative' }), /absoluto/)
})

test('identidade do workspace: alias symlink, caminho com .. e subdiretório do mesmo repo convergem', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'graph-workspace-id-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const repo = path.join(base, 'repo')
  await mkdir(path.join(repo, 'sub'), { recursive: true })
  const alias = path.join(base, 'alias')
  await symlink(repo, alias)
  const realRepo = await realpath(repo)
  const fakeGit = async cwd => (cwd === realRepo || cwd.startsWith(`${realRepo}${path.sep}`)) ? realRepo : null
  const id = cwd => workspaceResourceOf(cwd, { git: fakeGit })
  const expected = `workspace-${createHash('sha256').update(realRepo).digest('hex')}`
  assert.equal(await id(repo), expected)
  assert.equal(await id(alias), expected)
  assert.equal(await id(path.join(repo, 'sub', '..')), expected)
  assert.equal(await id(path.join(alias, 'sub')), expected)
  assert.equal(await id(path.join(repo, 'sub')), expected)
})

test('identidade do workspace fora de Git é o realpath do cwd e cwd inexistente lança', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'graph-workspace-nogit-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const dir = path.join(base, 'solo')
  await mkdir(dir)
  const alias = path.join(base, 'solo-alias')
  await symlink(dir, alias)
  const noGit = async () => null
  const realDir = await realpath(dir)
  assert.equal(await workspaceResourceOf(alias, { git: noGit }), `workspace-${createHash('sha256').update(realDir).digest('hex')}`)
  await assert.rejects(workspaceResourceOf(path.join(base, 'nao-existe'), { git: noGit }), { code: 'ENOENT' })
})

test('identidade do workspace cabe no limite de 80 caracteres do lock e é aceita pelo acquire', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'graph-workspace-len-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const resource = await workspaceResourceOf(base, { git: async () => null })
  assert.equal(resource.length, 74)
  assert.match(resource, /^workspace-[0-9a-f]{64}$/)
  const lock = createResourceLock(await fixture(t))
  const token = await lock.acquire({ runId: 'run-ws', resource })
  await lock.release(token)
})

test('identidade do workspace usa a raiz Git real por padrão, sem cwd', async t => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'graph-workspace-git-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await execFileAsync('git', ['init', '-q'], { cwd: repo })
  const sub = path.join(repo, 'deep')
  await mkdir(sub)
  const realRepo = await realpath(repo)
  const expected = `workspace-${createHash('sha256').update(realRepo).digest('hex')}`
  assert.equal(await workspaceResourceOf(sub), expected)
  assert.equal(await workspaceResourceOf(repo), expected)
})

test('erro de git diferente de não-repositório lança em vez de usar o cwd', async t => {
  // Sem seam: o git real do PATH é trocado por um falso, para exercitar defaultGitToplevel de ponta a ponta.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'graph-workspace-git-fail-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const realDir = await realpath(dir)
  const fakeBin = path.join(dir, 'bin')
  await mkdir(fakeBin)
  const emptyBin = path.join(dir, 'empty')
  await mkdir(emptyBin)
  const previousPath = process.env.PATH
  t.after(() => { process.env.PATH = previousPath })
  // dubious ownership: git sai com 128 e mensagem que não é "not a git repository"
  const gitBin = path.join(fakeBin, 'git')
  await writeFile(gitBin, "#!/bin/sh\necho \"fatal: detected dubious ownership in repository at '/x'\" >&2\nexit 128\n", { mode: 0o755 })
  process.env.PATH = fakeBin
  await assert.rejects(workspaceResourceOf(realDir), error => error.code === 128 && /dubious ownership/.test(error.stderr ?? ''))
  // ENOENT: git ausente do PATH
  process.env.PATH = emptyBin
  await assert.rejects(workspaceResourceOf(realDir), error => error.code === 'ENOENT')
  process.env.PATH = previousPath
})

test('C6: heavy com dono morto continua recuperável por padrão (regressão)', async t => {
  const config = await fixture(t)
  const host = 'test-host'
  const resource = 'checks-heavy'
  const digest = createHash('sha256').update(`${host}\0${resource}`).digest('hex')
  const lockFile = path.join(config.stateDir, `resource-${digest}.lock`)
  await writeFile(lockFile, JSON.stringify({ schemaVersion: 1, host, resource, runId: 'run-old', nonce: 'c6-heavy', pid: 99999995, processStartIdentity: 'dead', acquiredAt: new Date().toISOString() }))
  const deadLookup = async pid => pid === 99999995 ? { status: 'dead' } : { status: 'alive', startIdentity: 'test:process:1' }
  const lock = createResourceLock({ ...config, host, lookupProcessIdentity: deadLookup })
  const token = await lock.acquire({ runId: 'run-new', resource })
  await lock.release(token)
  assert.deepEqual(await readdir(config.stateDir), [])
})

test('C6: recoverDead:false preserva lock de dono morto e lança LOCK_OWNER_DEAD com caminho e pid', async t => {
  const config = await fixture(t)
  const host = 'test-host'
  const resource = 'workspace-c6-dead'
  const digest = createHash('sha256').update(`${host}\0${resource}`).digest('hex')
  const lockFile = path.join(await realpath(config.stateDir), `resource-${digest}.lock`)
  await writeFile(lockFile, JSON.stringify({ schemaVersion: 1, host, resource, runId: 'run-old', nonce: 'c6-dead', pid: 99999993, processStartIdentity: 'dead', acquiredAt: new Date().toISOString() }))
  const before = await readFile(lockFile, 'utf8')
  const deadLookup = async pid => pid === 99999993 ? { status: 'dead' } : { status: 'alive', startIdentity: 'test:process:1' }
  const lock = createResourceLock({ ...config, host, lookupProcessIdentity: deadLookup })
  await assert.rejects(lock.acquire({ runId: 'run-new', resource, recoverDead: false }), error => error.code === 'LOCK_OWNER_DEAD' && error.path === lockFile && error.pid === 99999993)
  assert.equal(await readFile(lockFile, 'utf8'), before)
})

test('C6: lock adulterado (JSON inválido) bloqueia com LOCK_INVALID e fica byte a byte', async t => {
  const config = await fixture(t)
  const host = 'test-host'
  const resource = 'workspace-c6-invalid'
  const digest = createHash('sha256').update(`${host}\0${resource}`).digest('hex')
  const lockFile = path.join(await realpath(config.stateDir), `resource-${digest}.lock`)
  await writeFile(lockFile, '{"schemaVersion":1,"resource":')
  const before = await readFile(lockFile, 'utf8')
  const lock = createResourceLock({ ...config, host })
  await assert.rejects(lock.acquire({ runId: 'run-new', resource, recoverDead: false }), error => error.code === 'LOCK_INVALID' && error.path === lockFile)
  assert.equal(await readFile(lockFile, 'utf8'), before)
})

test('C15 FIX2: pid vivo com startIdentity diferente (pid reutilizado) é dono morto: workspace preserva o lock', async t => {
  const config = await fixture(t)
  const host = 'test-host'
  const resource = 'workspace-c15-reused'
  const digest = createHash('sha256').update(`${host}\0${resource}`).digest('hex')
  const lockFile = path.join(await realpath(config.stateDir), `resource-${digest}.lock`)
  await writeFile(lockFile, JSON.stringify({ schemaVersion: 1, host, resource, runId: 'run-old', nonce: 'c15-reused', pid: 99999996, processStartIdentity: 'old-start', acquiredAt: new Date().toISOString() }))
  const before = await readFile(lockFile, 'utf8')
  const reusedLookup = async pid => pid === 99999996 ? { status: 'alive', startIdentity: 'new-start' } : { status: 'alive', startIdentity: 'test:process:1' }
  const lock = createResourceLock({ ...config, host, lookupProcessIdentity: reusedLookup })
  await assert.rejects(lock.acquire({ runId: 'run-new', resource, recoverDead: false }), error => error.code === 'LOCK_OWNER_DEAD' && error.path === lockFile && error.pid === 99999996)
  assert.equal(await readFile(lockFile, 'utf8'), before)
})

test('C15 FIX2: heavy com pid reutilizado (startIdentity diferente) é recuperado por padrão', async t => {
  const config = await fixture(t)
  const host = 'test-host'
  const resource = 'checks-heavy'
  const digest = createHash('sha256').update(`${host}\0${resource}`).digest('hex')
  const lockFile = path.join(config.stateDir, `resource-${digest}.lock`)
  await writeFile(lockFile, JSON.stringify({ schemaVersion: 1, host, resource, runId: 'run-old', nonce: 'c15-heavy-reused', pid: 99999997, processStartIdentity: 'old-start', acquiredAt: new Date().toISOString() }))
  const reusedLookup = async pid => pid === 99999997 ? { status: 'alive', startIdentity: 'new-start' } : { status: 'alive', startIdentity: 'test:process:1' }
  const lock = createResourceLock({ ...config, host, lookupProcessIdentity: reusedLookup })
  const token = await lock.acquire({ runId: 'run-new', resource })
  await lock.release(token)
  assert.deepEqual(await readdir(config.stateDir), [])
})
