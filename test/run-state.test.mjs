import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRunState } from '../bin/run-state.mjs'

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'graph-eng-state-'))
  const cwd = path.join(base, 'repo'); const runDir = path.join(cwd, '.graph-runs', 'test')
  await mkdir(cwd, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd }); execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd }); execFileSync('git', ['config', 'user.name', 'test'], { cwd })
  await writeFile(path.join(cwd, 'tracked.txt'), 'fixture'); execFileSync('git', ['add', '.'], { cwd }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd })
  t.after(() => rm(base, { recursive: true, force: true }))
  return { cwd, runDir }
}

test('lease é exclusivo e exige nonce e identidade do processo para heartbeat/release', async t => {
  const { cwd, runDir } = await fixture(t)
  const options = { cwd, runDir, runId: 'run-1', processIdentity: () => 'start-1', lookupProcessIdentity: async pid => ({ status: 'alive', startIdentity: 'start-1' }) }
  const first = createRunState(options); const second = createRunState(options)
  const lease = await first.acquire()
  await assert.rejects(second.acquire(), /já está em execução/)
  await assert.rejects(second.emit(lease, { type: 'unauthorized' }), /pertence/)
  await assert.rejects(first.acquire({ runId: 'another-run' }), /runId precisa corresponder/)
  await assert.rejects(first.heartbeat({ ...lease, nonce: 'other' }), /não pertence/)
  await first.heartbeat(lease); await first.release(lease)
  const next = await second.acquire(); assert.notEqual(next.nonce, lease.nonce); await second.release(next)
})

test('runIds diferentes não podem adquirir writer separado no mesmo runDir', async t => {
  const { cwd, runDir } = await fixture(t)
  const identity = { cwd, runDir, processIdentity: () => 'start', lookupProcessIdentity: async () => ({ status: 'alive', startIdentity: 'start' }) }
  const first = createRunState({ ...identity, runId: 'first' })
  const second = createRunState({ ...identity, runId: 'second' })
  const lease = await first.acquire()
  await assert.rejects(second.acquire(), /já pertence à run first/)
  await assert.rejects(second.emit(lease, { type: 'unauthorized' }), /pertence/)
  assert.equal(JSON.parse(await readFile(path.join(runDir, 'lease.json'), 'utf8')).runId, 'first')
  await first.release(lease)
})

test('PID reutilizado permite recuperar lease antigo sem liberar nonce substituto', async t => {
  const { cwd, runDir } = await fixture(t)
  const owner = createRunState({ cwd, runDir, runId: 'run-2', processIdentity: () => 'start-new', lookupProcessIdentity: async () => ({ status: 'alive', startIdentity: 'start-new' }) })
  const stale = createRunState({ cwd, runDir, runId: 'run-2', processIdentity: () => 'start-old', lookupProcessIdentity: async () => ({ status: 'alive', startIdentity: 'start-new' }) })
  const oldLease = { runId: 'run-2', nonce: 'old-nonce', pid: 987654, processStartIdentity: 'start-old', host: process.platform, acquiredAt: new Date().toISOString() }
  await mkdir(runDir, { recursive: true }); await writeFile(path.join(runDir, '.graph-eng-state-root'), 'graph-eng trusted run state v2\n')
  await writeFile(path.join(runDir, 'identity.json'), JSON.stringify({ schemaVersion: 2, runId: 'run-2' }))
  await writeFile(path.join(runDir, 'lease.json'), JSON.stringify(oldLease))
  const lease = await owner.acquire()
  assert.notEqual(lease.nonce, oldLease.nonce)
  await assert.rejects(stale.release(oldLease), /não pertence/)
  await owner.release(lease)
})

test('eventos ganham sequência e state é substituído atomicamente', async t => {
  const { cwd, runDir } = await fixture(t)
  const owner = createRunState({ cwd, runDir, runId: 'events', processIdentity: () => 'start', lookupProcessIdentity: async () => ({ status: 'alive', startIdentity: 'start' }) })
  const lease = await owner.acquire()
  const checkpoint = { schemaVersion: 2, planVersion: 2, nodes: {}, lastSeq: 0 }
  const one = await owner.emit(lease, { type: 'control.transition', payload: { checkpoint } })
  const two = await owner.emit(lease, { type: 'node.done', nodeId: 'A' })
  assert.equal(one.seq, 1); assert.equal(two.seq, 2)
  await owner.writeState(lease, { ...checkpoint, lastSeq: 1 })
  const saved = JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8'))
  assert.equal(saved.schemaVersion, 2); assert.equal(saved.planVersion, 2)
  assert.equal((await readFile(path.join(runDir, 'journal.jsonl'), 'utf8')).trim().split('\n').length, 2)
  const replay = await owner.load(lease)
  assert.deepEqual(replay.replayEvents.map(event => event.seq), [2])
  await writeFile(path.join(runDir, 'state.json'), JSON.stringify({ schemaVersion: 2, runId: 'events', planVersion: 2, nodes: {}, lastSeq: 3 }))
  await assert.rejects(owner.load(lease), /sequência ausente/)
  await writeFile(path.join(runDir, 'state.json'), JSON.stringify({ schemaVersion: 2, runId: 'events', planVersion: 2, nodes: {}, lastSeq: -1 }))
  await assert.rejects(owner.load(lease), /lastSeq inválido|sequência ausente/)
  await owner.release(lease)
  await assert.rejects(owner.emit(lease, { type: 'late' }), /não pertence/)
  await assert.rejects(owner.writeState(lease, { planVersion: 3 }), /não pertence/)
})

test('writeState não aceita seq fornecida pelo caller sem checkpoint histórico validado', async t => {
  const { cwd, runDir } = await fixture(t)
  const owner = createRunState({ cwd, runDir, runId: 'seq-guard', processIdentity: () => 'start', lookupProcessIdentity: async () => ({ status: 'alive', startIdentity: 'start' }) })
  const lease = await owner.acquire()
  await owner.emit(lease, { type: 'node.done' })
  await assert.rejects(owner.writeState(lease, { lastSeq: 1, arbitrary: true }), /checkpoint control.transition/)
  await assert.rejects(readFile(path.join(runDir, 'state.json'), 'utf8'), { code: 'ENOENT' })
  await owner.release(lease)
})

test('load avisa sobre linha parcial e só a recupera quando solicitado pelo dono', async t => {
  const { cwd, runDir } = await fixture(t)
  const owner = createRunState({ cwd, runDir, runId: 'partial', processIdentity: () => 'start', lookupProcessIdentity: async () => ({ status: 'alive', startIdentity: 'start' }) })
  const lease = await owner.acquire()
  await owner.emit(lease, { type: 'run.started' })
  await writeFile(path.join(runDir, 'journal.jsonl'), '{"runId":"partial","seq":1,"type":"run.started"}\n{"seq":')
  const before = await owner.load(lease)
  assert.equal(before.lastSeq, 1); assert.equal(before.warnings.length, 1)
  const recovered = await owner.load(lease, { recoverPartial: true })
  assert.deepEqual(recovered.warnings, [])
  assert.equal((await readFile(path.join(runDir, 'journal.jsonl'), 'utf8')).endsWith('\n'), true)
  await owner.release(lease)
})

test('lookup ambíguo preserva lease possivelmente vivo', async t => {
  const { cwd, runDir } = await fixture(t)
  const owner = createRunState({ cwd, runDir, runId: 'unknown', processIdentity: () => 'start', lookupProcessIdentity: async () => ({ status: 'unknown' }) })
  await mkdir(runDir, { recursive: true }); await writeFile(path.join(runDir, '.graph-eng-state-root'), 'graph-eng trusted run state v2\n')
  await writeFile(path.join(runDir, 'identity.json'), JSON.stringify({ schemaVersion: 2, runId: 'unknown' }))
  await writeFile(path.join(runDir, 'lease.json'), JSON.stringify({ runId: 'unknown', nonce: 'n', pid: 123, processStartIdentity: 'old', host: process.platform }))
  await assert.rejects(owner.acquire(), /ambíguo/)
  assert.equal(JSON.parse(await readFile(path.join(runDir, 'lease.json'), 'utf8')).nonce, 'n')
})

test('lookup alive sem identidade de início é ambíguo e não recupera o lease', async t => {
  const { cwd, runDir } = await fixture(t)
  const owner = createRunState({ cwd, runDir, runId: 'malformed', processIdentity: () => 'start', lookupProcessIdentity: async () => ({ status: 'alive' }) })
  await mkdir(runDir, { recursive: true }); await writeFile(path.join(runDir, '.graph-eng-state-root'), 'graph-eng trusted run state v2\n')
  await writeFile(path.join(runDir, 'identity.json'), JSON.stringify({ schemaVersion: 2, runId: 'malformed' }))
  const old = { runId: 'malformed', nonce: 'keep', pid: 123, processStartIdentity: 'old', host: process.platform }
  await writeFile(path.join(runDir, 'lease.json'), JSON.stringify(old))
  await assert.rejects(owner.acquire(), /ambíguo/)
  assert.equal(JSON.parse(await readFile(path.join(runDir, 'lease.json'), 'utf8')).nonce, 'keep')
})

test('load rejeita state incompatível e eventos pertencentes a outra run', async t => {
  const { cwd, runDir } = await fixture(t)
  const owner = createRunState({ cwd, runDir, runId: 'integrity', processIdentity: () => 'start', lookupProcessIdentity: async () => ({ status: 'alive', startIdentity: 'start' }) })
  const lease = await owner.acquire()
  await writeFile(path.join(runDir, 'state.json'), JSON.stringify({ schemaVersion: 1, runId: 'integrity' }))
  await assert.rejects(owner.load(lease), /incompatível/)
  await writeFile(path.join(runDir, 'state.json'), JSON.stringify({ schemaVersion: 2, runId: 'integrity', lastSeq: 0 }))
  await writeFile(path.join(runDir, 'journal.jsonl'), `${JSON.stringify({ schemaVersion: 2, runId: 'other', seq: 1, type: 'foreign' })}\n`)
  await assert.rejects(owner.load(lease), /outra run/)
  await owner.release(lease)
})

test('identidade do runDir persiste após release e impede overwrite por outro runId', async t => {
  const { cwd, runDir } = await fixture(t)
  const options = { cwd, runDir, processIdentity: () => 'start', lookupProcessIdentity: async () => ({ status: 'alive', startIdentity: 'start' }) }
  const first = createRunState({ ...options, runId: 'first' })
  const second = createRunState({ ...options, runId: 'second' })
  const lease = await first.acquire()
  const checkpoint = { schemaVersion: 2, lastSeq: 0, value: 'owned-by-first' }
  await first.emit(lease, { type: 'control.transition', payload: { checkpoint } })
  await first.writeState(lease, { ...checkpoint, lastSeq: 1 })
  await first.release(lease)
  const beforeJournal = await readFile(path.join(runDir, 'journal.jsonl'))
  const beforeState = await readFile(path.join(runDir, 'state.json'))
  await assert.rejects(second.acquire(), /já pertence à run first/)
  assert.deepEqual(await readFile(path.join(runDir, 'journal.jsonl')), beforeJournal)
  assert.deepEqual(await readFile(path.join(runDir, 'state.json')), beforeState)
})

test('readJournalFile lê o journal do runDir sem recuperar linha parcial (somente leitura)', async t => {
  const { runDir } = await fixture(t)
  await mkdir(runDir, { recursive: true })
  const { readJournalFile } = await import('../bin/run-state.mjs')
  const line = (seq, type) => JSON.stringify({ schemaVersion: 2, runId: 'test', seq, type, payload: {} })
  await writeFile(path.join(runDir, 'journal.jsonl'), `${line(1, 'a')}\n${line(2, 'b')}\n`)
  const complete = await readJournalFile(runDir)
  assert.equal(complete.partial, false)
  assert.deepEqual(complete.events.map(event => event.seq), [1, 2])
  assert.equal(complete.lastSeq, 2)
  await writeFile(path.join(runDir, 'journal.jsonl'), `${line(1, 'a')}\n{"schemaVersion":2,"seq":2,"ty`)
  const partial = await readJournalFile(runDir)
  assert.equal(partial.partial, true)
  assert.deepEqual(partial.events.map(event => event.seq), [1])
  assert.equal(await readFile(path.join(runDir, 'journal.jsonl'), 'utf8').then(text => text.endsWith('"ty')), true)
})
