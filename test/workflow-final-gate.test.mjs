import assert from 'node:assert/strict'
import test from 'node:test'
import { runWorkflow, defaultScript, runGraphScripted, withScriptedCriticEvidence } from './helpers/run-workflow.mjs'
import { compileWorkflow } from '../bin/workflow-source.mjs'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const CHECKS = [{ id: 'unit', command: 'node', args: ['--test'] }]
const PLAN = {
  goal: 'entrega', complexity: 'moderate', mode: 'implement', doneWhen: ['comportamento correto'],
  effort: { level: 'max', why: 'teste' },
  nodes: [
    { id: 'R1', title: 'pesquisa', kind: 'research', brief: 'r', deps: [], risk: 'low', acceptance: ['evidência'] },
    { id: 'D1', title: 'design', kind: 'design', brief: 'd', deps: ['R1'], risk: 'low', acceptance: ['decisão'] },
    { id: 'I1', title: 'implementação', kind: 'implement', brief: 'i', deps: ['D1'], files: ['src/a.js'], risk: 'low', acceptance: ['ok'] },
  ],
}
const BASE = { task: 'gate final', plan: PLAN, mode: 'implement', effort: 'max', runDir: '.graph-runs/test', checks: CHECKS }
const POLICY = { id: 'node-check-policy-v1', mappingHash: 'a'.repeat(64), adapter: 'node-test-v1', concurrency: 2 }
const models = { planner: 'test', planReviewer: 'test', designReviewer: 'test', executor: 'test', verifier: 'test', critic: 'test', synth: 'test' }

function fakeRuntime(overrides = {}) {
  let snapshotCount = 0
  let receiptCount = 0
  let eventSeq = 0
  const states = []
  const events = []
  return {
    host: 'test', models, capabilities: { checks: true, fingerprint: true, readOnlyEnforced: true },
    // C9: fixture do backup do polish feito pelo supervisor (só refs).
    backupPolishArea: async ({ files }) => ({ backupDir: '.graph-runs/test/polish-backups/fake', files: files.map(file => ({ path: file, kind: 'file', executable: false, sha256: 'a'.repeat(64), backupPath: `.graph-runs/test/polish-backups/fake/${file}` })) }),
    snapshot: async () => {
      snapshotCount++
      overrides.trace?.push('snapshot')
      return { identity: overrides.identityAt?.(snapshotCount) || 'delivery-A', evidencePath: `snap-${snapshotCount}.json`, evidenceHash: `snap-hash-${snapshotCount}`, manifestSpecs: {} }
    },
    fingerprint: async (...args) => overrides.fingerprint ? overrides.fingerprint(...args) : ({ identity: 'node-A' }),
    emit: async event => { events.push(event); overrides.trace?.push(event); return { ...event, seq: ++eventSeq } },
    saveState: async state => {
      overrides.beforeSaveState?.(state)
      if (overrides.failSaveAtStage === state.control?.stage) throw new Error('persistência simulada falhou')
      states.push(structuredClone(state))
    },
    states,
    events,
    verifyArtifact: async artifact => overrides.verifyArtifact ? overrides.verifyArtifact(artifact) : Boolean(artifact?.evidencePath && artifact?.evidenceHash),
    ...(overrides.policy ? {
      approveCheckNodes: async ({ planVersion, nodes }) => { overrides.trace?.push(['approve', planVersion, nodes]) },
      beginCheckNode: async ({ planVersion, nodeId }) => { overrides.trace?.push(['begin-node', planVersion, nodeId]); return { windowId: `node-${nodeId}` } },
      beginCheckWindow: async ({ phase, planVersion, nodeIds }) => { overrides.trace?.push(['begin-window', phase, planVersion, nodeIds]); return { windowId: `window-${nodeIds.join('-')}` } },
      endCheckWindow: async ({ windowId }) => { overrides.trace?.push(['end-window', windowId]); return { actualChangedPaths: [] } },
    } : {}),
    runChecks: async ({ snapshot, checks, phase, nodeId, planVersion, windowId }) => {
      overrides.trace?.push('checks')
      if (overrides.policy) {
        if (phase === 'node') assert.equal(windowId, `node-${nodeId}`)
        const checkIds = phase === 'final' ? ['unit'] : []
        const checkSpecs = phase === 'final' ? CHECKS : []
        const selection = { policyId: POLICY.id, mappingHash: POLICY.mappingHash, phase, nodeId: nodeId || null, planVersion: planVersion || null, files: [], actualChangedPaths: [], coverage: phase === 'final' ? 'complete' : 'syntax-contract-only', limitation: phase === 'final' ? null : 'mapping incompleto', checkIds, checkSpecs, hash: 'b'.repeat(64) }
        return { selection, receipts: checkIds.map(checkId => ({ id: `receipt-${++receiptCount}`, runId: 'run', checkId, identity: overrides.receiptIdentity || snapshot.identity, valid: overrides.receiptValid !== false, evidencePath: `receipt-${receiptCount}.json`, evidenceHash: `receipt-hash-${receiptCount}` })) }
      }
      return checks.map(check => ({ id: `receipt-${++receiptCount}`, runId: 'run', checkId: check.id, identity: overrides.receiptIdentity || snapshot.identity, valid: overrides.receiptValid !== false, evidencePath: `receipt-${receiptCount}.json`, evidenceHash: `receipt-hash-${receiptCount}` }))
    },
  }
}

test('gate final conclui com receipts e três snapshots idênticos após polish', async () => {
  const trace = []
  const defaults = defaultScript()
  const { result, calls } = await runWorkflow(BASE, async (label, prompt, opts) => {
    if (['polish:1', 'critic:r1', 'synth'].includes(label)) trace.push(label)
    return defaults(label, prompt, opts)
  }, { runtime: fakeRuntime({ trace }) })
  assert.equal(result.status, 'done')
  assert.equal(result.finalEvidence.identity, 'delivery-A')
  assert.deepEqual(calls.filter(label => ['polish:1', 'critic:r1', 'synth'].includes(label)), ['polish:1', 'critic:r1', 'synth'])
  assert.ok(trace.indexOf('polish:1') < trace.lastIndexOf('checks'))
  assert.ok(trace.lastIndexOf('checks') < trace.indexOf('critic:r1'))
  assert.ok(trace.indexOf('critic:r1') < trace.indexOf('synth'))
  assert.equal(result.finalEvidence.receiptIds.length, 1)
})

test('FIX_LOCAL do critic repara grant existente e repete polish, checks e critic', async t => {
  let criticCalls = 0
  const defaults = defaultScript()
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: B5_PLAN }, script: async (label, prompt, opts, ctx) => {
    if (label === 'critic:r1' && criticCalls++ === 0) return { feedback: { kind: 'FIX_LOCAL', reason: 'ajustar I1', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] }, done: false, gaps: [] }
    if (label === 'repair:I1') await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// ajuste do repair\n')
    return defaults(label, prompt, opts)
  } })
  assert.equal(result.status, 'done', JSON.stringify(result).slice(0, 1500))
  assert.equal(result.budget.localRepairsUsed, 1)
  assert.equal(calls.filter(label => label === 'repair:I1').length, 1)
  assert.deepEqual(calls.filter(label => ['polish:1', 'critic:r1', 'critic:r2'].includes(label)), ['polish:1', 'critic:r1', 'polish:1', 'critic:r2'])
  assert.equal(events.filter(event => event.type === 'checks.selection.completed').length >= 4, true)
})

test('REPLAN do critic exige planner e reviewer fortes e repete os gates com versão nova', async t => {
  const candidate = structuredClone(B5_PLAN)
  candidate.nodes.find(node => node.id === 'I1').brief = 'implementação replanejada'
  const defaults = defaultScript()
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: B5_PLAN }, script: async (label, prompt, opts, ctx) => {
    if (label === 'critic:r1') return { feedback: { kind: 'REPLAN', reason: 'contrato incompleto', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] }, done: false, gaps: [] }
    if (label === 'plan') return candidate
    if (label === 'plan-review:replan-1-1') return { feedback: { kind: 'APPROVE', reason: 'plano replanejado completo', severity: 'none', affectedNodes: [], evidenceIds: [] } }
    return defaults(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, planVersion: result.planVersion }))
  assert.equal(result.planVersion, 2)
  assert.ok(calls.includes('plan'))
  assert.ok(calls.includes('plan-review:replan-1-1'))
  assert.ok(calls.includes('critic:r2'))
  assert.equal(calls.filter(label => label === 'polish:1').length, 2)
  assert.ok(events.some(event => event.type === 'checks.nodes.approved' && event.payload?.planVersion === 2))
})

test('regressão: replan do critic recebe o doneWhen travado e não bloqueia por critérios fora de ordem', async t => {
  const plan = { ...structuredClone(B5_PLAN), doneWhen: ['critério um', 'critério dois'] }
  const candidate = structuredClone(plan)
  candidate.nodes.find(node => node.id === 'I1').brief = 'implementação replanejada'
  candidate.doneWhen = ['critério dois', 'critério um']
  const defaults = defaultScript()
  let planner = null
  const { result } = await runGraphScripted(t, { args: { plan }, script: async (label, prompt, opts, ctx) => {
    if (label === 'critic:r1') return { feedback: { kind: 'REPLAN', reason: 'contrato incompleto', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] }, done: false, gaps: [] }
    if (label === 'plan') { planner = { prompt, schema: opts.schema }; return structuredClone(candidate) }
    if (label === 'plan-review:replan-1-1') return { feedback: { kind: 'APPROVE', reason: 'plano replanejado completo', severity: 'none', affectedNodes: [], evidenceIds: [] } }
    return defaults(label, prompt, opts, ctx)
  } })
  assert.ok(planner, 'o planner do replan precisa rodar')
  assert.match(planner.prompt, /critério um/)
  const doneWhen = planner.schema.properties.doneWhen
  assert.deepEqual([...doneWhen.items.enum].sort(), ['critério dois', 'critério um'])
  assert.equal(doneWhen.minItems, 2)
  assert.equal(doneWhen.maxItems, 2)
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, planVersion: result.planVersion }))
  assert.equal(result.planVersion, 2)
})

test('regressão: schema do critic exige um item por critério, com o texto travado', async t => {
  const plan = { ...structuredClone(B5_PLAN), doneWhen: ['critério um', 'critério dois'] }
  const defaults = defaultScript()
  let schema = null
  await runGraphScripted(t, { args: { plan }, script: async (label, prompt, opts, ctx) => {
    if (label === 'critic:r1') schema = opts.schema
    return defaults(label, prompt, opts, ctx)
  } })
  assert.ok(schema, 'o critic precisa rodar')
  const criteria = schema.properties.criteria
  assert.equal(criteria.minItems, 2)
  assert.equal(criteria.maxItems, 2)
  assert.deepEqual([...criteria.items.properties.criterion.enum].sort(), ['critério dois', 'critério um'])
})

test('replacement aprovado só com metadata bloqueia sem instalar nova versão', async t => {
  const metadataOnly = structuredClone(B5_PLAN)
  metadataOnly.questions = ['pergunta diferente']
  metadataOnly.effort.why = 'justificativa diferente'
  const defaults = defaultScript()
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_PLAN }, script: async (label, prompt, opts, ctx) => {
    if (label === 'critic:r1') return { feedback: { kind: 'REPLAN', reason: 'replanejar I1', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] }, done: false, gaps: [] }
    if (label === 'plan') return metadataOnly
    if (label === 'plan-review:replan-1-1') return { feedback: { kind: 'APPROVE', reason: 'plano aprovado', severity: 'none', affectedNodes: [], evidenceIds: [] } }
    return defaults(label, prompt, opts, ctx)
  } })
  assert.notEqual(result.status, 'done')
  assert.equal(result.planVersion, 1)
  assert.equal(result.budget.structuralReplansUsed, 1)
  assert.equal(calls.filter(label => label === 'work:I1').length, 1)
  assert.equal(calls.filter(label => label === 'polish:1').length, 1)
  assert.ok(calls.includes('plan-review:replan-1-1'))
  assert.ok(!calls.includes('critic:r2'))
})

test('feedback igual no mesmo estado bloqueia antes do segundo reparo com cota restante', async t => {
  const defaults = defaultScript()
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: B5_PLAN }, script: async (label, prompt, opts, ctx) => {
    if (label === 'critic:r1' || label === 'critic:r2') return { feedback: { kind: 'FIX_LOCAL', reason: 'ajustar I1', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] }, done: false, gaps: [] }
    return defaults(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'blocked')
  assert.equal(result.critic.feedback.reason, 'no_progress_feedback_loop')
  assert.equal(result.budget.localRepairsUsed, 1)
  assert.equal(calls.filter(label => label.startsWith('critic:r')).length, 2)
  assert.equal(calls.filter(label => label === 'repair:I1').length, 1)
  assert.ok(events.some(event => event.type === 'control.transition' && event.payload?.checkpoint?.control?.seenPairs?.length === 1 && event.payload.checkpoint.control.counters?.localRepairsUsed === 1))
})

test('falha ao persistir FIX_LOCAL do critic bloqueia antes do worker de reparo', async () => {
  const script = defaultScript({ critic: () => ({ feedback: { kind: 'FIX_LOCAL', reason: 'corrigir I1', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] }, done: false, gaps: [] }) })
  const { result, calls } = await runWorkflow(BASE, script, { runtime: fakeRuntime({ failSaveAtStage: 'feedback-dispatch' }) })
  assert.equal(result.status, 'blocked')
  assert.equal(result.critic.feedback.reason, 'control_persistence_failed', JSON.stringify({ result, calls }))
  assert.ok(!calls.includes('repair:I1'))
})

test('FIX_LOCAL do reviewer do replacement persiste intent antes da correção forte', async t => {
  const candidate = structuredClone(B5_PLAN)
  candidate.nodes.find(node => node.id === 'I1').brief = 'replanejado'
  const correction = structuredClone(candidate)
  correction.nodes.find(node => node.id === 'I1').acceptance = ['contrato corrigido']
  let planCalls = 0
  const seen = []
  const defaults = defaultScript()
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_PLAN }, script: async (label, prompt, opts, ctx) => {
    if (label === 'critic:r1') return { feedback: { kind: 'REPLAN', reason: 'replanejar I1', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] }, done: false, gaps: [] }
    if (label === 'plan') {
      seen.push(lastControl(ctx))
      return planCalls++ === 0 ? candidate : correction
    }
    if (label === 'plan-review:replan-1-1') return { feedback: { kind: 'FIX_LOCAL', reason: 'corrigir contrato', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] } }
    if (label === 'plan-review:replan-1-2') return { feedback: { kind: 'APPROVE', reason: 'replacement aprovado', severity: 'none', affectedNodes: [], evidenceIds: [] } }
    return defaults(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, nodes: result.nodes, planVersion: result.planVersion, budget: result.budget, calls }))
  assert.equal(seen[0]?.stage, 'feedback-dispatch')
  assert.equal(seen[1]?.counters?.localRepairsUsed, 1)
  assert.equal(result.budget.localRepairsUsed, 1)
  assert.deepEqual(calls.filter(label => label === 'plan' || label.startsWith('plan-review:replan-')), ['plan', 'plan-review:replan-1-1', 'plan', 'plan-review:replan-1-2'])
})

test('REPLAN do reviewer pode consumir a segunda cota estrutural e chamar planner novamente', async t => {
  const firstCandidate = structuredClone(B5_PLAN)
  firstCandidate.nodes.find(node => node.id === 'I1').brief = 'primeiro replanejamento'
  const secondCandidate = structuredClone(firstCandidate)
  secondCandidate.nodes.find(node => node.id === 'I1').acceptance = ['aceite do segundo replanejamento']
  let planCalls = 0
  const defaults = defaultScript()
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_PLAN }, script: async (label, prompt, opts, ctx) => {
    if (label === 'critic:r1') return { feedback: { kind: 'REPLAN', reason: 'replanejar I1', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] }, done: false, gaps: [] }
    if (label === 'plan') return planCalls++ === 0 ? firstCandidate : secondCandidate
    if (label === 'plan-review:replan-1-1') return { feedback: { kind: 'REPLAN', reason: 'segunda tentativa estrutural', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] } }
    if (label === 'plan-review:replan-2-2') return { feedback: { kind: 'APPROVE', reason: 'plano completo aprovado', severity: 'none', affectedNodes: [], evidenceIds: [] } }
    return defaults(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, nodes: result.nodes, planVersion: result.planVersion, budget: result.budget, calls }))
  assert.equal(result.budget.structuralReplansUsed, 2)
  assert.ok(calls.includes('plan-review:replan-1-1'))
  assert.ok(calls.includes('plan-review:replan-2-2'))
  assert.equal(calls.filter(label => label === 'plan').length, 2)
})

test('FIX_LOCAL de design persiste contador e repete a revisão antes da implementação', async t => {
  const defaults = defaultScript()
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_PLAN }, script: async (label, prompt, opts, ctx) => {
    if (label === 'design-review:r1') return { feedback: { kind: 'FIX_LOCAL', reason: 'ajustar design', severity: 'high', affectedNodes: ['D1'], evidenceIds: [] }, pass: false, confidence: 'high', blocking: [{ node: 'D1', issue: 'contrato incompleto', where: 'D1', fix: 'completar contrato' }], checked: { assumptions: true, acceptance: true, stories: false, bestPractices: true } }
    return defaults(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, critic: result.critic }))
  assert.equal(result.budget.localRepairsUsed, 1)
  assert.ok(calls.includes('design-repair:D1'))
  assert.ok(calls.includes('design-review:r2'))
})

test('REPLAN de design chama planner+reviewer e repete os gates na versão instalada', async t => {
  const candidate = structuredClone(B5_PLAN)
  candidate.nodes.find(node => node.id === 'D1').brief = 'design replanejado'
  const defaults = defaultScript()
  let didReplan = false
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_PLAN }, script: async (label, prompt, opts, ctx) => {
    if (label === 'design-review:r1' && !didReplan) { didReplan = true; return { feedback: { kind: 'REPLAN', reason: 'contrato do design incompleto', severity: 'high', affectedNodes: ['D1'], evidenceIds: [] }, pass: false, confidence: 'high', blocking: [], checked: { assumptions: true, acceptance: true, stories: false, bestPractices: true } } }
    if (label === 'plan') return candidate
    if (label === 'plan-review:replan-1-1') return { feedback: { kind: 'APPROVE', reason: 'plano completo', severity: 'none', affectedNodes: [], evidenceIds: [] } }
    return defaults(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, critic: result.critic, budget: result.budget, calls, nodes: result.nodes }))
  assert.equal(result.planVersion, 2)
  assert.equal(result.budget.structuralReplansUsed, 1)
  assert.ok(calls.includes('plan-review:replan-1-1'))
  assert.equal(calls.filter(label => label.startsWith('design-review:')).length, 2)
})

test('os dois reparos locais são globais entre planner e design, e critic bloqueia antes de escrever', async t => {
  const candidate = structuredClone(B5_PLAN)
  candidate.nodes.find(node => node.id === 'R1').brief = 'pesquisa corrigida'
  const defaults = defaultScript()
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_PLAN }, script: async (label, prompt, opts, ctx) => {
    if (label === 'plan-review:r1') return { feedback: { kind: 'FIX_LOCAL', reason: 'corrigir plano', severity: 'high', affectedNodes: ['R1'], evidenceIds: [] } }
    if (label === 'plan') return candidate
    if (label === 'design-review:r1') return { feedback: { kind: 'FIX_LOCAL', reason: 'corrigir design', severity: 'high', affectedNodes: ['D1'], evidenceIds: [] }, pass: false, confidence: 'high', blocking: [{ node: 'D1', issue: 'contrato incompleto', where: 'D1', fix: 'ajustar' }], checked: { assumptions: true, acceptance: true, stories: false, bestPractices: true } }
    if (label === 'critic:r1') return { feedback: { kind: 'FIX_LOCAL', reason: 'corrigir implementação', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] }, done: false, gaps: [] }
    return defaults(label, prompt, opts, ctx)
  } })
  assert.notEqual(result.status, 'done')
  assert.equal(result.budget.localRepairsUsed, 2)
  assert.ok(calls.includes('design-repair:D1'))
  assert.ok(!calls.includes('repair:I1'))
  assert.equal(result.critic.feedback.reason, 'local_repair_budget_exhausted')
})

test('seleção aprovada por nó chega ao verify e gate final usa seleção completa após polish', async t => {
  let verifyPromptText = ''
  const defaults = defaultScript()
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: B5_PLAN }, script: async (label, prompt, opts, ctx) => {
    if (label === 'verify:I1') verifyPromptText = prompt
    return defaults(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, error: result.error }))
  assert.match(verifyPromptText, /Supervisor local check selection/)
  assert.match(verifyPromptText, /syntax-contract-only/)
  assert.equal(events.some(event => event.type === 'checks.nodes.approved' && event.payload?.planVersion === 1 && event.payload.nodes.some(node => node.id === 'I1' && node.files.includes('src/a.js'))), true)
  assert.ok(calls.indexOf('work:I1') < calls.indexOf('verify:I1'))
  assert.equal(result.finalEvidence.selection.coverage, 'complete')
  assert.ok(result.finalEvidence.receiptIds.length)
})

test('implement sem CheckSpec bloqueia antes de executar qualquer nó', async () => {
  const { result, calls } = await runWorkflow({ ...BASE, checks: [] }, defaultScript(), { runtime: fakeRuntime() })
  assert.equal(result.feedback.reason, 'required_checks_missing')
  assert.ok(!calls.some(label => label.startsWith('work:')))
})

test('string legada não é dividida nem executada', async () => {
  const { result, calls } = await runWorkflow({ ...BASE, checks: ['npm test && echo unsafe'] }, defaultScript(), { runtime: fakeRuntime() })
  assert.equal(result.feedback.reason, 'invalid_required_checks')
  assert.match(result.feedback.detail, /string legada/)
  assert.ok(!calls.some(label => label.startsWith('work:')))
})

test('receipt inválido bloqueia verificação do nó', async () => {
  const { result, calls } = await runWorkflow(BASE, defaultScript(), { runtime: fakeRuntime({ receiptValid: false }) })
  assert.notEqual(result.status, 'done')
  assert.ok(!calls.includes('verify:I1'))
})

test('receipt de identidade stale bloqueia a verificação do nó', async () => {
  const { result, calls } = await runWorkflow(BASE, defaultScript(), { runtime: fakeRuntime({ receiptIdentity: 'stale-delivery' }) })
  assert.notEqual(result.status, 'done')
  assert.ok(!calls.includes('verify:I1'))
})

function criticWithWrongIdentity() {
  const script = defaultScript({ critic: (label, prompt) => {
    const identity = prompt.match(/Final delivery identity: ([^\s]+)/)?.[1]
    const receipt = JSON.parse(prompt.match(/Verified supervisor receipts: (\[[^\n]+\])/)?.[1] || '[]')[0]
    return { done: true, assessment: 'ok', gaps: [], feedback: { kind: 'DONE', reason: 'ok', severity: 'none', affectedNodes: [], evidenceIds: [] }, criteria: [{ criterion: 'comportamento correto', met: true, evidence: 'ok', evidenceIds: [receipt.id] }], finalEvidence: { identity: identity + '-wrong', receiptIds: [receipt.id], criterionIds: ['criterion-1'] } }
  } })
  return script
}

test('critic com identidade diferente não promove DONE', async () => {
  const { result } = await runWorkflow(BASE, criticWithWrongIdentity(), { runtime: fakeRuntime() })
  assert.notEqual(result.status, 'done')
  assert.equal(result.finalEvidence, null)
})

test('critic não pode citar evidência que não existe no supervisor', async () => {
  const script = defaultScript({ critic: (_label, prompt) => {
    const identity = prompt.match(/Final delivery identity: ([^\s]+)/)?.[1]
    const receipt = JSON.parse(prompt.match(/Verified supervisor receipts: (\[[^\n]+\])/)?.[1] || '[]')[0]
    return { done: true, assessment: 'ok', gaps: [], feedback: { kind: 'DONE', reason: 'ok', severity: 'none', affectedNodes: [], evidenceIds: [] }, criteria: [{ criterion: 'comportamento correto', met: true, evidence: 'ok', evidenceIds: ['receipt-fabricado'] }], finalEvidence: { identity, receiptIds: [receipt.id], criterionIds: ['criterion-1'] } }
  } })
  const { result } = await runWorkflow(BASE, script, { runtime: fakeRuntime() })
  assert.notEqual(result.status, 'done')
  assert.equal(result.finalEvidence, null)
})

test('mudança durante o critic bloqueia a identidade final', async () => {
  const { result } = await runWorkflow(BASE, defaultScript(), { runtime: fakeRuntime({ identityAt: n => n === 3 ? 'delivery-B' : 'delivery-A' }) })
  assert.notEqual(result.status, 'done')
  assert.equal(result.finalEvidence, null)
})

test('mutação durante synth também bloqueia DONE', async () => {
  const { result } = await runWorkflow(BASE, defaultScript(), { runtime: fakeRuntime({ identityAt: n => n === 4 ? 'delivery-B' : 'delivery-A' }) })
  assert.notEqual(result.status, 'done')
  assert.equal(result.finalEvidence, null)
})

test('polidor sem retorno mantém sua área como falha e impede DONE', async () => {
  const script = defaultScript({ polish: () => null })
  const { result } = await runWorkflow(BASE, script, { runtime: fakeRuntime() })
  assert.equal(result.polish.length, 1)
  assert.equal(result.polish[0].status, 'blocked')
  assert.notEqual(result.status, 'done')
})

test('polidor que lança erro também mantém sua área como falha', async () => {
  const script = defaultScript({ polish: () => { throw new Error('polish falhou') } })
  const { result } = await runWorkflow(BASE, script, { runtime: fakeRuntime() })
  assert.equal(result.polish.length, 1)
  assert.equal(result.polish[0].status, 'blocked')
  assert.notEqual(result.status, 'done')
})

test('modo sem área de polish continua permitido', async () => {
  const researchPlan = { ...PLAN, mode: 'research', nodes: [PLAN.nodes[0]] }
  const { result } = await runWorkflow({ ...BASE, mode: 'research', plan: researchPlan }, defaultScript(), { runtime: fakeRuntime() })
  assert.deepEqual(result.polish, [])
  assert.equal(result.status, 'done')
})

test('synth nulo, malformado ou com erro nunca permite DONE', async t => {
  for (const [label, route] of [['nulo', () => null], ['malformado', () => ({ summary: 'sem humanGate' })], ['erro', () => { throw new Error('synth falhou') }]]) {
    await t.test(label, async () => {
      const { result } = await runWorkflow(BASE, defaultScript({ synth: route }), { runtime: fakeRuntime() })
      assert.notEqual(result.status, 'done')
      assert.equal(result.summary, null)
    })
  }
})

test('worker partial não vira done por aprovação do verifier', async () => {
  const defaults = defaultScript()
  const script = (label, prompt, opts) => label === 'work:I1'
    ? { status: 'partial', summary: 'incompleto', confidence: 'high' }
    : defaults(label, prompt, opts)
  const { result, calls } = await runWorkflow(BASE, script, { runtime: fakeRuntime() })
  assert.equal(result.nodes.find(node => node.id === 'I1').status, 'partial')
  assert.ok(!calls.includes('verify:I1'))
  assert.notEqual(result.status, 'done')
})

test('reparo blocked ou partial não é promovido por um segundo verifier', async t => {
  const defaults = defaultScript()
  for (const workerStatus of ['blocked', 'partial']) {
    await t.test(workerStatus, async () => {
      const script = (label, prompt, opts) => {
        if (label === 'verify:I1') return { pass: false, confidence: 'high', blocking: [{ issue: 'falha real', where: 'I1', fix: 'reparar' }] }
        if (label === 'repair:I1') return { status: workerStatus, summary: 'reparo não concluído', confidence: 'medium' }
        return defaults(label, prompt, opts)
      }
      const { result, calls } = await runWorkflow(BASE, script, { runtime: fakeRuntime() })
      assert.equal(result.nodes.find(node => node.id === 'I1').status, workerStatus)
      assert.equal(calls.filter(label => label === 'verify:I1').length, 1)
      assert.notEqual(result.status, 'done')
    })
  }
})

test('research e design retidos também precisam estar completos para DONE', async () => {
  const defaults = defaultScript()
  const script = (label, prompt, opts) => {
    if (label === 'work:R1') return { status: 'partial', summary: 'pesquisa incompleta', confidence: 'medium' }
    if (label === 'work:D1') return { status: 'partial', summary: 'design incompleto', confidence: 'medium' }
    return defaults(label, prompt, opts)
  }
  const { result } = await runWorkflow(BASE, script, { runtime: fakeRuntime() })
  assert.equal(result.nodes.find(node => node.id === 'R1').status, 'partial')
  assert.equal(result.nodes.find(node => node.id === 'D1').status, 'partial')
  assert.notEqual(result.status, 'done')
})

test('critérios vazios ou em branco bloqueiam antes de qualquer worker', async () => {
  for (const args of [{ ...BASE, doneWhen: [] }, { ...BASE, doneWhen: ['  '] }, { ...BASE, plan: { ...PLAN, doneWhen: [] } }, { ...BASE, plan: { ...PLAN, doneWhen: ['ok', '   '] } }]) {
    const { result, calls } = await runWorkflow(args, defaultScript(), { runtime: fakeRuntime() })
    assert.equal(result.feedback.reason, 'done_criteria_missing_or_invalid')
    assert.ok(!calls.some(label => label.startsWith('work:')))
  }
})

test('host test com política sem persistência de saída não aprova o design sem record', async () => {
  const runtime = fakeRuntime({ policy: true })
  runtime.initializeProvenanceFrontier = async () => ({ identity: 'delivery-A', evidencePath: 'root.json', evidenceHash: 'root-hash', manifestSpecs: {} })
  delete runtime.persistOutput
  delete runtime.verifyOutput
  const { result } = await runWorkflow(BASE, defaultScript(), { runtime })
  assert.equal(result.designReview?.pass, false, JSON.stringify(result.designReview))
  assert.equal(result.designReview?.feedback?.reason, 'design_output_approval_persistence_failed')
})

// Equivalente journal de runtime.states.at(-1).control: último checkpoint control.transition gravado até agora.
function lastControl(ctx) {
  const lines = readFileSync(path.join(ctx.cwd, ctx.runDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return lines.filter(event => event.type === 'control.transition').at(-1)?.payload?.checkpoint?.control || null
}

const B5_PLAN = {
  goal: 'entrega', mode: 'implement', complexity: 'moderate', doneWhen: ['comportamento correto'], effort: { level: 'max', why: 'teste b5' }, nodes: [
    { id: 'R1', title: 'pesquisa', kind: 'research', brief: 'r', deps: [], files: [], inputs: [], outputs: [], risk: 'low', acceptance: ['evidência'] },
    { id: 'D1', title: 'design', kind: 'design', brief: 'd', deps: ['R1'], files: [], inputs: [], outputs: [], risk: 'low', acceptance: ['decisão'] },
    { id: 'I1', title: 'implementação', kind: 'implement', brief: 'i', deps: ['D1'], files: ['src/a.js'], inputs: ['src/a.js'], outputs: ['src/a.js'], risk: 'low', acceptance: ['ok'] },
  ],
}

// Plano de polish: dois implement com arquivos disjuntos (k = 2 áreas: {I1} e {I2}). Requer createB5Fixture({ withB: true }).
const B5_POLISH_PLAN = {
  goal: 'entrega', mode: 'implement', complexity: 'moderate', doneWhen: ['comportamento correto'], effort: { level: 'max', why: 'teste polish' }, nodes: [
    { id: 'R1', title: 'pesquisa', kind: 'research', brief: 'r', deps: [], files: [], inputs: [], outputs: [], risk: 'low', acceptance: ['evidência'] },
    { id: 'D1', title: 'design', kind: 'design', brief: 'd', deps: ['R1'], files: [], inputs: [], outputs: [], risk: 'low', acceptance: ['decisão'] },
    { id: 'I1', title: 'implementação a', kind: 'implement', brief: 'i', deps: ['D1'], files: ['src/a.js'], inputs: ['src/a.js'], outputs: ['src/a.js'], risk: 'low', acceptance: ['ok'] },
    { id: 'I2', title: 'implementação b', kind: 'implement', brief: 'i', deps: ['D1'], files: ['src/b.js'], inputs: ['src/b.js'], outputs: ['src/b.js'], risk: 'low', acceptance: ['ok'] },
  ],
}

// 614/T6: mudança externa entre áreas de polish. O hook escreve src/b.js depois do retorno REAL do endCheckWindow
// da janela polish que contém I1 (valor devolvido intacto). Com a cadeia divergente, a área seguinte tem que bloquear
// antes da janela, sem novo READY e sem critic/synth.
test('614/T6: mudança externa entre áreas de polish bloqueia a área 2 antes da janela', async t => {
  let injected = false
  let cwdRef = null
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => {
      const hooked = { ...runtime, endCheckWindow: async input => {
        const value = await runtime.endCheckWindow(input)
        // A ordem real das áreas é {I2} e depois {I1} (buckets de areasForImplementIds). O hook muda o arquivo do nó
        // que ainda não foi revalidado: o da área seguinte.
        if (!injected && value?.windowEvidence?.phase === 'polish') {
          injected = true
          const nextFile = value.windowEvidence.nodeIds.includes('I1') ? 'src/b.js' : 'src/a.js'
          await writeFile(path.join(cwdRef, nextFile), 'export const changed = 2\n')
        }
        return value
      } }
      return workflow(args, agent, log, phase, parallel, budget, hooked)
    }
  }
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: B5_POLISH_PLAN }, workflowCompiler, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    cwdRef = ctx.cwd
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(injected, true, 'a mudança externa precisa acontecer entre as áreas')
  assert.equal(result.status, 'blocked', JSON.stringify({ feedback: result.feedback, calls }).slice(0, 800))
  assert.equal(result.feedback?.reason, 'provenance_frontier_changed_before_window', JSON.stringify({ feedback: result.feedback, calls }))
  assert.equal(calls.filter(label => label.startsWith('polish:')).length, 1, JSON.stringify(calls))
  assert.equal(nodeReadyEvents(events, 'I1').length, 1)
  assert.equal(nodeReadyEvents(events, 'I2').length, 1)
  assert.equal(nodeReadyEvents(events, 'I2').filter(event => event.payload.polishRevalidated).length, 0, 'área 2 não pode revalidar')
  assert.deepEqual(calls.filter(label => ['critic:r1', 'synth'].includes(label)), [], 'a run para antes do critic e do synth')
})

// T6a (8.1/8.2): polish sem edição encerra cada janela polish com delta vazio e não grava transição de polish.
test('T6a: polish sem edição encerra a janela de cada área com actualChangedPaths vazio e sem selo', async t => {
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: B5_POLISH_PLAN }, fixtureOptions: { withB: true }, script: defaultScript() })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, calls }).slice(0, 800))
  assert.deepEqual(calls.filter(label => label.startsWith('polish:')), ['polish:1', 'polish:2'], JSON.stringify(calls))
  const polishWindows = events.filter(event => event.type === 'checks.window.completed' && event.payload?.phase === 'polish')
  assert.equal(polishWindows.length, 2, 'cada área polish precisa de um checks.window.completed')
  for (const event of polishWindows) assert.deepEqual(event.payload.actualChangedPaths, [], 'polish sem edição não tem delta')
  assert.equal(events.filter(event => event.type === 'control.transition' && event.payload?.polishRevalidated).length, 0, 'delta vazio não gera READY de polish')
  assert.equal(events.filter(event => event.type === 'control.transition' && /^polish-/.test(event.payload?.stage || '')).length, 0, 'delta vazio não gera transição de polish')
})

// C9 (FIX_LOCAL 3): o motor não confia no retorno de backupPolishArea. Um backup que omite arquivo da área
// tem que bloquear com polish_backup_invalid antes de qualquer spawn do polidor.
test('C9: backup do polish que omite arquivo da área bloqueia polish_backup_invalid sem spawn do polidor', async t => {
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => workflow(args, agent, log, phase, parallel, budget, { ...runtime, backupPolishArea: async input => {
      const value = await runtime.backupPolishArea(input)
      return { ...value, files: value.files.slice(1) }
    } })
  }
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_POLISH_PLAN }, workflowCompiler, fixtureOptions: { withB: true }, script: defaultScript() })
  assert.equal(result.status, 'blocked', JSON.stringify({ feedback: result.feedback, calls }).slice(0, 800))
  assert.equal(result.feedback?.reason, 'polish_backup_invalid', JSON.stringify({ feedback: result.feedback, calls }))
  assert.deepEqual(calls.filter(label => label.startsWith('polish:')), [], 'backup inválido não pode disparar o polidor')
})

// T6b (8.3): R1 lê src/a.js como input. Polish edita src/a.js. Input não conta como afetado: R1 não ganha READY novo.
test('T6b: input editado no polish não invalida nó readonly; só o implement dono do arquivo é revalidado', async t => {
  const plan = { ...B5_POLISH_PLAN, nodes: B5_POLISH_PLAN.nodes.map(node => node.id === 'R1' ? { ...node, inputs: ['src/a.js'] } : node) }
  const { result, calls, events } = await runGraphScripted(t, { args: { plan }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:') && prompt.includes('Area (only these files): src/a.js')) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// polish\n')
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, calls }).slice(0, 800))
  assert.ok(!String(result.nodes?.find(node => node.id === 'R1')?.note || '').includes('polish_invalidated'), 'R1 não pode ser invalidado pelo polish')
  assert.equal(events.filter(event => event.type === 'control.transition' && event.payload?.polishRevalidated && event.payload?.nodeId === 'R1').length, 0, 'R1 sem READY de polish')
  assert.equal(calls.filter(label => label === 'work:I1').length, 1, 'polish não refaz work:I1')
})

// T6c (8.4): polish edita src/a.js (dono: I1). A revalidação de I1 acontece dentro da janela polish, com um selo único
// que cobre a área inteira. I2 não muda e não é revalidado.
test('T6c: polish que edita o arquivo do implement revalida dentro da janela e sela uma transição por área', async t => {
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: B5_POLISH_PLAN }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:') && prompt.includes('Area (only these files): src/a.js')) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// polish\n')
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, calls, polish: result.polish, critic: result.critic, error: result.error, nodes: result.nodes?.map(node => [node.id, node.status, node.note]) }).slice(0, 2000))
  assert.ok(calls.includes('polish:2'), JSON.stringify(calls))
  const transitions = provenanceTransitions(events).at(-1)?.payload?.checkpoint?.provenance?.transitions || []
  assert.equal(transitions.length, 3, 'I1, I2 e o selo da polish')
  assert.equal(events.filter(event => event.type === 'control.transition' && event.payload?.polishRevalidated && event.payload?.nodeId === 'I1').length, 1, 'um READY de polish para I1')
  assert.equal(events.filter(event => event.type === 'control.transition' && event.payload?.polishRevalidated && event.payload?.nodeId === 'I2').length, 0, 'I2 não muda')
  // 8.5: o registro de I1 aponta para o selo da polish, que é a última transição da cadeia.
  const finalCheckpoint = provenanceTransitions(events).at(-1)?.payload?.checkpoint
  const recordI1 = finalCheckpoint?.nodeRecords?.find(item => item.id === 'I1')?.nodeRecord
  assert.equal(recordI1?.transitionRef?.identity, transitions.at(-1)?.identity, 'transitionRef de I1 precisa ser o selo da polish')
  const polishWindow = events.find(event => event.type === 'checks.window.completed' && event.payload?.phase === 'polish' && event.payload?.actualChangedPaths?.length)
  assert.deepEqual(polishWindow?.payload.actualChangedPaths, ['src/a.js'], 'a janela polish do arquivo real precisa estar auditada')
})

// T6d (8.6): I2 depende de I1 e lê src/a.js. O polish de I1 muda src/a.js. I2 está fora da área de I1 e precisa
// ser revalidado em janela própria, depois do selo da polish.
test('T6d: dependente implement fora da área é revalidado em janela própria depois do selo da polish', async t => {
  const plan = { ...B5_POLISH_PLAN, nodes: B5_POLISH_PLAN.nodes.map(node => node.id === 'I2' ? { ...node, deps: ['D1', 'I1'], inputs: ['src/b.js', 'src/a.js'] } : node) }
  const { result, calls, events } = await runGraphScripted(t, { args: { plan }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:') && prompt.includes('Area (only these files): src/a.js')) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// polish\n')
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, calls, polish: result.polish }).slice(0, 1200))
  assert.equal(events.filter(event => event.type === 'control.transition' && event.payload?.polishRevalidated && event.payload?.nodeId === 'I1').length, 1)
  assert.equal(events.filter(event => event.type === 'control.transition' && event.payload?.polishRevalidated && event.payload?.nodeId === 'I2').length, 1, 'I2 revalidado depois do selo')
  assert.equal(calls.filter(label => label === 'verify:I2').length, 2, JSON.stringify(calls))
})

// T6e (8.7): falha ao persistir o node-record-ready de polish (saveState do cache) bloqueia com o motivo exato.
test('T6e: falha de checkpoint no node-record-ready da polish bloqueia com provenance_checkpoint_failed sem critic', async t => {
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => {
      let failNext = false
      const faulty = {
        ...runtime,
        emit: async event => { if (event.type === 'control.transition' && event.payload?.polishRevalidated && event.payload?.nodeId === 'I1') failNext = true; return runtime.emit(event) },
        saveState: async value => { if (failNext) { failNext = false; throw new Error('persistência simulada falhou') } return runtime.saveState(value) },
      }
      return workflow(args, agent, log, phase, parallel, budget, faulty)
    }
  }
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_POLISH_PLAN }, workflowCompiler, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:') && prompt.includes('Area (only these files): src/a.js')) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// polish\n')
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'blocked', JSON.stringify({ feedback: result.feedback, calls }).slice(0, 800))
  assert.equal(result.feedback?.reason, 'provenance_checkpoint_failed', JSON.stringify({ feedback: result.feedback, calls }))
  assert.deepEqual(calls.filter(label => ['critic:r1', 'synth'].includes(label)), [], 'nada pode rodar depois da falha de cadeia')
})

// T6e variante: persistWindowEvidence da polish falha (provenance_window_persist_failed) sem gravar selo.
test('T6e variante: falha ao persistir o selo da polish bloqueia com o motivo exato e sem critic', async t => {
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => {
      const faulty = { ...runtime, persistWindowEvidence: async (windowEvidence, validation) => {
        if (windowEvidence?.phase === 'polish') throw new Error('provenance_window_persist_failed')
        return runtime.persistWindowEvidence(windowEvidence, validation)
      } }
      return workflow(args, agent, log, phase, parallel, budget, faulty)
    }
  }
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_POLISH_PLAN }, workflowCompiler, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:') && prompt.includes('Area (only these files): src/a.js')) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// polish\n')
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'blocked', JSON.stringify({ feedback: result.feedback, calls }).slice(0, 800))
  assert.equal(result.feedback?.reason, 'provenance_window_persist_failed', JSON.stringify({ feedback: result.feedback, calls }))
  assert.deepEqual(calls.filter(label => ['critic:r1', 'synth'].includes(label)), [], 'nada pode rodar depois da falha de selo')
})

// T1 parte 1: polish que edita o arquivo de I1 revalida I1 sem refazer o trabalho (work:I1 = 1) e grava 1 READY novo.
test('T1: polish que edita a área de I1 não refaz work:I1 e grava exatamente um READY novo de I1', async t => {
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: B5_POLISH_PLAN }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:') && prompt.includes('Area (only these files): src/a.js')) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// polish\n')
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, calls }).slice(0, 800))
  assert.equal(calls.filter(label => label === 'work:I1').length, 1, JSON.stringify(calls))
  assert.equal(nodeReadyEvents(events, 'I1').filter(event => event.payload.polishRevalidated).length, 1, 'exatamente um READY novo de I1')
})

// 631: altera output APÓS A ÚLTIMA auditoria de polish. A última área é {I1} (ordem real: {I2}, depois {I1}).
// O hook escreve src/b.js (output de I2, já selado) depois do selo REAL da última janela polish (persistWindowEvidence
// devolvido). Asserts literais do mapa. Se o motor bloquear antes por motivo de proveniência, o teste mostra o motivo e para.
test('631: mutação depois da última janela polish bloqueia DONE apesar de gate e critic aprovados', async t => {
  let altered = false
  let cwdRef = null
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => {
      const hooked = { ...runtime, endCheckWindow: async input => {
        const value = await runtime.endCheckWindow(input)
        if (!altered && value?.windowEvidence?.phase === 'polish' && value.windowEvidence.nodeIds.includes('I1')) {
          altered = true
          await writeFile(path.join(cwdRef, 'src/b.js'), 'export const b = 2\n')
        }
        return value
      } }
      return workflow(args, agent, log, phase, parallel, budget, hooked)
    }
  }
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: B5_POLISH_PLAN }, workflowCompiler, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    cwdRef = ctx.cwd
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(altered, true, JSON.stringify({ status: result.status, reason: result.feedback?.reason, calls, polish: result.polish }).slice(0, 1200))
  assert.ok(calls.includes('critic:r1'), 'o check final precisa rodar: ' + JSON.stringify({ status: result.status, reason: result.feedback?.reason, calls, polish: result.polish }))
  assert.equal(result.critic?.feedback?.kind, 'BLOCK', JSON.stringify({ critic: result.critic, feedback: result.feedback, calls }).slice(0, 1200))
  assert.equal(result.critic?.feedback?.reason, 'node_record_stale_at_completion', JSON.stringify({ critic: result.critic, feedback: result.feedback }).slice(0, 1200))
  assert.equal(result.status, 'blocked', JSON.stringify({ feedback: result.feedback, calls }).slice(0, 800))
  assert.equal(result.finalEvidence ?? null, null)
  assert.equal(nodeReadyEvents(events, 'I1').length, 1, 'node-record-ready de I1 = 1')
  assert.equal(nodeReadyEvents(events, 'I2').length, 1, 'node-record-ready de I2 = 1')
})

// 8.3 (normPath): o output não-implement declarado como './src/a.js' é o mesmo arquivo que a polish editou em 'src/a.js'.
// Sem normalizar os dois lados, o R1 não seria afetado e a área passaria como done.
test('8.3: output não-implement canônico é comparado com o delta real da polish (o "./" agora é recusado no gate)', async t => {
  const plan = { ...B5_POLISH_PLAN, nodes: B5_POLISH_PLAN.nodes.map(node => node.id === 'R1' ? { ...node, outputs: ['src/a.js'] } : node) }
  const { result, calls } = await runGraphScripted(t, { args: { plan }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:') && prompt.includes('Area (only these files): src/a.js')) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// polish\n')
    return defaultScript()(label, prompt, opts, ctx)
  } })
  const area = result.polish?.find(item => item.files?.includes('src/a.js'))
  assert.ok(area, JSON.stringify({ status: result.status, reason: result.feedback?.reason, calls }))
  assert.match(area.summary, /polish_invalidated_non_implement:R1/, JSON.stringify(area))
})

// T6f (fim do passo 8, item 1): I2 lê src/a.js sem depender de I1. O polish de {I1} muda src/a.js.
// I2 está fora da área e não está no fecho por deps; precisa ser revalidado pelo input cruzado.
test('T6f: implement fora da área cujo input cruza o delta da polish é revalidado depois do selo', async t => {
  const plan = { ...B5_POLISH_PLAN, nodes: B5_POLISH_PLAN.nodes.map(node => node.id === 'I2' ? { ...node, deps: ['D1'], inputs: ['src/b.js', 'src/a.js'] } : node) }
  const { result, calls, events } = await runGraphScripted(t, { args: { plan }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:') && prompt.includes('Area (only these files): src/a.js')) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// polish\n')
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, calls, polish: result.polish }).slice(0, 1200))
  assert.equal(events.filter(event => event.type === 'control.transition' && event.payload?.polishRevalidated && event.payload?.nodeId === 'I2').length, 1, 'I2 revalidado pelo input cruzado')
})

// T6g (fim do passo 8, item 2): dependente fora da área é invalidado ANTES do selo. Se a revalidação dele falha depois
// do selo, o último checkpoint não pode mostrá-lo como done com o record antigo.
test('T6g: dependente fora da área reprovado na revalidação não fica done no último checkpoint', async t => {
  const plan = { ...B5_POLISH_PLAN, nodes: B5_POLISH_PLAN.nodes.map(node => node.id === 'I2' ? { ...node, deps: ['D1', 'I1'] } : node) }
  let verifyI2 = 0
  const { result, calls, events } = await runGraphScripted(t, { args: { plan }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:') && prompt.includes('Area (only these files): src/a.js')) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// polish\n')
    // FALHA INJETADA rotulada: a segunda verificação de I2 (a revalidação depois do selo) reprova.
    if (label === 'verify:I2' && ++verifyI2 === 2) return { pass: false, confidence: 'high', blocking: ['falha injetada'] }
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.notEqual(result.status, 'done', JSON.stringify({ status: result.status, feedback: result.feedback, calls }).slice(0, 800))
  const last = provenanceTransitions(events).at(-1)?.payload?.checkpoint
  const recordI2 = last?.nodeRecords?.find(item => item.id === 'I2')
  assert.ok(recordI2, 'o último checkpoint precisa conter I2')
  assert.notEqual(recordI2.status, 'done', JSON.stringify(recordI2).slice(0, 400))
  assert.equal(recordI2.nodeRecord ?? null, null, 'I2 não pode manter record antigo')
})

// T6h (fim do passo 8, item 3): falha injetada rotulada no runChecks de I2 durante a revalidação fora da área.
// A janela node daquela revalidação precisa ser auditada (checks.window.completed), a run não pode ser done.
test('T6h: falha de checks na janela node de dependente fora da área audita a janela e não termina done', async t => {
  const plan = { ...B5_POLISH_PLAN, nodes: B5_POLISH_PLAN.nodes.map(node => node.id === 'I2' ? { ...node, deps: ['D1', 'I1'] } : node) }
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => {
      let i2Checks = 0
      const faulty = { ...runtime, runChecks: async input => {
        // FALHA INJETADA rotulada: a segunda checagem de I2 (revalidação depois do selo da polish) lança.
        if (input?.nodeId === 'I2' && ++i2Checks === 2) throw new Error('falha injetada em runChecks de I2')
        return runtime.runChecks(input)
      } }
      return workflow(args, agent, log, phase, parallel, budget, faulty)
    }
  }
  const { result, calls, events } = await runGraphScripted(t, { args: { plan }, workflowCompiler, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:') && prompt.includes('Area (only these files): src/a.js')) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// polish\n')
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.notEqual(result.status, 'done', JSON.stringify({ status: result.status, feedback: result.feedback, calls }).slice(0, 800))
  const windowsI2 = events.filter(event => event.type === 'checks.window.started' && event.payload?.phase === 'node' && event.payload?.nodeIds?.[0] === 'I2')
  const completedI2 = events.filter(event => event.type === 'checks.window.completed' && event.payload?.phase === 'node' && event.payload?.nodeIds?.[0] === 'I2')
  assert.equal(completedI2.length, windowsI2.length, 'toda janela node de I2 precisa ser auditada')
})

test('B5 runner real conclui o plano base com política node ativa e evidência real', async t => {
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_PLAN } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, error: result.error }))
  assert.ok(calls.includes('critic:r1'))
})

test('política de checks ativa sem API de proveniência bloqueia com provenance_frontier_unavailable', async t => {
  const { result, calls } = await runGraphScripted(t, {
    args: { plan: B5_PLAN },
    workflowCompiler: async () => {
      const workflow = await compileWorkflow()
      return (...args) => workflow(...args.slice(0, 6), { ...args[6], initializeProvenanceFrontier: undefined })
    },
  })
  assert.equal(result.status, 'blocked', JSON.stringify({ feedback: result.feedback, calls }))
  assert.equal(result.feedback.reason, 'provenance_frontier_unavailable')
})

test('helper runGraphScripted nunca sobrescreve finalEvidence fornecido pelo script (inclusive null)', () => {
  const prompt = 'Final delivery identity: id-1\nVerified supervisor receipts: [{"id":"r1"}]\nCriterion references: [{"id":"c1","criterion":"ok"}]'
  const forged = { identity: 'forjado', receiptIds: [], criterionIds: [] }
  const supplied = { done: true, finalEvidence: forged, criteria: [{ criterion: 'ok', met: true, evidence: 'x', evidenceIds: [] }] }
  assert.strictEqual(withScriptedCriticEvidence('critic:r1', supplied, prompt), supplied)
  assert.deepEqual(supplied.finalEvidence, forged)
  const explicitNull = withScriptedCriticEvidence('critic:r1', { done: true, finalEvidence: null }, prompt)
  assert.strictEqual(explicitNull.finalEvidence, null)
  const filled = withScriptedCriticEvidence('critic:r1', { done: true }, prompt)
  assert.deepEqual(filled.finalEvidence, { identity: 'id-1', receiptIds: ['r1'], criterionIds: ['c1'] })
  assert.equal(withScriptedCriticEvidence('work:I1', { done: true }, prompt).finalEvidence, undefined)
})


// Passos 5-7 (B8/B10/C7, C3/T8, C6/T9). Todos com runtime real: fixture git, política node e evidência real.
const B6_PLAN = {
  ...B5_PLAN, nodes: [...B5_PLAN.nodes, { id: 'I2', title: 'segunda implementação', kind: 'implement', brief: 'i2', deps: [], files: ['src/b.js'], inputs: ['src/b.js'], outputs: ['src/b.js'], risk: 'low', acceptance: ['ok'] }],
}
const provenanceTransitions = events => events.filter(event => event.type === 'control.transition')
const nodeReadyEvents = (events, nodeId) => provenanceTransitions(events).filter(event => event.payload?.stage === 'node-record-ready' && event.payload?.nodeId === nodeId)

test('B8: falha de persistência do node-fix-intent não deixa janela de nó aberta', async t => {
  let verifyCalls = 0
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => {
      // FALHA INJETADA: só o checkpoint node-fix-intent falha, depois do emit real.
      let failNext = false
      const faulty = {
        ...runtime,
        emit: async event => { if (event.type === 'control.transition' && event.payload?.stage === 'node-fix-intent') failNext = true; return runtime.emit(event) },
        saveState: async value => { if (failNext) { failNext = false; throw new Error('persistência simulada falhou') } return runtime.saveState(value) },
      }
      return workflow(args, agent, log, phase, parallel, budget, faulty)
    }
  }
  const { result, events } = await runGraphScripted(t, { args: { plan: B5_PLAN }, workflowCompiler, script: async (label, prompt, opts, ctx) => {
    if (label === 'verify:I1' && verifyCalls++ === 0) return { pass: false, confidence: 'high', blocking: [{ node: 'I1', issue: 'falta cobertura', where: 'src/a.js', fix: 'ajustar' }] }
    return defaultScript()(label, prompt, opts, ctx)
  } })
  const node = result.nodes.find(item => item.id === 'I1')
  assert.equal(node.note, 'control_persistence_failed', JSON.stringify(node).slice(0, 400))
  const started = events.filter(event => event.type === 'checks.window.started' && event.payload?.phase === 'node').map(event => event.payload.windowId)
  const completed = new Set(events.filter(event => event.type === 'checks.window.completed').map(event => event.payload?.windowId))
  assert.ok(started.length >= 1, 'janela de nó não abriu')
  assert.deepEqual(started.filter(id => !completed.has(id)), [], 'janela aberta sem auditoria antes do bloqueio')
})

test('B8/C7: implement verificado sem voto com ref vira provenance_transition_unavailable (adulteração rotulada)', async t => {
  // ADULTERAÇÃO RÓTULADA: o voto de verify chega sem agentResultRef, como se o runtime não o tivesse registrado.
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => workflow(args, async (prompt, opts) => {
      const value = await agent(prompt, opts)
      return opts?.label?.startsWith('verify:') && value ? { ...value } : value
    }, log, phase, parallel, budget, runtime)
  }
  const { result, events } = await runGraphScripted(t, { args: { plan: B5_PLAN }, workflowCompiler, script: defaultScript() })
  const node = result.nodes.find(item => item.id === 'I1')
  assert.notEqual(node.status, 'done', JSON.stringify(node))
  assert.equal(node.note, 'provenance_transition_unavailable', JSON.stringify(node))
  assert.equal(nodeReadyEvents(events, 'I1').length, 0, 'sem voto com ref não pode haver node-record-ready de I1')
  assert.equal((provenanceTransitions(events).at(-1)?.payload?.checkpoint?.provenance?.transitions || []).length, 0, 'sem voto com ref não pode haver transição de cadeia')
})

test('C7: falha ao persistir node-record-ready depois do push encerra a run com provenance_checkpoint_failed', async t => {
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => {
      // FALHA INJETADA: só o saveState do checkpoint node-record-ready falha, depois do emit real.
      let failNext = false
      const faulty = {
        ...runtime,
        emit: async event => { if (event.type === 'control.transition' && event.payload?.stage === 'node-record-ready' && event.payload?.nodeId === 'I1') failNext = true; return runtime.emit(event) },
        saveState: async value => { if (failNext) { failNext = false; throw new Error('persistência simulada falhou') } return runtime.saveState(value) },
      }
      return workflow(args, agent, log, phase, parallel, budget, faulty)
    }
  }
  const failed = await runGraphScripted(t, { args: { plan: B5_PLAN }, workflowCompiler, script: defaultScript() })
  const { result, calls } = failed
  assert.equal(result.status, 'blocked', JSON.stringify(result).slice(0, 800))
  assert.equal(result.feedback.reason, 'provenance_checkpoint_failed', JSON.stringify({ feedback: result.feedback, calls }))
  assert.deepEqual(calls.filter(label => ['polish:1', 'critic:r1', 'synth'].includes(label)), [], 'nada pode rodar depois da falha de cadeia')
  // A injeção só derruba o saveState (cache de estado) depois do emit real. O journal já tem o node-record-ready do I1,
  // então o resume lê dele e termina done sem refazer R1, D1 ou I1. A variante "emit falha" (crash antes de journalizar) está no T7.
  const journalReady = nodeReadyEvents(failed.events, 'I1')
  assert.equal(journalReady.length, 1, 'o emit precisa ter entrado no journal')
  const resumed = await runGraphScripted(t, { fixture: failed.fixture, args: { runId: 'b5-run', runDir: failed.runDir, resume: { requestedRerunIds: [] } }, script: defaultScript() })
  assert.equal(resumed.result.status, 'done', JSON.stringify({ feedback: resumed.result.feedback, calls: resumed.calls }))
  assert.deepEqual(resumed.calls.filter(label => /^(work|verify):(R1|D1|I1)$/.test(label)), [], 'resume não pode refazer R1, D1 ou I1')
  const resumedTransitions = provenanceTransitions(resumed.events).at(-1)?.payload?.checkpoint?.provenance?.transitions || []
  const journalTransitions = journalReady[0].payload.checkpoint.provenance.transitions
  assert.ok(resumedTransitions.length >= journalTransitions.length, 'a cadeia do resume precisa conter as transições do journal')
  assert.deepEqual(resumedTransitions.slice(0, journalTransitions.length), journalTransitions, 'as transições do resume começam pelas do node-record-ready do I1 no journal')
})

test('T8: FIX_LOCAL do critic em I1 selado refaz o registro READY com uma transição nova e termina done', async t => {
  let criticCalls = 0
  const defaults = defaultScript()
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: B5_PLAN }, script: async (label, prompt, opts, ctx) => {
    if (label === 'critic:r1' && criticCalls++ === 0) return { feedback: { kind: 'FIX_LOCAL', reason: 'ajustar I1', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] }, done: false, gaps: [] }
    if (label === 'repair:I1') await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// ajuste do repair\n')
    return defaults(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, critic: result.critic, nodes: result.nodes?.map(node => [node.id, node.status, node.note]) }).slice(0, 1500))
  assert.equal(calls.filter(label => label === 'repair:I1').length, 1)
  assert.equal(nodeReadyEvents(events, 'I1').length, 2, 'o reparo do critic precisa gravar uma transição nova do I1')
  assert.equal(provenanceTransitions(events).at(-1)?.payload?.checkpoint?.provenance?.transitions?.length, 2, 'a cadeia final precisa ter exatamente o selo original e o do fix')
  assert.ok(events.some(event => event.type === 'control.transition' && event.payload?.stage === 'critic-fix-complete'))
})

test('T8 variante: fronteira adulterada antes do fix do critic bloqueia pelo motivo de fronteira, nunca supervisor_runtime_failure', async t => {
  let criticCalls = 0
  let cwdRef = null
  const defaults = defaultScript()
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => {
      // ADULTERAÇÃO RÓTULADA: depois do retorno real do node-record-ready do I1 (selo já feito), muda o arquivo no disco.
      const tampered = { ...runtime, emit: async event => {
        const record = await runtime.emit(event)
        if (event.type === 'control.transition' && event.payload?.stage === 'node-record-ready' && event.payload?.nodeId === 'I1' && !tampered.done) { tampered.done = true; await writeFile(path.join(cwdRef, 'src/a.js'), 'export const a = 1\n// adulterado\n') }
        return record
      } }
      return workflow(args, agent, log, phase, parallel, budget, tampered)
    }
  }
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_PLAN }, workflowCompiler, script: async (label, prompt, opts, ctx) => {
    cwdRef = ctx.cwd
    if (label === 'critic:r1' && criticCalls++ === 0) return { feedback: { kind: 'FIX_LOCAL', reason: 'ajustar I1', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] }, done: false, gaps: [] }
    return defaults(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'provenance_frontier_changed_before_window', JSON.stringify({ feedback: result.feedback, calls }))
  assert.ok(!calls.includes('repair:I1'), 'o reparo não pode rodar sobre fronteira adulterada')
})

test('T9a: I1 reprovado depois dos reparos deixa janela pendente; critic FIX_LOCAL sela com beforeRef na fronteira atestada', async t => {
  let afterCritic = false
  let criticCalls = 0
  const defaults = defaultScript()
  let runtime = null
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, suppliedRuntime) => { runtime = suppliedRuntime; return workflow(args, agent, log, phase, parallel, budget, suppliedRuntime) }
  }
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: B5_PLAN }, workflowCompiler, script: async (label, prompt, opts, ctx) => {
    if (label === 'work:I1' || label === 'repair:I1') {
      // Mudança real e válida do arquivo do nó: a janela do nó fica sem selo porque o verify reprova.
      await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// trabalho\n')
    }
    if (label === 'verify:I1' && !afterCritic) return { pass: false, confidence: 'high', blocking: [{ node: 'I1', issue: 'falta cobertura', where: 'src/a.js', fix: 'ajustar' }] }
    if (label === 'critic:r1' && criticCalls++ === 0) { afterCritic = true; return { feedback: { kind: 'FIX_LOCAL', reason: 'ajustar I1', severity: 'high', affectedNodes: ['I1'], evidenceIds: [] }, done: false, gaps: [] } }
    return defaults(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, nodes: result.nodes?.map(node => [node.id, node.status, node.note]) }).slice(0, 1500))
  assert.equal(calls.filter(label => label === 'critic:r1').length, 1)
  const checkpoint = provenanceTransitions(events).at(-1).payload.checkpoint
  const refs = checkpoint.provenance.transitions
  assert.equal(refs.length, 1, 'só o selo do fix do critic deve existir')
  const sealed = (await runtime.verifyOutput(refs[0])).value.windowEvidence
  assert.equal(sealed.beforeIdentity, checkpoint.provenance.rootRef.identity, 'beforeRef do selo final precisa ser a fronteira atestada')
  assert.ok(sealed.actualChangedPaths.includes('src/a.js'), 'o delta selado inclui a mudança da janela pendente')
})

test('T9b: janela de outro nó com janela pendente de I1 bloqueia com provenance_unsealed_window:I1 sem work de I2', async t => {
  const { result, calls } = await runGraphScripted(t, { args: { plan: B6_PLAN }, script: async (label, prompt, opts, ctx) => {
    if (label === 'work:I1') await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// trabalho\n')
    if (label === 'verify:I1') return { pass: false, confidence: 'high', blocking: [{ node: 'I1', issue: 'falta cobertura', where: 'src/a.js', fix: 'ajustar' }] }
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'blocked')
  assert.match(result.feedback.reason, /^provenance_unsealed_window:I1 \(causa: .+\)$/, JSON.stringify({ feedback: result.feedback, calls }))
  assert.deepEqual(result.feedback.affectedNodes, ['I1'])
  assert.ok(!calls.includes('work:I2'), 'I2 não pode trabalhar com janela de I1 pendente')
})

// T7 é a variante "emit falha": o crash acontece antes do emit do node-record-ready, então o journal não tem o I1 e o resume bloqueia.
test('T7: crash depois de checks.window.completed e antes do node-record-ready bloqueia o resume sem spawn', async t => {
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => {
      // CRASH INJETADO antes do node-record-ready entrar no journal: a janela do I1 já foi auditada e o push já aconteceu.
      const faulty = { ...runtime,
        emit: async event => { if (event.type === 'control.transition' && event.payload?.stage === 'node-record-ready' && event.payload?.nodeId === 'I1') throw new Error('crash simulado'); return runtime.emit(event) } }
      return workflow(args, agent, log, phase, parallel, budget, faulty)
    }
  }
  // Mudança real do arquivo do nó: sem ela a janela fica selada no mesmo estado e não há o que bloquear.
  const crashed = await runGraphScripted(t, { args: { plan: B5_PLAN }, workflowCompiler, script: async (label, prompt, opts, ctx) => {
    if (label === 'work:I1') await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// trabalho\n')
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(crashed.result.status, 'blocked')
  const windowsDone = crashed.events.filter(event => event.type === 'checks.window.completed' && event.nodeId === 'I1').length
  assert.ok(windowsDone >= 1, 'a janela do I1 precisa ter sido auditada antes do crash')
  const resumed = await runGraphScripted(t, { fixture: crashed.fixture, args: { runId: 'b5-run', runDir: crashed.runDir, resume: { requestedRerunIds: [] } }, script: defaultScript() })
  assert.equal(resumed.result.status, 'blocked', JSON.stringify(resumed.result).slice(0, 600))
  assert.equal(resumed.result.feedback.reason, 'provenance_frontier_changed_before_resume', JSON.stringify({ feedback: resumed.result.feedback, calls: resumed.calls }))
  assert.deepEqual(resumed.calls, [], 'resume com janela pendente não pode gastar agente')
  const lastCheckpoint = list => list.filter(event => event.type === 'control.transition').at(-1)?.payload?.checkpoint
  // Referência: último budget.call do crash (ledger real antes do node-record-ready que não entrou no journal).
  const lastBudget = crashed.events.filter(event => event.type === 'budget.call').at(-1)?.payload?.ledger
  const before = lastCheckpoint(crashed.events)
  const after = lastCheckpoint(resumed.events)
  assert.ok(lastBudget && before && after, 'o último budget.call e os checkpoints do crash e do resume precisam existir')
  assert.equal(after.control.counters.localRepairsUsed, before.control.counters.localRepairsUsed, 'localRepairsUsed do resume igual ao checkpoint anterior')
  assert.equal(after.control.counters.structuralReplansUsed, before.control.counters.structuralReplansUsed, 'structuralReplansUsed do resume igual ao checkpoint anterior')
  assert.deepEqual(after.ledger.usedByRole, lastBudget.usedByRole, 'usedByRole do resume igual ao do último budget.call de crashed.events')
  for (const role of Object.keys(lastBudget.usedByRole)) assert.ok(after.ledger.usedByRole[role] >= lastBudget.usedByRole[role], 'usedByRole.' + role + ' não pode diminuir no resume')
})


// 628 migrado (ratificado no critic do lote 3): receipt referenciado pela cadeia adulterado depois do selo.
// O replan não pode refazer X por cima de uma cadeia corrompida. BLOCK com motivo de proveniência exato,
// sem work:X novo e sem DONE. A adulteração é só em disco, depois do retorno real do critic (wait do host).
const B628_PLAN = {
  goal: 'invalidar receipt', mode: 'implement', complexity: 'moderate', doneWhen: ['receipts íntegros'], effort: { level: 'max', why: 'controle' }, nodes: [
    { id: 'R', title: 'R', kind: 'research', brief: 'R', deps: [], files: [], inputs: [], outputs: [], risk: 'low', acceptance: ['R'] },
    { id: 'D', title: 'D', kind: 'design', brief: 'D', deps: ['R'], files: [], inputs: [], outputs: [], risk: 'low', acceptance: ['D'] },
    { id: 'X', title: 'X', kind: 'implement', brief: 'X original', deps: ['D'], files: ['src/a.js'], inputs: ['src/a.js'], outputs: ['src/a.js'], risk: 'low', acceptance: ['ok'] },
    { id: 'Y', title: 'Y', kind: 'implement', brief: 'Y original', deps: ['D'], files: ['src/b.js'], inputs: ['src/b.js'], outputs: ['src/b.js'], risk: 'low', acceptance: ['ok'] },
  ],
}
// Lê do journal o receipt de X (args com src/a.js) que o selo de X referencia. Só lê; não escreve nada.
function receiptOfX(ctx) {
  const journal = readFileSync(path.join(ctx.cwd, ctx.runDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const receipt = journal.find(event => event.type === 'check.receipt' && event.payload?.args?.includes('src/a.js'))?.payload
  assert.ok(receipt?.evidencePath, 'receipt de X precisa existir antes do critic')
  return receipt
}

// (a) 628/B5: adulteração em disco do receipt de X depois do critic. O guard C13 pega antes do replan.
test('628/B5: receipt adulterado da cadeia bloqueia com run_integrity_violation sem refazer X', async t => {
  let tampered = 0
  let firstCritic = true
  let receiptName = null
  const { result, calls, cwd, runDir } = await runGraphScripted(t, { args: { plan: B628_PLAN }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label === 'work:X') await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 2\n// x\n')
    if (label === 'work:Y') await writeFile(path.join(ctx.cwd, 'src/b.js'), 'export const b = 2\n// y\n')
    if (label === 'critic:r1' && firstCritic) {
      firstCritic = false
      const receipt = receiptOfX(ctx)
      receiptName = path.basename(receipt.evidencePath)
      await writeFile(path.join(ctx.cwd, receipt.evidencePath), '{"receipt":"adulterado"}')
      tampered++
      return { feedback: { kind: 'REPLAN', reason: 'replanejar Y', severity: 'high', affectedNodes: ['Y'], evidenceIds: [] }, done: false, gaps: [] }
    }
    if (label === 'plan') { const replacement = structuredClone(B628_PLAN); replacement.nodes.find(item => item.id === 'Y').brief = 'Y corrigido'; return replacement }
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(tampered, 1, 'a adulteração precisa acontecer antes do replan')
  assert.equal(result.status, 'blocked', JSON.stringify({ calls, feedback: result.feedback }).slice(0, 800))
  assert.equal(result.feedback?.reason, 'run_integrity_violation', JSON.stringify({ calls, feedback: result.feedback }).slice(0, 800))
  assert.ok(receiptName && result.paths?.includes(receiptName), `paths precisa listar o receipt de X: ${JSON.stringify(result.paths)}`)
  assert.equal(calls.filter(label => label === 'work:X').length, 1, 'nenhum work:X novo sobre cadeia corrompida: ' + JSON.stringify(calls))
  assert.notEqual(result.status, 'done', 'sem DONE depois da cadeia corrompida')
  assert.ok(!calls.includes('critic:r2'), 'sem nova rodada de critic depois do BLOCK: ' + JSON.stringify(calls))
})

// (b) 628b: a verificação da cadeia pelo runtime acusa só o receipt de X, sem escrever nada em disco. O motor tem que
// bloquear o replan com provenance_history_invalid antes de qualquer planner ou refazer de X. Ponto injetado: RUNTIME.verifyArtifact.
test('628b: receipt inválido pela verificação do runtime bloqueia o replan com provenance_history_invalid sem refazer X', async t => {
  let armed = false
  let badPath = null
  let rejected = 0
  let firstCritic = true
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => workflow(args, agent, log, phase, parallel, budget, { ...runtime,
      verifyArtifact: async ref => {
        if (armed && badPath && ref?.evidencePath === badPath) { rejected++; return false }
        return runtime.verifyArtifact(ref)
      } })
  }
  const { result, calls } = await runGraphScripted(t, { args: { plan: B628_PLAN }, fixtureOptions: { withB: true }, workflowCompiler, script: async (label, prompt, opts, ctx) => {
    if (label === 'work:X') await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 2\n// x\n')
    if (label === 'work:Y') await writeFile(path.join(ctx.cwd, 'src/b.js'), 'export const b = 2\n// y\n')
    if (label === 'critic:r1' && firstCritic) {
      firstCritic = false
      badPath = receiptOfX(ctx).evidencePath
      armed = true
      return { feedback: { kind: 'REPLAN', reason: 'replanejar Y', severity: 'high', affectedNodes: ['Y'], evidenceIds: [] }, done: false, gaps: [] }
    }
    if (label === 'plan') { const replacement = structuredClone(B628_PLAN); replacement.nodes.find(item => item.id === 'Y').brief = 'Y corrigido'; return replacement }
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.ok(rejected >= 1, 'a verificação do runtime precisa ter recusado o receipt de X')
  assert.equal(result.status, 'blocked', JSON.stringify({ calls, critic: result.critic?.feedback }).slice(0, 800))
  assert.equal(result.critic?.feedback?.reason, 'provenance_history_invalid', JSON.stringify({ calls, critic: result.critic?.feedback }).slice(0, 800))
  assert.equal(calls.filter(label => label === 'work:X').length, 1, 'nenhum work:X novo sobre cadeia corrompida: ' + JSON.stringify(calls))
  assert.notEqual(result.status, 'done', 'sem DONE depois da cadeia corrompida')
  assert.ok(!calls.includes('critic:r2'), 'sem nova rodada de critic depois do BLOCK: ' + JSON.stringify(calls))
  assert.ok(!calls.includes('plan'), 'nenhum planner antes do BLOCK de proveniência: ' + JSON.stringify(calls))
})

// T4 (lote 3, passo 9): path do grant de I2 alterado depois do selo de I1 bloqueia antes de I2 rodar.
// Mutação em disco pelo wrapper de emit, DEPOIS do retorno real do node-record-ready de I1.
test('T4: path do grant de I2 alterado depois do selo de I1 bloqueia com work:I2=0', async t => {
  let cwdRef = null
  let hooked = false
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => workflow(args, agent, log, phase, parallel, budget, { ...runtime, emit: async event => {
      const value = await runtime.emit(event)
      if (!hooked && event.type === 'control.transition' && event.payload?.stage === 'node-record-ready' && event.payload?.nodeId === 'I1') { hooked = true; await writeFile(path.join(cwdRef, 'src/b.js'), 'export const b = 9\n') }
      return value
    } })
  }
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_PLAN }, workflowCompiler, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => { cwdRef = ctx.cwd; return defaultScript()(label, prompt, opts, ctx) } })
  assert.equal(hooked, true, 'a mutação precisa acontecer depois do selo de I1')
  assert.equal(result.status, 'blocked', JSON.stringify({ feedback: result.feedback, calls }))
  assert.equal(result.feedback?.reason, 'provenance_frontier_changed_before_window', JSON.stringify({ feedback: result.feedback, calls }))
  assert.equal(calls.filter(label => label === 'work:I2').length, 0, JSON.stringify(calls))
})

// T5 (lote 3, passo 11): bytes de gate ou de receipt da cadeia adulterados em disco. Resume BLOCK com motivo exato,
// zero spawn. Adulteração só em disco, depois que a run caiu; o resume lê os bytes adulterados.
async function crashAfterFirstSeal(t, plan = B5_POLISH_PLAN) {
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => workflow(args, agent, log, phase, parallel, budget, { ...runtime,
      emit: async event => { if (event.type === 'control.transition' && event.payload?.stage === 'critic-reviewed') throw new Error('crash simulado'); return runtime.emit(event) } })
  }
  return runGraphScripted(t, { args: { plan }, fixtureOptions: { withB: true }, workflowCompiler, script: defaultScript() })
}
async function resumeAfterTamper(t, crashed, tamper) {
  const journal = (await readFile(path.join(crashed.cwd, crashed.runDir, 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  await tamper(journal, path.join(crashed.cwd, crashed.runDir))
  return runGraphScripted(t, { fixture: crashed.fixture, args: { runId: 'b5-run', runDir: crashed.runDir, resume: { requestedRerunIds: [] } }, script: defaultScript() })
}
test('T5a: gate da cadeia adulterado em disco bloqueia o resume com provenance_checkpoint_chain_invalid, sem spawn', async t => {
  const crashed = await crashAfterFirstSeal(t)
  assert.equal(crashed.result.status, 'blocked')
  const resumed = await resumeAfterTamper(t, crashed, async journal => {
    const event = journal.find(item => item.type === 'control.transition' && item.payload?.checkpoint?.provenance?.transitions?.length)
    const ref = event.payload.checkpoint.provenance.transitions[0]
    await writeFile(path.join(crashed.cwd, crashed.runDir, ref.evidencePath), '{"gate":"adulterado"}')
  })
  assert.equal(resumed.result.status, 'blocked', JSON.stringify(resumed.result.feedback))
  assert.equal(resumed.result.feedback?.reason, 'provenance_checkpoint_chain_invalid')
  assert.deepEqual(resumed.calls, [], 'zero spawn no resume com gate adulterado')
})
test('T5b: receipt da cadeia adulterado em disco bloqueia o resume com provenance_checkpoint_receipt_invalid, sem spawn', async t => {
  const crashed = await crashAfterFirstSeal(t)
  const resumed = await resumeAfterTamper(t, crashed, async journal => {
    const receipt = journal.find(item => item.type === 'check.receipt' && item.payload?.args?.includes('src/a.js'))?.payload
    assert.ok(receipt?.evidencePath, 'receipt de I1 precisa existir')
    await writeFile(path.join(crashed.cwd, receipt.evidencePath), '{"receipt":"adulterado"}')
  })
  assert.equal(resumed.result.status, 'blocked', JSON.stringify(resumed.result.feedback))
  assert.equal(resumed.result.feedback?.reason, 'provenance_checkpoint_receipt_invalid')
  assert.deepEqual(resumed.calls, [], 'zero spawn no resume com receipt adulterado')
})

// T2 variante (lote 3, passo 9): I2 depende de I1 e os dois compartilham a área de polish (arquivos que se sobrepõem).
// A polish edita src/a.js; ambos são revalidados pelo mesmo selo e o gate final aceita sem registro stale.
test('T2 variante: dependente implement na mesma área de polish do dep fica done com o selo único', async t => {
  const plan = { ...B5_POLISH_PLAN, nodes: B5_POLISH_PLAN.nodes.map(node => node.id === 'I2' ? { ...node, deps: ['D1', 'I1'], files: ['src/a.js', 'src/b.js'], inputs: ['src/a.js', 'src/b.js'] } : node) }
  const { result, calls, events } = await runGraphScripted(t, { args: { plan }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:') && prompt.includes('src/a.js')) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// polish\n')
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, critic: result.critic?.feedback, calls, nodes: result.nodes?.map(node => [node.id, node.status, node.note]) }).slice(0, 1500))
  assert.equal(calls.filter(label => label === 'work:I2').length, 1, JSON.stringify(calls))
  assert.equal(nodeReadyEvents(events, 'I1').length, 2, 'I1 sela uma vez e a polish revalida uma vez')
  assert.equal(nodeReadyEvents(events, 'I2').length, 2, 'I2 sela uma vez e a polish revalida na mesma área')
})

// Guard do vínculo record-selo (gate final do lote 3b). Adulteração só em disco no journal, depois da queda da run.
const T2_ELO_PLAN = { ...B5_POLISH_PLAN, nodes: B5_POLISH_PLAN.nodes.map(node => node.id === 'I2' ? { ...node, deps: ['D1', 'I1'] } : node) }
const lastCheckpointOf = events => events.filter(event => event.type === 'control.transition').at(-1)?.payload?.checkpoint
async function tamperJournalRecord(crashed, mutate) {
  const jpath = path.join(crashed.cwd, crashed.runDir, 'journal.jsonl')
  const lines = (await readFile(jpath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  let target = null
  for (const event of lines) if (event.type === 'control.transition' && event.payload?.checkpoint?.nodeRecords?.some(item => item.id === 'I2' && item.nodeRecord)) target = event
  assert.ok(target, 'o checkpoint com I2 pronto precisa existir')
  mutate(target.payload.checkpoint.nodeRecords.find(item => item.id === 'I2').nodeRecord)
  await writeFile(jpath, lines.map(event => JSON.stringify(event)).join('\n') + '\n')
}
test('T2e: elo de dependência adulterado no checkpoint bloqueia o resume com provenance_history_invalid, sem spawn', async t => {
  const crashed = await crashAfterFirstSeal(t, T2_ELO_PLAN)
  const before = lastCheckpointOf(crashed.events)
  await tamperJournalRecord(crashed, record => { record.dependencyIdentities.I1 = '0'.repeat(64) })
  const resumed = await runGraphScripted(t, { fixture: crashed.fixture, args: { runId: 'b5-run', runDir: crashed.runDir, resume: { requestedRerunIds: [] } }, script: defaultScript() })
  assert.equal(resumed.result.status, 'blocked', JSON.stringify({ status: resumed.result.status, calls: resumed.calls }))
  assert.equal(resumed.result.feedback?.reason, 'provenance_history_invalid', JSON.stringify({ feedback: resumed.result.feedback, calls: resumed.calls }))
  assert.deepEqual(resumed.calls, [], 'zero spawn com elo adulterado')
  assert.deepEqual(lastCheckpointOf(resumed.events)?.control?.counters, before.control.counters, 'contadores iguais ao checkpoint anterior')
})
test('T2t: transitionRef adulterado no checkpoint bloqueia o resume com provenance_history_invalid, sem spawn', async t => {
  const crashed = await crashAfterFirstSeal(t, T2_ELO_PLAN)
  const before = lastCheckpointOf(crashed.events)
  await tamperJournalRecord(crashed, record => { record.transitionRef = { ...record.transitionRef, evidenceHash: '0'.repeat(64) } })
  const resumed = await runGraphScripted(t, { fixture: crashed.fixture, args: { runId: 'b5-run', runDir: crashed.runDir, resume: { requestedRerunIds: [] } }, script: defaultScript() })
  assert.equal(resumed.result.status, 'blocked', JSON.stringify({ status: resumed.result.status, calls: resumed.calls }))
  assert.equal(resumed.result.feedback?.reason, 'provenance_history_invalid', JSON.stringify({ feedback: resumed.result.feedback, calls: resumed.calls }))
  assert.deepEqual(resumed.calls, [], 'zero spawn com transitionRef adulterado')
  assert.deepEqual(lastCheckpointOf(resumed.events)?.control?.counters, before.control.counters, 'contadores iguais ao checkpoint anterior')
})


// T2 variante C (lote 3b): nó independente escreve a saída de A antes do selo de B. Sem DONE.
test('T2 variante C: nó independente sobrescreve a saída de A antes de B e a run não termina done', async t => {
  const plan = { ...T2_ELO_PLAN, nodes: [...T2_ELO_PLAN.nodes, { id: 'I3', title: 'c', kind: 'implement', brief: 'c', deps: [], files: ['src/c.js'], inputs: ['src/c.js'], outputs: ['src/c.js'], risk: 'low', acceptance: ['ok'] }] }
  const { result, calls } = await runGraphScripted(t, { args: { plan }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label === 'work:I3') await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 9\n// sobrescrita\n')
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(result.status === 'done', false, JSON.stringify({ status: result.status, feedback: result.feedback, calls }).slice(0, 800))
  assert.ok(calls.includes('work:I3'), JSON.stringify(calls))
  assert.ok(!calls.includes('critic:r2'), 'sem rodada extra de critic depois da sobrescrita')
})

// T2 principal (gate final do lote 3b): A→B, DONE. A polish de A muda a saída de A; B é revalidado depois do selo.
// O elo que B registra é o binding do selo do próprio B, e muda em relação ao registro inicial.
// (Sem reparo do critic: o reparo gastaria o orçamento de executor de max e a polish de re-execução seria recusada.)
test('T2: B registra a identidade de A selada; polish de A muda o elo de B e o selo de B atesta a nova', async t => {
  const { result, calls, events, cwd, runDir } = await runGraphScripted(t, { args: { plan: T2_ELO_PLAN }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:') && prompt.includes('Area (only these files): src/a.js')) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// polish\n')
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, critic: result.critic?.feedback, calls }).slice(0, 1200))
  const recordsI2 = events.filter(event => event.type === 'control.transition' && event.payload?.checkpoint?.nodeRecords).map(event => event.payload.checkpoint.nodeRecords.find(item => item.id === 'I2')?.nodeRecord).filter(Boolean)
  const first = recordsI2[0]
  const last = recordsI2.at(-1)
  assert.notEqual(last.dependencyIdentities.I1, first.dependencyIdentities.I1, 'a polish de A precisa mudar o elo que B registra')
  const gate = JSON.parse(readFileSync(path.join(cwd, runDir, last.transitionRef.evidencePath), 'utf8'))
  assert.equal(last.dependencyIdentities.I1, gate.value.validation.bindings.I2.dependencyIdentities.I1, 'elo de B igual ao binding do selo de B')
  assert.equal(calls.filter(label => label === 'work:I2').length, 1, 'B é revalidado, não refeito: ' + JSON.stringify(calls))
})

// T3 (gate final do lote 3b): três adulterações em disco, cada uma no seu ponto, cada uma com motivo exato.
// Mutação depois do retorno REAL do emit (node-record-ready de I1): a janela seguinte fica bloqueada, nenhum
// node-record-ready depois da adulteração e nenhum DONE.
test('T3a: adulteração depois do node-record-ready de I1 bloqueia a janela seguinte com motivo exato e sem novo READY', async t => {
  let cwdRef = null
  let hookedAt = -1
  let seq = 0
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => workflow(args, agent, log, phase, parallel, budget, { ...runtime, emit: async event => {
      const value = await runtime.emit(event)
      seq++
      if (hookedAt < 0 && event.type === 'control.transition' && event.payload?.stage === 'node-record-ready' && event.payload?.nodeId === 'I1') { hookedAt = seq; await writeFile(path.join(cwdRef, 'src/a.js'), 'export const a = 7\n// T3a\n') }
      return value
    } })
  }
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: B5_POLISH_PLAN }, workflowCompiler, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => { cwdRef = ctx.cwd; return defaultScript()(label, prompt, opts, ctx) } })
  assert.ok(hookedAt > 0, 'a adulteração precisa acontecer')
  assert.equal(result.status, 'blocked', JSON.stringify({ feedback: result.feedback, calls }).slice(0, 600))
  assert.equal(result.feedback?.reason, 'provenance_frontier_changed_before_window', JSON.stringify({ feedback: result.feedback, calls }))
  assert.equal(calls.filter(label => label === 'work:I2').length, 0, 'a área seguinte não pode executar')
  assert.equal(nodeReadyEvents(events, 'I2').length, 0, 'nenhum READY de I2 depois da adulteração')
  assert.notEqual(result.status, 'done')
})

// Regressão (benchmark real b343): a 1ª área de polish edita, a revalidação falha e a janela fica sem selo. A 2ª área
// não pode rodar nem trocar o motivo real por provenance_frontier_changed_before_window.
test('regressão: polish com revalidação reprovada para as áreas seguintes e preserva o motivo real', async t => {
  let polished = false
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_POLISH_PLAN }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label === 'polish:1') {
      polished = true
      const file = /Area \(only these files\): ([^.\s,]+\.js)/.exec(prompt)[1]
      await writeFile(path.join(ctx.cwd, file), `export const polido = 1\n`)
    }
    if (polished && label.startsWith('verify:')) return { pass: false, confidence: 'high', blocking: ['regrediu no polish'] }
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(polished, true)
  assert.notEqual(result.status, 'done')
  assert.notEqual(result.feedback?.reason, 'provenance_frontier_changed_before_window', JSON.stringify({ feedback: result.feedback, calls }).slice(0, 800))
  assert.equal(calls.filter(label => label.startsWith('polish:')).length, 1, JSON.stringify(calls))
  assert.match(result.polish[0].summary, /polish_revalidation_verify_failed/)
  assert.equal(result.polish[1]?.status, 'blocked')
  assert.match(result.polish[1].summary, /polish:1/)
})

test('regressão: verificador do nó sabe que a suíte inteira só roda no gate final', async t => {
  const prompts = []
  await runGraphScripted(t, { args: { plan: B5_PLAN }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('verify:I1')) prompts.push(prompt)
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.ok(prompts.length, 'o verificador do I1 precisa rodar')
  assert.match(prompts[0], /full test suite runs only at the final gate/i)
})

test('regressão: implement reprovado não deixa o polish mascarar o motivo com a fronteira', async t => {
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_POLISH_PLAN }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('verify:I2')) return { pass: false, confidence: 'high', blocking: ['I2 sem evidência'] }
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.notEqual(result.status, 'done')
  assert.doesNotMatch(String(result.feedback?.reason), /provenance_frontier_changed_before_window/, JSON.stringify({ feedback: result.feedback, calls }).slice(0, 800))
  assert.equal(calls.filter(label => label.startsWith('polish:')).length, 0, JSON.stringify(calls))
  assert.match(result.polish[0].summary, /implement não concluído \(I2/)
})

test('regressão: polish de área com dois nós revalida cada nó só pelos arquivos dele', async t => {
  const plan = structuredClone(B5_POLISH_PLAN)
  plan.nodes.push({ id: 'I3', title: 'implementação c', kind: 'implement', brief: 'i', deps: ['D1'], files: ['src/c.js'], inputs: ['src/c.js'], outputs: ['src/c.js'], risk: 'low', acceptance: ['ok'] })
  const areas = []
  const { result, calls } = await runGraphScripted(t, { args: { plan }, fixtureOptions: { withB: true, withC: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:')) {
      const files = /Area \(only these files\): ([^\n]+?)\. The supervisor/.exec(prompt)[1].split(', ')
      areas.push(files)
      for (const file of files) await writeFile(path.join(ctx.cwd, file), `export const ${path.basename(file, '.js')} = 1 // polido\n`)
    }
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.ok(areas.some(files => files.length === 2), JSON.stringify(areas))
  for (const item of result.polish) assert.equal(item.status, 'done', JSON.stringify({ polish: result.polish, calls }).slice(0, 900))

  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, critic: result.critic?.feedback }).slice(0, 900))
})

test('regressão: polish da área de uma dependência revalida o dependente sem deixar o registro dele vencido', async t => {
  const plan = structuredClone(B5_POLISH_PLAN)
  plan.nodes.push({ id: 'I3', title: 'implementação c', kind: 'implement', brief: 'i', deps: ['D1', 'I1'], files: ['src/c.js'], inputs: ['src/c.js', 'src/a.js'], outputs: ['src/c.js'], risk: 'low', acceptance: ['ok'] })
  const areas = []
  const { result, calls } = await runGraphScripted(t, { args: { plan }, fixtureOptions: { withB: true, withC: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:')) {
      const files = /Area \(only these files\): ([^\n]+?)\. The supervisor/.exec(prompt)[1].split(', ')
      areas.push(files)
      for (const file of files) await writeFile(path.join(ctx.cwd, file), `export const ${path.basename(file, '.js')} = 1 // polido\n`)
    }
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.ok(areas.some(files => files.includes('src/a.js')), JSON.stringify(areas))
  for (const item of result.polish) assert.equal(item.status, 'done', JSON.stringify({ polish: result.polish, calls }).slice(0, 900))
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.critic?.feedback, calls }).slice(0, 900))
})

// T3b: adulteração no disco do arquivo da área seguinte, depois do selo da primeira polish (mesmo ponto da 614).
// Motivo exato, e a segunda área não ganha READY novo.
test('T3b: adulteração entre áreas de polish bloqueia a área seguinte com motivo exato e sem READY novo', async t => {
  let cwdRef = null
  let injected = false
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, runtime) => workflow(args, agent, log, phase, parallel, budget, { ...runtime, endCheckWindow: async input => {
      const value = await runtime.endCheckWindow(input)
      if (!injected && value?.windowEvidence?.phase === 'polish') { injected = true; await writeFile(path.join(cwdRef, value.windowEvidence.nodeIds.includes('I1') ? 'src/b.js' : 'src/a.js'), 'export const z = 3\n') }
      return value
    } })
  }
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: B5_POLISH_PLAN }, workflowCompiler, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => { cwdRef = ctx.cwd; return defaultScript()(label, prompt, opts, ctx) } })
  assert.equal(injected, true)
  assert.equal(result.status, 'blocked', JSON.stringify({ feedback: result.feedback, calls }).slice(0, 600))
  assert.equal(result.feedback?.reason, 'provenance_frontier_changed_before_window', JSON.stringify({ feedback: result.feedback, calls }))
  assert.equal(calls.filter(label => label.startsWith('polish:')).length, 1, JSON.stringify(calls))
  assert.equal(nodeReadyEvents(events, 'I2').filter(event => event.payload.polishRevalidated).length, 0, 'área 2 sem READY novo')
  assert.ok(!calls.includes('critic:r1'), 'sem critic depois da adulteração')
})

// T3c: adulteração depois do critic aprovar DONE (wait do critic). A identidade final muda: nada pode ser DONE.
test('T3c: adulteração depois do DONE do critic não termina done', async t => {
  let cwdRef = null
  let mutated = false
  const { result, calls } = await runGraphScripted(t, { args: { plan: B5_POLISH_PLAN }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    cwdRef = ctx.cwd
    const value = await defaultScript()(label, prompt, opts, ctx)
    if (label === 'critic:r1' && !mutated) { mutated = true; await writeFile(path.join(ctx.cwd, 'src/b.js'), 'export const b = 5\n') }
    return value
  } })
  assert.equal(mutated, true, 'a adulteração precisa acontecer no critic')
  // Valores observados: o critic é readonly e a mutação do workspace é detectada nele. Sem DONE e sem finalEvidence.
  assert.equal(result.status, 'blocked', JSON.stringify({ status: result.status, reason: result.feedback?.reason, calls }).slice(0, 800))
  assert.equal(result.feedback?.reason, 'readonly_workspace_mutation', JSON.stringify({ feedback: result.feedback, calls }).slice(0, 800))
  assert.equal(result.finalEvidence ?? null, null, 'sem finalEvidence depois da mutação')
  assert.ok(cwdRef)
})

// T1 parte 2 (gate final do lote 3b): polish de I1 mudou a entrada externa de R1 (src/a.js). Replan em seguida,
// sem nó pedido para refazer (requestedRerunIds vazio): R1 não é reutilizado e refaz o trabalho (work:R1 = 2).
test('T1 parte 2: replan depois da polish não reutiliza R1 cuja entrada externa mudou (work:R1 = 2)', async t => {
  const plan = { ...B5_POLISH_PLAN, nodes: B5_POLISH_PLAN.nodes.map(node => node.id === 'R1' ? { ...node, inputs: ['src/a.js'] } : node) }
  let replanUsed = false
  const { result, calls } = await runGraphScripted(t, { args: { plan }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label.startsWith('polish:') && prompt.includes('Area (only these files): src/a.js')) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 1\n// polish\n')
    if (label === 'critic:r1' && !replanUsed) { replanUsed = true; return { feedback: { kind: 'REPLAN', reason: 'replanejar I2', severity: 'high', affectedNodes: ['I2'], evidenceIds: [] }, done: false, gaps: [] } }
    if (label === 'plan') { const replacement = structuredClone(plan); replacement.nodes.find(node => node.id === 'I2').brief = 'i2 corrigido'; return replacement }
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(calls.filter(label => label === 'work:R1').length, 2, JSON.stringify(calls))
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, critic: result.critic?.feedback, calls }).slice(0, 1000))
})

test('plano com inputs em texto livre bloqueia no gate (invalid_dag) sem nenhum work do nó', async () => {
  // Caso real do benchmark: prosa com faixa de linha no campo inputs do I1.
  const plan = structuredClone(PLAN)
  plan.nodes[2].inputs = ['R1 findings: src/a.js:2-4, acceptance.md:6-14']
  const { result, calls } = await runWorkflow({ ...BASE, plan }, defaultScript(), { runtime: fakeRuntime() })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'invalid_dag')
  assert.ok(result.errors.some(error => error === 'manifesto inválido em I1.inputs: "R1 findings: src/a.js:2-4, acceptance.md:6-14"'), JSON.stringify(result.errors))
  assert.ok(!calls.some(label => label.startsWith('work:')), JSON.stringify(calls))
})

// Item 3: fingerprint do input externo do I1 falha (ENOENT engolido pelo motor -> null).
// Sem fingerprint, o I1 não pode gastar work nem abrir janela: bloqueia com external_inputs_unfingerprintable.
// Nota: runtime fake sem política de checks (modo que o motor usa sem CHECK_SELECTION_MODE); a janela
// só existe nesse modo, então aqui a ausência de janela é garantida pela posição do bloqueio no código.
test('input externo sem fingerprint bloqueia I1 antes do work, com external_inputs_unfingerprintable', async () => {
  const plan = structuredClone(PLAN)
  plan.nodes[2].inputs = ['src/ext.js']
  const runtime = fakeRuntime({ fingerprint: async ({ inputs, contracts }) => { if (inputs.includes('src/ext.js') && contracts[0]?.value?.id === 'I1') throw new Error('ENOENT: src/ext.js'); return { identity: 'node-A' } } })
  const { result, calls } = await runWorkflow({ ...BASE, plan }, defaultScript(), { runtime })
  const i1 = result.nodes?.find(node => node.id === 'I1')
  assert.equal(i1?.note, 'external_inputs_unfingerprintable', JSON.stringify({ feedback: result.feedback, nodes: result.nodes?.map(node => [node.id, node.status, node.note]) }))
  assert.ok(!calls.includes('work:I1'), 'sem fingerprint não pode haver work do I1')
})

test('input externo que só falha depois do work vira external_inputs_unfingerprintable, nunca "mudou durante o work"', async () => {
  let extCalls = 0
  const plan = structuredClone(PLAN)
  plan.nodes[2].inputs = ['src/ext.js']
  const runtime = fakeRuntime({ fingerprint: async ({ inputs, contracts }) => {
    if (inputs.includes('src/ext.js') && contracts[0]?.value?.id === 'I1' && ++extCalls >= 3) throw new Error('ENOENT: src/ext.js')
    return { identity: 'node-A' }
  } })
  const { result, calls } = await runWorkflow({ ...BASE, plan }, defaultScript(), { runtime })
  const i1 = result.nodes?.find(node => node.id === 'I1')
  assert.equal(i1?.note, 'external_inputs_unfingerprintable', JSON.stringify({ feedback: result.feedback, nodes: result.nodes?.map(node => [node.id, node.status, node.note]) }))
  assert.ok(calls.includes('work:I1'), 'o work chegou a rodar, então a falha é pós-work')
})

test('planner e plan reviewer recebem a regra de manifesto e o schema diz repo-relative file paths only', async () => {
  const MANIFEST_RULE = "`files`, `inputs` and `outputs` are machine manifests: each entry is ONE repo-relative file path (e.g. `src/a.mjs`), no line ranges, no prose, no symbols. Inputs must already exist or be produced by a node in `deps`; outputs must be files this node writes (subset of `files`). Put findings, line ranges and exported symbols in `brief`/`acceptance`; express 'uses I1' via `deps`."
  const defaults = defaultScript({ plan: PLAN })
  const seen = {}
  const script = async (label, prompt, opts) => {
    if (label === 'plan') { seen.planPrompt = prompt; seen.planSchema = JSON.stringify(opts?.schema || null) }
    if (label.startsWith('plan-review')) seen.reviewPrompt = prompt
    return defaults(label, prompt, opts)
  }
  await runWorkflow({ task: 'manifestos', mode: 'implement', effort: 'max', runDir: '.graph-runs/test', checks: CHECKS }, script, { runtime: fakeRuntime() })
  assert.ok(seen.planPrompt, 'o planner precisa ser chamado')
  assert.ok(seen.planPrompt.includes(MANIFEST_RULE), 'prompt do planner sem a regra de manifesto')
  assert.ok(seen.reviewPrompt, 'o plan reviewer precisa ser chamado')
  assert.match(seen.reviewPrompt, /repo-relative file path/, 'prompt do plan reviewer sem a checagem de manifesto')
  for (const field of ['files', 'inputs', 'outputs']) {
    assert.match(seen.planSchema, new RegExp(`"${field}":\\{"type":"array","items":\\{"type":"string"\\},"description":"[^"]*repo-relative file paths only`), `schema de ${field} sem a descrição`)
  }
})
