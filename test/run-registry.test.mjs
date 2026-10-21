import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readRunRegistry, registerRun, runIdentityHash } from '../bin/run-registry.mjs'

async function fixture(t, name = 'repo') {
  const base = await mkdtemp(path.join(os.tmpdir(), 'graph-eng-registry-'))
  const cwd = path.join(base, name)
  const runDir = path.join(cwd, '.graph-runs', 'same-run')
  const stateDir = path.join(base, 'state')
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, '.graph-eng-state-root'), 'graph-eng trusted run state v2\n', { mode: 0o600 })
  await writeFile(path.join(runDir, 'identity.json'), JSON.stringify({ schemaVersion: 2, runId: 'same-run' }) + '\n', { mode: 0o600 })
  await writeFile(path.join(runDir, 'run.meta.json'), JSON.stringify({ schemaVersion: 2, runId: 'same-run', host: 'codex', cwd, runDir }) + '\n', { mode: 0o600 })
  t.after(() => rm(base, { recursive: true, force: true }))
  return { base, cwd, runDir, stateDir }
}

test('registry grava entradas independentes por identidade composta e preserva registros concorrentes', async t => {
  const a = await fixture(t, 'repo-a')
  const b = await fixture(t, 'repo-b')
  a.stateDir = b.stateDir = path.join(a.base, 'shared-state')
  const [left, right] = await Promise.all([
    registerRun({ ...a, runId: 'same-run', host: 'codex' }),
    registerRun({ ...b, runId: 'same-run', host: 'codex' }),
  ])
  assert.equal(left.registered, true)
  assert.equal(right.registered, true)
  assert.notEqual(runIdentityHash(left.entry), runIdentityHash(right.entry))
  const registry = await readRunRegistry({ stateDir: a.stateDir })
  assert.equal(registry.entries.length, 2)
  assert.deepEqual(registry.warnings, [])
  assert.equal((await stat(path.join(a.stateDir, 'runs-v2'))).mode & 0o777, 0o700)
  const names = await (await import('node:fs/promises')).readdir(path.join(a.stateDir, 'runs-v2'))
  for (const name of names) assert.equal((await stat(path.join(a.stateDir, 'runs-v2', name))).mode & 0o777, 0o600)
})

test('registro rejeita runId inválido, caminho fora do cwd e metadado divergente sem inventar sucesso', async t => {
  const f = await fixture(t)
  assert.equal((await registerRun({ ...f, runId: '../escape', host: 'codex' })).registered, false)
  assert.equal((await registerRun({ ...f, runId: 'same-run', host: 'codex', runDir: f.base })).registered, false)
  await writeFile(path.join(f.runDir, 'run.meta.json'), JSON.stringify({ schemaVersion: 2, runId: 'other', host: 'codex', cwd: f.cwd, runDir: f.runDir }))
  const result = await registerRun({ ...f, runId: 'same-run', host: 'codex' })
  assert.equal(result.registered, false)
  assert.match(result.warning.message, /diverge/)
  assert.deepEqual((await readRunRegistry({ stateDir: f.stateDir })).entries, [])
})

test('registry ignora entrada adulterada e reporta warning sem tocar o alvo', async t => {
  const f = await fixture(t)
  const ok = await registerRun({ ...f, runId: 'same-run', host: 'codex' })
  assert.equal(ok.registered, true)
  await writeFile(path.join(f.stateDir, 'runs-v2', `${'a'.repeat(64)}.json`), JSON.stringify(ok.entry))
  const result = await readRunRegistry({ stateDir: f.stateDir })
  assert.equal(result.entries.length, 1)
  assert.equal(result.warnings.length, 1)
  assert.equal(result.warnings[0].code, 'invalid_registry_entry')
  assert.ok((await readFile(path.join(f.runDir, 'identity.json'), 'utf8')).includes('same-run'))
})

test('schema futuro gera warning e não vira entrada acionável', async t => {
  const f = await fixture(t)
  const ok = await registerRun({ ...f, runId: 'same-run', host: 'codex' })
  assert.equal(ok.registered, true)
  await writeFile(path.join(f.stateDir, 'runs-v2', `${'b'.repeat(64)}.json`), JSON.stringify({ ...ok.entry, schemaVersion: 3 }))
  const result = await readRunRegistry({ stateDir: f.stateDir })
  assert.equal(result.entries.length, 1)
  assert.ok(result.warnings.some(warning => warning.code === 'invalid_registry_entry' && /schema não suportado/.test(warning.message)))
})

test('falha real de armazenamento retorna diagnóstico sem relatar registro inexistente como sucesso', async t => {
  const f = await fixture(t)
  const blockedStateDir = path.join(f.base, 'not-a-directory')
  await writeFile(blockedStateDir, 'obstruction')
  const result = await registerRun({ ...f, stateDir: blockedStateDir, runId: 'same-run', host: 'codex' })
  assert.equal(result.registered, false)
  assert.equal(typeof result.warning.code, 'string')
  assert.match(result.warning.message, /exist|diretório|directory/i)
})
