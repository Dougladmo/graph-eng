#!/usr/bin/env node
// Benchmark mínimo reproduzível do graph-eng 2.0 (PGR-47), parte (a): sem host real.
// Controle v1 roda os bytes históricos de 91bf1dc pelo compilador compartilhado, com uma
// bridge que só normaliza transporte e papéis. Adaptativo roda o executeGrapheng atual.
// Avaliação externa roda depois de todos os filhos encerrarem, com aceites fora do workspace.
// Cada tentativa tem workspace próprio fora do repo (GRAPH_ENG_STATE_DIR) e nunca é apagada.
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, copyFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createHost } from './hosts.mjs'
import { compileWorkflow } from './workflow-source.mjs'
import { runGraph } from './graph-run.mjs'
import { executeGrapheng } from './grapheng.mjs'

const execFileAsync = promisify(execFile)
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'benchmark-v2')
export const FATURAMENTO_FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'benchmark-v2-faturamento')
export const EVIDENCE_ROOT = path.join(REPO_ROOT, '.graph-runs', 'benchmarks')
export const BASELINE = Object.freeze({ commit: '91bf1dc', path: 'workflows/graph-eng.js', bytes: 77172, sha256: '099335e3cf21fa05aea179d75f6cc01deceba81c142e1fceeefcc7f32b0604f2' })
export const DEFAULT_MAX_CALLS = 60
export const DEFAULT_MAX_WALL_MS = 90 * 60 * 1000
const EVAL_TIMEOUT_MS = 10 * 60 * 1000
const HOSTS = ['codex', 'claude']
const VARIANTS = ['v1-normalized', 'adaptive', 'single-agent']
// Cenário -> fixture. faturamento: 9 módulos com dependência, contratos espalhados em docs/ e aceites de borda.
// chess: gerador de lances de xadrez conferido por perft (valores da Chess Programming Wiki).
export const CHESS_FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'benchmark-chess')
const SCENARIO_FIXTURES = Object.freeze({ happy: FIXTURE_DIR, 'contract-change': FIXTURE_DIR, faturamento: FATURAMENTO_FIXTURE_DIR, chess: CHESS_FIXTURE_DIR })
const SCENARIOS = Object.keys(SCENARIO_FIXTURES)
export function fixtureDirFor(scenario) {
  if (!Object.hasOwn(SCENARIO_FIXTURES, scenario)) throw new TypeError(`cenário desconhecido: ${scenario}`)
  return SCENARIO_FIXTURES[scenario]
}
const VOLATILE = new Set(['startedAt', 'endedAt', 'durationMs', 'engineMs', 'evaluatorMs', 'outDir', 'workspace', 'seq', 'createdAt', 'generatedAt', 'evidencePath', 'attemptId'])
const POLICY_NAME = Object.freeze({ codex: 'lógica v1 com política Sol/Luna normalizada', claude: 'lógica v1 com política Opus/Haiku normalizada' })
const MODEL_BY_STRENGTH = Object.freeze({
  codex: { strong: 'gpt-6.1-sol', operational: 'gpt-6-luna' },
  claude: { strong: 'opus', operational: 'haiku' },
})
// Papel do transporte -> força e permissão de escrita. Mapa fechado: papel fora daqui é recusado no createHost.
const ROLE_POLICY = Object.freeze({
  planner: { strength: 'strong', readOnly: false },
  planReviewer: { strength: 'strong', readOnly: true },
  designReviewer: { strength: 'strong', readOnly: true },
  critic: { strength: 'strong', readOnly: true },
  executor: { strength: 'operational', readOnly: false },
  verifier: { strength: 'operational', readOnly: true },
  synth: { strength: 'operational', readOnly: false },
})
// Rótulo histórico do v1 -> papel lógico, papel de transporte e grant de escrita (auditado por chamada).
// 'by-node-kind' resolve pelo kind do nó no cabeçalho "## Your node" do próprio prompt (implement -> product, demais -> artifacts).
export const V1_LABEL_MAP = Object.freeze({
  plan: Object.freeze({ logicalRole: 'planner', transportRole: 'planner', grant: 'artifacts' }),
  'design-review': Object.freeze({ logicalRole: 'designReviewer', transportRole: 'designReviewer', grant: 'none' }),
  critic: Object.freeze({ logicalRole: 'critic', transportRole: 'critic', grant: 'none' }),
  judge: Object.freeze({ logicalRole: 'judge', transportRole: 'planReviewer', grant: 'none' }),
  work: Object.freeze({ logicalRole: 'executor', transportRole: 'executor', grant: 'by-node-kind' }),
  repair: Object.freeze({ logicalRole: 'executor', transportRole: 'executor', grant: 'by-node-kind' }),
  polish: Object.freeze({ logicalRole: 'executor', transportRole: 'executor', grant: 'product' }),
  'design-repair': Object.freeze({ logicalRole: 'executor', transportRole: 'executor', grant: 'artifacts' }),
  'draft-a': Object.freeze({ logicalRole: 'executor', transportRole: 'executor', grant: 'artifacts' }),
  'draft-b': Object.freeze({ logicalRole: 'executor', transportRole: 'executor', grant: 'artifacts' }),
  verify: Object.freeze({ logicalRole: 'verifier', transportRole: 'verifier', grant: 'none' }),
  escalate: Object.freeze({ logicalRole: 'verifier', transportRole: 'verifier', grant: 'none' }),
  synth: Object.freeze({ logicalRole: 'synth', transportRole: 'synth', grant: 'artifacts' }),
})
// Cabeçalho que o motor v1 grava em todo prompt de nó: "## Your node: <id> - <título> [<kind>, risk <risco>]".
const NODE_HEADER = /^## Your node: (\S+) - .*?\[([a-z-]+), risk /m

export class BenchmarkBlock extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BenchmarkBlock'
    this.code = code
    Object.assign(this, details)
  }
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

// Estado do graph-eng (onde os workspaces das tentativas ficam). Padrão: ~/.claude/graph-eng.
// Workspaces das tentativas NÃO usam este caminho: Claude Code nega Write em cwd com segmento .claude.
export function benchmarkWorkspaceRoot(env = process.env) {
  return env.GRAPH_ENG_BENCH_WORKSPACES || path.join(os.tmpdir(), 'graph-eng-benchmarks')
}
export function benchmarkStateDir(env = process.env) {
  return env.GRAPH_ENG_STATE_DIR || path.join(os.homedir(), '.claude', 'graph-eng')
}

function toPosix(rel) { return rel.split(path.sep).join('/') }

function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// Hash de cada arquivo da árvore, por caminho relativo. node_modules e .git ficam de fora.
export async function hashTree(dir, { exclude = ['node_modules', '.git'] } = {}) {
  const entries = {}
  async function walk(current) {
    const items = await readdir(current, { withFileTypes: true })
    for (const item of items) {
      if (exclude.includes(item.name)) continue
      const full = path.join(current, item.name)
      if (item.isDirectory()) await walk(full)
      else if (item.isFile()) entries[toPosix(path.relative(dir, full))] = sha256(await readFile(full))
    }
  }
  await walk(dir)
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function diffTrees(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter(key => before[key] !== after[key]).sort()
}

const GRANT_PREFIXES = Object.freeze({ product: ['src/', '.benchmark-run/'], artifacts: ['.benchmark-run/'], none: [] })
export function grantPrefixes(grant) {
  if (!Object.hasOwn(GRANT_PREFIXES, grant)) throw new TypeError(`grant desconhecido: ${grant}`)
  return GRANT_PREFIXES[grant]
}

// Devolve os caminhos alterados que não estão cobertos pelo grant da chamada.
export function auditWrites(changed, grant) {
  const prefixes = grantPrefixes(grant)
  return changed.filter(file => !prefixes.some(prefix => file.startsWith(prefix)))
}

async function defaultGit(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

// Extrai só por git show (leitura). Não faz checkout, reset, stash, worktree nem commit.
export async function extractBaseline({ repoRoot = REPO_ROOT, destDir, execGit = defaultGit } = {}) {
  const bytes = await execGit(['show', `${BASELINE.commit}:${BASELINE.path}`], repoRoot)
  const digest = sha256(bytes)
  if (bytes.length !== BASELINE.bytes || digest !== BASELINE.sha256) {
    throw new BenchmarkBlock('baseline_hash_mismatch', 'bytes de 91bf1dc:workflows/graph-eng.js não conferem com o SHA-256 fixado', { bytes: bytes.length, sha256: digest })
  }
  await mkdir(destDir, { recursive: true })
  const file = path.join(destDir, `graph-eng-${BASELINE.commit}.js`)
  await writeFile(file, bytes)
  return { commit: BASELINE.commit, path: file, bytes: bytes.length, sha256: digest }
}

// Arquivo .mjs.txt do workspace (teste visível) vira .mjs na cópia: no repo ele não pode entrar no node --test do graph-eng.
export async function prepareWorkspace({ fixtureDir = FIXTURE_DIR, destDir } = {}) {
  await cp(path.join(fixtureDir, 'workspace'), destDir, { recursive: true })
  for (const rel of Object.keys(await hashTree(destDir)).filter(file => file.endsWith('.mjs.txt'))) {
    await rename(path.join(destDir, rel), path.join(destDir, rel.slice(0, -'.txt'.length)))
  }
  return { destDir, hashes: await hashTree(destDir) }
}

// Repositório git próprio do workspace (fora do repo do produto), com commit inicial para auditar diffs.
export async function initWorkspaceRepo(dir, execGit = defaultGit) {
  await execGit(['init', '-q'], dir)
  await execGit(['add', '-A'], dir)
  await execGit(['-c', 'user.name=graph-eng-benchmark', '-c', 'user.email=benchmark@graph-eng.invalid', 'commit', '-q', '--allow-empty', '-m', 'benchmark: estado inicial'], dir)
}

// folder: 'reference' (passa nos aceites) ou outra solução guardada na fixture, como a 'ingenua' do faturamento.
export async function applyFixtureReference({ fixtureDir = FIXTURE_DIR, workspaceDir, folder = 'reference' } = {}) {
  const src = path.join(fixtureDir, folder, 'src')
  const applied = []
  for (const name of await readdir(src)) {
    if (!name.endsWith('.mjs.txt')) continue
    const target = name.slice(0, -'.txt'.length)
    await copyFile(path.join(src, name), path.join(workspaceDir, 'src', target))
    applied.push(target)
  }
  return applied.sort()
}

// Supervisor troca A v1 por A v2 entre execuções. Registra hashes antes e depois; B não é tocado.
export async function applyContractChange({ fixtureDir = FIXTURE_DIR, workspaceDir } = {}) {
  const before = await hashTree(workspaceDir)
  await copyFile(path.join(fixtureDir, 'contract-v2', 'a.mjs.txt'), path.join(workspaceDir, 'src', 'a.mjs'))
  const after = await hashTree(workspaceDir)
  return { before, after, changed: diffTrees(before, after) }
}

// Política do transporte experimental, aplicada só pelo benchmark via createHost({ experimentalPolicy }).
export function policyFor(host) {
  if (!MODEL_BY_STRENGTH[host]) throw new TypeError(`host desconhecido para a política: ${host}`)
  const models = {}
  const readOnly = {}
  for (const [role, rule] of Object.entries(ROLE_POLICY)) {
    models[role] = MODEL_BY_STRENGTH[host][rule.strength]
    readOnly[role] = rule.readOnly
  }
  return { host, name: POLICY_NAME[host], models: Object.freeze(models), readOnly: Object.freeze(readOnly) }
}

// models e readOnly precisam ter exatamente os mesmos papéis; a política não pode ter lacuna que vire escrita por padrão.
export function assertPolicyKeys(policy) {
  const roles = Object.keys(ROLE_POLICY).sort()
  for (const field of ['models', 'readOnly']) {
    const keys = Object.keys(policy?.[field] ?? {}).sort()
    if (keys.length !== roles.length || keys.some((key, index) => key !== roles[index])) {
      throw new BenchmarkBlock('policy_keys_mismatch', `chaves de ${field} não são os mesmos papéis da política`, { field, keys })
    }
  }
}

const abortedError = () => new BenchmarkBlock('bridge_aborted', 'bridge abortada: spawn recusado')

// Bridge do v1: agent/parallel/log/phase/budget com a mesma assinatura do motor histórico.
// Serializa todas as chamadas (uma por vez) para que a auditoria de escrita seja exata por chamada.
export function createAgentBridge({ hostApi, workspaceDir, maxCalls = DEFAULT_MAX_CALLS } = {}) {
  const calls = []
  const logs = []
  const phases = []
  const inflight = new Set()
  let chain = Promise.resolve()
  let spawnAttempts = 0
  let active = 0
  let maxConcurrent = 0
  let block = null
  let aborted = false

  const setBlock = (code, details = {}) => {
    aborted = true
    if (!block) block = { code, ...details }
    return new BenchmarkBlock(code, `benchmark bloqueado: ${code}`, details)
  }

  const snapshot = () => hashTree(workspaceDir)

  async function doCall(label, prompt, opts) {
    if (aborted) throw abortedError()
    const [prefix, ...rest] = label.split(':')
    const suffix = rest.join(':')
    const mapping = Object.hasOwn(V1_LABEL_MAP, prefix) ? V1_LABEL_MAP[prefix] : null
    if (!mapping) throw setBlock('label_unmapped', { label })
    if (!opts.schema || typeof opts.schema !== 'object' || Array.isArray(opts.schema)) throw setBlock('bridge_invalid_request', { label })
    if (spawnAttempts >= maxCalls) throw setBlock('operational_cap', { limit: maxCalls, label })
    const { grant, nodeKind } = resolveGrant(mapping, String(prompt), suffix, label)
    spawnAttempts++
    const record = {
      label, role: mapping.logicalRole, transportRole: mapping.transportRole, grant, nodeKind,
      sourceModel: opts.model === undefined ? 'session' : opts.model,
      requestedModel: null, effectiveModel: null, usage: null, exitCode: null,
      status: 'inflight', errorCode: null, violation: null, startedAt: new Date().toISOString(), endedAt: null,
    }
    calls.push(record)
    const before = await snapshot()
    active++
    maxConcurrent = Math.max(maxConcurrent, active)
    let handle
    try {
      handle = await hostApi.spawn({ role: mapping.transportRole, prompt, schema: opts.schema, timeoutMs: opts.timeoutMs })
    } catch (error) {
      active--
      record.status = 'failed'
      record.errorCode = error.code ?? 'SPAWN_EXCEPTION'
      record.endedAt = new Date().toISOString()
      setBlock(record.errorCode, { label, cause: error.message })
      throw error
    }
    record.requestedModel = handle?.built?.model ?? null
    inflight.add(handle)
    let result = null
    let failure = null
    try { result = await hostApi.wait(handle) } catch (error) { failure = error }
    inflight.delete(handle)
    active--
    record.endedAt = new Date().toISOString()
    const changed = diffTrees(before, await snapshot())
    const violations = auditWrites(changed, grant)
    if (failure) {
      record.status = 'failed'
      record.errorCode = failure.code ?? 'EXCEPTION'
      record.violation = violations.length ? violations : null
      setBlock(record.errorCode, { label })
      throw failure
    }
    if (violations.length) {
      record.status = 'violation'
      record.violation = violations
      throw setBlock('grant_violation', { label, paths: violations, grant })
    }
    record.status = 'completed'
    record.effectiveModel = result.effectiveModel ?? null
    record.usage = result.usage ?? null
    record.exitCode = result.exitCode ?? null
    record.permissionDenials = Array.isArray(result.permissionDenials) ? result.permissionDenials : []
    return result.output
  }

  // Grant pelo kind do cabeçalho do próprio prompt. Sem cabeçalho do mesmo id, BLOCK antes do spawn.
  function resolveGrant(mapping, prompt, suffix, label) {
    if (mapping.grant !== 'by-node-kind') return { grant: mapping.grant, nodeKind: null }
    const header = NODE_HEADER.exec(prompt)
    if (!header || header[1] !== suffix) throw setBlock('node_kind_missing', { label })
    return { grant: header[2] === 'implement' ? 'product' : 'artifacts', nodeKind: header[2] }
  }

  function agent(prompt, opts = {}) {
    const label = typeof opts.label === 'string' ? opts.label : ''
    const run = () => doCall(label, prompt, opts)
    const result = chain.then(run)
    chain = result.catch(() => {})
    return result
  }

  return {
    agent,
    parallel(fns) { return Promise.all(fns.map(fn => fn())) },
    log(message) { logs.push(String(message)) },
    phase(name) { phases.push(String(name)) },
    budget: { total: 0, remaining: () => Infinity },
    // Interrupção externa (teto de relógio, SIGINT): registra o motivo antes de qualquer erro posterior.
    abort(code, details = {}) { setBlock(code, details) },
    summary() {
      const aggregate = summarizeCalls(calls)
      return {
        calls: calls.map(call => ({ ...call })),
        blocked: Boolean(block),
        block,
        complete: !block && aggregate.complete,
        spawnAttempts,
        maxConcurrent,
        logs: [...logs],
        phases: [...phases],
      }
    },
    async close() {
      aborted = true
      const pending = [...inflight]
      for (const handle of pending) hostApi.cancel(handle)
      await chain.catch(() => {})
      await Promise.allSettled(pending.map(handle => hostApi.wait(handle)))
    },
  }
}

// Rastreia as chamadas do adaptativo pelo hostFactory: papel, requested/effective, usage, cap e handles em voo.
// Falha de métrica não derruba a chamada: fica em metricErrors. Qualquer falha de transporte vira BLOCK.
export function createCallTracker({ maxCalls = DEFAULT_MAX_CALLS } = {}) {
  const calls = []
  const open = new Map()
  const metricErrors = []
  let spawnAttempts = 0
  let block = null
  const now = () => new Date().toISOString()
  const note = fn => {
    try { fn() } catch (error) { metricErrors.push({ code: error?.code ?? 'METRIC_ERROR', message: error?.message ?? String(error) }) }
  }
  const tracker = {
    calls,
    metricErrors,
    get block() { return block },
    get spawnAttempts() { return spawnAttempts },
    get openCount() { return open.size },
    abort(code, details = {}) { if (!block) block = { code, ...details } },
    async cancelAll() {
      const pending = [...open.entries()]
      for (const [handle, entry] of pending) {
        if (entry.record.status === 'inflight') { entry.record.status = 'failed'; entry.record.errorCode = 'CANCELLED'; entry.record.endedAt = now() }
        try { entry.host.cancel(handle) } catch { /* best-effort: a espera abaixo confirma a saída */ }
      }
      await Promise.allSettled(pending.map(([handle, entry]) => Promise.resolve().then(() => entry.host.wait(handle))))
      for (const [handle] of pending) open.delete(handle)
    },
    wrap(host) {
      return {
        ...host,
        async spawn(request) {
          if (block) throw new BenchmarkBlock('tracker_aborted', 'tentativa bloqueada: spawn recusado', { block })
          if (spawnAttempts >= maxCalls) {
            tracker.abort('operational_cap', { limit: maxCalls })
            throw new BenchmarkBlock('operational_cap', `limite operacional de ${maxCalls} chamadas atingido`, { limit: maxCalls })
          }
          spawnAttempts++
          const record = { role: request?.role ?? null, status: 'inflight', requestedModel: null, effectiveModel: null, usage: null, exitCode: null, errorCode: null, startedAt: now(), endedAt: null }
          calls.push(record)
          let handle
          try {
            handle = await host.spawn(request)
          } catch (error) {
            record.status = 'failed'
            record.errorCode = error.code ?? 'SPAWN_EXCEPTION'
            record.endedAt = now()
            tracker.abort(record.errorCode, { role: record.role })
            throw error
          }
          note(() => { record.requestedModel = handle?.built?.model ?? null })
          open.set(handle, { host, record })
          return handle
        },
        async wait(handle) {
          const entry = open.get(handle)
          let result
          try {
            result = await host.wait(handle)
          } catch (error) {
            open.delete(handle)
            if (entry) {
              entry.record.status = 'failed'; entry.record.errorCode = error.code ?? 'EXCEPTION'; entry.record.endedAt = now()
              // O erro do host traz o motivo e o custo da chamada que falhou; sem isso o BLOCK fica opaco.
              note(() => {
                entry.record.errorSubtype = error?.subtype ?? null
                entry.record.errorMessage = typeof error?.message === 'string' ? error.message.slice(0, 2000) : null
                entry.record.effectiveModel = error?.effectiveModel ?? null
                entry.record.usage = error?.usage ?? null
                entry.record.permissionDenials = Array.isArray(error?.permissionDenials) ? error.permissionDenials : []
              })
            }
            tracker.abort(entry?.record.errorCode ?? 'EXCEPTION', { role: entry?.record.role ?? null })
            throw error
          }
          open.delete(handle)
          if (entry) {
            entry.record.status = 'completed'
            entry.record.endedAt = now()
            note(() => {
              entry.record.effectiveModel = result?.effectiveModel ?? null
              entry.record.usage = result?.usage ?? null
              entry.record.exitCode = result?.exitCode ?? null
              entry.record.permissionDenials = Array.isArray(result?.permissionDenials) ? result.permissionDenials : []
            })
          }
          return result
        },
        cancel(handle) { return host.cancel(handle) },
      }
    },
  }
  return tracker
}

// Teto de relógio: a promessa vira BLOCK wall_cap se não resolver a tempo. Quem chama cancela os handles.
export function withWallCap(promise, maxWallMs) {
  let timer = null
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BenchmarkBlock('wall_cap', 'teto de relógio atingido', { limitMs: maxWallMs })), maxWallMs)
  })
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer))
}

// B2: motivo do v1 vem só da estrutura do motor (status e ids dos nós, critic, lacunas). Nunca leva texto livre.
const safeToken = value => String(value ?? '').replace(/[^\w.-]/g, '_').slice(0, 64)
export function v1Reason(result) {
  const bad = (result?.nodes ?? []).find(node => ['blocked', 'failed', 'partial'].includes(node?.status))
  if (bad) return `v1_node_${bad.status}:${safeToken(bad.id)}`
  if (result?.critic && result.critic.done === false) return 'v1_critic_not_done'
  if (Array.isArray(result?.openGaps) && result.openGaps.length) return 'v1_open_gaps'
  return `v1_synth_${safeToken(result?.status ?? 'none')}`
}

// Executa o motor histórico (bytes de 91bf1dc) por compileWorkflow, com a bridge. Não usa runGraph.
export async function runV1({ sourcePath, workspaceDir, hostApi, task, maxCalls = DEFAULT_MAX_CALLS, maxWallMs = DEFAULT_MAX_WALL_MS, simulated = false, extraArgs = {}, compile = compileWorkflow, control = null } = {}) {
  const fn = await compile(sourcePath)
  const bridge = createAgentBridge({ hostApi, workspaceDir, maxCalls })
  if (control) control.abort = (code, details) => { bridge.abort(code, details); return bridge.close() }
  const args = { task, mode: 'implement', effort: 'medium', effortSource: 'manual', checks: ['node --test'], context: '', spec: '', doneWhen: '', runDir: '.benchmark-run/v1', runId: 'bench-v1', ...extraArgs }
  let result = null
  let exception = null
  try {
    result = await withWallCap(fn(args, bridge.agent, bridge.log, bridge.phase, bridge.parallel, bridge.budget, {}), maxWallMs)
  } catch (error) {
    if (error.code === 'wall_cap') bridge.abort('wall_cap', { limitMs: maxWallMs })
    else exception = { code: error.code ?? 'EXCEPTION', message: error.message }
  } finally {
    await bridge.close()
  }
  const summary = bridge.summary()
  return {
    engine: 'v1', simulated,
    reportedStatus: result?.status ? String(result.status).toUpperCase() : null,
    // Só o motivo do motor: o runVariant lê result.feedback.reason para não gravar engine_blocked genérico.
    result: result ? { status: result.status ?? null, feedback: result.feedback ?? result.error ?? v1Reason(result) } : null,
    exception,
    block: summary.block,
    blocked: summary.blocked,
    complete: summary.complete,
    spawnAttempts: summary.spawnAttempts,
    calls: summary.calls,
    maxConcurrent: summary.maxConcurrent,
    metricErrors: [],
  }
}

// Variante adaptativa: executeGrapheng com cwd na cópia limpa, tarefa = task.md, hostFactory com métricas.
export async function runAdaptive({ workspaceDir, host, transportFactory = null, runGraphImpl = null, simulated = false, maxCalls = DEFAULT_MAX_CALLS, maxWallMs = DEFAULT_MAX_WALL_MS, control = null } = {}) {
  const tracker = createCallTracker({ maxCalls })
  if (control) control.abort = (code, details) => { tracker.abort(code, details); return tracker.cancelAll() }
  const task = await readFile(path.join(workspaceDir, 'task.md'), 'utf8')
  const hostFactory = options => {
    if (!transportFactory) return tracker.wrap(createHost(options))
    const fake = transportFactory()
    return tracker.wrap(createHost({ ...options, transport: { spawn: fake.spawn }, killProcess: fake.killProcess }))
  }
  const engineRun = opts => (runGraphImpl ?? runGraph)({ ...opts, hostFactory })
  let result = null
  let exception = null
  try {
    result = await withWallCap(executeGrapheng({ invocation: ['implemente', task, '--effort', 'medium'], cwd: workspaceDir, host, runGraphImpl: engineRun }), maxWallMs)
  } catch (error) {
    if (error.code === 'wall_cap') tracker.abort('wall_cap', { limitMs: maxWallMs })
    else exception = { code: error.code ?? 'EXCEPTION', message: error.message }
  }
  await tracker.cancelAll()
  return {
    engine: 'adaptive', simulated,
    reportedStatus: result?.status ? String(result.status).toUpperCase() : null,
    result,
    block: tracker.block,
    exception,
    calls: tracker.calls,
    spawnAttempts: tracker.spawnAttempts,
    inflight: tracker.openCount,
    metricErrors: tracker.metricErrors,
  }
}

// Baseline de agente único: o modelo forte faz a tarefa inteira numa chamada só, no mesmo workspace limpo.
// O supervisor roda o `npm test` do workspace (node --test) depois da chamada, como no gate final do graph-eng;
// se falhar, a saída volta para uma nova chamada do mesmo modelo, até `rounds`. Escrita só em src/, como pede o task.md.
export const DEFAULT_SINGLE_AGENT_ROUNDS = 3
export const SINGLE_AGENT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: { status: { type: 'string', enum: ['DONE', 'BLOCKED'] }, summary: { type: 'string' } },
  required: ['status', 'summary'],
})

// Todos os papéis no modelo forte; o agente único usa o transporte do executor (escrita no cwd).
export function singleAgentPolicy(host) {
  const base = policyFor(host)
  const strong = MODEL_BY_STRENGTH[host].strong
  const models = Object.fromEntries(Object.keys(base.models).map(role => [role, strong]))
  return { host, name: `agente único no modelo forte (${strong})`, models: Object.freeze(models), readOnly: base.readOnly }
}

export function singleAgentPrompt(task, checkFailure = null) {
  const parts = [
    'Você é o único agente desta tarefa. Leia os arquivos do diretório atual e implemente a tarefa inteira.',
    'Você não tem shell: o supervisor roda `npm test` (node --test) depois da sua resposta.',
    'Responda DONE quando a tarefa estiver completa, ou BLOCKED com o motivo em summary.',
    '',
    task,
  ]
  if (checkFailure) parts.push('', '## Sua resposta anterior não passou no `npm test` do supervisor', 'Saída (final):', '```', checkFailure, '```')
  return parts.join('\n')
}

export async function runSingleAgent({ workspaceDir, hostApi, task, rounds = DEFAULT_SINGLE_AGENT_ROUNDS, maxWallMs = DEFAULT_MAX_WALL_MS, simulated = false, control = null, runChecks = cwd => runNodeTest(cwd) } = {}) {
  const tracker = createCallTracker({ maxCalls: rounds })
  if (control) control.abort = (code, details) => { tracker.abort(code, details); return tracker.cancelAll() }
  const host = tracker.wrap(hostApi)
  const checks = []
  let reportedStatus = null
  let reason = null
  let exception = null
  const loop = async () => {
    let checkFailure = null
    for (let round = 1; round <= rounds; round++) {
      const before = await hashTree(workspaceDir)
      const handle = await host.spawn({ role: 'executor', prompt: singleAgentPrompt(task, checkFailure), schema: SINGLE_AGENT_SCHEMA })
      const result = await host.wait(handle)
      const outside = diffTrees(before, await hashTree(workspaceDir)).filter(file => !file.startsWith('src/'))
      if (outside.length) { tracker.abort('grant_violation', { paths: outside, round }); return }
      if (result.output?.status !== 'DONE') { reportedStatus = 'BLOCKED'; reason = 'single_agent_blocked'; return }
      const check = await runChecks(workspaceDir)
      checks.push({ round, exitCode: check.exitCode, tap: check.tap })
      if (check.exitCode === 0) { reportedStatus = 'DONE'; return }
      checkFailure = check.outputTail
    }
    reportedStatus = 'BLOCKED'
    reason = 'single_agent_checks_failed'
  }
  try {
    await withWallCap(loop(), maxWallMs)
  } catch (error) {
    if (error.code === 'wall_cap') tracker.abort('wall_cap', { limitMs: maxWallMs })
    else exception = { code: error.code ?? 'EXCEPTION', message: error.message }
  }
  await tracker.cancelAll()
  // O transporte é o do executor, mas o papel lógico é o agente único (modelo forte): calls.jsonl e byRole dizem isso.
  for (const call of tracker.calls) call.role = 'singleAgent'
  return {
    engine: 'single-agent', simulated,
    reportedStatus,
    result: reason ? { status: 'blocked', feedback: { reason } } : null,
    block: tracker.block,
    exception,
    calls: tracker.calls,
    checks,
    spawnAttempts: tracker.spawnAttempts,
    inflight: tracker.openCount,
    metricErrors: tracker.metricErrors,
  }
}

// Lê o resumo do TAP do node --test: "# pass N" e "# fail N".
export function parseTap(text) {
  const pass = /^# pass (\d+)\s*$/m.exec(text)
  const fail = /^# fail (\d+)\s*$/m.exec(text)
  return { pass: pass ? Number(pass[1]) : null, fail: fail ? Number(fail[1]) : null }
}

// Roda aceites fora do workspace, numa cópia temporária. Não entra nos números se o aceite foi adulterado.
export async function runAcceptance({ workspaceDir, acceptanceDir, tmpRoot = path.join(EVIDENCE_ROOT, '_eval') } = {}) {
  await mkdir(tmpRoot, { recursive: true })
  const evalDir = await mkdtemp(path.join(tmpRoot, 'eval-'))
  try {
    const wsCopy = path.join(evalDir, 'ws')
    await cp(workspaceDir, wsCopy, { recursive: true, filter: src => !path.relative(workspaceDir, src).split(path.sep).some(seg => seg === 'node_modules' || seg === '.graph-runs' || seg === '.git') })
    const accDir = path.join(wsCopy, '__acceptance__')
    await mkdir(accDir)
    const files = []
    for (const name of (await readdir(acceptanceDir)).sort()) {
      if (!name.endsWith('.mjs.txt')) continue
      const target = name.slice(0, -'.txt'.length)
      await copyFile(path.join(acceptanceDir, name), path.join(accDir, target))
      files.push(path.join('__acceptance__', target))
    }
    return { ...await runNodeTest(wsCopy, files), files: files.map(file => toPosix(file)) }
  } finally {
    await rm(evalDir, { recursive: true, force: true })
  }
}

// node --test com concorrência 2 no cwd. Sem arquivos, usa a descoberta padrão (o `npm test` do workspace).
export async function runNodeTest(cwd, files = []) {
  const started = Date.now()
  let exitCode = 0
  let output = ''
  try {
    // NODE_TEST_CONTEXT herdado de um node --test pai faz o filho reportar pelo IPC e sair com 0: removido para o exit code ser real.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--test', '--test-concurrency=2', ...files], { cwd, env, timeout: EVAL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
    output = stdout + stderr
  } catch (error) {
    if (typeof error.code !== 'number') throw error
    exitCode = error.code
    output = String(error.stdout ?? '') + String(error.stderr ?? '')
  }
  return { exitCode, tap: parseTap(output), durationMs: Date.now() - started, outputTail: output.slice(-2000) }
}

// Quantidade de testes de nível superior nos aceites (cada "test(" é um caso).
export async function countAcceptanceTests(acceptanceDir) {
  let total = 0
  for (const name of (await readdir(acceptanceDir)).sort()) {
    if (!name.endsWith('.mjs.txt')) continue
    total += (await readFile(path.join(acceptanceDir, name), 'utf8')).match(/^test\(/gm)?.length ?? 0
  }
  return total
}

// Avaliador externo: confere os aceites contra o manifesto antes de rodar. PASS exige exit 0, "# fail 0" e "# pass" igual ao esperado.
// DONE declarado + FAIL externo = falseDone.
export async function evaluateExternal({ workspaceDir, acceptanceDir, expectedAcceptanceHashes, expectedPass, reportedStatus, tmpRoot } = {}) {
  const actual = await hashTree(acceptanceDir)
  const keys = new Set([...Object.keys(expectedAcceptanceHashes), ...Object.keys(actual)])
  const mismatches = [...keys].filter(key => expectedAcceptanceHashes[key] !== actual[key]).sort()
  if (mismatches.length) throw new BenchmarkBlock('acceptance_tampered', 'aceites diferem do manifesto', { mismatches })
  const wanted = expectedPass ?? await countAcceptanceTests(acceptanceDir)
  const run = await runAcceptance({ workspaceDir, acceptanceDir, tmpRoot })
  const passed = run.exitCode === 0 && run.tap.fail === 0 && run.tap.pass === wanted
  const externalStatus = passed ? 'PASS' : 'FAIL'
  return {
    reportedStatus: reportedStatus ?? null,
    externalStatus,
    exitCode: run.exitCode,
    expectedPass: wanted,
    tap: run.tap,
    durationMs: run.durationMs,
    falseDone: reportedStatus === 'DONE' && externalStatus !== 'PASS',
  }
}

// C: usage em duas formas. Codex: input_tokens/output_tokens direto. Claude: modelUsage por modelo (camelCase),
// com cache de leitura e criação somado à entrada e exposto à parte em cacheInputTokens.
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  if (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number') {
    return { input: typeof usage.input_tokens === 'number' ? usage.input_tokens : null, output: typeof usage.output_tokens === 'number' ? usage.output_tokens : null, cacheInputTokens: typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : null }
  }
  const entries = Object.values(usage).filter(entry => entry && typeof entry === 'object')
  const KEYS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']
  if (!entries.some(entry => KEYS.some(key => typeof entry[key] === 'number'))) return null
  const sum = key => entries.map(entry => entry[key]).filter(value => typeof value === 'number').reduce((total, value) => total + value, 0)
  const cacheInputTokens = sum('cacheReadInputTokens') + sum('cacheCreationInputTokens')
  return { input: sum('inputTokens') + cacheInputTokens, output: sum('outputTokens'), cacheInputTokens }
}

// Métricas: null quando não medido, zero informado é preservado, parcial nunca vira completo.
export function summarizeCalls(calls, { expectedCalls } = {}) {
  const byRole = {}
  let failed = 0
  let inflight = 0
  let completed = 0
  for (const call of calls) {
    byRole[call.role] = (byRole[call.role] ?? 0) + 1
    if (call.status === 'failed' || call.status === 'violation') failed++
    else if (call.status === 'inflight') inflight++
    else if (call.status === 'completed') completed++
  }
  const total = calls.length
  const present = (predicate) => calls.filter(predicate)
  const models = field => {
    const values = [...new Set(calls.map(call => call[field]).filter(value => value !== null && value !== undefined))].sort()
    return { value: values.length ? values : null, coverage: `${present(call => call[field] != null).length}/${total}` }
  }
  const tokens = field => {
    const values = calls.map(call => normalizeUsage(call.usage)?.[field]).filter(value => typeof value === 'number')
    return { value: values.length ? values.reduce((sum, value) => sum + value, 0) : null, coverage: `${values.length}/${total}` }
  }
  return {
    total,
    byRole,
    completed,
    failed,
    inflight,
    complete: inflight === 0 && failed === 0 && (expectedCalls === undefined || total === expectedCalls),
    fields: {
      requestedModel: models('requestedModel'),
      effectiveModel: models('effectiveModel'),
      usage: { coverage: `${present(call => call.usage !== null && call.usage !== undefined).length}/${total}` },
      inputTokens: tokens('input'),
      outputTokens: tokens('output'),
      // Maior entrada de uma chamada (soma dos turnos dela, cache incluso): o "maior contexto" comparável entre variantes.
      maxCallInputTokens: (() => {
        const values = calls.map(call => normalizeUsage(call.usage)?.input).filter(value => typeof value === 'number')
        return { value: values.length ? Math.max(...values) : null, coverage: `${values.length}/${total}` }
      })(),
      // Só o Claude informa custo (modelUsage[*].costUSD, preço de tabela); Codex fica null.
      costUSD: (() => {
        const values = calls.map(call => callCostUSD(call.usage)).filter(value => typeof value === 'number')
        return { value: values.length ? values.reduce((sum, value) => sum + value, 0) : null, coverage: `${values.length}/${total}` }
      })(),
    },
  }
}

export function callCostUSD(usage) {
  if (!usage || typeof usage !== 'object') return null
  const costs = Object.values(usage).map(entry => entry?.costUSD).filter(value => typeof value === 'number')
  return costs.length ? costs.reduce((sum, value) => sum + value, 0) : null
}

// Pasta opcional da fixture (contract-v2 só existe no benchmark-v2): ausente vale árvore vazia, e criá-la depois diverge do manifesto.
async function hashTreeIfExists(dir) {
  return existsSync(dir) ? hashTree(dir) : {}
}

async function treeDigest(dir, pattern) {
  const names = (await readdir(dir)).filter(name => pattern.test(name)).sort()
  const parts = []
  for (const name of names) parts.push(`${name}\0${sha256(await readFile(path.join(dir, name)))}`)
  return sha256(parts.join('\n'))
}

export async function buildManifest({ id, host, scenario = 'happy', repoRoot = REPO_ROOT, fixtureDir = fixtureDirFor(scenario), evidenceDir, baseline, checks = ['node --test'] } = {}) {
  if (!HOSTS.includes(host)) throw new TypeError(`host desconhecido: ${host}`)
  if (!SCENARIOS.includes(scenario)) throw new TypeError(`cenário desconhecido: ${scenario}`)
  const bin = path.join(repoRoot, 'bin')
  const fileSha = async rel => sha256(await readFile(path.join(repoRoot, rel)))
  const policy = policyFor(host)
  return {
    schemaVersion: 2,
    id,
    host,
    scenario,
    createdAt: new Date().toISOString(),
    fixtureDir: path.resolve(fixtureDir),
    fixture: {
      workspace: await hashTree(path.join(fixtureDir, 'workspace')),
      acceptance: await hashTree(path.join(fixtureDir, 'acceptance')),
      reference: await hashTree(path.join(fixtureDir, 'reference')),
      contractV2: await hashTreeIfExists(path.join(fixtureDir, 'contract-v2')),
    },
    acceptance: { expectedPass: await countAcceptanceTests(path.join(fixtureDir, 'acceptance')) },
    baseline: { commit: BASELINE.commit, path: BASELINE.path, bytes: baseline.bytes, sha256: baseline.sha256, file: path.relative(evidenceDir, baseline.path) },
    bridge: { file: 'bin/graph-benchmark.mjs', sha256: await fileSha('bin/graph-benchmark.mjs') },
    transport: { file: 'bin/hosts.mjs', sha256: await fileSha('bin/hosts.mjs') },
    compiler: { file: 'bin/workflow-source.mjs', sha256: await fileSha('bin/workflow-source.mjs') },
    engine: { adaptiveTreeSha256: await treeDigest(bin, /\.mjs$/), workflowFile: 'workflows/graph-eng.js', workflowSha256: await fileSha('workflows/graph-eng.js') },
    packageFile: 'package.json',
    packageSha256: await fileSha('package.json'),
    policy,
    policySha256: sha256(JSON.stringify(policy)),
    labelMap: V1_LABEL_MAP,
    labelMapSha256: sha256(JSON.stringify(V1_LABEL_MAP)),
    checks,
    effort: 'medium',
    economy: 'balanced',
    ceiling: 24,
    maxCalls: DEFAULT_MAX_CALLS,
    maxWallMs: DEFAULT_MAX_WALL_MS,
    nodeVersion: process.version,
    cli: { codex: 'not-probed', claude: 'not-probed' },
  }
}

// Recalcula todos os hashes do manifesto. Divergência em qualquer um bloqueia antes de qualquer spawn.
export async function verifyManifest(manifestPath, { repoRoot = REPO_ROOT } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const dir = path.dirname(manifestPath)
  const mismatches = []
  const dirs = { workspace: 'workspace', acceptance: 'acceptance', reference: 'reference', contractV2: 'contract-v2' }
  for (const [key, folder] of Object.entries(dirs)) {
    const actual = await hashTreeIfExists(path.join(manifest.fixtureDir, folder))
    const expected = manifest.fixture[key]
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
    for (const file of [...keys].sort()) if (expected[file] !== actual[file]) mismatches.push(`fixture.${key}:${file}`)
  }
  if (sha256(await readFile(path.join(dir, manifest.baseline.file))) !== manifest.baseline.sha256) mismatches.push('baseline')
  for (const key of ['bridge', 'transport', 'compiler']) {
    if (sha256(await readFile(path.join(repoRoot, manifest[key].file))) !== manifest[key].sha256) mismatches.push(key)
  }
  if (await treeDigest(path.join(repoRoot, 'bin'), /\.mjs$/) !== manifest.engine.adaptiveTreeSha256) mismatches.push('engine')
  if (sha256(await readFile(path.join(repoRoot, manifest.engine.workflowFile))) !== manifest.engine.workflowSha256) mismatches.push('workflow')
  if (sha256(await readFile(path.join(repoRoot, manifest.packageFile))) !== manifest.packageSha256) mismatches.push('package')
  const expectedPolicy = JSON.stringify(policyFor(manifest.host))
  if (JSON.stringify(manifest.policy) !== expectedPolicy || sha256(expectedPolicy) !== manifest.policySha256) mismatches.push('policy')
  if (sha256(JSON.stringify(V1_LABEL_MAP)) !== manifest.labelMapSha256) mismatches.push('labelMap')
  return { ok: mismatches.length === 0, mismatches }
}

// Executa uma tentativa de uma variante. Nunca apaga tentativa: run.json nasce inflight e recebe status final.
// Workspace próprio em <GRAPH_ENG_STATE_DIR>/benchmarks/<id>/<variante>-<tentativa>/workspace, fora do repo.
export async function runVariant({ manifestPath, variant, outDir, transportFactory = null, repoRoot = REPO_ROOT, workspaceRoot = benchmarkWorkspaceRoot(), maxWallMs = DEFAULT_MAX_WALL_MS, runGraphImpl = null } = {}) {
  if (!VARIANTS.includes(variant)) throw new TypeError(`variante desconhecida: ${variant}`)
  if (existsSync(outDir)) throw new BenchmarkBlock('attempt_exists', `tentativa já existe em ${outDir}: nada é apagado nem repetido`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const base = { id: manifest.id, host: manifest.host, variant, scenario: manifest.scenario, simulated: Boolean(transportFactory), attemptId: randomUUID(), manifestSha256: sha256(JSON.stringify(manifest)), policy: variant === 'v1-normalized' ? manifest.policy.name : variant === 'single-agent' ? singleAgentPolicy(manifest.host).name : 'produto atual (createHost sem política)' }
  await mkdir(outDir, { recursive: true })
  const runPath = path.join(outDir, 'run.json')
  const startedAt = new Date().toISOString()
  await writeFile(runPath, JSON.stringify({ ...base, status: 'inflight', attempted: false, block: null, reason: null, startedAt, endedAt: null }, null, 2))
  const finish = async fields => {
    const run = { ...base, startedAt, endedAt: new Date().toISOString(), ...fields }
    await writeFile(runPath, JSON.stringify(run, null, 2))
    return run
  }
  const verified = await verifyManifest(manifestPath, { repoRoot })
  if (!verified.ok) return finish({ status: 'BLOCK', attempted: false, block: { code: 'manifest_mismatch', mismatches: verified.mismatches }, reason: 'manifest_mismatch', reportedStatus: null, externalStatus: null, falseDone: false, complete: false, summary: null })
  // Cenário contract-change exige retomada com A v2 aplicada pelo supervisor: ainda não implementada.
  // Sem essa etapa, rodar como happy seria fallback silencioso; por isso BLOCK antes de qualquer spawn.
  if (manifest.scenario === 'contract-change') return finish({ status: 'BLOCK', attempted: false, block: { code: 'scenario_not_implemented', scenario: 'contract-change' }, reason: 'scenario_not_implemented', reportedStatus: null, externalStatus: null, falseDone: false, complete: false, summary: null })
  const workspace = path.join(workspaceRoot, manifest.id, `${variant}-${base.attemptId.slice(0, 8)}`, 'workspace')
  if (isInside(REPO_ROOT, workspace)) return finish({ status: 'BLOCK', attempted: false, block: { code: 'workspace_inside_repo', workspace }, reason: 'workspace_inside_repo', reportedStatus: null, externalStatus: null, falseDone: false, complete: false, summary: null, workspace })
  // B1: segmento .claude no caminho faz o Claude Code negar Write; BLOCK antes de gastar chamada.
  if (workspace.split(path.sep).includes('.claude')) return finish({ status: 'BLOCK', attempted: false, block: { code: 'workspace_under_protected_dir', workspace }, reason: 'workspace_under_protected_dir', reportedStatus: null, externalStatus: null, falseDone: false, complete: false, summary: null, workspace })
  await mkdir(path.dirname(workspace), { recursive: true })
  await prepareWorkspace({ fixtureDir: manifest.fixtureDir, destDir: workspace })
  await initWorkspaceRepo(workspace)
  const fake = variant !== 'adaptive' && transportFactory ? transportFactory() : null
  const hostOptions = { host: manifest.host, cwd: workspace, runDir: path.join(outDir, 'host-runs'), runId: `${manifest.id}-${variant}` }
  // Sinal: registra BLOCK cancelled sem apagar nada e cancela os handles em voo. Segundo sinal: comportamento padrão.
  const control = {}
  const onSignal = signal => {
    if (control.signal) {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      process.kill(process.pid, signal)
      return
    }
    control.signal = signal
    try {
      writeFileSync(runPath, JSON.stringify({ ...base, status: 'BLOCK', attempted: true, block: { code: 'cancelled', signal }, reason: 'cancelled', reportedStatus: null, externalStatus: null, falseDone: false, complete: false, summary: null, startedAt, endedAt: new Date().toISOString() }, null, 2))
    } catch { /* o run.json final, mais abaixo, substitui este registro */ }
    if (control.abort) void control.abort('cancelled', { signal })
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const engineStart = Date.now()
  let engine
  try {
    if (variant === 'v1-normalized') {
      const policy = policyFor(manifest.host)
      assertPolicyKeys(policy)
      const hostApi = createHost({ ...hostOptions, experimentalPolicy: policy, ...(fake ? { transport: { spawn: fake.spawn }, killProcess: fake.killProcess } : {}) })
      engine = await runV1({ sourcePath: path.join(path.dirname(manifestPath), manifest.baseline.file), workspaceDir: workspace, hostApi, task: await readFile(path.join(manifest.fixtureDir, 'workspace', 'task.md'), 'utf8'), maxCalls: manifest.maxCalls, maxWallMs, simulated: base.simulated, control })
    } else if (variant === 'single-agent') {
      const hostApi = createHost({ ...hostOptions, experimentalPolicy: singleAgentPolicy(manifest.host), ...(fake ? { transport: { spawn: fake.spawn }, killProcess: fake.killProcess } : {}) })
      engine = await runSingleAgent({ workspaceDir: workspace, hostApi, task: await readFile(path.join(workspace, 'task.md'), 'utf8'), maxWallMs, simulated: base.simulated, control })
    } else {
      engine = await runAdaptive({ workspaceDir: workspace, host: manifest.host, transportFactory, simulated: base.simulated, maxCalls: manifest.maxCalls, maxWallMs, control, runGraphImpl })
    }
  } catch (error) {
    const isBlock = error instanceof BenchmarkBlock
    engine = { simulated: base.simulated, reportedStatus: null, block: isBlock ? { code: error.code, message: error.message } : null, exception: isBlock ? null : { code: error.code ?? 'EXCEPTION', message: error.message }, calls: [], spawnAttempts: 0, metricErrors: [] }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  const engineMs = Date.now() - engineStart
  const calls = engine.calls ?? []
  const summary = summarizeCalls(calls, {})
  let evaluation
  try {
    evaluation = await evaluateExternal({ workspaceDir: workspace, acceptanceDir: path.join(manifest.fixtureDir, 'acceptance'), expectedAcceptanceHashes: manifest.fixture.acceptance, expectedPass: manifest.acceptance.expectedPass, reportedStatus: engine.reportedStatus, tmpRoot: path.join(workspaceRoot, '_eval', base.attemptId) })
  } catch (error) {
    evaluation = { reportedStatus: engine.reportedStatus ?? null, externalStatus: null, exitCode: null, durationMs: 0, falseDone: false, block: { code: error.code ?? 'EVALUATOR_EXCEPTION', message: error.message } }
  }
  const block = engine.block ?? evaluation.block ?? null
  const exception = engine.exception ?? null
  const feedback = engine.result?.feedback
  const feedbackReason = typeof feedback === 'string' ? feedback : feedback?.reason
  const engineBlocked = engine.reportedStatus === 'BLOCKED' ? { code: feedbackReason ?? 'engine_blocked' } : null
  const finalBlock = block ?? engineBlocked ?? (exception ? { code: 'engine_exception', message: exception.message } : null)
  const status = finalBlock ? 'BLOCK' : evaluation.externalStatus === 'PASS' ? 'PASS' : 'FAIL'
  await writeFile(path.join(outDir, 'calls.jsonl'), calls.map(call => JSON.stringify(call)).join('\n') + (calls.length ? '\n' : ''))
  await writeFile(path.join(outDir, 'external-eval.json'), JSON.stringify(evaluation, null, 2))
  return finish({
    status,
    attempted: (engine.spawnAttempts ?? calls.length) > 0,
    block: finalBlock,
    reason: finalBlock?.code ?? null,
    reportedStatus: engine.reportedStatus ?? null,
    externalStatus: evaluation.externalStatus ?? null,
    falseDone: evaluation.falseDone ?? false,
    complete: !finalBlock && summary.complete,
    summary,
    workspace,
    durationMs: { engine: engineMs, evaluator: evaluation.durationMs ?? 0 },
    engineMs,
    evaluatorMs: evaluation.durationMs ?? 0,
    exception,
    metricErrors: engine.metricErrors ?? [],
    ...(engine.checks ? { checks: engine.checks } : {}),
  })
}

// Grava evidência nova; nunca sobrescreve (flag wx). Destino existente recusa com evidence_exists.
export async function writeNewEvidence(file, text) {
  try {
    await writeFile(file, text, { flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') throw new BenchmarkBlock('evidence_exists', `evidência já existe: ${file}; nada é sobrescrito`, { file })
    throw error
  }
}

// archive: copia a evidência da run (ignorada pelo git em .graph-runs) para docs/benchmarks/runs/<id>/, versionada,
// e regera docs/benchmarks/RESULTADOS.md com todas as runs arquivadas. Não copia workspace nem baseline v1.
export const ARCHIVE_ROOT = path.join(REPO_ROOT, 'docs', 'benchmarks')
const ARCHIVED_RUN_FILES = new Set(['manifest.json', 'report.json'])
const ARCHIVED_VARIANT_FILE = /^(run\.json|calls\.jsonl|external-eval(-[\w-]+)?\.json)$/

export async function archiveRun(manifestPath, { archiveRoot = ARCHIVE_ROOT } = {}) {
  const dir = path.dirname(manifestPath)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const dest = path.join(archiveRoot, 'runs', manifest.id)
  await mkdir(dest, { recursive: true })
  const copied = []
  for (const name of (await readdir(dir)).sort()) {
    if (ARCHIVED_RUN_FILES.has(name)) { await copyFile(path.join(dir, name), path.join(dest, name)); copied.push(name) }
  }
  for (const variant of VARIANTS) {
    const variantDir = path.join(dir, `variant-${variant}`)
    if (!existsSync(variantDir)) continue
    await mkdir(path.join(dest, `variant-${variant}`), { recursive: true })
    for (const name of (await readdir(variantDir)).sort()) {
      if (!ARCHIVED_VARIANT_FILE.test(name)) continue
      await copyFile(path.join(variantDir, name), path.join(dest, `variant-${variant}`, name))
      copied.push(`variant-${variant}/${name}`)
    }
  }
  await writeFile(path.join(archiveRoot, 'RESULTADOS.md'), await renderArchivedResults(archiveRoot))
  return { dest, copied }
}

const readJson = async file => JSON.parse(await readFile(file, 'utf8').catch(() => 'null'))

// Uma linha por variante arquivada. Custo, tokens e maior contexto saem do calls.jsonl, então valem também para runs antigas.
export async function renderArchivedResults(archiveRoot = ARCHIVE_ROOT) {
  const runsDir = path.join(archiveRoot, 'runs')
  const rows = []
  for (const id of existsSync(runsDir) ? (await readdir(runsDir)).sort() : []) {
    for (const variant of VARIANTS) {
      const variantDir = path.join(runsDir, id, `variant-${variant}`)
      const run = await readJson(path.join(variantDir, 'run.json'))
      if (!run) continue
      const evaluation = await readJson(path.join(variantDir, 'external-eval.json'))
      const callsText = await readFile(path.join(variantDir, 'calls.jsonl'), 'utf8').catch(() => '')
      const fields = summarizeCalls(callsText.split('\n').filter(Boolean).map(line => JSON.parse(line))).fields
      const tap = evaluation?.tap ? `${evaluation.tap.pass ?? '?'}/${evaluation.expectedPass ?? '?'}` : '—'
      const num = (value, digits = 0) => (typeof value === 'number' ? value.toFixed(digits) : '—')
      const k = value => (typeof value === 'number' ? `${Math.round(value / 1000)}k` : '—')
      rows.push(`| ${id} | ${run.scenario} | ${run.host} | ${variant} | ${run.status} | ${cell(run.reason)} | ${cell(run.reportedStatus)} | ${cell(run.externalStatus)} ${tap} | ${cell(run.falseDone)} | ${run.summary?.total ?? '—'} | ${typeof fields.costUSD.value === 'number' ? `US$ ${num(fields.costUSD.value, 2)}` : '—'} | ${num(typeof run.engineMs === 'number' ? run.engineMs / 1000 : null)} | ${k(fields.maxCallInputTokens.value)} | ${k(fields.inputTokens.value)} / ${k(fields.outputTokens.value)} |`)
    }
  }
  return [
    '# Resultados das runs reais',
    '',
    'Gerado por `node bin/graph-benchmark.mjs archive`. Não edite à mão. Leitura e contexto: `docs/validation/graph-eng-2-benchmark.md`.',
    '',
    '| run | cenário | host | variante | status | motivo | reportedStatus | externo | falso DONE | chamadas | custo | motor (s) | maior contexto | entrada / saída |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

// eval: reavalia cada variante com run.json e grava external-eval-<ts>.json (novo). A evidência da run não muda.
export async function runEval(manifestPath) {
  const verified = await verifyManifest(manifestPath)
  if (!verified.ok) throw new BenchmarkBlock('manifest_mismatch', 'manifesto diverge; eval não roda', { mismatches: verified.mismatches })
  const dir = path.dirname(manifestPath)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = []
  for (const variant of VARIANTS) {
    const variantDir = path.join(dir, `variant-${variant}`)
    const run = JSON.parse(await readFile(path.join(variantDir, 'run.json'), 'utf8').catch(() => 'null'))
    if (!run?.workspace) continue
    const evaluation = await evaluateExternal({ workspaceDir: run.workspace, acceptanceDir: path.join(manifest.fixtureDir, 'acceptance'), expectedAcceptanceHashes: manifest.fixture.acceptance, expectedPass: manifest.acceptance.expectedPass, reportedStatus: run.reportedStatus, tmpRoot: path.join(workspaceRoot0(), '_eval', stamp, variant) })
    const file = path.join(variantDir, `external-eval-${stamp}.json`)
    await writeNewEvidence(file, JSON.stringify(evaluation, null, 2))
    out.push({ variant, file, ...evaluation })
  }
  return out
}

function workspaceRoot0() { return path.join(benchmarkStateDir(), 'benchmarks') }

// Relatório: linhas fixas da matriz sempre presentes. NOT_RUN não recebe métrica nem percentual.
export function buildReport(runs) {
  const rows = runs.map(run => ({
    host: run.host,
    variant: run.variant,
    scenario: run.scenario,
    status: run.status ?? 'NOT_RUN',
    attempted: run.attempted ?? false,
    real: run.simulated === true ? false : run.status !== 'NOT_RUN',
    reason: run.reason ?? null,
    reportedStatus: run.reportedStatus ?? null,
    externalStatus: run.externalStatus ?? null,
    falseDone: run.falseDone ?? null,
    calls: run.status === 'NOT_RUN' ? null : run.summary?.byRole ?? null,
    coverage: run.status === 'NOT_RUN' ? null : run.summary?.fields ?? null,
    complete: run.status === 'NOT_RUN' ? null : run.complete ?? false,
    durationMs: run.status === 'NOT_RUN' ? null : run.durationMs ?? null,
    simulated: run.simulated === true,
  }))
  return {
    rows,
    fixed: [
      { host: 'claude', variant: 'HISTÓRICO CLAUDE (sonnet/sessão)', status: 'BLOCK / NOT_RUN', reason: 'organização bloqueia assinatura; sem remapeamento' },
      { host: 'codex', variant: 'planner barato histórico (fora de escopo)', status: 'fora de escopo', reason: 'não entra no produto nem no benchmark' },
    ],
  }
}

export function stripTiming(value) {
  if (Array.isArray(value)) return value.map(stripTiming)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !VOLATILE.has(key)).map(([key, item]) => [key, stripTiming(item)]))
  }
  return value
}

const cell = value => (value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value))

export function renderReport(report, { includeTiming = true } = {}) {
  const lines = [
    '| host | variante | cenário | status | attempted | real | motivo | reportedStatus | externalStatus | falseDone | calls por papel | complete | cobertura | duração motor/avaliador (ms) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const row of report.rows) {
    lines.push(`| ${row.host} | ${row.variant} | ${row.scenario} | ${row.status} | ${row.attempted} | ${row.real} | ${cell(row.reason)} | ${cell(row.reportedStatus)} | ${cell(row.externalStatus)} | ${cell(row.falseDone)} | ${cell(row.calls)} | ${cell(row.complete)} | ${cell(row.coverage)} | ${includeTiming ? cell(row.durationMs) : '—'} |`)
  }
  for (const row of report.fixed) lines.push(`| ${row.host} | ${row.variant} | — | ${row.status} | false | false | ${row.reason} | — | — | — | — | — | — | — |`)
  return lines.join('\n') + '\n'
}

// CLI: prepare|run|eval|report|verify|archive. Só o caminho `run` sem transporte injetado chama CLI real.
export function parseBenchmarkArgs(argv) {
  const [command, ...tail] = argv
  if (!['prepare', 'run', 'eval', 'report', 'verify', 'archive'].includes(command)) throw new Error(`comando desconhecido: ${command}; use prepare, run, eval, report, verify ou archive`)
  const options = {}
  for (let i = 0; i < tail.length; i += 2) {
    const flag = tail[i]
    const value = tail[i + 1]
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`opção inválida: ${flag}`)
    options[flag.slice(2)] = value
  }
  if (options.host !== undefined && !HOSTS.includes(options.host)) throw new Error(`host desconhecido: ${options.host}; use codex ou claude`)
  if (options.variant !== undefined && !VARIANTS.includes(options.variant)) throw new Error(`variant desconhecida: ${options.variant}; use v1-normalized, adaptive ou single-agent`)
  if (options.scenario !== undefined && !SCENARIOS.includes(options.scenario)) throw new Error(`scenario desconhecido: ${options.scenario}; use ${SCENARIOS.join(', ')}`)
  const out = path.resolve(REPO_ROOT, options.out ?? '.graph-runs/benchmarks')
  if (out !== EVIDENCE_ROOT && !out.startsWith(EVIDENCE_ROOT + path.sep)) throw new Error('--out precisa estar em .graph-runs/benchmarks')
  let manifest
  if (options.manifest !== undefined) {
    manifest = path.resolve(options.manifest)
    if (!manifest.startsWith(EVIDENCE_ROOT + path.sep)) throw new Error('--manifest precisa estar em .graph-runs/benchmarks')
  }
  let maxWallMs
  if (options['max-wall-ms'] !== undefined) {
    maxWallMs = Number(options['max-wall-ms'])
    if (!Number.isInteger(maxWallMs) || maxWallMs <= 0) throw new Error('--max-wall-ms precisa ser inteiro positivo em milissegundos')
  }
  return { command, host: options.host, variant: options.variant, scenario: options.scenario, manifest, out, maxWallMs }
}

function print(value) { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n') }

async function main(argv) {
  const args = parseBenchmarkArgs(argv)
  if (args.command === 'prepare') {
    if (!args.host) throw new Error('prepare exige --host')
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
    const id = `bench-${args.host}-${args.scenario ?? 'happy'}-${stamp}-${randomUUID().slice(0, 4)}`
    const dir = path.join(args.out, id)
    const baseline = await extractBaseline({ repoRoot: REPO_ROOT, destDir: path.join(dir, 'baseline') })
    const manifest = await buildManifest({ id, host: args.host, scenario: args.scenario ?? 'happy', evidenceDir: dir, baseline })
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    print({ status: 'PREPARED', id, manifest: path.join(dir, 'manifest.json'), baselineSha256: baseline.sha256 })
    return 0
  }
  if (!args.manifest) throw new Error(`${args.command} exige --manifest`)
  const manifestPath = args.manifest
  const dir = path.dirname(manifestPath)
  if (args.command === 'verify') {
    const verified = await verifyManifest(manifestPath)
    print(verified)
    return verified.ok ? 0 : 2
  }
  if (args.command === 'run') {
    if (!args.variant) throw new Error('run exige --variant')
    const verified = await verifyManifest(manifestPath)
    if (!verified.ok) { print({ status: 'BLOCK', reason: 'manifest_mismatch', mismatches: verified.mismatches }); return 2 }
    const run = await runVariant({ manifestPath, variant: args.variant, outDir: path.join(dir, `variant-${args.variant}`), ...(args.maxWallMs ? { maxWallMs: args.maxWallMs } : {}) })
    print({ status: run.status, reason: run.reason, attempted: run.attempted, externalStatus: run.externalStatus, workspace: run.workspace })
    return run.status === 'BLOCK' ? 2 : 0
  }
  if (args.command === 'archive') {
    print(await archiveRun(manifestPath))
    return 0
  }
  if (args.command === 'eval') {
    print(await runEval(manifestPath))
    return 0
  }
  if (args.command === 'report') {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const runs = []
    for (const variant of VARIANTS) {
      const file = path.join(dir, `variant-${variant}`, 'run.json')
      const run = JSON.parse(await readFile(file, 'utf8').catch(() => 'null'))
      runs.push(run ?? { host: manifest.host, variant, scenario: manifest.scenario, status: 'NOT_RUN', attempted: false, reason: 'sem execução nesta sessão' })
    }
    const report = buildReport(runs)
    await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2))
    print(renderReport(report))
    return 0
  }
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => { process.stderr.write(`graph-benchmark: ${error.message}\n`); process.exitCode = 2 })
}
