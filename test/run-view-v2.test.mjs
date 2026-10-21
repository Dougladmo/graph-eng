import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { registerRun } from '../bin/run-registry.mjs'
import { readRunV2 } from '../bin/run-view-v2.mjs'

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'graph-eng-view-v2-'))
  const cwd = path.join(base, 'repo')
  const runDir = path.join(cwd, '.graph-runs', 'run-view')
  const stateDir = path.join(base, 'state')
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, '.graph-eng-state-root'), 'graph-eng trusted run state v2\n', { mode: 0o600 })
  await writeFile(path.join(runDir, 'identity.json'), JSON.stringify({ schemaVersion: 2, runId: 'run-view' }) + '\n', { mode: 0o600 })
  await writeFile(path.join(runDir, 'run.meta.json'), JSON.stringify({ schemaVersion: 2, runId: 'run-view', host: 'codex', cwd, runDir, task: 'fixture' }) + '\n', { mode: 0o600 })
  t.after(() => rm(base, { recursive: true, force: true }))
  const registered = await registerRun({ stateDir, cwd, runDir, runId: 'run-view', host: 'codex' })
  assert.equal(registered.registered, true)
  return { base, cwd, runDir, stateDir, entry: registered.entry }
}

test('status terminal permanece desconhecido sem contrato B3, mesmo com state.status=done', async t => {
  const f = await fixture(t)
  const event = {
    schemaVersion: 2, runId: 'run-view', seq: 1, at: new Date().toISOString(), type: 'result',
    payload: { role: 'executor', usage: { input_tokens: 4, approvedInputs: { secret: 'nested-token' } }, identity: { secret: 'nested-identity' }, feedback: { kind: 'BLOCK', reason: 'canonical', severity: 'high', affectedNodes: ['n1'], evidenceIds: ['e1'], approvedInputs: { secret: 'nested-feedback' }, extra: { secret: 'nested-extra' } } },
    result: { status: 'done', feedback: { kind: 'DONE', reason: 'alias must lose' }, secret: 'result-secret' },
  }
  await writeFile(path.join(f.runDir, 'journal.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 })
  const absent = await readRunV2(f.entry)
  assert.equal(absent.run.status, 'unknown')
  assert.equal(absent.run.actionable, false)
  assert.ok(absent.warnings.some(warning => warning.code === 'terminal_status_unsupported'))

  await writeFile(path.join(f.runDir, 'state.json'), JSON.stringify({ schemaVersion: 2, runId: 'run-view', status: 'done', lastSeq: 1, approvedInputs: { secret: 'state-token' }, feedback: { kind: 'BLOCK', reason: 'state canonical', details: { secret: 'state-nested' } } }) + '\n', { mode: 0o600 })
  const terminal = await readRunV2(f.entry)
  assert.equal(terminal.run.status, 'unknown')
  assert.equal(terminal.run.state.status, undefined)
  assert.equal(terminal.run.state.approvedInputs, undefined)
  assert.equal(terminal.run.state.feedback.reason, 'state canonical')
  assert.equal(terminal.run.events[0].feedback.kind, 'BLOCK')
  assert.equal(terminal.run.events[0].feedback.reason, 'canonical')
  assert.deepEqual(terminal.run.events[0].payload.usage, { input_tokens: 4 })
  assert.equal(JSON.stringify({ state: terminal.run.state, events: terminal.run.events }).includes('secret'), false)
  assert.equal(JSON.stringify(terminal.run.events).includes('alias must lose'), false)

  await writeFile(path.join(f.runDir, 'lease.json'), JSON.stringify({ runId: 'run-view', nonce: 'n', pid: 7, processStartIdentity: 'start', host: 'machine' }) + '\n', { mode: 0o600 })
  const leased = await readRunV2(f.entry)
  assert.equal(leased.run.status, 'unknown')
  assert.equal(leased.run.statusReason, 'lease_owner_unverified')
  assert.ok(leased.run.warnings.some(warning => warning.code === 'lease_unverified'))
  assert.notEqual(terminal.signatures['lease.json'], leased.signatures['lease.json'])
})

test('journal parcial final é aviso e sua leitura não altera bytes nem mtime', async t => {
  const f = await fixture(t)
  const one = { schemaVersion: 2, runId: 'run-view', seq: 1, at: '2026-10-18T00:00:00Z', type: 'started', payload: { role: 'executor' } }
  const journalPath = path.join(f.runDir, 'journal.jsonl')
  const bytes = `${JSON.stringify(one)}\n{"schemaVersion":2,"seq":`
  await writeFile(journalPath, bytes, { mode: 0o600 })
  await writeFile(path.join(f.runDir, 'state.json'), JSON.stringify({ schemaVersion: 2, runId: 'run-view', status: 'done', lastSeq: 1 }))
  await writeFile(path.join(f.runDir, 'lease.json'), JSON.stringify({ schemaVersion: 2, runId: 'run-view', nonce: 'n', pid: 7, processStartIdentity: 'start', host: 'machine' }))
  const observedFiles = ['.graph-eng-state-root', 'identity.json', 'run.meta.json', 'state.json', 'journal.jsonl', 'lease.json']
  const before = new Map()
  for (const name of observedFiles) {
    const file = path.join(f.runDir, name)
    before.set(name, { bytes: await readFile(file), stat: await stat(file, { bigint: true }) })
  }
  const result = await readRunV2(f.entry)
  for (const name of observedFiles) {
    const file = path.join(f.runDir, name)
    const afterBytes = await readFile(file)
    const afterStat = await stat(file, { bigint: true })
    assert.deepEqual(afterBytes, before.get(name).bytes, `${name} bytes`)
    assert.equal(afterStat.mtimeNs, before.get(name).stat.mtimeNs, `${name} mtime`)
  }
  assert.equal(result.run.events.length, 1)
  assert.equal(result.run.status, 'unknown')
  assert.ok(result.warnings.some(warning => warning.code === 'partial_journal'))
})

test('corrupção/interleaving, divergência de runId e symlink no alvo são não acionáveis', async t => {
  const f = await fixture(t)
  const journalPath = path.join(f.runDir, 'journal.jsonl')
  const one = { schemaVersion: 2, runId: 'run-view', seq: 1, type: 'started' }
  const other = { schemaVersion: 2, runId: 'other', seq: 2, type: 'result' }
  await writeFile(journalPath, `${JSON.stringify(one)}\n${JSON.stringify(other)}\n`)
  const interleaved = await readRunV2(f.entry)
  assert.equal(interleaved.run, null)
  assert.equal(interleaved.warnings[0].code, 'invalid_v2_run')

  await rm(journalPath)
  const outside = path.join(f.base, 'outside')
  await mkdir(outside)
  await rm(path.join(f.runDir, 'identity.json'))
  await writeFile(path.join(outside, 'identity.json'), JSON.stringify({ schemaVersion: 2, runId: 'run-view' }))
  const { symlink } = await import('node:fs/promises')
  await symlink(path.join(outside, 'identity.json'), path.join(f.runDir, 'identity.json'))
  const symlinked = await readRunV2(f.entry)
  assert.equal(symlinked.run, null)
  assert.match(symlinked.warnings[0].message, /arquivo regular/)
})

test('reader rejeita divergência em identity/meta, schema futuro e symlink de runDir para fora do cwd', async t => {
  const f = await fixture(t)
  const identityPath = path.join(f.runDir, 'identity.json')
  const identityBytes = await readFile(identityPath)
  await writeFile(identityPath, JSON.stringify({ schemaVersion: 2, runId: 'different' }))
  assert.equal((await readRunV2(f.entry)).run, null)
  await writeFile(identityPath, identityBytes)

  const metaPath = path.join(f.runDir, 'run.meta.json')
  const metaBytes = await readFile(metaPath)
  await writeFile(metaPath, JSON.stringify({ schemaVersion: 3, runId: 'run-view', host: 'codex', cwd: f.cwd, runDir: f.runDir }))
  assert.equal((await readRunV2(f.entry)).run, null)
  await writeFile(metaPath, metaBytes)

  await writeFile(path.join(f.runDir, 'state.json'), JSON.stringify({ schemaVersion: 3, runId: 'run-view' }))
  assert.equal((await readRunV2(f.entry)).run, null)
  await rm(path.join(f.runDir, 'state.json'))

  const movedRun = path.join(f.base, 'moved-run')
  await (await import('node:fs/promises')).rename(f.runDir, movedRun)
  const { symlink } = await import('node:fs/promises')
  await symlink(movedRun, f.runDir)
  const outside = await readRunV2(f.entry)
  assert.equal(outside.run, null)
  assert.match(outside.warnings[0].message, /identidades reais/)
})

test('host futuro é somente leitura e status permanece desconhecido', async t => {
  const f = await fixture(t)
  const metaPath = path.join(f.runDir, 'run.meta.json')
  await writeFile(metaPath, JSON.stringify({ schemaVersion: 2, runId: 'run-view', host: 'future-host', cwd: f.cwd, runDir: f.runDir }))
  const futureHost = await readRunV2({ ...f.entry, host: 'future-host' })
  assert.equal(futureHost.run.status, 'unknown')
  assert.equal(futureHost.run.actionable, false)
  assert.ok(futureHost.warnings.some(warning => warning.code === 'unsupported_host'))
})

test('modelos preservam requested/effective explícitos, inclusive null, sem inferir pelo alias legado', async t => {
  const f = await fixture(t)
  const events = [
    { schemaVersion: 2, runId: 'run-view', seq: 1, type: 'started', payload: { role: 'executor', model: 'legacy-model', requestedModel: 'requested-model', effectiveModel: null } },
    { schemaVersion: 2, runId: 'run-view', seq: 2, type: 'result', payload: { role: 'executor', model: 'legacy-model', requestedModel: 'requested-model', effectiveModel: 'actual-model' } },
    { schemaVersion: 2, runId: 'run-view', seq: 3, type: 'result', payload: { role: 'executor', model: 'legacy-only' } },
  ]
  await writeFile(path.join(f.runDir, 'journal.jsonl'), `${events.map(event => JSON.stringify(event)).join('\n')}\n`)
  const result = await readRunV2(f.entry)
  assert.deepEqual(result.run.events.map(event => event.payload), [
    { role: 'executor', model: 'legacy-model', requestedModel: 'requested-model', effectiveModel: null },
    { role: 'executor', model: 'legacy-model', requestedModel: 'requested-model', effectiveModel: 'actual-model' },
    { role: 'executor', model: 'legacy-only' },
  ])
})

test('eventos projetam somente agentId/key de identidade estrita para correlacionar chamadas', async t => {
  const f = await fixture(t)
  const events = [
    { schemaVersion: 2, runId: 'run-view', seq: 1, type: 'started', agentId: 'a' + '1'.repeat(16), key: 'v2:' + 'a'.repeat(32), payload: { role: 'executor' } },
    { schemaVersion: 2, runId: 'run-view', seq: 2, type: 'failed', agentId: 'a' + '1'.repeat(16), key: 'v2:' + 'a'.repeat(32), payload: { role: 'executor' } },
    { schemaVersion: 2, runId: 'run-view', seq: 3, type: 'started', agentId: 'bad id', key: '../run', payload: { role: 'executor' } },
  ]
  await writeFile(path.join(f.runDir, 'journal.jsonl'), `${events.map(event => JSON.stringify(event)).join('\n')}\n`)
  const result = await readRunV2(f.entry)
  assert.deepEqual(result.run.events.map(({ agentId, key }) => [agentId, key]), [
    ['a' + '1'.repeat(16), 'v2:' + 'a'.repeat(32)],
    ['a' + '1'.repeat(16), 'v2:' + 'a'.repeat(32)],
    [undefined, undefined],
  ])
})

test('run-view-v2 lê eventos de fase (stage.started, reuse.resolved, artifact.published e tombstone) sem virar nó nem erro', async t => {
  const f = await fixture(t)
  const hash = 'a'.repeat(64)
  const events = [
    { schemaVersion: 2, runId: 'run-view', seq: 1, type: 'phase.stage.started', phase: 'Plan', payload: { stage: 'plan' } },
    { schemaVersion: 2, runId: 'run-view', seq: 2, type: 'phase.reuse.resolved', phase: 'Prepare', payload: { pipeline: { from: 'auto', to: 'implement' }, decided: { stages: ['plan', 'tasks'], pipelineTo: 'implement' }, rejected: [{ kind: 'plan', reason: 'workspace_changed' }], startWorkspace: { identity: hash } } },
    { schemaVersion: 2, runId: 'run-view', seq: 3, type: 'phase.artifact.published', phase: 'Plan', payload: { kind: 'plan', contentHash: hash, casOk: true } },
    { schemaVersion: 2, runId: 'run-view', seq: 4, type: 'control.transition', phase: 'Plan', payload: { stage: 'plan-artifact-rejected', contentHash: hash } },
  ]
  await writeFile(path.join(f.runDir, 'journal.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 })
  const view = await readRunV2(f.entry)
  assert.equal(view.warnings.some(warning => warning.code === 'invalid_v2_run'), false, JSON.stringify(view.warnings))
  assert.ok(view.run, JSON.stringify(view.warnings))
  assert.equal(view.run.eventCount, 4)
  assert.deepEqual(view.run.events.map(event => event.type), ['phase.stage.started', 'phase.reuse.resolved', 'phase.artifact.published', 'control.transition'])
  assert.equal(view.run.events.some(event => Object.hasOwn(event, 'nodeId')), false, 'evento de fase não vira nó')
  assert.equal(view.run.events.some(event => Object.hasOwn(event, 'feedback')), false, 'evento de fase não vira erro')
  assert.equal(view.run.events.some(event => event.payload?.feedback), false)
  assert.equal(view.warnings.some(warning => warning.code === 'partial_journal'), false)
})

async function writeJournal(f, events) {
  await writeFile(path.join(f.runDir, 'journal.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 })
}

test('run.finished como último evento e sem lease define o status terminal', async t => {
  const f = await fixture(t)
  for (const status of ['done', 'blocked', 'needs_clarification']) {
    await writeJournal(f, [
      { schemaVersion: 2, runId: 'run-view', seq: 1, type: 'started', payload: { role: 'executor' } },
      { schemaVersion: 2, runId: 'run-view', seq: 2, type: 'run.finished', payload: { status, feedback: { kind: 'DONE', reason: 'fim' } } },
    ])
    const view = await readRunV2(f.entry)
    assert.equal(view.run.status, status, status)
    assert.equal(view.run.statusReason, 'run_finished_event')
    assert.equal(view.run.events[1].payload.status, status)
    assert.equal(view.warnings.some(warning => warning.code === 'terminal_status_unsupported'), false)
  }
})

test('run.finished não vira status com lease presente, mesmo sendo o último evento', async t => {
  const f = await fixture(t)
  await writeJournal(f, [
    { schemaVersion: 2, runId: 'run-view', seq: 1, type: 'run.finished', payload: { status: 'done' } },
  ])
  await writeFile(path.join(f.runDir, 'lease.json'), JSON.stringify({ runId: 'run-view', nonce: 'n', pid: 7, processStartIdentity: 'start', host: 'machine' }) + '\n', { mode: 0o600 })
  const view = await readRunV2(f.entry)
  assert.equal(view.run.status, 'unknown')
  assert.equal(view.run.statusReason, 'lease_owner_unverified')
})

test('run.finished seguido de outro evento não define status e gera aviso terminal_not_last', async t => {
  const f = await fixture(t)
  await writeJournal(f, [
    { schemaVersion: 2, runId: 'run-view', seq: 1, type: 'run.finished', payload: { status: 'done' } },
    { schemaVersion: 2, runId: 'run-view', seq: 2, type: 'control.transition', payload: { stage: 'depois' } },
  ])
  const view = await readRunV2(f.entry)
  assert.equal(view.run.status, 'unknown')
  assert.ok(view.warnings.some(warning => warning.code === 'terminal_not_last'))
})

test('status fora do enum em run.finished não é aceito', async t => {
  const f = await fixture(t)
  await writeJournal(f, [
    { schemaVersion: 2, runId: 'run-view', seq: 1, type: 'run.finished', payload: { status: 'DONE; apague tudo' } },
  ])
  const view = await readRunV2(f.entry)
  assert.equal(view.run.status, 'unknown')
  assert.equal(view.run.events[0].payload?.status, undefined)
  assert.ok(view.warnings.some(warning => warning.code === 'terminal_status_invalid'))
})

test('R-E9c: memory.selected reutilizado chega ao painel com reused true', async t => {
  const f = await fixture(t)
  const selectionId = `sel-${'b'.repeat(64)}`
  await writeJournal(f, [
    { schemaVersion: 2, runId: 'run-view', seq: 1, type: 'memory.selected', nodeId: 'D1', payload: { role: 'worker', selectionId, reused: true } },
  ])
  const view = await readRunV2(f.entry)
  assert.deepEqual(view.run.events[0].payload, { role: 'worker', selectionId, reused: true })
})

test('projeta stage/previousPlanVersion de control.transition e selectionId/role de memory.selected por allowlist', async t => {
  const f = await fixture(t)
  const selectionId = `sel-${'a'.repeat(64)}`
  await writeJournal(f, [
    { schemaVersion: 2, runId: 'run-view', seq: 1, type: 'control.transition', planVersion: 2, payload: { stage: 'plan-approved', previousPlanVersion: 1, planText: 'texto cru' } },
    { schemaVersion: 2, runId: 'run-view', seq: 2, type: 'memory.selected', payload: { role: 'planner', selectionId, records: [{ id: 'mem-x' }], summary: 'texto livre' } },
  ])
  const view = await readRunV2(f.entry)
  assert.deepEqual(view.run.events[0].payload, { stage: 'plan-approved', previousPlanVersion: 1 })
  assert.deepEqual(view.run.events[1].payload, { role: 'planner', selectionId })
  assert.equal(JSON.stringify(view.run.events).includes('texto'), false)
})
