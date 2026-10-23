import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHost } from '../bin/hosts.mjs'
import { workspaceResourceOf } from '../bin/resource-lock.mjs'
import * as bench from '../bin/graph-benchmark.mjs'
import {
  FIXTURE_DIR, BASELINE, V1_LABEL_MAP,
  sha256, hashTree, diffTrees, grantPrefixes, auditWrites, extractBaseline, prepareWorkspace,
  applyFixtureReference, applyContractChange, policyFor, createAgentBridge, runV1, runAdaptive,
  runAcceptance, evaluateExternal, summarizeCalls, buildManifest, verifyManifest, runVariant,
  buildReport, renderReport, stripTiming, parseBenchmarkArgs,
} from '../bin/graph-benchmark.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
const created = []
const keepAlives = new Set()
// Estado do graph-eng isolado por processo de teste: nunca escreve em ~/.claude.
const STATE_ROOT = await mkdtemp(path.join(os.tmpdir(), 'graph-eng-bench-state-'))
const previousStateDir = process.env.GRAPH_ENG_STATE_DIR
process.env.GRAPH_ENG_STATE_DIR = STATE_ROOT

// Fora do repo: num worktree em .claude/worktrees/ o caminho herdaria o segmento .claude e a guarda CWD_PROTECTED_PATH recusaria a escrita.
async function tempDir(name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `graph-eng-bench-${name}-`))
  created.push(dir)
  return dir
}
after(async () => {
  for (const id of keepAlives) clearInterval(id)
  keepAlives.clear()
  for (const dir of created) await rm(dir, { recursive: true, force: true })
  if (previousStateDir === undefined) delete process.env.GRAPH_ENG_STATE_DIR
  else process.env.GRAPH_ENG_STATE_DIR = previousStateDir
  await rm(STATE_ROOT, { recursive: true, force: true })
})

// Transporte fake: nunca chama CLI real. Escreve a saída que o CLI escreveria e fecha o processo.
function fakeTransport({ mode = 'ok', writes = () => ({}), output = () => ({ ok: true }), modelUsage = () => ({}) } = {}) {
  const spawns = []
  const children = new Map()
  let inflight = 0
  let maxInflight = 0
  let killed = 0
  const spawn = (command, args, opts) => {
    if (mode === 'enoent') { const error = new Error(`spawn ${command} ENOENT`); error.code = 'ENOENT'; throw error }
    const record = { command, args, cwd: opts.cwd, prompt: null, index: spawns.length, simulated: true }
    spawns.push(record)
    const child = new EventEmitter()
    child.pid = 50000 + record.index
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const chunks = []
    child.stdin = new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb() } })
    children.set(child.pid, child)
    inflight++
    maxInflight = Math.max(maxInflight, inflight)
    // Processo real mantém o event loop vivo; o fake precisa disso porque o timer de timeout é unref.
    const keepAlive = setInterval(() => {}, 1000)
    keepAlives.add(keepAlive)
    child.once('close', () => { inflight--; clearInterval(keepAlive); keepAlives.delete(keepAlive) })
    child.stdin.on('finish', () => { record.prompt = chunks.join(''); void behave(child, record) })
    return child
  }
  async function behave(child, record) {
    if (mode === 'hang') return
    for (const [rel, content] of Object.entries(writes(record))) {
      await mkdir(path.dirname(path.join(record.cwd, rel)), { recursive: true })
      await writeFile(path.join(record.cwd, rel), content)
    }
    if (mode === 'fail') { child.stderr.end('fatal'); child.stdout.end(); setImmediate(() => child.emit('close', 1, null)); return }
    if (record.command === 'codex') {
      const at = record.args.indexOf('--output-last-message')
      await writeFile(record.args[at + 1], JSON.stringify(output(record)))
      child.stdout.end(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 0 } }) + '\n')
    } else {
      child.stdout.end(JSON.stringify({ is_error: false, structured_output: output(record), modelUsage: modelUsage(record) }))
    }
    child.stderr.end()
    setImmediate(() => child.emit('close', 0, null))
  }
  const killProcess = (pid, signal) => { killed++; children.get(Math.abs(pid))?.emit('close', null, signal) }
  return { spawn, spawns, killProcess, get maxInflight() { return maxInflight }, get killed() { return killed } }
}

async function workspaceCopy(name) {
  const dir = await tempDir(name)
  const ws = path.join(dir, 'ws')
  await prepareWorkspace({ fixtureDir: FIXTURE_DIR, destDir: ws })
  return { dir, ws }
}

// Cabeçalho que o próprio motor v1 põe no prompt de cada nó (workflows/graph-eng.js).
const header = (id, kind) => `## Your node: ${id} - Título ${id} [${kind}, risk low]\n`

test('fixture: aceites reprovam o workspace inicial e aprovam a referência', async () => {
  const { ws } = await workspaceCopy('fixture')
  const acceptanceDir = path.join(FIXTURE_DIR, 'acceptance')
  const initial = await runAcceptance({ workspaceDir: ws, acceptanceDir })
  assert.notEqual(initial.exitCode, 0, 'aceite não pode passar no estado inicial')
  await applyFixtureReference({ fixtureDir: FIXTURE_DIR, workspaceDir: ws })
  const reference = await runAcceptance({ workspaceDir: ws, acceptanceDir })
  assert.equal(reference.exitCode, 0, 'referência precisa passar todos os aceites')
})

test('hash de árvore é estável, muda com 1 byte e diff aponta adição, remoção e alteração', async () => {
  const { ws } = await workspaceCopy('hash')
  const first = await hashTree(ws)
  assert.deepEqual(first, await hashTree(ws))
  assert.match(first['src/a.mjs'], /^[0-9a-f]{64}$/)
  const before = { ...first }
  await writeFile(path.join(ws, 'src', 'a.mjs'), (await readFile(path.join(ws, 'src', 'a.mjs'), 'utf8')).replace('texto', 'texto '))
  await writeFile(path.join(ws, 'src', 'novo.mjs'), 'export {}\n')
  await rm(path.join(ws, 'src', 'b.mjs'))
  const after2 = await hashTree(ws)
  assert.notEqual(after2['src/a.mjs'], before['src/a.mjs'])
  assert.deepEqual(diffTrees(before, after2), ['src/a.mjs', 'src/b.mjs', 'src/novo.mjs'])
  assert.equal(sha256('abc'), sha256(Buffer.from('abc')))
})

test('grants de escrita: product cobre src/ e .benchmark-run/, artifacts só .benchmark-run/, none nada; fora do grant bloqueia', () => {
  assert.deepEqual(grantPrefixes('product'), ['src/', '.benchmark-run/'])
  assert.deepEqual(grantPrefixes('artifacts'), ['.benchmark-run/'])
  assert.deepEqual(grantPrefixes('none'), [])
  assert.deepEqual(auditWrites(['src/a.mjs', '.benchmark-run/v1/plan.md'], 'product'), [])
  assert.deepEqual(auditWrites(['src/a.mjs', 'package.json'], 'product'), ['package.json'])
  assert.deepEqual(auditWrites(['src/a.mjs'], 'artifacts'), ['src/a.mjs'])
  assert.deepEqual(auditWrites([], 'none'), [])
})

test('baseline extraído por git show confere o SHA-256 fixado e só usa leitura', async () => {
  const dir = await tempDir('baseline')
  const calls = []
  const spoof = async args => { calls.push(args); return Buffer.from('bytes diferentes') }
  await assert.rejects(extractBaseline({ repoRoot: ROOT, destDir: dir, execGit: spoof }), { code: 'baseline_hash_mismatch' })
  assert.deepEqual(calls.map(args => args[0]), ['show'], 'só git show é permitido, sem checkout nem reset')
  const real = await extractBaseline({ repoRoot: ROOT, destDir: dir })
  assert.equal(real.commit, BASELINE.commit)
  assert.equal(real.bytes, 77172)
  assert.equal(real.sha256, BASELINE.sha256)
})

test('política experimental aceita só o mapa fechado por papel e preserva o caminho de produto', async () => {
  const runDir = await tempDir('policy')
  const fake = fakeTransport()
  const policy = policyFor('codex')
  assert.equal(policy.models.planner, 'gpt-6.1-sol')
  assert.equal(policy.models.executor, 'gpt-6-luna')
  assert.equal(policy.readOnly.planner, false)
  assert.equal(policy.readOnly.planReviewer, true)
  const experimental = createHost({ host: 'codex', cwd: runDir, runDir, transport: { spawn: fake.spawn }, experimentalPolicy: policy })
  const handle = await experimental.spawn({ role: 'planner', prompt: 'planejar', schema: SCHEMA })
  await experimental.wait(handle)
  assert.equal(fake.spawns[0].args[fake.spawns[0].args.indexOf('--model') + 1], 'gpt-6.1-sol')
  assert.equal(fake.spawns[0].args[fake.spawns[0].args.indexOf('-s') + 1], 'workspace-write')
  await assert.rejects(experimental.spawn({ role: 'designer', prompt: 'x', schema: SCHEMA }), { code: 'EXPERIMENT_ROLE_UNMAPPED' })
  await assert.rejects(experimental.spawn({ role: 'planner', prompt: 'x', schema: SCHEMA, model: 'gpt-6-luna' }), { code: 'MODEL_MISMATCH' })
  const product = createHost({ host: 'codex', cwd: runDir, runDir, transport: { spawn: fakeTransport().spawn } })
  await assert.rejects(product.spawn({ role: 'planner', prompt: 'x', schema: SCHEMA, model: 'gpt-6-luna' }), { code: 'MODEL_MISMATCH' })
  const productRo = await product.spawn({ role: 'planner', prompt: 'x', schema: SCHEMA })
  await product.wait(productRo)
  assert.equal(productRo.built.readonly, true, 'produto mantém planner read-only')
})

test('label fora do mapa bloqueia antes de qualquer spawn; sourceModel ausente vira session', async () => {
  const runDir = await tempDir('label')
  const fake = fakeTransport()
  const host = createHost({ host: 'codex', cwd: runDir, runDir, transport: { spawn: fake.spawn }, experimentalPolicy: policyFor('codex') })
  const bridge = createAgentBridge({ hostApi: host, workspaceDir: runDir, maxCalls: 5 })
  await assert.rejects(bridge.agent('x', { label: 'misterio:1', schema: SCHEMA }), { code: 'label_unmapped' })
  assert.equal(fake.spawns.length, 0, 'nenhum spawn para label desconhecido')
  assert.equal(bridge.summary().block.code, 'label_unmapped')
  await bridge.close()
  const ok = createAgentBridge({ hostApi: createHost({ host: 'codex', cwd: runDir, runDir, transport: { spawn: fakeTransport().spawn }, experimentalPolicy: policyFor('codex') }), workspaceDir: runDir, maxCalls: 5 })
  await ok.agent('x', { label: 'critic:r1', schema: SCHEMA })
  assert.equal(ok.summary().calls[0].sourceModel, 'session')
  assert.equal(V1_LABEL_MAP.judge.transportRole, 'planReviewer')
  await ok.close()
})

test('B3: a bridge grava permissionDenials do Claude no registro da chamada (calls.jsonl)', async () => {
  const dir = await tempDir('bridge-denials')
  const hostApi = {
    spawn: async () => ({ built: { model: 'opus' } }),
    wait: async () => ({ output: { ok: true }, usage: null, effectiveModel: 'opus', exitCode: 0, permissionDenials: [{ tool_name: 'Write' }] }),
    cancel: () => true,
  }
  const bridge = createAgentBridge({ hostApi, workspaceDir: dir, maxCalls: 5 })
  await bridge.agent('p1', { label: 'critic:r1', schema: SCHEMA })
  const [call] = bridge.summary().calls
  assert.deepEqual(call.permissionDenials, [{ tool_name: 'Write' }])
  await bridge.close()
})

test('bridge v1 roda agentes em série, devolve só o output e rejeita spawns depois de abortar', async () => {
  const dir = await tempDir('bridge')
  const fake = fakeTransport({ output: () => ({ ok: true }) })
  const host = createHost({ host: 'codex', cwd: dir, runDir: dir, transport: { spawn: fake.spawn }, experimentalPolicy: policyFor('codex') })
  const bridge = createAgentBridge({ hostApi: host, workspaceDir: dir, maxCalls: 10 })
  const results = await bridge.parallel([
    () => bridge.agent('p1', { label: 'critic:r1', schema: SCHEMA }),
    () => bridge.agent('p2', { label: 'design-review:r1', schema: SCHEMA }),
  ])
  assert.deepEqual(results, [{ ok: true }, { ok: true }])
  assert.equal(fake.maxInflight, 1, 'chamadas são serializadas: nunca duas ao mesmo tempo')
  assert.equal(bridge.summary().maxConcurrent, 1)
  await bridge.close()
  await assert.rejects(bridge.agent('depois', { label: 'critic:r2', schema: SCHEMA }), { code: 'bridge_aborted' })
  assert.equal(fake.spawns.length, 2, 'depois de fechar, nenhum spawn novo')
})

test('erro de transporte é lançado, registrado como BLOCK e interrompe novos spawns', async () => {
  const dir = await tempDir('transport-error')
  const fake = fakeTransport({ mode: 'enoent' })
  const host = createHost({ host: 'codex', cwd: dir, runDir: dir, transport: { spawn: fake.spawn }, experimentalPolicy: policyFor('codex') })
  const bridge = createAgentBridge({ hostApi: host, workspaceDir: dir, maxCalls: 10 })
  await assert.rejects(bridge.agent('p', { label: 'critic:r1', schema: SCHEMA }), { code: 'CLI_MISSING' })
  await assert.rejects(bridge.agent('p', { label: 'critic:r2', schema: SCHEMA }), { code: 'bridge_aborted' })
  const summary = bridge.summary()
  assert.equal(summary.blocked, true)
  assert.equal(summary.block.code, 'CLI_MISSING')
  assert.equal(summary.calls.length, 1)
  assert.equal(summary.calls[0].status, 'failed')
  await bridge.close()
})

test('timeout conserva incompletude, cancela e aguarda o handle no close', async () => {
  const dir = await tempDir('timeout')
  const fake = fakeTransport({ mode: 'hang' })
  const host = createHost({ host: 'codex', cwd: dir, runDir: dir, transport: { spawn: fake.spawn }, killProcess: fake.killProcess, experimentalPolicy: policyFor('codex') })
  const bridge = createAgentBridge({ hostApi: host, workspaceDir: dir, maxCalls: 10 })
  await assert.rejects(bridge.agent('p', { label: 'critic:r1', schema: SCHEMA, timeoutMs: 50 }), { code: 'TIMEOUT' })
  assert.equal(bridge.summary().complete, false)
  await bridge.close()
  assert.equal(fake.spawns.length, 1)
})

test('close cancela chamada em voo, aguarda a liquidação e não deixa handle pendente', { timeout: 5000 }, async () => {
  const dir = await tempDir('cancel')
  const fake = fakeTransport({ mode: 'hang' })
  const host = createHost({ host: 'codex', cwd: dir, runDir: dir, transport: { spawn: fake.spawn }, killProcess: fake.killProcess, experimentalPolicy: policyFor('codex') })
  const bridge = createAgentBridge({ hostApi: host, workspaceDir: dir, maxCalls: 10 })
  const inflightCall = bridge.agent('p', { label: 'critic:r1', schema: SCHEMA }).catch(error => error)
  for (let i = 0; i < 100 && fake.spawns.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(fake.spawns.length, 1, 'a chamada precisa estar em voo antes do close')
  await bridge.close()
  const outcome = await inflightCall
  assert.equal(outcome.code, 'CANCELLED')
  assert.equal(fake.killed, 1, 'o encerramento foi enviado ao grupo do handle em voo')
  assert.equal(bridge.summary().calls[0].status, 'failed')
})

test('auditoria de escrita: escrita de artefato por nó de design fora do grant bloqueia; implement em src/ passa', async () => {
  const dir = await tempDir('grant')
  const fake = fakeTransport({
    writes: record => (record.prompt.includes('DESENHO') ? { 'src/c.mjs': 'export const y = 2\n' } : record.prompt.includes('IMPLEMENTA') ? { 'src/b.mjs': 'export const x = 1\n' } : {}),
  })
  const host = createHost({ host: 'codex', cwd: dir, runDir: dir, transport: { spawn: fake.spawn }, experimentalPolicy: policyFor('codex') })
  const bridge = createAgentBridge({ hostApi: host, workspaceDir: dir, maxCalls: 10 })
  await bridge.agent(header('I1', 'implement') + 'IMPLEMENTA', { label: 'work:I1', schema: SCHEMA })
  assert.equal(bridge.summary().blocked, false, 'implement pode escrever src/')
  await assert.rejects(bridge.agent(header('D1', 'design') + 'DESENHO', { label: 'work:D1', schema: SCHEMA }), { code: 'grant_violation' })
  assert.equal(bridge.summary().block.code, 'grant_violation')
  assert.deepEqual(bridge.summary().block.paths, ['src/c.mjs'])
  await bridge.close()
})

test('grant sai do cabeçalho "## Your node" do prompt: gap e research-base passam; design em src/ bloqueia; sem cabeçalho bloqueia', async () => {
  const dir = await tempDir('grant-kind')
  const fake = fakeTransport({
    writes: record => (record.prompt.includes('GRAVA-SRC')
      ? { 'src/b.mjs': `export const x = ${record.index}\n`, '.benchmark-run/v1/gap.md': `gap ${record.index}\n` }
      : record.prompt.includes('GRAVA-ART') ? { '.benchmark-run/v1/x.md': `artefato ${record.index}\n` } : {}),
  })
  const newBridge = () => createAgentBridge({ hostApi: createHost({ host: 'codex', cwd: dir, runDir: dir, transport: { spawn: fake.spawn }, experimentalPolicy: policyFor('codex') }), workspaceDir: dir, maxCalls: 10 })
  const ok = newBridge()
  await ok.agent(header('r2-x', 'implement') + 'GRAVA-SRC', { label: 'work:r2-x', schema: SCHEMA })
  await ok.agent(header('research-base', 'research') + 'GRAVA-ART', { label: 'work:research-base', schema: SCHEMA })
  assert.equal(ok.summary().blocked, false)
  assert.deepEqual(ok.summary().calls.map(call => call.grant), ['product', 'artifacts'])
  await ok.close()
  const spawnsBefore = fake.spawns.length
  const design = newBridge()
  await assert.rejects(design.agent(header('D1', 'design') + 'GRAVA-SRC', { label: 'work:D1', schema: SCHEMA }), { code: 'grant_violation' })
  assert.deepEqual(design.summary().block.paths, ['src/b.mjs'])
  await design.close()
  const semCabecalho = newBridge()
  await assert.rejects(semCabecalho.agent('sem cabeçalho GRAVA-ART', { label: 'work:X1', schema: SCHEMA }), { code: 'node_kind_missing' })
  assert.equal(fake.spawns.length, spawnsBefore + 1, 'sem cabeçalho não há spawn; só o de design, que foi auditado')
  await semCabecalho.close()
})

test('limite operacional de chamadas gera BLOCK antes do spawn excedente', async () => {
  const dir = await tempDir('cap')
  const fake = fakeTransport()
  const host = createHost({ host: 'codex', cwd: dir, runDir: dir, transport: { spawn: fake.spawn }, experimentalPolicy: policyFor('codex') })
  const bridge = createAgentBridge({ hostApi: host, workspaceDir: dir, maxCalls: 2 })
  await bridge.agent('1', { label: 'critic:r1', schema: SCHEMA })
  await bridge.agent('2', { label: 'critic:r2', schema: SCHEMA })
  await assert.rejects(bridge.agent('3', { label: 'critic:r3', schema: SCHEMA }), { code: 'operational_cap' })
  await assert.rejects(bridge.agent('4', { label: 'critic:r4', schema: SCHEMA }), { code: 'bridge_aborted' })
  assert.equal(bridge.summary().block.code, 'operational_cap')
  assert.equal(fake.spawns.length, 2)
  await bridge.close()
})

test('motor v1 real: CLI ausente vira BLOCK mesmo que o motor devolva uma resposta própria', async () => {
  const dir = await tempDir('v1-real')
  const baseline = await extractBaseline({ repoRoot: ROOT, destDir: dir })
  const workspace = path.join(dir, 'ws')
  await prepareWorkspace({ fixtureDir: FIXTURE_DIR, destDir: workspace })
  const fake = fakeTransport({ mode: 'enoent' })
  const host = createHost({ host: 'codex', cwd: workspace, runDir: workspace, transport: { spawn: fake.spawn }, experimentalPolicy: policyFor('codex') })
  const run = await runV1({ sourcePath: baseline.path, workspaceDir: workspace, hostApi: host, task: 'Implemente a fixture', maxCalls: 20, simulated: true })
  assert.equal(run.block?.code, 'CLI_MISSING')
  assert.equal(run.complete, false)
  assert.equal(run.simulated, true)
  assert.ok(fake.spawns.length <= 1, 'depois do erro não há novos spawns')
})

test('adaptativo: implemente recebe o task.md byte a byte, effort medium e os checks do package.json', async () => {
  const dir = await tempDir('adaptive')
  const { ws } = await workspaceCopy('adaptive-ws')
  let captured = null
  const result = await runAdaptive({
    workspaceDir: ws,
    host: 'codex',
    runGraphImpl: async opts => { captured = opts; return { status: 'done', runId: 'x' } },
  })
  assert.equal(result.reportedStatus, 'DONE')
  assert.equal(captured.cwd, ws)
  assert.equal(captured.args.task, await readFile(path.join(FIXTURE_DIR, 'workspace', 'task.md'), 'utf8'), 'a tarefa do implemente é o task.md, sem alterar bytes')
  assert.equal(captured.args.effort, 'medium')
  assert.equal(captured.args.mode, 'implement')
  assert.equal(captured.args.checks.length, 1)
  assert.equal(captured.args.checks[0].id, 'node-test')
  assert.deepEqual(captured.args.checks[0].args, ['--test', '--test-concurrency=2'])
  assert.equal(captured.args.checkContract.source, 'scripts.test=node --test', 'contrato vem do package.json copiado')
  assert.ok(dir)
})

test('métricas do adaptativo: o hostFactory conta papel, requested e usage de cada chamada', async () => {
  const { ws } = await workspaceCopy('metrics')
  const fake = fakeTransport({ output: () => ({ ok: true }) })
  const result = await runAdaptive({
    workspaceDir: ws,
    host: 'codex',
    transportFactory: () => fake,
    runGraphImpl: async ({ hostFactory }) => {
      const host = hostFactory({ host: 'codex', cwd: ws, runDir: ws, runId: 'metricas' })
      for (const role of ['planner', 'executor']) await host.wait(await host.spawn({ role, prompt: `p-${role}`, schema: SCHEMA }))
      return { status: 'done' }
    },
  })
  assert.equal(result.reportedStatus, 'DONE')
  assert.equal(result.spawnAttempts, 2)
  assert.deepEqual(result.calls.map(call => call.role), ['planner', 'executor'])
  assert.ok(result.calls.every(call => call.status === 'completed'))
  assert.equal(typeof result.calls[0].requestedModel, 'string')
  assert.ok(result.calls[0].usage, 'usage do transporte fica registrado')
  assert.equal(result.block, null)
})

test('regressão: chamada que falha registra subtype, usage e modelo que vieram no erro do host', async () => {
  const tracker = bench.createCallTracker({ maxCalls: 5 })
  const usage = { 'claude-haiku-5-5': { inputTokens: 4, outputTokens: 9 } }
  const failure = Object.assign(new Error('claude: Claude retornou erro (error_during_execution)'), { code: 'CLI_FAILED', subtype: 'error_during_execution', usage, effectiveModel: 'claude-haiku-5-5', permissionDenials: [] })
  const host = tracker.wrap({ spawn: async () => ({ built: { model: 'haiku' } }), wait: async () => { throw failure }, cancel: () => true })
  await assert.rejects(host.wait(await host.spawn({ role: 'executor', prompt: 'x', schema: SCHEMA })), { code: 'CLI_FAILED' })
  const call = tracker.calls[0]
  assert.equal(call.status, 'failed')
  assert.equal(call.errorCode, 'CLI_FAILED')
  assert.equal(call.errorSubtype, 'error_during_execution')
  assert.match(call.errorMessage, /error_during_execution/)
  assert.deepEqual(call.usage, usage)
  assert.equal(call.effectiveModel, 'claude-haiku-5-5')
})

test('falha ao registrar métrica não derruba a chamada: o resultado volta e a falha fica em metricErrors', async () => {
  const tracker = bench.createCallTracker({ maxCalls: 5 })
  const host = tracker.wrap({
    spawn: async () => ({ built: { model: 'm' } }),
    wait: async () => ({ output: { ok: true }, get usage() { throw new Error('usage quebrado') } }),
    cancel: () => true,
  })
  const handle = await host.spawn({ role: 'critic', prompt: 'x', schema: SCHEMA })
  const result = await host.wait(handle)
  assert.deepEqual(result.output, { ok: true })
  assert.equal(tracker.calls[0].status, 'completed')
  assert.equal(tracker.metricErrors.length, 1)
  assert.equal(tracker.metricErrors[0].message, 'usage quebrado')
})

test('exceção do motor no adaptativo volta como exception, sem lançar, com as chamadas registradas', async () => {
  const { ws } = await workspaceCopy('adaptive-throw')
  const result = await runAdaptive({ workspaceDir: ws, host: 'codex', runGraphImpl: async () => { throw new Error('motor quebrou') } })
  assert.equal(result.exception.message, 'motor quebrou')
  assert.equal(result.reportedStatus, null)
  assert.deepEqual(result.calls, [])
})

test('cap de chamadas no adaptativo: a chamada excedente vira BLOCK operational_cap antes do spawn', async () => {
  const { ws } = await workspaceCopy('adaptive-cap')
  const fake = fakeTransport()
  const result = await runAdaptive({
    workspaceDir: ws,
    host: 'codex',
    transportFactory: () => fake,
    maxCalls: 1,
    runGraphImpl: async ({ hostFactory }) => {
      const host = hostFactory({ host: 'codex', cwd: ws, runDir: ws, runId: 'cap' })
      await host.wait(await host.spawn({ role: 'planner', prompt: 'a', schema: SCHEMA }))
      await assert.rejects(host.spawn({ role: 'planner', prompt: 'b', schema: SCHEMA }), { code: 'operational_cap' })
      return { status: 'done' }
    },
  })
  assert.equal(result.block.code, 'operational_cap')
  assert.equal(fake.spawns.length, 1, 'excedente não chega a spawn')
})

test('teto de relógio: engine que não termina vira BLOCK wall_cap, cancela o handle em voo e não deixa pendência', { timeout: 10000 }, async () => {
  const { ws } = await workspaceCopy('adaptive-wall')
  const fake = fakeTransport({ mode: 'hang' })
  const result = await runAdaptive({
    workspaceDir: ws,
    host: 'codex',
    transportFactory: () => fake,
    maxWallMs: 100,
    runGraphImpl: async ({ hostFactory }) => {
      const host = hostFactory({ host: 'codex', cwd: ws, runDir: ws, runId: 'wall' })
      void host.spawn({ role: 'planner', prompt: 'nunca termina', schema: SCHEMA })
      return new Promise(() => {})
    },
  })
  assert.equal(result.block.code, 'wall_cap')
  assert.ok(fake.killed >= 1, 'handle em voo foi cancelado')
  assert.equal(result.inflight, 0, 'nenhum handle pendente depois do BLOCK')
})

test('avaliador externo: DONE falso com aceite FAIL vira falseDone; referência PASS; aceite adulterado é recusado', async () => {
  const { dir, ws } = await workspaceCopy('eval')
  const acceptanceDir = path.join(FIXTURE_DIR, 'acceptance')
  const expected = await hashTree(acceptanceDir)
  const falseDone = await evaluateExternal({ workspaceDir: ws, acceptanceDir, expectedAcceptanceHashes: expected, reportedStatus: 'DONE' })
  assert.equal(falseDone.externalStatus, 'FAIL')
  assert.equal(falseDone.falseDone, true)
  assert.ok(falseDone.durationMs >= 0)
  const partial = await evaluateExternal({ workspaceDir: ws, acceptanceDir, expectedAcceptanceHashes: expected, reportedStatus: 'PARTIAL' })
  assert.equal(partial.falseDone, false)
  await applyFixtureReference({ fixtureDir: FIXTURE_DIR, workspaceDir: ws })
  const pass = await evaluateExternal({ workspaceDir: ws, acceptanceDir, expectedAcceptanceHashes: expected, reportedStatus: 'DONE' })
  assert.equal(pass.externalStatus, 'PASS')
  assert.equal(pass.falseDone, false)
  const tampered = path.join(dir, 'acceptance-tampered')
  await cp(acceptanceDir, tampered, { recursive: true })
  await writeFile(path.join(tampered, 'a.acceptance.mjs.txt'), 'test("trivial", () => {})\n')
  await assert.rejects(evaluateExternal({ workspaceDir: ws, acceptanceDir: tampered, expectedAcceptanceHashes: expected, reportedStatus: 'DONE' }), { code: 'acceptance_tampered' })
})

test('avaliador exige # fail 0 e # pass igual ao esperado: exit 0 sem contagem reprova, contagem errada reprova', async () => {
  const { dir, ws } = await workspaceCopy('eval-tap')
  await applyFixtureReference({ fixtureDir: FIXTURE_DIR, workspaceDir: ws })
  const acceptanceDir = path.join(FIXTURE_DIR, 'acceptance')
  const expected = await hashTree(acceptanceDir)
  const wrongCount = await evaluateExternal({ workspaceDir: ws, acceptanceDir, expectedAcceptanceHashes: expected, expectedPass: 999, reportedStatus: 'DONE' })
  assert.equal(wrongCount.externalStatus, 'FAIL', 'referência que passa mas com contagem diferente do manifesto reprova')
  const exitDir = path.join(dir, 'acceptance-exit')
  await mkdir(exitDir)
  await writeFile(path.join(exitDir, 'saida.acceptance.mjs.txt'), 'process.exit(0)\n')
  const exitOnly = await evaluateExternal({ workspaceDir: ws, acceptanceDir: exitDir, expectedAcceptanceHashes: await hashTree(exitDir), expectedPass: 10, reportedStatus: 'DONE' })
  assert.equal(exitOnly.externalStatus, 'FAIL', 'exit 0 sem TAP de aprovação não conta como PASS')
  assert.equal(exitOnly.falseDone, true)
})

test('política com readOnly de chaves diferentes de models é recusada antes de criar o host', () => {
  const policy = policyFor('codex')
  assert.doesNotThrow(() => bench.assertPolicyKeys(policy))
  const readOnly = { ...policy.readOnly }
  delete readOnly.executor
  assert.throws(() => bench.assertPolicyKeys({ ...policy, readOnly }), { code: 'policy_keys_mismatch' })
})

test('contract-change: aplica A v2 e registra hashes antes e depois; B permanece idêntico', async () => {
  const { ws } = await workspaceCopy('contract')
  const before = await hashTree(ws)
  const change = await applyContractChange({ fixtureDir: FIXTURE_DIR, workspaceDir: ws })
  const after2 = await hashTree(ws)
  assert.notEqual(change.before['src/a.mjs'], change.after['src/a.mjs'])
  assert.equal(change.after['src/a.mjs'], after2['src/a.mjs'])
  assert.equal(after2['src/b.mjs'], before['src/b.mjs'])
})

test('manifesto fixa hashes e verifyManifest recusa fixture adulterada antes de qualquer spawn', async () => {
  const dir = await tempDir('manifest')
  const copy = path.join(dir, 'fixture')
  await cp(FIXTURE_DIR, copy, { recursive: true })
  const manifestPath = path.join(dir, 'manifest.json')
  const manifest = await buildManifest({ id: 'teste-manifesto', host: 'codex', scenario: 'happy', repoRoot: ROOT, fixtureDir: copy, evidenceDir: dir, baseline: await extractBaseline({ repoRoot: ROOT, destDir: dir }), checks: ['node --test'] })
  for (const key of ['baseline', 'compiler', 'bridge', 'transport', 'engine', 'fixture', 'labelMap', 'nodeVersion', 'effort', 'ceiling', 'maxCalls']) assert.ok(key in manifest, key)
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  assert.equal((await verifyManifest(manifestPath)).ok, true)
  await writeFile(path.join(copy, 'workspace', 'src', 'b.mjs'), 'export const somarInteiros = () => 999\n')
  const verified = await verifyManifest(manifestPath)
  assert.equal(verified.ok, false)
  assert.ok(verified.mismatches.some(item => item.startsWith('fixture.workspace')))
  const fake = fakeTransport()
  const run = await runVariant({ manifestPath, variant: 'v1-normalized', transportFactory: () => fake, outDir: path.join(dir, 'out') })
  assert.equal(run.status, 'BLOCK')
  assert.equal(run.block.code, 'manifest_mismatch')
  assert.equal(fake.spawns.length, 0, 'manifesto adulterado não chega a spawn')
})

test('manifesto cobre workflows/graph-eng.js, package.json e a política: alterar um deles faz verify falhar', async () => {
  const dir = await tempDir('manifest-engine')
  const repo = path.join(dir, 'repo')
  await mkdir(path.join(repo, 'workflows'), { recursive: true })
  await cp(path.join(ROOT, 'bin'), path.join(repo, 'bin'), { recursive: true })
  await cp(path.join(ROOT, 'workflows', 'graph-eng.js'), path.join(repo, 'workflows', 'graph-eng.js'))
  await cp(path.join(ROOT, 'package.json'), path.join(repo, 'package.json'))
  const manifestPath = path.join(dir, 'manifest.json')
  const manifest = await buildManifest({ id: 'engine-hash', host: 'codex', scenario: 'happy', repoRoot: repo, fixtureDir: FIXTURE_DIR, evidenceDir: dir, baseline: await extractBaseline({ repoRoot: ROOT, destDir: dir }) })
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  assert.equal((await verifyManifest(manifestPath, { repoRoot: repo })).ok, true)
  const wf = path.join(repo, 'workflows', 'graph-eng.js')
  const workflowBytes = await readFile(wf)
  await writeFile(wf, Buffer.concat([workflowBytes, Buffer.from(' ')]))
  assert.deepEqual((await verifyManifest(manifestPath, { repoRoot: repo })).mismatches, ['workflow'])
  await writeFile(wf, workflowBytes)
  const pkg = path.join(repo, 'package.json')
  const pkgText = await readFile(pkg, 'utf8')
  await writeFile(pkg, pkgText + ' ')
  assert.deepEqual((await verifyManifest(manifestPath, { repoRoot: repo })).mismatches, ['package'])
  await writeFile(pkg, pkgText)
  const tampered = { ...manifest, policy: { ...manifest.policy, models: { ...manifest.policy.models, executor: 'gpt-6.1-sol' } } }
  await writeFile(manifestPath, JSON.stringify(tampered, null, 2))
  assert.ok((await verifyManifest(manifestPath, { repoRoot: repo })).mismatches.includes('policy'))
})

test('cenário contract-change sem passo de retomada implementado vira BLOCK antes de qualquer spawn', async () => {
  const dir = await tempDir('contract-block')
  const baseline = await extractBaseline({ repoRoot: ROOT, destDir: dir })
  const manifestPath = path.join(dir, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(await buildManifest({ id: 'contract-block', host: 'codex', scenario: 'contract-change', repoRoot: ROOT, fixtureDir: FIXTURE_DIR, evidenceDir: dir, baseline }), null, 2))
  const fake = fakeTransport()
  const run = await runVariant({ manifestPath, variant: 'adaptive', transportFactory: () => fake, outDir: path.join(dir, 'out') })
  assert.equal(run.status, 'BLOCK')
  assert.equal(run.block.code, 'scenario_not_implemented')
  assert.equal(fake.spawns.length, 0, 'sem retomada implementada, nenhum spawn')
})

test('verify falha quando o baseline v1 (bytes do motor histórico) é adulterado', async () => {
  const dir = await tempDir('verify-baseline')
  const baseline = await extractBaseline({ repoRoot: ROOT, destDir: dir })
  const manifestPath = path.join(dir, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(await buildManifest({ id: 'verify-baseline', host: 'codex', scenario: 'happy', repoRoot: ROOT, fixtureDir: FIXTURE_DIR, evidenceDir: dir, baseline }), null, 2))
  assert.equal((await verifyManifest(manifestPath)).ok, true)
  await writeFile(baseline.path, (await readFile(baseline.path, 'utf8')) + '\n// alterado\n')
  const verified = await verifyManifest(manifestPath)
  assert.equal(verified.ok, false)
  assert.deepEqual(verified.mismatches, ['baseline'])
})

test('workspace de cada tentativa fica fora do repo, em GRAPH_ENG_BENCH_WORKSPACES, como repositório git próprio', { timeout: 60000 }, async () => {
  const previousBench = process.env.GRAPH_ENG_BENCH_WORKSPACES
  const benchRoot = path.join(STATE_ROOT, 'benchmarks')
  process.env.GRAPH_ENG_BENCH_WORKSPACES = benchRoot
  try {
    const dir = await tempDir('ws-outside')
    const manifestPath = path.join(dir, 'manifest.json')
    const baseline = await extractBaseline({ repoRoot: ROOT, destDir: dir })
    await writeFile(manifestPath, JSON.stringify(await buildManifest({ id: 'ws-outside', host: 'codex', scenario: 'happy', repoRoot: ROOT, fixtureDir: FIXTURE_DIR, evidenceDir: dir, baseline }), null, 2))
    const run = await runVariant({ manifestPath, variant: 'v1-normalized', outDir: path.join(dir, 'variant-v1-normalized'), transportFactory: () => fakeTransport({ mode: 'enoent' }) })
    assert.ok(run.workspace, 'run.json registra o workspace')
    assert.ok(run.workspace.startsWith(benchRoot + path.sep), 'workspace fica em GRAPH_ENG_BENCH_WORKSPACES')
    assert.ok(!run.workspace.startsWith(ROOT + path.sep), 'workspace não fica dentro do repo')
    assert.ok(existsSync(path.join(run.workspace, '.git')), 'workspace é repositório git próprio')
    assert.equal(existsSync(path.join(dir, 'variant-v1-normalized', '_eval')), false, 'avaliador não grava dentro da tentativa nem do repo')
    assert.notDeepEqual(await workspaceResourceOf(run.workspace), await workspaceResourceOf(ROOT), 'lock do workspace não é o do repo')
    assert.equal(bench.benchmarkStateDir({}), path.join(os.homedir(), '.claude', 'graph-eng'), 'padrão ~/.claude/graph-eng')
    assert.equal(bench.benchmarkStateDir({ GRAPH_ENG_STATE_DIR: '/x/estado' }), '/x/estado')
  } finally {
    if (previousBench === undefined) delete process.env.GRAPH_ENG_BENCH_WORKSPACES
    else process.env.GRAPH_ENG_BENCH_WORKSPACES = previousBench
  }
})

// B1: workspace de tentativa nunca cai em ~/.claude (Claude Code nega Write em cwd com segmento .claude).
test('B1: workspace sob diretório com segmento .claude dá BLOCK workspace_under_protected_dir antes de qualquer spawn', { timeout: 60000 }, async () => {
  const dir = await tempDir('ws-protected')
  const manifestPath = path.join(dir, 'manifest.json')
  const baseline = await extractBaseline({ repoRoot: ROOT, destDir: dir })
  await writeFile(manifestPath, JSON.stringify(await buildManifest({ id: 'ws-protected', host: 'claude', scenario: 'happy', repoRoot: ROOT, fixtureDir: FIXTURE_DIR, evidenceDir: dir, baseline }), null, 2))
  const transport = fakeTransport()
  const outDir = path.join(dir, 'variant-v1-normalized')
  const outside = await mkdtemp(path.join(os.tmpdir(), 'b1-protected-'))
  created.push(outside)
  const run = await runVariant({ manifestPath, variant: 'v1-normalized', outDir, transportFactory: () => transport, workspaceRoot: path.join(outside, '.claude', 'graph-eng', 'benchmarks') })
  assert.equal(run.status, 'BLOCK')
  assert.equal(run.reason, 'workspace_under_protected_dir')
  assert.equal(run.attempted, false)
  assert.equal(transport.spawns.length, 0, 'nenhum spawn antes do BLOCK')
})

test('B1: padrão de workspace fica fora de ~/.claude e do repo (GRAPH_ENG_BENCH_WORKSPACES sobrescreve)', () => {
  const root = bench.benchmarkWorkspaceRoot({})
  assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep), root)
  assert.ok(!root.split(path.sep).includes('.claude'), root)
  assert.ok(!root.startsWith(ROOT + path.sep), root)
  assert.equal(bench.benchmarkWorkspaceRoot({ GRAPH_ENG_BENCH_WORKSPACES: '/x/bench' }), '/x/bench')
})

test('tentativa existente não é apagada nem repetida: segunda run na mesma variante recusa e preserva os arquivos', { timeout: 60000 }, async () => {
  const dir = await tempDir('no-delete')
  const manifestPath = path.join(dir, 'manifest.json')
  const baseline = await extractBaseline({ repoRoot: ROOT, destDir: dir })
  await writeFile(manifestPath, JSON.stringify(await buildManifest({ id: 'no-delete', host: 'codex', scenario: 'happy', repoRoot: ROOT, fixtureDir: FIXTURE_DIR, evidenceDir: dir, baseline }), null, 2))
  const outDir = path.join(dir, 'variant-v1-normalized')
  await runVariant({ manifestPath, variant: 'v1-normalized', outDir, transportFactory: () => fakeTransport({ mode: 'enoent' }) })
  const before = await readFile(path.join(outDir, 'run.json'), 'utf8')
  await assert.rejects(runVariant({ manifestPath, variant: 'v1-normalized', outDir, transportFactory: () => fakeTransport({ mode: 'enoent' }) }), { code: 'attempt_exists' })
  assert.equal(await readFile(path.join(outDir, 'run.json'), 'utf8'), before, 'run.json da tentativa anterior intacto')
  assert.ok(existsSync(path.join(outDir, 'calls.jsonl')))
})

test('run.json fica inflight enquanto a tentativa roda e recebe status final ao terminar', { timeout: 60000 }, async () => {
  const dir = await tempDir('inflight')
  const manifestPath = path.join(dir, 'manifest.json')
  const baseline = await extractBaseline({ repoRoot: ROOT, destDir: dir })
  await writeFile(manifestPath, JSON.stringify(await buildManifest({ id: 'inflight', host: 'codex', scenario: 'happy', repoRoot: ROOT, fixtureDir: FIXTURE_DIR, evidenceDir: dir, baseline }), null, 2))
  const outDir = path.join(dir, 'variant-v1-normalized')
  const fake = fakeTransport({ mode: 'enoent' })
  let seen = null
  const transport = {
    spawn: (...args) => { seen = JSON.parse(readFileSync(path.join(outDir, 'run.json'), 'utf8')).status; return fake.spawn(...args) },
    killProcess: fake.killProcess,
  }
  const run = await runVariant({ manifestPath, variant: 'v1-normalized', outDir, transportFactory: () => transport })
  assert.equal(seen, 'inflight', 'antes do primeiro spawn o run.json já está inflight')
  assert.notEqual(run.status, 'inflight')
  assert.equal(JSON.parse(await readFile(path.join(outDir, 'run.json'), 'utf8')).status, run.status)
})

test('SIGINT durante a tentativa marca BLOCK cancelled, cancela o handle em voo e não apaga nada', { timeout: 20000 }, async () => {
  const dir = await tempDir('sigint')
  const manifestPath = path.join(dir, 'manifest.json')
  const baseline = await extractBaseline({ repoRoot: ROOT, destDir: dir })
  await writeFile(manifestPath, JSON.stringify(await buildManifest({ id: 'sigint', host: 'codex', scenario: 'happy', repoRoot: ROOT, fixtureDir: FIXTURE_DIR, evidenceDir: dir, baseline }), null, 2))
  const outDir = path.join(dir, 'variant-v1-normalized')
  const fake = fakeTransport({ mode: 'hang' })
  const listenersBefore = process.listenerCount('SIGINT')
  const pending = runVariant({ manifestPath, variant: 'v1-normalized', outDir, transportFactory: () => fake })
  for (let i = 0; i < 200 && fake.spawns.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(fake.spawns.length, 1, 'a chamada precisa estar em voo antes do sinal')
  process.emit('SIGINT')
  const outcome = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('timeout'), 3000))])
  assert.notEqual(outcome, 'timeout', 'o handler de SIGINT precisa encerrar a tentativa')
  assert.equal(outcome.status, 'BLOCK')
  assert.equal(outcome.reason, 'cancelled')
  assert.equal(JSON.parse(await readFile(path.join(outDir, 'run.json'), 'utf8')).reason, 'cancelled')
  assert.ok(fake.killed >= 1, 'handle em voo foi cancelado')
  assert.equal(process.listenerCount('SIGINT'), listenersBefore, 'handler removido ao terminar')
})

test('CLI recusa --manifest fora de .graph-runs/benchmarks e --max-wall-ms inválido', () => {
  assert.throws(() => parseBenchmarkArgs(['run', '--manifest', '/nao-existe/manifest.json', '--variant', 'adaptive']), /manifest/)
  const ok = parseBenchmarkArgs(['run', '--manifest', path.join(bench.EVIDENCE_ROOT, 'x', 'manifest.json'), '--variant', 'adaptive'])
  assert.equal(ok.command, 'run')
  assert.throws(() => parseBenchmarkArgs(['run', '--manifest', path.join(bench.EVIDENCE_ROOT, 'x', 'manifest.json'), '--variant', 'adaptive', '--max-wall-ms', '0']), /max-wall-ms/)
})

test('métricas: requested/effective/usage ausentes são null, zero informado é preservado, parcial não parece completo', () => {
  const summary = summarizeCalls([
    { label: 'plan', role: 'planner', status: 'completed', requestedModel: 'gpt-6.1-sol', effectiveModel: null, usage: { output_tokens: 0 } },
    { label: 'work:I1', role: 'executor', status: 'failed', requestedModel: 'gpt-6-luna', effectiveModel: null, usage: null },
    { label: 'verify:I1', role: 'verifier', status: 'inflight', requestedModel: null, effectiveModel: null, usage: null },
  ], { expectedCalls: 3 })
  assert.equal(summary.total, 3)
  assert.equal(summary.byRole.planner, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.inflight, 1)
  assert.equal(summary.complete, false)
  assert.equal(summary.fields.outputTokens.value, 0, 'zero informado é preservado')
  assert.equal(summary.fields.effectiveModel.value, null)
  assert.equal(summary.fields.usage.coverage, '1/3')
})

// C: o usage do Claude (modelUsage por modelo, camelCase) soma cache na entrada; o do Codex segue direto.
test('C: normalizeUsage soma o modelUsage do Claude com cache na entrada e mantém o formato Codex', () => {
  const claude = bench.normalizeUsage({ 'claude-haiku-5-5': { inputTokens: 6, outputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 } })
  assert.deepEqual(claude, { input: 126, output: 10, cacheInputTokens: 120 })
  const codex = bench.normalizeUsage({ input_tokens: 7, output_tokens: 3 })
  assert.equal(codex.input, 7)
  assert.equal(codex.output, 3)
  const summary = summarizeCalls([
    { role: 'planner', status: 'completed', requestedModel: 'opus', effectiveModel: 'claude-haiku-5-5', usage: { 'claude-haiku-5-5': { inputTokens: 6, outputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 } } },
  ], {})
  assert.equal(summary.fields.usage.coverage, '1/1')
  assert.equal(summary.fields.inputTokens.value, 126)
  assert.equal(summary.fields.outputTokens.value, 10)
  const codexSummary = summarizeCalls([{ role: 'executor', status: 'completed', requestedModel: 'g', effectiveModel: 'g', usage: { input_tokens: 7, output_tokens: 0 } }], {})
  assert.equal(codexSummary.fields.inputTokens.value, 7)
  assert.equal(codexSummary.fields.outputTokens.value, 0, 'zero informado é preservado')
})

test('relatório: NOT_RUN não recebe métrica nem percentual; linhas fixas de Claude e planner barato sempre existem', () => {
  const report = buildReport([
    { host: 'claude', variant: 'v1-normalized', scenario: 'happy', status: 'NOT_RUN', attempted: false, reason: 'auth' },
    { host: 'codex', variant: 'adaptive', scenario: 'happy', status: 'BLOCK', attempted: false, reason: 'manifest_mismatch' },
  ])
  const markdown = renderReport(report)
  assert.match(markdown, /HISTÓRICO CLAUDE/)
  assert.match(markdown, /BLOCK/)
  assert.match(markdown, /planner barato.*fora de escopo/i)
  const notRunRow = markdown.split('\n').find(line => line.includes('NOT_RUN'))
  assert.ok(notRunRow)
  assert.doesNotMatch(notRunRow, /%/)
})

test('reprodutibilidade: duas execuções fake do mesmo manifesto geram o mesmo relatório, exceto tempos', async () => {
  const dir = await tempDir('repro')
  const manifestPath = path.join(dir, 'manifest.json')
  const manifest = await buildManifest({ id: 'repro', host: 'codex', scenario: 'happy', repoRoot: ROOT, fixtureDir: FIXTURE_DIR, evidenceDir: dir, baseline: await extractBaseline({ repoRoot: ROOT, destDir: dir }), checks: ['node --test'] })
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  const first = await runVariant({ manifestPath, variant: 'v1-normalized', outDir: path.join(dir, 'a'), transportFactory: () => fakeTransport({ mode: 'enoent' }) })
  const second = await runVariant({ manifestPath, variant: 'v1-normalized', outDir: path.join(dir, 'b'), transportFactory: () => fakeTransport({ mode: 'enoent' }) })
  const a = JSON.stringify(stripTiming(buildReport([first])))
  const b = JSON.stringify(stripTiming(buildReport([second])))
  assert.equal(a, b)
  assert.equal(renderReport(buildReport([first]), { includeTiming: false }), renderReport(buildReport([second]), { includeTiming: false }))
})

test('CLI: aceita só host/variante/cenário conhecidos e recusa --out fora de .graph-runs/benchmarks', () => {
  const ok = parseBenchmarkArgs(['prepare', '--host', 'codex', '--scenario', 'happy', '--out', '.graph-runs/benchmarks'])
  assert.equal(ok.command, 'prepare')
  assert.throws(() => parseBenchmarkArgs(['prepare', '--host', 'gemini']), /host/)
  assert.throws(() => parseBenchmarkArgs(['run', '--variant', 'planner-barato']), /variant/)
  assert.throws(() => parseBenchmarkArgs(['prepare', '--host', 'codex', '--scenario', 'happy', '--out', '/tmp/fora']), /out/)
})

test('F1: runAdaptive com runGraph REAL repassa capabilities e chega a pelo menos 1 spawn contado', { timeout: 60000 }, async () => {
  const { ws } = await workspaceCopy('adaptive-real')
  await bench.initWorkspaceRepo(ws)
  const fake = fakeTransport({ output: () => ({ ok: true }) })
  const result = await bench.runAdaptive({ workspaceDir: ws, host: 'codex', transportFactory: () => fake, maxCalls: 6 })
  assert.doesNotMatch(JSON.stringify(result.result ?? {}), /trusted_host_capability/, 'capabilities() não pode faltar no wrap')
  assert.ok(result.spawnAttempts >= 1, 'o motor real chegou ao spawn e isso foi contado')
  assert.ok(fake.spawns.length >= 1)
})

test('F2: motor que responde BLOCKED grava BLOCK com feedback.reason, não FAIL', { timeout: 60000 }, async () => {
  const dir = await tempDir('blocked')
  const manifestPath = path.join(dir, 'manifest.json')
  const baseline = await extractBaseline({ repoRoot: ROOT, destDir: dir })
  await writeFile(manifestPath, JSON.stringify(await buildManifest({ id: 'blocked', host: 'codex', scenario: 'happy', repoRoot: ROOT, fixtureDir: FIXTURE_DIR, evidenceDir: dir, baseline }), null, 2))
  const outDir = path.join(dir, 'variant-adaptive')
  const run = await bench.runVariant({ manifestPath, variant: 'adaptive', outDir, transportFactory: () => fakeTransport(), runGraphImpl: async () => ({ status: 'blocked', feedback: { kind: 'BLOCK', reason: 'razao_teste' } }) })
  assert.equal(run.status, 'BLOCK')
  assert.equal(run.reason, 'razao_teste')
  const saved = JSON.parse(await readFile(path.join(outDir, 'run.json'), 'utf8'))
  assert.equal(saved.status, 'BLOCK')
  assert.equal(saved.reason, 'razao_teste')
})

test('F3: eval não sobrescreve external-eval.json: grava external-eval-<ts>.json e recusa destino existente', { timeout: 120000 }, async () => {
  const dir = await tempDir('eval-new')
  const manifestPath = path.join(dir, 'manifest.json')
  const baseline = await extractBaseline({ repoRoot: ROOT, destDir: dir })
  await writeFile(manifestPath, JSON.stringify(await buildManifest({ id: 'eval-new', host: 'codex', scenario: 'happy', repoRoot: ROOT, fixtureDir: FIXTURE_DIR, evidenceDir: dir, baseline }), null, 2))
  const outDir = path.join(dir, 'variant-v1-normalized')
  await bench.runVariant({ manifestPath, variant: 'v1-normalized', outDir, transportFactory: () => fakeTransport({ mode: 'enoent' }) })
  const original = await readFile(path.join(outDir, 'external-eval.json'), 'utf8')
  await bench.runEval(manifestPath)
  await bench.runEval(manifestPath)
  assert.equal(await readFile(path.join(outDir, 'external-eval.json'), 'utf8'), original, 'a evidência da run não muda')
  const extra = (await readdir(outDir)).filter(name => /^external-eval-.+\.json$/.test(name)).sort()
  assert.equal(extra.length, 2, 'cada eval grava arquivo novo')
  const target = path.join(outDir, extra[0])
  const before = await readFile(target, 'utf8')
  await assert.rejects(bench.writeNewEvidence(target, 'sobrescrever'), { code: 'evidence_exists' })
  assert.equal(await readFile(target, 'utf8'), before, 'destino existente preservado')
})

// Regressão (R6 real Claude, 20/10/2026): a v1 bloqueou e o run.json gravou só "engine_blocked",
// porque runV1 não devolvia o result do motor e o runVariant não tinha de onde ler feedback.reason.
test('motor v1: bloqueio preserva o motivo do motor no resultado', async () => {
  const dir = await tempDir('v1-reason')
  const workspace = path.join(dir, 'ws')
  await prepareWorkspace({ fixtureDir: FIXTURE_DIR, destDir: workspace })
  const host = createHost({ host: 'codex', cwd: workspace, runDir: workspace, transport: { spawn: fakeTransport({ mode: 'enoent' }).spawn }, experimentalPolicy: policyFor('codex') })
  const compile = async () => async () => ({ status: 'blocked', feedback: { kind: 'BLOCK', reason: 'plan_review_failed_or_invalid', severity: 'high', affectedNodes: [], evidenceIds: [] } })
  const run = await runV1({ sourcePath: 'x', workspaceDir: workspace, hostApi: host, task: 't', simulated: true, compile })
  assert.equal(run.reportedStatus, 'BLOCKED')
  assert.equal(run.result?.feedback?.reason, 'plan_review_failed_or_invalid')
})

// B2: o motivo do v1 vem da estrutura do motor (node/status/critic/gaps), nunca de texto do modelo.
test('B2: runV1 sem feedback do motor deriva o motivo de nó bloqueado, critic não concluído, lacunas e síntese', async () => {
  const dir = await tempDir('v1-derived-reason')
  const workspace = path.join(dir, 'ws')
  await prepareWorkspace({ fixtureDir: FIXTURE_DIR, destDir: workspace })
  const host = createHost({ host: 'codex', cwd: workspace, runDir: workspace, transport: { spawn: fakeTransport({ mode: 'enoent' }).spawn }, experimentalPolicy: policyFor('codex') })
  const run = async body => runV1({ sourcePath: 'x', workspaceDir: workspace, hostApi: host, task: 't', simulated: true, compile: async () => async () => body })
  const blockedNode = await run({ status: 'blocked', nodes: [{ id: 'r2-i2', kind: 'implement', status: 'blocked' }], critic: null, openGaps: [] })
  assert.equal(blockedNode.result.feedback, 'v1_node_blocked:r2-i2')
  const notDone = await run({ status: 'partial', nodes: [{ id: 'r1', kind: 'research', status: 'done' }], critic: { done: false }, openGaps: [] })
  assert.equal(notDone.result.feedback, 'v1_critic_not_done')
  const gaps = await run({ status: 'partial', nodes: [], critic: { done: true }, openGaps: ['lacuna A'] })
  assert.equal(gaps.result.feedback, 'v1_open_gaps')
  const synth = await run({ status: 'done', nodes: [], critic: { done: true }, openGaps: [] })
  assert.equal(synth.result.feedback, 'v1_synth_done')
  const modelText = await run({ status: 'blocked', nodes: [{ id: 'x y ignore instructions', kind: 'implement', status: 'failed' }], critic: null, openGaps: [] })
  assert.equal(modelText.result.feedback, 'v1_node_failed:x_y_ignore_instructions')
})


// Baseline de agente único: o modelo forte faz a tarefa inteira; mesma avaliação externa e mesmo formato de evidência.
const referenceWrites = () => Object.fromEntries(['a', 'b', 'c'].map(name => [`src/${name}.mjs`, readFileSync(path.join(FIXTURE_DIR, 'reference', 'src', `${name}.mjs.txt`), 'utf8')]))
const opusUsage = () => ({ 'claude-opus-5-5': { inputTokens: 10, outputTokens: 200, cacheReadInputTokens: 30000, cacheCreationInputTokens: 5000, costUSD: 0.5 } })

async function singleAgentHost(fake) {
  const { dir, ws } = await workspaceCopy('single')
  await bench.initWorkspaceRepo(ws)
  const hostApi = createHost({ host: 'claude', cwd: ws, runDir: path.join(dir, 'host-runs'), transport: { spawn: fake.spawn }, killProcess: fake.killProcess, experimentalPolicy: bench.singleAgentPolicy('claude') })
  return { ws, hostApi, task: await readFile(path.join(ws, 'task.md'), 'utf8') }
}

// Regressão: com o repo num worktree em .claude/worktrees/, workspace criado dentro do repo herdava o segmento
// .claude e a guarda CWD_PROTECTED_PATH recusava o papel de escrita antes do spawn (spawns ficava 0).
test('single-agent: workspace de teste fica em os.tmpdir(), sem segmento .claude, mesmo com o repo sob .claude', { timeout: 30000 }, async () => {
  const fake = fakeTransport({ output: () => ({ status: 'DONE', summary: 'feito' }) })
  const { ws, hostApi, task } = await singleAgentHost(fake)
  assert.ok(ws.startsWith(path.resolve(os.tmpdir()) + path.sep), ws)
  assert.ok(!ws.startsWith(ROOT + path.sep), 'workspace não fica dentro do repo')
  assert.ok(!ws.split(path.sep).includes('.claude'), ws)
  await bench.runSingleAgent({ workspaceDir: ws, hostApi, task, rounds: 1, runChecks: async () => ({ exitCode: 0, tap: { pass: 1, fail: 0 }, outputTail: '' }) })
  assert.equal(fake.spawns.length, 1, 'papel de escrita chega ao spawn')
})

test('single-agent: uma chamada do modelo forte, avaliação externa PASS e custo, tokens e maior contexto no run.json', { timeout: 60000 }, async () => {
  const dir = await tempDir('single-run')
  const manifestPath = path.join(dir, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(await buildManifest({ id: 'single', host: 'claude', scenario: 'happy', repoRoot: ROOT, fixtureDir: FIXTURE_DIR, evidenceDir: dir, baseline: await extractBaseline({ repoRoot: ROOT, destDir: dir }) }), null, 2))
  const fake = fakeTransport({ writes: referenceWrites, output: () => ({ status: 'DONE', summary: 'feito' }), modelUsage: opusUsage })
  const outDir = path.join(dir, 'variant-single-agent')
  const run = await runVariant({ manifestPath, variant: 'single-agent', outDir, transportFactory: () => fake })
  assert.equal(fake.spawns.length, 1)
  assert.equal(fake.spawns[0].args[fake.spawns[0].args.indexOf('--model') + 1], 'opus', 'modelo forte do host')
  assert.match(fake.spawns[0].prompt, /somarInteiros/, 'o prompt leva o task.md')
  assert.equal(run.status, 'PASS')
  assert.equal(run.reportedStatus, 'DONE')
  assert.equal(run.externalStatus, 'PASS')
  assert.equal(run.falseDone, false)
  assert.deepEqual(run.summary.byRole, { singleAgent: 1 })
  assert.equal(run.summary.fields.costUSD.value, 0.5)
  assert.equal(run.summary.fields.maxCallInputTokens.value, 35010)
  assert.deepEqual(run.checks.map(check => check.exitCode), [0])
  const calls = (await readFile(path.join(outDir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].requestedModel, 'opus')
  assert.equal(JSON.parse(await readFile(path.join(outDir, 'run.json'), 'utf8')).variant, 'single-agent')
})

test('single-agent: npm test do supervisor falhou, a saída volta para a próxima chamada do mesmo modelo', { timeout: 30000 }, async () => {
  const fake = fakeTransport({ output: () => ({ status: 'DONE', summary: 'feito' }) })
  const { ws, hostApi, task } = await singleAgentHost(fake)
  const results = [{ exitCode: 1, tap: { pass: 0, fail: 1 }, outputTail: 'not ok 1 - erro_marcado' }, { exitCode: 0, tap: { pass: 1, fail: 0 }, outputTail: '' }]
  const run = await bench.runSingleAgent({ workspaceDir: ws, hostApi, task, runChecks: async () => results.shift() })
  assert.equal(fake.spawns.length, 2)
  assert.doesNotMatch(fake.spawns[0].prompt, /erro_marcado/)
  assert.match(fake.spawns[1].prompt, /erro_marcado/)
  assert.equal(run.reportedStatus, 'DONE')
  assert.deepEqual(run.checks.map(check => check.exitCode), [1, 0])
})

test('single-agent: escrita fora de src/ bloqueia sem nova chamada; BLOCKED do agente e npm test falhando até o fim viram BLOCKED com motivo', { timeout: 30000 }, async () => {
  const outside = fakeTransport({ writes: () => ({ 'package.json': '{}' }), output: () => ({ status: 'DONE', summary: 'x' }) })
  const a = await singleAgentHost(outside)
  const violated = await bench.runSingleAgent({ ...a, workspaceDir: a.ws, runChecks: async () => ({ exitCode: 1, tap: {}, outputTail: '' }) })
  assert.equal(violated.block.code, 'grant_violation')
  assert.deepEqual(violated.block.paths, ['package.json'])
  assert.equal(outside.spawns.length, 1)

  const blocked = fakeTransport({ output: () => ({ status: 'BLOCKED', summary: 'sem saída' }) })
  const b = await singleAgentHost(blocked)
  const refused = await bench.runSingleAgent({ ...b, workspaceDir: b.ws })
  assert.equal(refused.reportedStatus, 'BLOCKED')
  assert.equal(refused.result.feedback.reason, 'single_agent_blocked')

  const failing = fakeTransport({ output: () => ({ status: 'DONE', summary: 'x' }) })
  const c = await singleAgentHost(failing)
  const exhausted = await bench.runSingleAgent({ ...c, workspaceDir: c.ws, rounds: 2, runChecks: async () => ({ exitCode: 1, tap: {}, outputTail: 'falhou' }) })
  assert.equal(failing.spawns.length, 2)
  assert.equal(exhausted.reportedStatus, 'BLOCKED')
  assert.equal(exhausted.result.feedback.reason, 'single_agent_checks_failed')
})

test('CLI aceita --variant single-agent', () => {
  assert.equal(parseBenchmarkArgs(['run', '--variant', 'single-agent']).variant, 'single-agent')
})

// Cenário faturamento: 9 módulos com dependência, contratos em docs/contratos/ e aceites de borda que o teste visível não cobre.
const FAT_DIR = bench.FATURAMENTO_FIXTURE_DIR
const solutionWrites = (...folders) => () => {
  const files = {}
  for (const folder of folders) {
    const dir = path.join(FAT_DIR, folder, 'src')
    for (const name of readdirSync(dir).filter(file => file.endsWith('.mjs.txt'))) files[`src/${name.slice(0, -'.txt'.length)}`] = readFileSync(path.join(dir, name), 'utf8')
  }
  return files
}

async function faturamentoManifest(id) {
  const dir = await tempDir(id)
  const manifestPath = path.join(dir, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(await buildManifest({ id, host: 'claude', scenario: 'faturamento', repoRoot: ROOT, evidenceDir: dir, baseline: await extractBaseline({ repoRoot: ROOT, destDir: dir }) }), null, 2))
  return { dir, manifestPath }
}

test('faturamento fixture: aceites reprovam o inicial e a solução ingênua, aprovam a referência; o teste visível aprova as duas', { timeout: 120000 }, async () => {
  const acceptanceDir = path.join(FAT_DIR, 'acceptance')
  const expected = await bench.countAcceptanceTests(acceptanceDir)
  assert.ok(expected >= 30, `aceites suficientes para cobrir os 9 módulos (${expected})`)
  const copy = async (name, folders) => {
    const dir = await tempDir(`fat-${name}`)
    const ws = path.join(dir, 'ws')
    await prepareWorkspace({ fixtureDir: FAT_DIR, destDir: ws })
    for (const folder of folders) await applyFixtureReference({ fixtureDir: FAT_DIR, workspaceDir: ws, folder })
    return ws
  }
  const initial = await copy('inicial', [])
  assert.ok(existsSync(path.join(initial, 'test', 'caminho-feliz.test.mjs')), 'teste visível chega ao workspace sem o .txt')
  assert.ok(!existsSync(path.join(initial, 'test', 'caminho-feliz.test.mjs.txt')))
  assert.notEqual((await bench.runNodeTest(initial)).exitCode, 0, 'teste visível reprova o estado inicial')
  assert.notEqual((await runAcceptance({ workspaceDir: initial, acceptanceDir })).exitCode, 0)

  const reference = await copy('referencia', ['reference'])
  assert.equal((await bench.runNodeTest(reference)).exitCode, 0)
  const refRun = await runAcceptance({ workspaceDir: reference, acceptanceDir })
  assert.equal(refRun.exitCode, 0, refRun.outputTail)
  assert.deepEqual(refRun.tap, { pass: expected, fail: 0 })

  // A ingênua passa no npm test do workspace: um agente que confia só nele declara DONE e erra o aceite.
  const naive = await copy('ingenua', ['reference', 'ingenua'])
  assert.equal((await bench.runNodeTest(naive)).exitCode, 0, 'ingênua passa no teste visível')
  const naiveRun = await runAcceptance({ workspaceDir: naive, acceptanceDir })
  assert.notEqual(naiveRun.exitCode, 0)
  assert.ok(naiveRun.tap.fail >= 10, `ingênua falha em vários módulos (${naiveRun.tap.fail})`)
})

test('faturamento manifesto: fixture própria, sem contract-v2, contagem de aceites e verify ok; contract-v2 criado depois diverge', async () => {
  const { dir, manifestPath } = await faturamentoManifest('fat-manifest')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.scenario, 'faturamento')
  assert.equal(manifest.fixtureDir, FAT_DIR)
  assert.deepEqual(manifest.fixture.contractV2, {})
  assert.equal(manifest.acceptance.expectedPass, await bench.countAcceptanceTests(path.join(FAT_DIR, 'acceptance')))
  assert.ok(Object.keys(manifest.fixture.workspace).filter(file => file.startsWith('docs/contratos/')).length >= 9, 'contrato espalhado em vários arquivos')
  assert.deepEqual(await verifyManifest(manifestPath), { ok: true, mismatches: [] })
  assert.equal(bench.fixtureDirFor('happy'), FIXTURE_DIR)
  assert.throws(() => bench.fixtureDirFor('nenhum'), /cenário desconhecido/)

  const copyDir = path.join(dir, 'fixture-copia')
  await cp(FAT_DIR, copyDir, { recursive: true })
  const copyManifest = path.join(dir, 'manifest-copia.json')
  await writeFile(copyManifest, JSON.stringify({ ...manifest, fixtureDir: copyDir, fixture: { ...manifest.fixture } }, null, 2))
  assert.equal((await verifyManifest(copyManifest)).ok, true)
  await mkdir(path.join(copyDir, 'contract-v2'))
  await writeFile(path.join(copyDir, 'contract-v2', 'x.mjs.txt'), 'export {}\n')
  assert.deepEqual((await verifyManifest(copyManifest)).mismatches, ['fixture.contractV2:x.mjs.txt'])
})

test('faturamento single-agent: solução ingênua passa no npm test do supervisor, declara DONE e vira falso DONE', { timeout: 120000 }, async () => {
  const { dir, manifestPath } = await faturamentoManifest('fat-naive')
  const fake = fakeTransport({ writes: solutionWrites('reference', 'ingenua'), output: () => ({ status: 'DONE', summary: 'feito' }) })
  const run = await runVariant({ manifestPath, variant: 'single-agent', outDir: path.join(dir, 'variant-single-agent'), transportFactory: () => fake })
  assert.equal(fake.spawns.length, 1, 'npm test verde na primeira rodada: sem nova chamada')
  assert.match(fake.spawns[0].prompt, /docs\/contratos\//, 'o prompt leva o task.md do faturamento')
  assert.deepEqual(run.checks.map(check => check.exitCode), [0])
  assert.equal(run.reportedStatus, 'DONE')
  assert.equal(run.externalStatus, 'FAIL')
  assert.equal(run.falseDone, true)
  assert.equal(run.status, 'FAIL')
  assert.equal(run.scenario, 'faturamento')
})

test('faturamento single-agent: referência completa passa no aceite externo sem falso DONE', { timeout: 120000 }, async () => {
  const { dir, manifestPath } = await faturamentoManifest('fat-ref')
  const fake = fakeTransport({ writes: solutionWrites('reference'), output: () => ({ status: 'DONE', summary: 'feito' }) })
  const run = await runVariant({ manifestPath, variant: 'single-agent', outDir: path.join(dir, 'variant-single-agent'), transportFactory: () => fake })
  assert.equal(run.status, 'PASS')
  assert.equal(run.externalStatus, 'PASS')
  assert.equal(run.falseDone, false)
})

test('CLI aceita --scenario faturamento e lista os cenários no erro', () => {
  assert.equal(parseBenchmarkArgs(['prepare', '--host', 'claude', '--scenario', 'faturamento']).scenario, 'faturamento')
  assert.throws(() => parseBenchmarkArgs(['prepare', '--host', 'claude', '--scenario', 'gigante']), /happy, contract-change, faturamento/)
})

// Cenário chess: gerador de lances de xadrez; os aceites conferem perft contra os valores publicados.
const CHESS_DIR = bench.CHESS_FIXTURE_DIR

test('chess fixture: aceites reprovam o esqueleto inicial e aprovam a referência (15 casos, perft incluso)', { timeout: 180000 }, async () => {
  const acceptanceDir = path.join(CHESS_DIR, 'acceptance')
  const expected = await bench.countAcceptanceTests(acceptanceDir)
  assert.equal(expected, 15)
  const dir = await tempDir('chess-fixture')
  const initial = path.join(dir, 'inicial')
  await prepareWorkspace({ fixtureDir: CHESS_DIR, destDir: initial })
  const initialRun = await runAcceptance({ workspaceDir: initial, acceptanceDir })
  assert.notEqual(initialRun.exitCode, 0)
  // Só os dois aceites de recusa (FEN inválida e lance ilegal) passam: o esqueleto lança sempre.
  assert.deepEqual(initialRun.tap, { pass: 2, fail: 13 })
  const reference = path.join(dir, 'referencia')
  await prepareWorkspace({ fixtureDir: CHESS_DIR, destDir: reference })
  assert.deepEqual(await applyFixtureReference({ fixtureDir: CHESS_DIR, workspaceDir: reference }), ['fen.mjs', 'game.mjs', 'movegen.mjs', 'perft.mjs'])
  const refRun = await runAcceptance({ workspaceDir: reference, acceptanceDir })
  assert.equal(refRun.exitCode, 0, refRun.outputTail)
  assert.deepEqual(refRun.tap, { pass: expected, fail: 0 })
})

test('chess single-agent: prompt leva o task.md do xadrez; referência escrita pelo agente passa no aceite externo', { timeout: 180000 }, async () => {
  const dir = await tempDir('chess-single')
  const manifestPath = path.join(dir, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(await buildManifest({ id: 'chess-single', host: 'claude', scenario: 'chess', repoRoot: ROOT, evidenceDir: dir, baseline: await extractBaseline({ repoRoot: ROOT, destDir: dir }) }), null, 2))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.fixtureDir, CHESS_DIR)
  assert.equal(manifest.acceptance.expectedPass, 15)
  const writes = () => Object.fromEntries(readdirSync(path.join(CHESS_DIR, 'reference', 'src')).map(name => [`src/${name.slice(0, -'.txt'.length)}`, readFileSync(path.join(CHESS_DIR, 'reference', 'src', name), 'utf8')]))
  const fake = fakeTransport({ writes, output: () => ({ status: 'DONE', summary: 'feito' }) })
  const run = await runVariant({ manifestPath, variant: 'single-agent', outDir: path.join(dir, 'variant-single-agent'), transportFactory: () => fake })
  assert.match(fake.spawns[0].prompt, /perft/)
  assert.equal(run.scenario, 'chess')
  assert.equal(run.status, 'PASS')
  assert.equal(run.falseDone, false)
})

test('CLI aceita --scenario chess', () => {
  assert.equal(parseBenchmarkArgs(['prepare', '--host', 'claude', '--scenario', 'chess']).scenario, 'chess')
})

test('archive copia só a evidência da run e regera RESULTADOS.md com custo do calls.jsonl', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bench-archive-'))
  after(() => rm(root, { recursive: true, force: true }))
  const runDir = path.join(root, 'evidence', 'bench-x-chess-1')
  const variantDir = path.join(runDir, 'variant-single-agent')
  await mkdir(path.join(variantDir, 'workspace'), { recursive: true })
  await mkdir(path.join(runDir, 'baseline'), { recursive: true })
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({ id: 'bench-x-chess-1' }))
  await writeFile(path.join(runDir, 'report.json'), '{}')
  await writeFile(path.join(runDir, 'baseline', 'graph-eng.js'), 'v1')
  await writeFile(path.join(variantDir, 'run.json'), JSON.stringify({ scenario: 'chess', host: 'claude', status: 'PASS', reason: null, reportedStatus: 'DONE', externalStatus: 'PASS', falseDone: false, summary: { total: 2 }, engineMs: 261000 }))
  await writeFile(path.join(variantDir, 'external-eval.json'), JSON.stringify({ tap: { pass: 15, fail: 0 }, expectedPass: 15 }))
  await writeFile(path.join(variantDir, 'external-eval-2026.json'), '{}')
  const usage = cost => ({ 'claude-opus-5-5': { inputTokens: 10, outputTokens: 1000, cacheReadInputTokens: 40000, cacheCreationInputTokens: 0, costUSD: cost } })
  await writeFile(path.join(variantDir, 'calls.jsonl'), [usage(0.25), usage(0.5)].map(u => JSON.stringify({ role: 'singleAgent', status: 'completed', usage: u })).join('\n') + '\n')
  await writeFile(path.join(variantDir, 'workspace', 'lixo.mjs'), 'x')

  const archiveRoot = path.join(root, 'docs')
  const result = await bench.archiveRun(path.join(runDir, 'manifest.json'), { archiveRoot })
  assert.deepEqual(result.copied, ['manifest.json', 'report.json', 'variant-single-agent/calls.jsonl', 'variant-single-agent/external-eval-2026.json', 'variant-single-agent/external-eval.json', 'variant-single-agent/run.json'])
  assert.equal(existsSync(path.join(archiveRoot, 'runs', 'bench-x-chess-1', 'variant-single-agent', 'workspace')), false)
  assert.equal(existsSync(path.join(archiveRoot, 'runs', 'bench-x-chess-1', 'baseline')), false)
  const md = await readFile(path.join(archiveRoot, 'RESULTADOS.md'), 'utf8')
  assert.match(md, /\| bench-x-chess-1 \| chess \| claude \| single-agent \| PASS \| — \| DONE \| PASS 15\/15 \| false \| 2 \| US\$ 0\.75 \| 261 \|/)

  // Arquivar de novo a mesma run não duplica a linha.
  await bench.archiveRun(path.join(runDir, 'manifest.json'), { archiveRoot })
  assert.equal((await readFile(path.join(archiveRoot, 'RESULTADOS.md'), 'utf8')).match(/bench-x-chess-1/g).length, 1)
})

test('CLI aceita o comando archive', () => {
  assert.equal(parseBenchmarkArgs(['archive', '--manifest', path.join(bench.EVIDENCE_ROOT, 'x', 'manifest.json')]).command, 'archive')
})
