import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEvidence } from '../bin/run-evidence.mjs'
import { createIntegrityGuard } from '../bin/run-integrity.mjs'

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'graph-eng-evidence-'))
  const cwd = path.join(base, 'repo'); const runDir = path.join(cwd, '.graph-runs', 'test')
  await mkdir(cwd, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore' })
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test')
  await writeFile(path.join(cwd, 'a.txt'), 'A0'); await writeFile(path.join(cwd, 'b.txt'), 'B0')
  git('add', 'a.txt', 'b.txt'); git('commit', '-qm', 'fixture')
  t.after(() => rm(base, { recursive: true, force: true }))
  return { cwd, runDir, git }
}

test('snapshot acompanha arquivos novos, modificados e removidos, e ignora gitignored', async t => {
  const { cwd, runDir } = await fixture(t); const evidence = createEvidence({ cwd, runDir })
  await writeFile(path.join(cwd, '.gitignore'), 'ignored.txt\n'); await writeFile(path.join(cwd, 'ignored.txt'), 'ignored')
  const initial = await evidence.snapshot()
  assert.equal(initial.files.some(file => file.path === 'ignored.txt'), false)
  await writeFile(path.join(cwd, 'a.txt'), 'A1'); await writeFile(path.join(cwd, 'new.txt'), 'N')
  const changed = await evidence.snapshot()
  assert.notEqual(changed.identity, initial.identity)
  assert.ok(changed.files.some(file => file.path === 'new.txt' && file.kind === 'file'))
  await rm(path.join(cwd, 'b.txt'))
  const removed = await evidence.snapshot()
  assert.ok(removed.files.some(file => file.path === 'b.txt' && file.kind === 'deleted'))
})

test('manifestos declarados entram na identidade e caminhos escapantes são rejeitados', async t => {
  const { cwd, runDir } = await fixture(t); const evidence = createEvidence({ cwd, runDir })
  const first = await evidence.snapshot({ inputs: [{ name: 'brief', value: 'one' }], contracts: ['a.txt'] })
  const changed = await evidence.snapshot({ inputs: [{ name: 'brief', value: 'two' }], contracts: ['a.txt'] })
  assert.notEqual(first.identity, changed.identity)
  await assert.rejects(evidence.snapshot({ inputs: ['../outside'] }), /Caminho inválido/)
})

test('fingerprints semânticos preservam B quando A muda e invalidam C que consome A', async t => {
  const { cwd, runDir } = await fixture(t); const evidence = createEvidence({ cwd, runDir })
  const a0 = await evidence.fingerprint({ inputs: ['a.txt'], contracts: [{ name: 'acceptance', value: 'A contract' }], outputs: [{ name: 'artifact', value: 'a-output-v1' }] })
  const b0 = await evidence.fingerprint({ inputs: ['b.txt'], contracts: [{ name: 'acceptance', value: 'B contract' }] })
  const c0 = await evidence.fingerprint({ inputs: [{ name: 'dependency:A', value: a0.identity }] })
  await writeFile(path.join(cwd, 'a.txt'), 'A changed')
  const a1 = await evidence.fingerprint({ inputs: ['a.txt'], contracts: [{ name: 'acceptance', value: 'A contract' }], outputs: [{ name: 'artifact', value: 'a-output-v1' }] })
  const b1 = await evidence.fingerprint({ inputs: ['b.txt'], contracts: [{ name: 'acceptance', value: 'B contract' }] })
  const c1 = await evidence.fingerprint({ inputs: [{ name: 'dependency:A', value: a1.identity }] })
  assert.notEqual(a1.identity, a0.identity)
  assert.equal(b1.identity, b0.identity)
  assert.notEqual(c1.identity, c0.identity)
})

test('symlink de entrada que sai do workspace falha fechado', async t => {
  const { cwd, runDir } = await fixture(t); const outside = path.join(path.dirname(cwd), 'outside.txt')
  await writeFile(outside, 'private'); await symlink(outside, path.join(cwd, 'escape'))
  const evidence = createEvidence({ cwd, runDir })
  await assert.rejects(evidence.snapshot(), /Symlink escapa/)
})

test('symlink de manifesto inclui conteúdo do destino ignorado e detecta destino ausente', async t => {
  const { cwd, runDir } = await fixture(t)
  await writeFile(path.join(cwd, '.gitignore'), 'target.txt\n')
  await writeFile(path.join(cwd, 'target.txt'), 'one')
  await symlink('target.txt', path.join(cwd, 'input-link'))
  const evidence = createEvidence({ cwd, runDir })
  const first = await evidence.fingerprint({ inputs: ['input-link'] })
  await writeFile(path.join(cwd, 'target.txt'), 'two')
  const second = await evidence.fingerprint({ inputs: ['input-link'] })
  assert.notEqual(second.identity, first.identity)
  await rm(path.join(cwd, 'target.txt'))
  await assert.rejects(evidence.fingerprint({ inputs: ['input-link'] }))
})

test('bit executável participa da identidade global', async t => {
  const { cwd, runDir } = await fixture(t); const evidence = createEvidence({ cwd, runDir })
  const first = await evidence.snapshot()
  await (await import('node:fs/promises')).chmod(path.join(cwd, 'a.txt'), 0o755)
  const second = await evidence.snapshot()
  assert.notEqual(second.identity, first.identity)
})

test('checks usam argv e recibo fica inválido se o comando altera a árvore', async t => {
  const { cwd, runDir } = await fixture(t); const events = []; const evidence = createEvidence({ cwd, runDir, emit: event => events.push(event) })
  const before = await evidence.snapshot()
  const receipts = await evidence.runChecks({ runId: 'test-run', snapshot: before, checks: [{ id: 'mutating', command: process.execPath, args: ['-e', "require('fs').writeFileSync('a.txt','changed')"], cwd: '.', timeoutMs: 5000 }] })
  assert.equal(receipts[0].exitCode, 0)
  assert.equal(receipts[0].valid, false)
  assert.equal(receipts[0].beforeIdentity, before.identity)
  assert.notEqual(receipts[0].afterIdentity, before.identity)
  assert.equal(events.length, 1)
  assert.match(await readFile(path.join(runDir, path.basename(receipts[0].stdoutPath)), 'utf8'), /^$/)
  assert.equal(await evidence.verifyArtifact(receipts[0]), true)
  const savedValidity = receipts[0].valid
  receipts[0].valid = !savedValidity
  assert.equal(await evidence.verifyArtifact(receipts[0]), false)
  receipts[0].valid = savedValidity
  await writeFile(path.join(runDir, path.basename(receipts[0].evidencePath)), 'tampered')
  assert.equal(await evidence.verifyArtifact(receipts[0]), false)
})

test('spawn failure e timeout produzem recibos sem deixar o runner pendurado', async t => {
  const { cwd, runDir } = await fixture(t); const evidence = createEvidence({ cwd, runDir }); const snapshot = await evidence.snapshot()
  const receipts = await evidence.runChecks({ runId: 'process-checks', snapshot, checks: [
    { id: 'missing', command: 'graph-eng-command-that-does-not-exist', args: [], timeoutMs: 1000 },
    { id: 'timeout', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 40 },
  ] })
  assert.match(receipts[0].error, /ENOENT|spawn/)
  assert.match(receipts[1].error, /Timeout/)
  assert.equal(receipts.every(receipt => receipt.valid === false), true)
})

test('check pesado sempre libera lock após falha e serializa uso compartilhado', async t => {
  const { cwd, runDir } = await fixture(t)
  let active = 0; let maxActive = 0; const waiting = []; let acquired = 0; let released = 0
  const heavyLock = {
    async acquire() {
      if (active) await new Promise(resolve => waiting.push(resolve))
      active++; maxActive = Math.max(maxActive, active); acquired++
      return { id: acquired }
    },
    async release() { active--; released++; waiting.shift()?.() },
  }
  const first = createEvidence({ cwd, runDir, heavyLock }); const second = createEvidence({ cwd, runDir, heavyLock })
  const snapshot = await first.snapshot()
  const check = id => ({ id, command: process.execPath, args: ['-e', "setTimeout(() => process.exit(3), 30)"], timeoutMs: 1000, heavy: true })
  const [a, b] = await Promise.all([
    first.runChecks({ runId: 'heavy-a', snapshot, checks: [check('a')] }),
    second.runChecks({ runId: 'heavy-b', snapshot, checks: [check('b')] }),
  ])
  assert.equal(maxActive, 1); assert.equal(acquired, 2); assert.equal(released, 2)
  assert.equal(a[0].valid || b[0].valid, false)
})

// C13: escritas do supervisor na runDir (receipt, stdout e stderr) passam pelo guard; a adulteração depois do close é pega no gate.
async function guardedEvidence(t) {
  const { cwd, runDir } = await fixture(t)
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, '.graph-eng-state-root'), 'graph-eng trusted run state v2\n')
  const guard = createIntegrityGuard({ root: runDir, scope: 'tree' })
  await guard.install()
  return { cwd, runDir, guard, evidence: createEvidence({ cwd, runDir, integrity: guard }) }
}

test('C13: receipt existente adulterado bloqueia no gate final', async t => {
  const { runDir, guard, evidence } = await guardedEvidence(t)
  const before = await evidence.snapshot()
  const [receipt] = await evidence.runChecks({ runId: 'c13-receipt', snapshot: before, checks: [{ id: 'ok', command: process.execPath, args: ['-e', ''], cwd: '.', timeoutMs: 5000 }] })
  await guard.assertIntegrity()
  const name = path.basename(receipt.evidencePath)
  await writeFile(path.join(runDir, name), 'tampered')
  await assert.rejects(guard.assertIntegrity(), error => error.code === 'run_integrity_violation' && error.paths.includes(name))
})

test('C13: stdout do check alterado depois do close bloqueia', async t => {
  const { runDir, guard, evidence } = await guardedEvidence(t)
  const before = await evidence.snapshot()
  const [receipt] = await evidence.runChecks({ runId: 'c13-stdout', snapshot: before, checks: [{ id: 'talk', command: process.execPath, args: ['-e', "process.stdout.write('original')"], cwd: '.', timeoutMs: 5000 }] })
  await guard.assertIntegrity()
  const name = path.basename(receipt.stdoutPath)
  assert.equal(await readFile(path.join(runDir, name), 'utf8'), 'original')
  await writeFile(path.join(runDir, name), 'alterado')
  await assert.rejects(guard.assertIntegrity(), error => error.code === 'run_integrity_violation' && error.paths.includes(name))
})

test('C13 FIX1: stdout plantado logo depois do register não é adotado; vira run_integrity_violation', async t => {
  const { cwd, runDir, guard } = await guardedEvidence(t)
  const planted = { ...guard, registerEphemeral: async names => { await guard.registerEphemeral(names); for (const name of names) if (name.endsWith('.stdout')) await writeFile(path.join(runDir, name), 'planted') } }
  const planting = createEvidence({ cwd, runDir, integrity: planted })
  const before = await planting.snapshot()
  await planting.runChecks({ runId: 'c13-planted', snapshot: before, checks: [{ id: 'quiet', command: process.execPath, args: ['-e', ''], cwd: '.', timeoutMs: 5000 }] }).catch(() => {})
  const stdoutName = (await readdir(runDir)).find(name => /^check-.*\.stdout$/.test(name))
  await assert.rejects(guard.assertIntegrity(), error => error.code === 'run_integrity_violation' && error.paths.includes(stdoutName))
})

// Regressão (review do design adaptativo, item 1): o check confiável herdava o process.env e via a chave do OpenRouter.
test('check confiável roda sem OPENROUTER_API_KEY nem GRAPH_ENG_* no ambiente', async t => {
  const { cwd, runDir } = await fixture(t); const evidence = createEvidence({ cwd, runDir }); const snapshot = await evidence.snapshot()
  const saved = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'sk-or-teste'
  t.after(() => { if (saved === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = saved })
  const probe = "process.exit(process.env.OPENROUTER_API_KEY || Object.keys(process.env).some(k => k.startsWith('GRAPH_ENG_')) ? 7 : 0)"
  const receipts = await evidence.runChecks({ runId: 'env-check', snapshot, checks: [{ id: 'env', command: process.execPath, args: ['-e', probe], timeoutMs: 5000 }] })
  assert.equal(receipts[0].exitCode, 0)
})
