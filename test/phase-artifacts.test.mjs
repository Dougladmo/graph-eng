import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  contentHashOf, planningInputsOf, planningKeyOf, questionSetIdOf, readSlot, resolveReuse,
  sealArtifact, STAGE_BY_STATUS, validateArtifact, verifySource, workspaceIdentityOf, workspaceOf, writeSlot,
} from '../bin/phase-artifacts.mjs'

const HEX = c => c.repeat(64)
const SNAP = { head: 'h1', files: [{ path: 'src/a.mjs', sha256: HEX('f') }] }
const WS = workspaceIdentityOf(SNAP)
const RUN_ID = 'grapheng-20261019120000-abcdef12'

async function makeRepo(t) {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'phase-artifacts-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function inputsFor(repo, overrides = {}) {
  return planningInputsOf({
    repo, task: 'tarefa exata', context: 'contexto', spec: null, acceptedCriteria: ['pronto'],
    host: 'claude', modelPolicyHash: HEX('a'), workflowSourceHash: HEX('b'), ...overrides,
  })
}

function approvedPlan(repo, { inputs = inputsFor(repo), identity = WS, goal = 'meta' } = {}) {
  return sealArtifact({
    schemaVersion: 1, kind: 'graph-eng.plan', status: 'approved',
    planningKey: planningKeyOf(inputs), planningInputs: inputs,
    source: { runId: RUN_ID, runDir: `.graph-runs/${RUN_ID}`, seq: 4 },
    workspace: { head: 'h1', identity },
    content: {
      goal, doneWhen: ['pronto'], assumptions: [], risks: [], researchNodes: ['research-a'],
      research: [{ nodeId: 'research-a', summary: 'resumo', findings: ['achado'] }],
      openQuestions: [], questionSetId: null, clarifications: [],
    },
    critic: { kind: 'APPROVE', evidenceIds: ['ev-1'] }, reason: null,
  })
}

function needsClarification(repo) {
  const inputs = inputsFor(repo)
  const openQuestions = [{ id: 'Q1', text: 'Qual banco?', options: ['pg', 'sqlite'] }]
  return sealArtifact({
    schemaVersion: 1, kind: 'graph-eng.plan', status: 'needs_clarification',
    planningKey: planningKeyOf(inputs), planningInputs: inputs,
    source: { runId: RUN_ID, runDir: `.graph-runs/${RUN_ID}`, seq: 4 },
    workspace: { head: 'h1', identity: WS },
    content: {
      goal: 'meta', doneWhen: ['pronto'], assumptions: [], risks: [], researchNodes: [], research: [],
      openQuestions, questionSetId: questionSetIdOf(openQuestions), clarifications: [],
    },
    critic: { kind: 'APPROVE', evidenceIds: [] }, reason: null,
  })
}

function rejectedPlan(repo) {
  const inputs = inputsFor(repo)
  return sealArtifact({
    schemaVersion: 1, kind: 'graph-eng.plan', status: 'rejected',
    planningKey: planningKeyOf(inputs), planningInputs: inputs,
    source: { runId: RUN_ID, runDir: `.graph-runs/${RUN_ID}`, seq: 4 },
    workspace: { head: 'h1', identity: WS }, reason: 'critic_block',
  })
}

function approvedTasks(plan) {
  return sealArtifact({
    schemaVersion: 1, kind: 'graph-eng.tasks', status: 'approved',
    planningKey: plan.planningKey, planningInputs: plan.planningInputs,
    source: { runId: RUN_ID, runDir: `.graph-runs/${RUN_ID}`, seq: 4 },
    workspace: { head: 'h1', identity: WS }, planContentHash: plan.contentHash,
    content: { nodes: [{ id: 'impl-a', kind: 'implement', deps: [], title: 't', brief: 'b', files: ['src/a.mjs'] }] },
    reason: null,
  })
}

// Journal e meta falsos com a mesma forma que run-state e run.meta.json entregam.
function fakeRun(repo, artifact, { events, meta, partial = false } = {}) {
  const kind = artifact.kind === 'graph-eng.tasks' ? 'tasks' : 'plan'
  const defaultEvent = {
    seq: artifact.source.seq, runId: artifact.source.runId, type: 'control.transition',
    payload: { stage: STAGE_BY_STATUS[kind][artifact.status], contentHash: artifact.contentHash },
  }
  return {
    readJournal: async () => ({ events: events ?? [defaultEvent], partial }),
    readMeta: async () => meta ?? { schemaVersion: 2, runId: artifact.source.runId, host: artifact.planningInputs.host, cwd: repo },
  }
}

async function reuseOf(repo, artifact, { kind = 'plan', slot, planningKey = planningKeyOf(inputsFor(repo)), workspace = { head: 'h1', identity: WS }, planArtifact, run } = {}) {
  return resolveReuse({
    repo, kind, slot: slot ?? { artifact, invalid: false }, planningKey, workspace, planArtifact,
    ...(run ?? (artifact ? fakeRun(repo, artifact) : {})),
  })
}

test('planningKey é estável, ignora effort e muda com cada entrada de planejamento', async t => {
  const repo = await makeRepo(t)
  const base = planningKeyOf(inputsFor(repo))
  assert.match(base, /^[a-f0-9]{64}$/)
  assert.equal(planningKeyOf(inputsFor(repo)), base)
  assert.equal(planningKeyOf(planningInputsOf({ repo, task: 'tarefa exata', context: 'contexto', spec: null, acceptedCriteria: ['pronto'], host: 'claude', modelPolicyHash: HEX('a'), workflowSourceHash: HEX('b'), effort: 'max' })), base)
  const variants = [
    { task: 'tarefa exata ' }, { task: 'Tarefa exata' }, { context: 'outro' },
    { spec: { path: 'docs/spec.md', sha256: HEX('c') } }, { acceptedCriteria: ['outro'] }, { acceptedCriteria: null },
    { host: 'codex' }, { modelPolicyHash: HEX('d') }, { workflowSourceHash: HEX('e') },
  ]
  const keys = variants.map(overrides => planningKeyOf(inputsFor(repo, overrides)))
  for (const key of keys) assert.notEqual(key, base)
  assert.equal(new Set(keys).size, keys.length)
})

test('canonicalJson recusa undefined, NaN, Infinity, função e objeto que não é simples', () => {
  for (const bad of [undefined, NaN, Infinity, () => 1, new Date(0)]) {
    assert.throws(() => planningKeyOf({ schemaVersion: 1, value: bad }), TypeError)
  }
})

test('workspaceIdentity ignora .graph-runs e branch, e muda com head, arquivo alterado, novo ou removido', () => {
  const base = { head: 'h1', branch: 'main', files: [{ path: 'a.mjs', sha256: HEX('1') }, { path: 'b.mjs', sha256: HEX('2') }] }
  const id = workspaceIdentityOf(base)
  assert.match(id, /^[a-f0-9]{64}$/)
  assert.equal(workspaceIdentityOf({ ...base, branch: 'outra' }), id)
  assert.equal(workspaceIdentityOf({ ...base, files: [base.files[1], base.files[0]] }), id)
  assert.equal(workspaceIdentityOf({ ...base, files: [...base.files, { path: '.graph-runs/x/run.json', sha256: HEX('9') }] }), id)
  assert.notEqual(workspaceIdentityOf({ ...base, head: 'h2' }), id)
  assert.notEqual(workspaceIdentityOf({ ...base, files: [{ path: 'a.mjs', sha256: HEX('3') }, base.files[1]] }), id)
  assert.notEqual(workspaceIdentityOf({ ...base, files: [...base.files, { path: 'c.mjs', sha256: HEX('4') }] }), id)
  assert.notEqual(workspaceIdentityOf({ ...base, files: [base.files[0]] }), id)
  assert.deepEqual(workspaceOf(base), { head: 'h1', identity: id })
})

test('artefato adulterado sem recalcular contentHash vira artifact_invalid', async t => {
  const repo = await makeRepo(t)
  const plan = approvedPlan(repo)
  assert.deepEqual(validateArtifact(plan, 'plan'), { ok: true })
  const tampered = { ...plan, content: { ...plan.content, goal: 'adulterado' } }
  const verdict = validateArtifact(tampered, 'plan')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'artifact_invalid')
  assert.equal((await reuseOf(repo, tampered)).rejected[0].reason, 'artifact_invalid')
})

test('artefato acima de 1 MiB canônico vira plan_artifact_too_large e não é gravado', async t => {
  const repo = await makeRepo(t)
  const big = approvedPlan(repo, { goal: 'x'.repeat(1024 * 1024 + 10) })
  assert.equal(validateArtifact(big, 'plan').reason, 'plan_artifact_too_large')
  await assert.rejects(writeSlot({ repo, kind: 'plan', artifact: big, expectedPrevContentHash: null }), /plan_artifact_too_large/)
  assert.deepEqual(await readSlot({ repo, kind: 'plan' }), { artifact: null, invalid: false, hash: null })
})

test('writeSlot publica atomicamente sem deixar .tmp nem lock e recusa artefato inválido sem tocar no slot', async t => {
  const repo = await makeRepo(t)
  const plan = approvedPlan(repo)
  assert.deepEqual(await writeSlot({ repo, kind: 'plan', artifact: plan, expectedPrevContentHash: null }), { published: true, contentHash: plan.contentHash })
  assert.deepEqual((await readSlot({ repo, kind: 'plan' })).artifact, plan)
  const dir = path.join(repo, '.graph-runs', 'artifacts')
  assert.deepEqual(await readdir(dir), ['plan.json'])
  const broken = { ...plan, content: { ...plan.content, goal: 'adulterado' } }
  await assert.rejects(writeSlot({ repo, kind: 'plan', artifact: broken, expectedPrevContentHash: plan.contentHash }), /artifact_invalid/)
  assert.deepEqual((await readSlot({ repo, kind: 'plan' })).artifact, plan)
  assert.deepEqual(await readdir(dir), ['plan.json'])
})

test('writeSlot recusa publicação quando outra run trocou o slot (compare-and-swap)', async t => {
  const repo = await makeRepo(t)
  const first = approvedPlan(repo, { goal: 'primeiro' })
  const second = approvedPlan(repo, { goal: 'segundo' })
  assert.equal((await writeSlot({ repo, kind: 'plan', artifact: first, expectedPrevContentHash: null })).published, true)
  assert.deepEqual(await writeSlot({ repo, kind: 'plan', artifact: second, expectedPrevContentHash: null }), { published: false, reason: 'artifact_slot_changed' })
  assert.equal((await readSlot({ repo, kind: 'plan' })).artifact.contentHash, first.contentHash)
  assert.equal((await writeSlot({ repo, kind: 'plan', artifact: second, expectedPrevContentHash: first.contentHash })).published, true)
})

test('lock de slot presente falha fechado, sem espera e sem remover o lock de outro dono', async t => {
  const repo = await makeRepo(t)
  const dir = path.join(repo, '.graph-runs', 'artifacts')
  await mkdir(dir, { recursive: true })
  const lock = path.join(dir, '.slot.lock')
  await writeFile(lock, '{"pid":1}\n')
  const result = await writeSlot({ repo, kind: 'plan', artifact: approvedPlan(repo), expectedPrevContentHash: null })
  assert.equal(result.published, false)
  assert.equal(result.reason, 'artifact_slot_locked')
  assert.match(result.detail, new RegExp(`${lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} com pid 1`))
  assert.equal(await readFile(lock, 'utf8'), '{"pid":1}\n')
  assert.deepEqual(await readdir(dir), ['.slot.lock'])
})

test('readSlot distingue slot ausente, artefato válido e slot inválido com hash dos bytes', async t => {
  const repo = await makeRepo(t)
  assert.deepEqual(await readSlot({ repo, kind: 'plan' }), { artifact: null, invalid: false, hash: null })
  const dir = path.join(repo, '.graph-runs', 'artifacts')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'plan.json'), '{nao-e-json')
  const broken = await readSlot({ repo, kind: 'plan' })
  assert.equal(broken.artifact, null)
  assert.equal(broken.invalid, true)
  assert.match(broken.hash, /^invalid:[a-f0-9]{64}$/)
  await writeFile(path.join(dir, 'plan.json'), '{"foo":1}')
  const notArtifact = await readSlot({ repo, kind: 'plan' })
  assert.equal(notArtifact.invalid, true)
  assert.match(notArtifact.hash, /^invalid:[a-f0-9]{64}$/)
  assert.notEqual(notArtifact.hash, broken.hash)
  const plan = approvedPlan(repo)
  await writeFile(path.join(dir, 'plan.json'), JSON.stringify(plan))
  const valid = await readSlot({ repo, kind: 'plan' })
  assert.equal(valid.invalid, false)
  assert.equal(valid.hash, plan.contentHash)
})

test('slot corrompido ou não-artefato só é sobrescrito por quem leu exatamente aqueles bytes', async t => {
  const repo = await makeRepo(t)
  const dir = path.join(repo, '.graph-runs', 'artifacts')
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, 'plan.json')
  await writeFile(target, '{"foo":1}\n')
  const seen = await readSlot({ repo, kind: 'plan' })
  const plan = approvedPlan(repo)
  assert.deepEqual(await writeSlot({ repo, kind: 'plan', artifact: plan, expectedPrevContentHash: null }), { published: false, reason: 'artifact_slot_changed' })
  assert.deepEqual(await writeSlot({ repo, kind: 'plan', artifact: plan, expectedPrevContentHash: `invalid:${'f'.repeat(64)}` }), { published: false, reason: 'artifact_slot_changed' })
  assert.equal(await readFile(target, 'utf8'), '{"foo":1}\n')
  await writeFile(target, '{"foo":1} \n')
  assert.deepEqual(await writeSlot({ repo, kind: 'plan', artifact: plan, expectedPrevContentHash: seen.hash }), { published: false, reason: 'artifact_slot_changed' })
  await writeFile(target, '{"foo":1}\n')
  assert.equal((await writeSlot({ repo, kind: 'plan', artifact: plan, expectedPrevContentHash: seen.hash })).published, true)
  assert.equal((await readSlot({ repo, kind: 'plan' })).hash, plan.contentHash)
})

test('resolveReuse aceita plano aprovado compatível e reporta cada motivo na ordem fixa', async t => {
  const repo = await makeRepo(t)
  const plan = approvedPlan(repo)
  const ok = (await reuseOf(repo, plan))
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.rejected, [])

  assert.equal((await reuseOf(repo, null, { slot: { artifact: null, invalid: true } })).rejected[0].reason, 'artifact_invalid')
  assert.equal((await reuseOf(repo, null, { slot: { artifact: null, invalid: false } })).rejected[0].reason, 'absent')

  const changedTask = (await reuseOf(repo, plan, { planningKey: planningKeyOf(inputsFor(repo, { task: 'outra' })) }))
  assert.equal(changedTask.rejected[0].reason, 'task_changed')

  assert.equal((await reuseOf(repo, plan, { run: fakeRun(repo, plan, { partial: true }) })).rejected[0].reason, 'source_unverified')

  const moved = (await reuseOf(repo, plan, { workspace: { head: 'h2', identity: workspaceIdentityOf({ head: 'h2', files: SNAP.files }) } }))
  assert.equal(moved.rejected[0].reason, 'workspace_changed')

  const pending = needsClarification(repo)
  assert.equal((await reuseOf(repo, pending)).rejected[0].reason, 'not_approved:needs_clarification')

  const tombstone = rejectedPlan(repo)
  assert.equal((await reuseOf(repo, tombstone)).rejected[0].reason, 'not_approved:rejected')

  // Ordem fixa: tarefa divergente vence workspace divergente quando ambos falham.
  const both = (await reuseOf(repo, plan, {
    planningKey: planningKeyOf(inputsFor(repo, { task: 'outra' })),
    workspace: { head: 'h2', identity: workspaceIdentityOf({ head: 'h2', files: SNAP.files }) },
  }))
  assert.deepEqual(both.rejected.map(item => item.reason), ['task_changed'])
})

test('conteúdo alterado com contentHash recalculado vira source_unverified, porque o journal guarda o hash antigo', async t => {
  const repo = await makeRepo(t)
  const plan = approvedPlan(repo)
  const recomputed = sealArtifact({ ...plan, content: { ...plan.content, goal: 'atacante' } })
  assert.equal(validateArtifact(recomputed, 'plan').ok, true)
  const verdict = (await reuseOf(repo, recomputed, { run: fakeRun(repo, plan) }))
  assert.equal(verdict.rejected[0].reason, 'source_unverified')
  assert.equal(verdict.rejected[0].detail, 'content_hash_mismatch')
})

test('verifySource rejeita journal parcial, seq ausente, estágio de outro tipo e meta de outro host, repo ou formato', async t => {
  const repo = await makeRepo(t)
  const plan = approvedPlan(repo)
  const good = fakeRun(repo, plan)
  assert.deepEqual(await verifySource({ repo, artifact: plan, ...good }), { ok: true })
  const cases = {
    journal_partial: fakeRun(repo, plan, { partial: true }),
    seq_missing: fakeRun(repo, plan, { events: [] }),
    event_not_transition: fakeRun(repo, plan, { events: [{ seq: 4, runId: RUN_ID, type: 'tool.call', payload: {} }] }),
    stage_mismatch: fakeRun(repo, plan, { events: [{ seq: 4, runId: RUN_ID, type: 'control.transition', payload: { stage: 'tasks-approved', contentHash: plan.contentHash } }] }),
    content_hash_mismatch: fakeRun(repo, plan, { events: [{ seq: 4, runId: RUN_ID, type: 'control.transition', payload: { stage: 'plan-artifact-approved', contentHash: HEX('e') } }] }),
    meta_host_mismatch: fakeRun(repo, plan, { meta: { schemaVersion: 2, runId: RUN_ID, host: 'codex', cwd: repo } }),
    meta_cwd_mismatch: fakeRun(repo, plan, { meta: { schemaVersion: 2, runId: RUN_ID, host: 'claude', cwd: '/outro/repo' } }),
    meta_not_v2: fakeRun(repo, plan, { meta: { schemaVersion: 1, runId: RUN_ID, host: 'claude', cwd: repo } }),
  }
  for (const [detail, run] of Object.entries(cases)) {
    const verdict = await verifySource({ repo, artifact: plan, ...run })
    assert.equal(verdict.ok, false, detail)
    assert.equal(verdict.reason, 'source_unverified', detail)
    assert.equal(verdict.detail, detail)
  }
})

test('tasks antigo é rejeitado com tasks_plan_mismatch quando o plano foi substituído ou virou tombstone', async t => {
  const repo = await makeRepo(t)
  const plan = approvedPlan(repo)
  const tasks = approvedTasks(plan)
  assert.equal(validateArtifact(tasks, 'tasks').ok, true)
  assert.equal((await reuseOf(repo, tasks, { kind: 'tasks', planArtifact: plan, run: fakeRun(repo, tasks) })).ok, true)
  const newer = approvedPlan(repo, { goal: 'novo' })
  assert.equal((await reuseOf(repo, tasks, { kind: 'tasks', planArtifact: newer, run: fakeRun(repo, tasks) })).rejected[0].reason, 'tasks_plan_mismatch')
  assert.equal((await reuseOf(repo, tasks, { kind: 'tasks', planArtifact: rejectedPlan(repo), run: fakeRun(repo, tasks) })).rejected[0].reason, 'tasks_plan_mismatch')
  assert.equal((await reuseOf(repo, tasks, { kind: 'tasks', planArtifact: undefined, run: fakeRun(repo, tasks) })).rejected[0].reason, 'tasks_plan_mismatch')
})

async function orphanLock(repo, { pid = 4242, processStartIdentity = 'start-A', token = 'tok-velho' } = {}) {
  const dir = path.join(repo, '.graph-runs', 'artifacts')
  await mkdir(dir, { recursive: true })
  const lock = path.join(dir, '.slot.lock')
  const { localHostIdentity } = await import('../bin/process-identity.mjs')
  await writeFile(lock, `${JSON.stringify({ schemaVersion: 1, pid, host: localHostIdentity(), processStartIdentity, token, startedAt: '2026-10-19T00:00:00.000Z' })}\n`)
  return { dir, lock }
}

test('lock órfão de processo morto é recuperado uma vez e o slot é publicado (quarentena em .stale-)', async t => {
  const repo = await makeRepo(t)
  const { dir, lock } = await orphanLock(repo)
  const plan = approvedPlan(repo)
  const result = await writeSlot({ repo, kind: 'plan', artifact: plan, expectedPrevContentHash: null, processIdentity: async () => 'start-B', lookupProcessIdentity: async () => ({ status: 'dead' }) })
  assert.deepEqual(result, { published: true, contentHash: plan.contentHash })
  assert.equal((await readSlot({ repo, kind: 'plan' })).artifact.contentHash, plan.contentHash)
  const names = await readdir(dir)
  assert.ok(names.some(name => name.startsWith('.slot.lock.stale-')), `quarentena ausente: ${names.join(',')}`)
  await assert.rejects(readFile(lock, 'utf8'), { code: 'ENOENT' })
})

test('pid reutilizado com identidade de início diferente é lock órfão e não bloqueia a publicação', async t => {
  const repo = await makeRepo(t)
  await orphanLock(repo, { processStartIdentity: 'start-A' })
  const plan = approvedPlan(repo)
  const result = await writeSlot({ repo, kind: 'plan', artifact: plan, expectedPrevContentHash: null, processIdentity: async () => 'start-B', lookupProcessIdentity: async () => ({ status: 'alive', startIdentity: 'start-OUTRO' }) })
  assert.equal(result.published, true)
})

test('dono vivo com a mesma identidade de início falha fechado, sem espera e sem recuperar o lock', async t => {
  const repo = await makeRepo(t)
  const { dir, lock } = await orphanLock(repo, { processStartIdentity: 'start-A' })
  const result = await writeSlot({ repo, kind: 'plan', artifact: approvedPlan(repo), expectedPrevContentHash: null, processIdentity: async () => 'start-B', lookupProcessIdentity: async () => ({ status: 'alive', startIdentity: 'start-A' }) })
  assert.equal(result.published, false)
  assert.equal(result.reason, 'artifact_slot_locked')
  assert.ok((await readFile(lock, 'utf8')).includes('tok-velho'))
  assert.deepEqual((await readdir(dir)).filter(name => name.includes('stale')), [])
})

test('lookup desconhecido preserva o lock e falha fechado', async t => {
  const repo = await makeRepo(t)
  const { lock } = await orphanLock(repo)
  const result = await writeSlot({ repo, kind: 'plan', artifact: approvedPlan(repo), expectedPrevContentHash: null, processIdentity: async () => 'start-B', lookupProcessIdentity: async () => ({ status: 'unknown', reason: 'sem ps' }) })
  assert.equal(result.reason, 'artifact_slot_locked')
  assert.ok((await readFile(lock, 'utf8')).includes('tok-velho'))
})
