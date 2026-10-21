import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRunMemory } from '../bin/run-memory.mjs'
import { createSourceResolver } from '../bin/memory-sources.mjs'
import { registerRun } from '../bin/run-registry.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const RUN_ID = 'run-src'

async function fixture(t) {
  const base = fs.realpathSync(await mkdtemp(path.join(os.tmpdir(), 'graph-memory-sources-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const cwd = path.join(base, 'repo')
  const runDir = path.join(cwd, '.graph-runs', RUN_ID)
  const dataDir = path.join(base, 'state')
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, '.graph-eng-state-root'), 'graph-eng trusted run state v2\n', { mode: 0o600 })
  await writeFile(path.join(runDir, 'identity.json'), JSON.stringify({ schemaVersion: 2, runId: RUN_ID }) + '\n', { mode: 0o600 })
  await writeFile(path.join(runDir, 'run.meta.json'), JSON.stringify({ schemaVersion: 2, runId: RUN_ID, host: 'codex', cwd, runDir, task: 'fonte' }) + '\n', { mode: 0o600 })
  const registered = await registerRun({ stateDir: dataDir, cwd, runDir, runId: RUN_ID, host: 'codex' })
  assert.equal(registered.registered, true)
  const lines = [
    { schemaVersion: 2, runId: RUN_ID, seq: 1, type: 'started', payload: { role: 'planner' } },
    { schemaVersion: 2, runId: RUN_ID, seq: 2, type: 'result', payload: { role: 'planner' } },
  ].map(event => Buffer.from(JSON.stringify(event)))
  await writeFile(path.join(runDir, 'journal.jsonl'), Buffer.concat(lines.flatMap(line => [line, Buffer.from('\n')])), { mode: 0o600 })
  await mkdir(path.join(runDir, 'outputs'))
  const artifactBytes = Buffer.from('{"decisao":"usar a fonte"}\n')
  await writeFile(path.join(runDir, 'outputs', 'decisao.json'), artifactBytes, { mode: 0o600 })
  const resolver = createSourceResolver({ dataDir })
  resolver.registerArtifact({ runId: RUN_ID, kind: 'decision', id: 'dec-1', relPath: 'outputs/decisao.json', identity: 'identity-dec-1' })
  return { base, cwd, runDir, dataDir, lines, artifactBytes, resolver, rootDir: path.join(base, 'memory') }
}

function decisionRecord(f, memory, eventSeq = 1) {
  return {
    schemaVersion: 1, kind: 'decision', repoId: memory.repoId, topic: 'decisão de teste', summary: 'contexto estruturado',
    scope: { nodeIds: ['node-a'], paths: [], contracts: [] },
    source: {
      runId: RUN_ID, planVersion: 'plan-1', eventSeq, eventHash: sha(f.lines[eventSeq - 1]),
      artifactRefs: [{ id: 'dec-1', hash: sha(f.artifactBytes), identity: 'identity-dec-1', kind: 'decision' }],
    },
    validity: { inputFingerprints: [], supersedes: [] },
  }
}

test('registro ponta a ponta com createRunMemory e o adaptador real; seleção devolve o registro', async t => {
  const f = await fixture(t)
  const memory = await createRunMemory({ rootDir: f.rootDir, repoRoot: f.cwd, resolveSource: f.resolver.resolveSource })
  const registered = await memory.register(decisionRecord(f, memory))
  assert.equal(registered.registered ?? true, true)
  assert.ok(registered.id)
  const selected = await memory.select({ role: 'planner', repoId: memory.repoId, nodeId: 'node-a' })
  assert.deepEqual(selected.records.map(item => item.id), [registered.id])
  assert.deepEqual(await memory.verifySelection(selected), { valid: true, selectionId: selected.selectionId, diagnostics: [] })
})

test('linha do journal adulterada faz o hash divergir e o registro sai da seleção', async t => {
  const f = await fixture(t)
  const memory = await createRunMemory({ rootDir: f.rootDir, repoRoot: f.cwd, resolveSource: f.resolver.resolveSource })
  await memory.register(decisionRecord(f, memory))
  const forged = Buffer.from(JSON.stringify({ schemaVersion: 2, runId: RUN_ID, seq: 1, type: 'started', payload: { role: 'forjado' } }))
  await writeFile(path.join(f.runDir, 'journal.jsonl'), Buffer.concat([forged, Buffer.from('\n'), f.lines[1], Buffer.from('\n')]))
  const selected = await memory.select({ role: 'planner', repoId: memory.repoId, nodeId: 'node-a' })
  assert.deepEqual(selected.records, [])
  assert.ok(selected.omissions.some(item => /fonte inválida/.test(item.reason)))
})

test('runDir trocada por symlink é recusada e journal que é symlink também', async t => {
  const f = await fixture(t)
  const memory = await createRunMemory({ rootDir: f.rootDir, repoRoot: f.cwd, resolveSource: f.resolver.resolveSource })
  await memory.register(decisionRecord(f, memory))
  const event = { kind: 'event', runId: RUN_ID, eventSeq: 1, hash: sha(f.lines[0]), identity: { runId: RUN_ID, eventSeq: 1 } }
  assert.ok(await f.resolver.resolveSource(event), 'antes da troca, a fonte resolve')

  // Dentro do cwd de propósito: assim só a checagem de caminho real recusa a troca, não o assertDescendant.
  const moved = path.join(f.cwd, '.graph-runs', 'moved-run')
  await rename(f.runDir, moved)
  await symlink(moved, f.runDir)
  assert.equal(await f.resolver.resolveSource(event), null, 'runDir symlink não pode ser seguida')
  assert.equal(await f.resolver.resolveSource({ kind: 'decision', id: 'dec-1', identity: 'identity-dec-1', hash: sha(f.artifactBytes) }), null)

  await rm(f.runDir)
  await rename(moved, f.runDir)
  const outsideJournal = path.join(f.base, 'fora.jsonl')
  await writeFile(outsideJournal, await readFile(path.join(f.runDir, 'journal.jsonl')))
  await rm(path.join(f.runDir, 'journal.jsonl'))
  await symlink(outsideJournal, path.join(f.runDir, 'journal.jsonl'))
  assert.equal(await f.resolver.resolveSource(event), null, 'journal symlink é recusado com O_NOFOLLOW')
})

test('run não registrada fica indisponível e identidade divergente do marker é recusada', async t => {
  const f = await fixture(t)
  assert.equal(await f.resolver.resolveSource({ kind: 'event', runId: 'run-fantasma', eventSeq: 1, hash: sha(f.lines[0]), identity: { runId: 'run-fantasma', eventSeq: 1 } }), null)

  const identityPath = path.join(f.runDir, 'identity.json')
  const identityBytes = await readFile(identityPath)
  await writeFile(identityPath, JSON.stringify({ schemaVersion: 2, runId: 'outra' }))
  assert.equal(await f.resolver.resolveSource({ kind: 'event', runId: RUN_ID, eventSeq: 1, hash: sha(f.lines[0]), identity: { runId: RUN_ID, eventSeq: 1 } }), null)
  await writeFile(identityPath, identityBytes)

  await writeFile(path.join(f.runDir, '.graph-eng-state-root'), 'marcador adulterado\n')
  assert.equal(await f.resolver.resolveSource({ kind: 'event', runId: RUN_ID, eventSeq: 1, hash: sha(f.lines[0]), identity: { runId: RUN_ID, eventSeq: 1 } }), null)
})

test('id fora do mapa do supervisor e relPath fora de outputs/receipts são recusados', async t => {
  const f = await fixture(t)
  assert.equal(await f.resolver.resolveSource({ kind: 'decision', id: 'nao-registrado', identity: 'x', hash: sha(f.artifactBytes) }), null)
  assert.throws(() => f.resolver.registerArtifact({ runId: RUN_ID, kind: 'decision', id: 'dec-2', relPath: '../fora.json', identity: 'i' }), /relPath/)
  assert.throws(() => f.resolver.registerArtifact({ runId: RUN_ID, kind: 'decision', id: 'dec-2', relPath: 'journal.jsonl', identity: 'i' }), /relPath/)
  assert.throws(() => f.resolver.registerArtifact({ runId: RUN_ID, kind: 'decision', id: 'dec-2', relPath: 'outputs/../../x', identity: 'i' }), /relPath/)
})

test('evento é resolvido pela seq exata e seq ausente devolve nulo', async t => {
  const f = await fixture(t)
  const second = await f.resolver.resolveSource({ kind: 'event', runId: RUN_ID, eventSeq: 2, hash: sha(f.lines[1]), identity: { runId: RUN_ID, eventSeq: 2 } })
  assert.deepEqual(Buffer.from(second.bytes), f.lines[1])
  assert.deepEqual(second.identity, { runId: RUN_ID, eventSeq: 2 })
  assert.equal(second.verified, true)
  assert.equal(await f.resolver.resolveSource({ kind: 'event', runId: RUN_ID, eventSeq: 9, hash: sha(f.lines[0]), identity: { runId: RUN_ID, eventSeq: 9 } }), null)
})

// R-E7b: receipts do check ficam na raiz da runDir com o nome receipt-<uuid>.json (run-evidence.mjs).
const RECEIPT_ID = '0b6f3c2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'
const RECEIPT_NAME = `receipt-${RECEIPT_ID}.json`

test('R-E7b: receipt válido na raiz da runDir é resolvido com bytes e identidade verificados', async t => {
  const f = await fixture(t)
  const bytes = Buffer.from('{"checkId":"node-test","valid":true}\n')
  await writeFile(path.join(f.runDir, RECEIPT_NAME), bytes, { mode: 0o600 })
  f.resolver.registerArtifact({ runId: RUN_ID, kind: 'receipt', id: RECEIPT_ID, relPath: RECEIPT_NAME, identity: `identity-${RECEIPT_ID}` })
  const resolved = await f.resolver.resolveSource({ kind: 'receipt', id: RECEIPT_ID })
  assert.equal(resolved.verified, true)
  assert.deepEqual(Buffer.from(resolved.bytes), bytes)
  assert.equal(resolved.identity, `identity-${RECEIPT_ID}`)
})

test('R-E7b: nomes parecidos com receipt e arquivos da raiz são recusados no registro', async t => {
  const f = await fixture(t)
  const refused = [`receipt-x.json.bak`, `../receipt-${RECEIPT_ID}.json`, `receipt-${RECEIPT_ID}.json.bak`, 'REPORT.md', `receipt-${RECEIPT_ID.toUpperCase()}.json`, `sub/receipt-${RECEIPT_ID}.json`]
  for (const relPath of refused) {
    assert.throws(() => f.resolver.registerArtifact({ runId: RUN_ID, kind: 'receipt', id: `id-${refused.indexOf(relPath)}`, relPath, identity: 'x' }), undefined, relPath)
  }
})

test('R-E7b: receipt que é symlink na raiz da runDir não é resolvido', async t => {
  const f = await fixture(t)
  const target = path.join(f.base, 'fora.json')
  await writeFile(target, '{"fora":true}\n', { mode: 0o600 })
  await symlink(target, path.join(f.runDir, RECEIPT_NAME))
  f.resolver.registerArtifact({ runId: RUN_ID, kind: 'receipt', id: RECEIPT_ID, relPath: RECEIPT_NAME, identity: 'identity-link' })
  assert.equal(await f.resolver.resolveSource({ kind: 'receipt', id: RECEIPT_ID }), null)
})

test('R-E7b: evidência de receipt na raiz da runDir vira registro e volta na seleção do critic', async t => {
  const f = await fixture(t)
  const receiptBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, id: RECEIPT_ID, checkId: 'node-test', valid: true }) + '\n')
  await writeFile(path.join(f.runDir, RECEIPT_NAME), receiptBytes, { mode: 0o600 })
  f.resolver.registerArtifact({ runId: RUN_ID, kind: 'receipt', id: RECEIPT_ID, relPath: RECEIPT_NAME, identity: 'identity-entrega-1' })
  const memory = await createRunMemory({ rootDir: f.rootDir, repoRoot: f.cwd, resolveSource: f.resolver.resolveSource })
  const registered = await memory.register({
    schemaVersion: 1, kind: 'evidence', repoId: memory.repoId, topic: 'Check node-test', summary: 'Check node-test válido na identidade identity-entrega-1',
    scope: { nodeIds: ['node-a'], paths: [], contracts: [] },
    source: { runId: RUN_ID, planVersion: 'plan-1', eventSeq: 1, eventHash: sha(f.lines[0]), artifactRefs: [{ id: RECEIPT_ID, hash: sha(receiptBytes), identity: 'identity-entrega-1', kind: 'receipt' }] },
    validity: { inputFingerprints: [], supersedes: [] },
  })
  assert.ok(registered.id, JSON.stringify(registered))
  const selected = await memory.select({ role: 'critic', repoId: memory.repoId, nodeId: 'node-a' })
  assert.deepEqual(selected.records.map(item => item.id), [registered.id])
})

// R-E7c: o mapa de artifacts fica em <artifactsDir> (dentro de <dataDir>/memory/<repoId>), fora da runDir.
// O mapa só localiza a fonte; o resolver continua relendo e validando a runDir (hash e identidade).
test('R-E7c: artifact registrado por um resolver é resolvido por outro resolver (cross-run)', async t => {
  const f = await fixture(t)
  const artifactsDir = path.join(f.base, 'memory', 'repo-x', 'artifacts')
  const writer = createSourceResolver({ dataDir: f.dataDir, artifactsDir })
  writer.registerArtifact({ runId: RUN_ID, kind: 'decision', id: 'dec-persist', relPath: 'outputs/decisao.json', identity: 'identity-persist' })
  const reader = createSourceResolver({ dataDir: f.dataDir, artifactsDir })
  const resolved = await reader.resolveSource({ kind: 'decision', id: 'dec-persist', hash: sha(f.artifactBytes), identity: 'identity-persist' })
  assert.equal(resolved.verified, true)
  assert.deepEqual(Buffer.from(resolved.bytes), f.artifactBytes)
})

test('R-E7c: entrada do mapa adulterada (outro arquivo) dá null, porque o hash da fonte não confere', async t => {
  const f = await fixture(t)
  const artifactsDir = path.join(f.base, 'memory', 'repo-y', 'artifacts')
  createSourceResolver({ dataDir: f.dataDir, artifactsDir }).registerArtifact({ runId: RUN_ID, kind: 'decision', id: 'dec-adult', relPath: 'outputs/decisao.json', identity: 'identity-adult' })
  const entry = fs.readdirSync(artifactsDir).find(name => name.endsWith('.json'))
  await writeFile(path.join(artifactsDir, entry), JSON.stringify({ schemaVersion: 1, kind: 'decision', id: 'dec-adult', runId: RUN_ID, relPath: 'REPORT.md', identity: 'identity-adult' }) + '\n')
  const reader = createSourceResolver({ dataDir: f.dataDir, artifactsDir })
  assert.equal(await reader.resolveSource({ kind: 'decision', id: 'dec-adult', hash: sha(f.artifactBytes), identity: 'identity-adult' }), null)
})

test('R-E7c: entrada do mapa com identidade trocada dá null quando a referência traz outra identidade', async t => {
  const f = await fixture(t)
  const artifactsDir = path.join(f.base, 'memory', 'repo-z', 'artifacts')
  createSourceResolver({ dataDir: f.dataDir, artifactsDir }).registerArtifact({ runId: RUN_ID, kind: 'decision', id: 'dec-id', relPath: 'outputs/decisao.json', identity: 'identity-real' })
  const entry = fs.readdirSync(artifactsDir).find(name => name.endsWith('.json'))
  await writeFile(path.join(artifactsDir, entry), JSON.stringify({ schemaVersion: 1, kind: 'decision', id: 'dec-id', runId: RUN_ID, relPath: 'outputs/decisao.json', identity: 'identity-forjada' }) + '\n')
  const reader = createSourceResolver({ dataDir: f.dataDir, artifactsDir })
  assert.equal(await reader.resolveSource({ kind: 'decision', id: 'dec-id', hash: sha(f.artifactBytes), identity: 'identity-real' }), null)
})

test('R-E7c: fonte original alterada na runDir dá null mesmo com o mapa intacto', async t => {
  const f = await fixture(t)
  const artifactsDir = path.join(f.base, 'memory', 'repo-w', 'artifacts')
  const writer = createSourceResolver({ dataDir: f.dataDir, artifactsDir })
  writer.registerArtifact({ runId: RUN_ID, kind: 'decision', id: 'dec-src', relPath: 'outputs/decisao.json', identity: 'identity-src' })
  await writeFile(path.join(f.runDir, 'outputs', 'decisao.json'), '{"decisao":"adulterada"}\n', { mode: 0o600 })
  const reader = createSourceResolver({ dataDir: f.dataDir, artifactsDir })
  assert.equal(await reader.resolveSource({ kind: 'decision', id: 'dec-src', hash: sha(f.artifactBytes), identity: 'identity-src' }), null)
})

test('R-E7c: id já registrado com conteúdo diferente é recusado; mesmo conteúdo é idempotente', async t => {
  const f = await fixture(t)
  const artifactsDir = path.join(f.base, 'memory', 'repo-v', 'artifacts')
  const writer = createSourceResolver({ dataDir: f.dataDir, artifactsDir })
  writer.registerArtifact({ runId: RUN_ID, kind: 'decision', id: 'dec-dup', relPath: 'outputs/decisao.json', identity: 'identity-dup' })
  writer.registerArtifact({ runId: RUN_ID, kind: 'decision', id: 'dec-dup', relPath: 'outputs/decisao.json', identity: 'identity-dup' })
  const other = createSourceResolver({ dataDir: f.dataDir, artifactsDir })
  assert.throws(() => other.registerArtifact({ runId: RUN_ID, kind: 'decision', id: 'dec-dup', relPath: 'outputs/decisao.json', identity: 'identity-outra' }), /já registrado/)
  assert.equal(fs.readdirSync(artifactsDir).filter(name => name.endsWith('.json')).length, 1)
})

test('R-E7c: o arquivo do mapa é 0600 e não é gravado dentro da runDir', async t => {
  const f = await fixture(t)
  const artifactsDir = path.join(f.base, 'memory', 'repo-m', 'artifacts')
  createSourceResolver({ dataDir: f.dataDir, artifactsDir }).registerArtifact({ runId: RUN_ID, kind: 'decision', id: 'dec-mode', relPath: 'outputs/decisao.json', identity: 'identity-mode' })
  const entry = fs.readdirSync(artifactsDir).find(name => name.endsWith('.json'))
  assert.equal(fs.statSync(path.join(artifactsDir, entry)).mode & 0o777, 0o600)
  assert.equal(fs.readdirSync(f.runDir).some(name => name.includes('dec-mode')), false)
})

test('FIX6 3E: fonte registrada por run de outro cwd não resolve; mesmo cwd resolve', async t => {
  const f = await fixture(t)
  const otherCwd = path.join(f.base, 'outro-repo')
  await mkdir(otherCwd, { recursive: true })
  const current = (cwd, runId) => ({ schemaVersion: 2, runId, runDir: path.join(cwd, '.graph-runs', runId), cwd, host: 'codex', registeredAt: new Date().toISOString() })
  const fromOtherRepo = createSourceResolver({ dataDir: f.dataDir, currentRun: current(otherCwd, 'run-current') })
  assert.equal(await fromOtherRepo.resolveSource({ kind: 'event', runId: RUN_ID, eventSeq: 1 }), null)
  const sameRepo = createSourceResolver({ dataDir: f.dataDir, currentRun: current(f.cwd, 'run-current') })
  const resolved = await sameRepo.resolveSource({ kind: 'event', runId: RUN_ID, eventSeq: 1 })
  assert.equal(resolved?.verified, true)
})
