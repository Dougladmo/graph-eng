// Harness de teste do workflow (D1 §12): o arquivo inteiro, sem `export const meta`, roda como
// AsyncFunction, com os globais que o host do Workflow injeta (args, agent, log, phase, parallel,
// budget). Exportado para test/target.test.mjs, test/workflow-rails.test.mjs e para o teste de
// paridade de I3 (graph-watch).
import { compileWorkflow, ENGINE_PATH } from '../../bin/workflow-source.mjs'
import { allocateBudget, areasForImplementIds, polishAffectedClosure, polishRevalidationBudget, normalizeBudgetNodes, resolveBudgetMode, validateBudgetDag } from '../../bin/budget-policy.mjs'
export { ENGINE_PATH }

// script(label, prompt, opts) => resultado estruturado (ou null, como agent() pode devolver).
export async function runWorkflow(args, script, options = {}) {
  let testReceiptSeq = 0
  let eventSeq = 0
  const suppliedRuntime = options.runtime === undefined ? {
    host: 'test',
    models: { planner: 'test-strong', planReviewer: 'test-strong', designReviewer: 'test-strong', executor: 'test-cheap', verifier: 'test-cheap', critic: 'test-strong', synth: 'test-cheap' },
    capabilities: { checks: true, fingerprint: true, readOnlyEnforced: true },
    snapshot: async () => ({ schemaVersion: 2, identity: 'test-delivery-identity', evidencePath: 'test/snapshot.json', evidenceHash: 'test-snapshot-hash', manifestSpecs: {} }),
    fingerprint: async () => ({ schemaVersion: 2, identity: 'test-node-identity' }),
    runChecks: async ({ snapshot, checks }) => checks.map(check => ({ schemaVersion: 2, id: `test-receipt-${++testReceiptSeq}`, runId: 'test-run', checkId: check.id, identity: snapshot.identity, valid: true, evidencePath: `test/receipt-${testReceiptSeq}.json`, evidenceHash: `test-receipt-hash-${testReceiptSeq}` })),
    verifyArtifact: async artifact => Boolean(artifact?.evidencePath && artifact?.evidenceHash),
    emit: async event => ({ ...event, seq: ++eventSeq }),
    saveState: async value => value,
    // C9: backup do polish feito pelo supervisor (fake: só refs; o runner real grava os bytes).
    backupPolishArea: async ({ files }) => ({ backupDir: `${args.runDir || '.graph-runs/test'}/polish-backups/fake`, files: files.map(file => ({ path: file, kind: 'file', executable: false, sha256: 'a'.repeat(64), backupPath: `${args.runDir || '.graph-runs/test'}/polish-backups/fake/${file}` })) }),
  } : options.runtime
  // runtime: null simula ausência de runtime confiável: o motor precisa bloquear sozinho, sem ser mascarado pelo helper.
  const workflowRuntime = suppliedRuntime === null ? null : { ...suppliedRuntime, allocateBudget: suppliedRuntime.allocateBudget || allocateBudget, areasForImplementIds: suppliedRuntime.areasForImplementIds || areasForImplementIds, polishAffectedClosure: suppliedRuntime.polishAffectedClosure || polishAffectedClosure, polishRevalidationBudget: suppliedRuntime.polishRevalidationBudget || polishRevalidationBudget, normalizeBudgetNodes: suppliedRuntime.normalizeBudgetNodes || normalizeBudgetNodes, resolveBudgetMode: suppliedRuntime.resolveBudgetMode || resolveBudgetMode, validateBudgetDag: suppliedRuntime.validateBudgetDag || validateBudgetDag }
  const calls = []
  const logs = []
  let live = 0
  let maxLive = 0
  const agent = async (prompt, opts) => {
    live++
    maxLive = Math.max(maxLive, live)
    calls.push(opts.label)
    try {
      await Promise.resolve()
      const value = await script(opts.label, prompt, opts)
      // O host:test preserva as rotas históricas das regressões enquanto o contrato v2 é testado
      // diretamente com runtime explícito de host de produção.
      if (workflowRuntime?.host === 'test' && value) {
        const kind = String(opts.label).split(':')[0]
        const feedback = kind === 'plan-review' ? { kind: 'APPROVE', reason: 'stub de teste', severity: 'none', affectedNodes: [], evidenceIds: [] }
          : kind === 'design-review' && value.pass === true ? { kind: 'APPROVE', reason: 'stub de teste', severity: 'none', affectedNodes: [], evidenceIds: [] }
            : kind === 'design-review' && value.pass === false ? { kind: value.blocking?.length ? 'FIX_LOCAL' : 'BLOCK', reason: 'stub de teste', severity: 'high', affectedNodes: (value.blocking || []).map(item => item.node).filter(Boolean), evidenceIds: [] }
            : kind === 'critic' && value.done === true ? { kind: 'DONE', reason: 'stub de teste', severity: 'none', affectedNodes: [], evidenceIds: [] } : null
        let adapted = feedback && !value.feedback ? { ...value, feedback } : value
        if (kind === 'critic' && value.done === true && !value.finalEvidence) {
          const identity = prompt.match(/Final delivery identity: ([^\s]+)/)?.[1]
          const receiptText = prompt.match(/Verified supervisor receipts: (\[[^\n]+\])/)?.[1]
          const criterionText = prompt.match(/Criterion references: (\[[^\n]+\])/)?.[1]
          if (identity && receiptText && criterionText) {
            const receipts = JSON.parse(receiptText)
            const criteria = JSON.parse(criterionText)
            const refs = [...receipts.map(receipt => receipt.id), `snapshot:${identity}`]
            adapted = { ...adapted, criteria: criteria.map(item => ({ criterion: item.criterion, met: true, evidence: 'evidência simulada pelo runtime host:test', evidenceIds: refs.slice(0, 1) })), finalEvidence: { identity, receiptIds: receipts.map(receipt => receipt.id), criterionIds: criteria.map(item => item.id) } }
          }
        }
        return adapted
      }
      return value
    } finally {
      live--
    }
  }
  const fn = await compileWorkflow(options.sourcePath || ENGINE_PATH)
  const result = await fn(
    args,
    agent,
    (m) => logs.push(String(m)),
    (p) => calls.push('#' + p),
    (fns) => Promise.all(fns.map((f) => f())),
    { total: 0, remaining: () => Infinity },
    workflowRuntime,
  )
  return { result, calls, logs, maxLive }
}

// Stub padrão: responde por prefixo do rótulo, do jeito que a maioria dos testes precisa.
// `routes` pode sobrescrever por prefixo exato (ex.: 'design-review') com uma função (label, prompt) => valor,
// ou um valor fixo.
export function defaultScript(routes) {
  const R = routes || {}
  return async (label, prompt, opts) => {
    const prefix = label.split(':')[0]
    if (R[prefix]) {
      const v = typeof R[prefix] === 'function' ? R[prefix](label, prompt, opts) : R[prefix]
      return v
    }
    if (R[label]) return typeof R[label] === 'function' ? R[label](label, prompt, opts) : R[label]
    if (prefix === 'plan') return R.plan || { goal: 'g', complexity: 'moderate', doneWhen: ['ok'], nodes: [], effort: { level: 'medium', why: 'default' } }
    if (prefix === 'work' || prefix === 'repair' || prefix === 'design-repair' || prefix === 'polish' || prefix === 'draft-a' || prefix === 'draft-b' || prefix === 'judge') {
      return { status: 'done', summary: label + ' ok', confidence: 'high', checks: [] }
    }
    if (prefix === 'verify' || prefix === 'escalate') return { pass: true, confidence: 'high', blocking: [] }
    if (prefix === 'plan-review') return { feedback: { kind: 'APPROVE', reason: 'plano aprovado', severity: 'none', affectedNodes: [], evidenceIds: [] } }
    if (prefix === 'design-review') return { feedback: { kind: 'APPROVE', reason: 'design aprovado', severity: 'none', affectedNodes: [], evidenceIds: [] }, pass: true, confidence: 'high', blocking: [], checked: { assumptions: true, acceptance: true, stories: false, bestPractices: true } }
    if (prefix === 'critic') return { feedback: { kind: 'DONE', reason: 'critérios atendidos', severity: 'none', affectedNodes: [], evidenceIds: [] }, done: true, assessment: 'ok', gaps: [] }
    if (prefix === 'synth') return { summary: 'ok', humanGate: [] }
    return null
  }
}

// B5: runner real com evidência real. Cria fixture git temporária (src/a.js + test/a.test.mjs +
// package.json com node --test), aprova a política node-check-policy-v1 com o CheckSpec node-test
// real, e executa runGraph com createEvidence real (snapshot, fingerprint, checks reais).
// O host fake só traduz script(label, prompt, opts, ctx) em spawn/wait. Não há host:'test',
// nem janela/proveniência emulada, nem política removida.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runGraph } from '../../bin/graph-run.mjs'
import { NODE_CHECK_MAPPING_HASH, NODE_CHECK_POLICY_ID } from '../../bin/node-check-policy.mjs'

export const B5_NODE_CHECK = { id: 'node-test', command: process.execPath, args: ['--test', '--test-concurrency=2'], cwd: '.', timeoutMs: 1_800_000, heavy: true }
export const B5_POLICY = { id: NODE_CHECK_POLICY_ID, mappingHash: NODE_CHECK_MAPPING_HASH, adapter: 'node-test-v1', concurrency: 2 }

// Identidade final e critérios do critic, extraídos do prompt real (mesma fonte que graph-run usa).
export function criticDoneFromPrompt(prompt) {
  const identity = prompt.match(/Final delivery identity: ([^\s]+)/)?.[1]
  const receipts = JSON.parse(prompt.match(/Verified supervisor receipts: (\[[^\n]+\])/)?.[1] || '[]')
  const criteria = JSON.parse(prompt.match(/Criterion references: (\[[^\n]+\])/)?.[1] || '[]')
  return {
    criteria: criteria.map(item => ({ criterion: item.criterion, met: true, evidence: 'checkpoint e evidências verificados', evidenceIds: [`snapshot:${identity}`] })),
    finalEvidence: { identity, receiptIds: receipts.map(item => item.id), criterionIds: criteria.map(item => item.id) },
  }
}

// Preenche só o que falta no DONE do critic. Um finalEvidence fornecido pelo script (inclusive null)
// nunca é sobrescrito: o script pode forjar a evidência e o motor precisa recusá-la, não o helper.
export function withScriptedCriticEvidence(label, output, prompt) {
  if (!String(label || '').startsWith('critic:') || output?.done !== true || Object.hasOwn(output, 'finalEvidence')) return output
  const derived = criticDoneFromPrompt(prompt)
  return { ...output, criteria: output.criteria ?? derived.criteria, finalEvidence: derived.finalEvidence }
}

export async function createB5Fixture(t, { withB = false, withC = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'graph-b5-'))
  const cwd = path.join(base, 'repo')
  await mkdir(path.join(cwd, 'src'), { recursive: true })
  await mkdir(path.join(cwd, 'test'), { recursive: true })
  const packageBytes = Buffer.from('{"name":"fixture","scripts":{"test":"node --test"}}\n')
  await writeFile(path.join(cwd, 'src/a.js'), 'export const a = 1\n')
  await writeFile(path.join(cwd, 'test/a.test.mjs'), 'import test from "node:test"; import assert from "node:assert/strict"; import { a } from "../src/a.js"; test("a", () => assert.equal(a, 1))\n')
  // withB: segundo arquivo disjunto (src/b.js + test/b.test.mjs), para planos com dois nós implement.
  if (withB) {
    await writeFile(path.join(cwd, 'src/b.js'), 'export const b = 1\n')
    await writeFile(path.join(cwd, 'test/b.test.mjs'), 'import test from "node:test"; import assert from "node:assert/strict"; import { b } from "../src/b.js"; test("b", () => assert.equal(b, 1))\n')
  }
  // withC: terceiro arquivo disjunto (src/c.js + test/c.test.mjs): três implements dão uma área de polish com dois nós.
  if (withC) {
    await writeFile(path.join(cwd, 'src/c.js'), 'export const c = 1\n')
    await writeFile(path.join(cwd, 'test/c.test.mjs'), 'import test from "node:test"; import assert from "node:assert/strict"; import { c } from "../src/c.js"; test("c", () => assert.equal(c, 1))\n')
  }
  await writeFile(path.join(cwd, 'package.json'), packageBytes)
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  git('add', '.')
  git('commit', '-qm', 'fixture b5')
  t.after(() => rm(base, { recursive: true, force: true }))
  return { base, cwd, checkContract: { path: 'package.json', sha256: createHash('sha256').update(packageBytes).digest('hex'), source: 'scripts.test=node --test' } }
}

// runGraphScripted(t, { args, script, workflowCompiler }) => { result, events, calls, cwd, runDir }
// fixture: reaproveita o repo de uma run anterior (resume no mesmo cwd e stateDir).
export async function runGraphScripted(t, { args = {}, script = defaultScript(), workflowCompiler, fixture: reusedFixture, fixtureOptions } = {}) {
  const fixture = reusedFixture || await createB5Fixture(t, fixtureOptions)
  const { cwd } = fixture
  const calls = []
  const runDir = args.runDir || 'runs/b5'
  const ctx = { cwd, runDir }
  const host = {
    capabilities: () => ({ structuredOutput: true, host: 'codex', readOnlyEnforced: true, readOnlyEnforcement: 'stub de teste' }),
    spawn: async request => ({ request }),
    wait: async handle => {
      const { request } = handle
      calls.push(request.label)
      let output = await script(request.label, request.prompt, request, ctx)
      output = withScriptedCriticEvidence(request.label, output, request.prompt)
      return { output, requestedModel: request.model, effectiveModel: request.model, usage: null }
    },
  }
  const result = await runGraph({
    hostName: 'codex', cwd, stateDir: path.join(fixture.base, 'state'),
    args: { task: 'b5', mode: 'implement', effort: 'max', runId: args.runId || 'b5-run', runDir, checks: [B5_NODE_CHECK], checkContract: fixture.checkContract, nodeCheckPolicy: B5_POLICY, ...args },
    hostFactory: () => host,
    ...(workflowCompiler ? { workflowCompiler } : {}),
  })
  const journal = await readFile(path.join(cwd, runDir, 'journal.jsonl'), 'utf8').catch(() => '')
  const events = journal.trim() ? journal.trim().split('\n').map(line => JSON.parse(line)) : []
  return { result, events, calls, cwd, runDir, fixture }
}
