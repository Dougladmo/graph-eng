import assert from 'node:assert/strict'
import test from 'node:test'
import { runWorkflow, defaultScript, criticDoneFromPrompt } from './helpers/run-workflow.mjs'
import { questionSetIdOf } from '../bin/phase-artifacts.mjs'

// Fluxo adaptativo: o runner passa o tier (fast | standard | full) a cada estágio. fast pula pesquisa, revisão do plano e
// design; standard mantém a revisão do plano (Opus) e pula o design; full roda tudo. Verify, checks e critic final sempre rodam.
function runtimeWithEvents(events, prepared = []) {
  let seq = 0
  return {
    preparePhaseArtifact: async input => { prepared.push(input); return { contentHash: `hash-${input.kind}-${prepared.length}`, status: input.status, questionSetId: input.content?.openQuestions?.length ? questionSetIdOf(input.content.openQuestions) : null } },
    host: 'test',
    models: { planner: 'test-strong', planReviewer: 'test-strong', designReviewer: 'test-strong', executor: 'test-cheap', verifier: 'test-cheap', critic: 'test-strong', synth: 'test-cheap' },
    capabilities: { checks: true, fingerprint: true, readOnlyEnforced: true },
    snapshot: async () => ({ schemaVersion: 2, identity: 'test-delivery-identity', evidencePath: 'test/snapshot.json', evidenceHash: 'test-snapshot-hash', manifestSpecs: {} }),
    fingerprint: async () => ({ schemaVersion: 2, identity: 'test-node-identity' }),
    runChecks: async ({ snapshot, checks }) => checks.map((check, index) => ({ schemaVersion: 2, id: `test-receipt-${index}`, runId: 'test-run', checkId: check.id, identity: snapshot.identity, valid: true, evidencePath: `test/receipt-${index}.json`, evidenceHash: `hash-${index}` })),
    verifyArtifact: async artifact => Boolean(artifact?.evidencePath && artifact?.evidenceHash),
    emit: async event => { const record = { ...event, seq: ++seq }; events.push(record); return record },
    saveState: async value => value,
    backupPolishArea: async ({ files }) => ({ backupDir: '.graph-runs/test/polish-backups/fake', files: files.map(file => ({ path: file, kind: 'file', executable: false, sha256: 'a'.repeat(64), backupPath: `.graph-runs/test/polish-backups/fake/${file}` })) }),
  }
}

const transitions = events => events.filter(event => event.type === 'control.transition').map(event => event.payload.stage)
const real = calls => calls.filter(label => !label.startsWith('#'))
const critic = (label, prompt) => ({ feedback: { kind: 'DONE', reason: 'ok', severity: 'none', affectedNodes: [], evidenceIds: [] }, done: true, assessment: 'ok', gaps: [], ...criticDoneFromPrompt(prompt) })
const CHECK = { id: 'node-check', command: 'node', args: ['-e', '0'] }
const IMPL = { id: 'I1', kind: 'implement', title: 'I1', brief: 'implementar', deps: [], risk: 'low', acceptance: ['ok'], files: ['src/a.js'] }
const DESIGN = { id: 'D1', kind: 'design', title: 'D1', brief: 'desenhar', deps: [], risk: 'low', acceptance: ['ok'], files: [], inputs: [], outputs: [] }
const implPlan = nodes => ({ goal: 'implementar', complexity: 'moderate', mode: 'implement', doneWhen: ['ok'], effort: { level: 'medium', why: 'teste' }, nodes })

async function implementRun(tier, nodes = [IMPL]) {
  const events = []
  const args = { task: 'implementar', mode: 'implement', effort: 'medium', checks: [CHECK], stage: 'implement', plan: implPlan(nodes), ...(tier ? { tier } : {}) }
  const { result, calls, logs } = await runWorkflow(args, defaultScript({ plan: implPlan(nodes), critic }), { runtime: runtimeWithEvents(events) })
  return { result, calls: real(calls), logs, events }
}

test('tier fast: sem revisão do plano nem do design; implement, verify, critic e synth rodam e a run fecha DONE', async () => {
  const { result, calls, events } = await implementRun('fast')
  assert.equal(calls.some(label => label.startsWith('plan-review')), false, JSON.stringify(calls))
  assert.equal(calls.some(label => label.startsWith('design-review')), false, JSON.stringify(calls))
  assert.ok(calls.some(label => label.startsWith('work:I1')), JSON.stringify(calls))
  assert.ok(calls.some(label => label.startsWith('verify:I1')), JSON.stringify(calls))
  assert.ok(calls.some(label => label.startsWith('critic')), JSON.stringify(calls))
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, critic: result.critic, designReview: result.designReview, openGaps: result.openGaps, fe: result.finalEvidence }))
  const approved = events.find(event => event.type === 'control.transition' && event.payload.stage === 'plan-approved')
  assert.equal(approved.payload.checkpoint.approvals.planReview.synthetic, true)
  assert.equal(approved.payload.checkpoint.approvals.planReview.tier, 'fast')
  assert.equal(approved.payload.checkpoint.budgetPolicy.tier, 'fast')
  assert.ok(transitions(events).includes('design-approved'), JSON.stringify(transitions(events)))
})

test('tier standard: revisão do plano real, sem nó nem revisão de design', async () => {
  const { result, calls } = await implementRun('standard')
  assert.ok(calls.includes('plan-review:r1'), JSON.stringify(calls))
  assert.equal(calls.some(label => label.startsWith('design-review')), false, JSON.stringify(calls))
  assert.equal(calls.some(label => label.startsWith('work:design-base')), false, JSON.stringify(calls))
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, critic: result.critic, designReview: result.designReview, openGaps: result.openGaps, fe: result.finalEvidence }))
})

test('sem tier (adaptive off ou run antiga) vale o fluxo completo: design-base injetado e revisado', async () => {
  const { calls } = await implementRun(undefined)
  assert.ok(calls.includes('plan-review:r1'), JSON.stringify(calls))
  assert.ok(calls.some(label => label.startsWith('design-review')), JSON.stringify(calls))
})

test('tier fast com nó de design sobe para full: revisão do plano e do design reais', async () => {
  const { calls, logs } = await implementRun('fast', [DESIGN, { ...IMPL, deps: ['D1'] }])
  assert.ok(calls.includes('plan-review:r1'), JSON.stringify(calls))
  assert.ok(calls.some(label => label.startsWith('design-review')), JSON.stringify(calls))
  assert.ok(logs.some(line => /tier fast -> full/.test(line)), JSON.stringify(logs))
})

test('tier fast com nó de risco alto sobe para standard: revisão do plano real', async () => {
  const { calls } = await implementRun('fast', [{ ...IMPL, risk: 'high' }])
  assert.ok(calls.includes('plan-review:r1'), JSON.stringify(calls))
  assert.equal(calls.some(label => label.startsWith('design-review')), false, JSON.stringify(calls))
})

test('tier fast com mais nós que o teto (3) sobe de tier', async () => {
  const nodes = ['I1', 'I2', 'I3', 'I4'].map(id => ({ ...IMPL, id, files: [`src/${id}.js`] }))
  const { calls, logs } = await implementRun('fast', nodes)
  assert.ok(calls.includes('plan-review:r1'), JSON.stringify(calls))
  assert.ok(logs.some(line => /tier fast -> standard/.test(line)), JSON.stringify(logs))
})

// Estágio plan no fluxo enxuto: o planner é a pesquisa e devolve zero nós; o critic do estágio vira sintético.
const LEAN_PLAN = { goal: 'implementar a soma', complexity: 'moderate', mode: 'research', doneWhen: ['ok'], effort: { level: 'medium', why: 'teste' }, nodes: [], findings: ['src/a.js:1 exporta soma'] }

async function planStageRun(tier, planOut = LEAN_PLAN) {
  const events = []
  const prepared = []
  const base = defaultScript({ critic })
  const script = async (label, prompt, opts) => (label === 'plan' ? planOut : base(label, prompt, opts))
  const prompts = {}
  const spy = async (label, prompt, opts) => { prompts[label] = { prompt, opts }; return script(label, prompt, opts) }
  const { result, calls, logs } = await runWorkflow({ task: 'implementar', mode: 'research', effort: 'medium', stage: 'plan', planReviewDeferred: true, ...(tier ? { tier } : {}) }, spy, { runtime: runtimeWithEvents(events, prepared) })
  return { result, calls: real(calls), logs, events, prepared, prompts }
}

test('estágio plan no tier fast: só o planner chama modelo; publica o plano com os achados do planner e tier fast', async () => {
  const { result, calls, prepared, prompts } = await planStageRun('fast')
  assert.equal(result.status, 'plan_approved', JSON.stringify(result.feedback))
  assert.deepEqual(calls, ['plan'], JSON.stringify(calls))
  assert.match(prompts.plan.prompt, /Lean flow \(tier fast\)/)
  assert.equal(prompts.plan.opts.schema.properties.nodes.minItems, 0)
  assert.equal(prepared.length, 1)
  assert.deepEqual(prepared[0].content.researchNodes, [])
  assert.deepEqual(prepared[0].content.research, [{ nodeId: 'planner', summary: 'implementar a soma', findings: ['src/a.js:1 exporta soma'] }])
  assert.equal(prepared[0].tier, 'fast')
})

test('estágio plan no tier full: o prompt pede só nós de pesquisa e o schema exige ao menos um nó', async () => {
  const withResearch = { ...LEAN_PLAN, nodes: [{ id: 'R1', kind: 'research', title: 'R1', brief: 'pesquisar', deps: [], risk: 'low', acceptance: ['fonte'], files: [], inputs: [], outputs: [] }] }
  const { calls, prompts } = await planStageRun('full', withResearch)
  assert.doesNotMatch(prompts.plan.prompt, /Lean flow/)
  assert.equal(prompts.plan.opts.schema.properties.nodes.minItems, 1)
  assert.ok(calls.some(label => label.startsWith('work:R1')), JSON.stringify(calls))
  assert.ok(calls.some(label => label.startsWith('critic')), JSON.stringify(calls))
})

// Benchmark faturamento (21/10): o planner do estágio plan escreveu doneWhen sobre a pesquisa ("cada contrato com file:line"). O
// doneWhen fica travado até o critic final, que cobrou um registro que nenhum nó de implementação podia gravar, e a run bloqueou
// com critic_fix_incomplete mesmo com 31/31 no aceite externo.
test('estágio plan: o prompt diz que doneWhen descreve a tarefa pronta, não a pesquisa', async () => {
  const withResearch = { ...LEAN_PLAN, nodes: [{ id: 'R1', kind: 'research', title: 'R1', brief: 'pesquisar', deps: [], risk: 'low', acceptance: ['fonte'], files: [], inputs: [], outputs: [] }] }
  for (const [tier, planOut] of [['full', withResearch], ['fast', LEAN_PLAN]]) {
    const { prompts } = await planStageRun(tier, planOut)
    assert.match(prompts.plan.prompt, /doneWhen describes the finished task/, tier)
    assert.match(prompts.plan.prompt, /never the research itself/, tier)
  }
})

// Benchmark Minecraft MVP (21/10): mesmo com a frase acima, o planner Sonnet do estágio plan escreveu goal "Investigation plan
// for the Minecraft MVP" e doneWhen "the engine contract is mapped to each stub". O goal de pesquisa puxava o doneWhen de
// pesquisa, o revisor cobrou arquivos de registro dos nós de implementação e a run bloqueou antes de escrever código.
test('estágio plan: o prompt diz que goal e doneWhen são da tarefa inteira, não deste estágio de pesquisa', async () => {
  const withResearch = { ...LEAN_PLAN, nodes: [{ id: 'R1', kind: 'research', title: 'R1', brief: 'pesquisar', deps: [], risk: 'low', acceptance: ['fonte'], files: [], inputs: [], outputs: [] }] }
  for (const [tier, planOut] of [['full', withResearch], ['fast', LEAN_PLAN]]) {
    const { prompts } = await planStageRun(tier, planOut)
    assert.match(prompts.plan.prompt, /goal and doneWhen describe the whole task as the implementation stage delivers it, not this research stage/, tier)
    assert.match(prompts.plan.prompt, /Bad: "the contract is mapped/, tier)
  }
})

test('estágio plan no tier fast: planner que pede pesquisa sobe para full e o critic é real', async () => {
  const withResearch = { ...LEAN_PLAN, nodes: [{ id: 'R1', kind: 'research', title: 'R1', brief: 'pesquisar', deps: [], risk: 'low', acceptance: ['fonte'], files: [], inputs: [], outputs: [] }] }
  const { result, calls, prepared } = await planStageRun('fast', withResearch)
  assert.equal(result.status, 'plan_approved', JSON.stringify(result.feedback))
  assert.ok(calls.some(label => label.startsWith('work:R1')), JSON.stringify(calls))
  assert.ok(calls.some(label => label.startsWith('critic')), JSON.stringify(calls))
  assert.equal(prepared[0].tier, 'full')
})

test('tier inválido vindo do runner vale como full', async () => {
  const { calls } = await implementRun('turbo')
  assert.ok(calls.includes('plan-review:r1'), JSON.stringify(calls))
  assert.ok(calls.some(label => label.startsWith('design-review')), JSON.stringify(calls))
})

// Regressão (benchmark chess, tier fast): o planner do fluxo enxuto devolveu nós de implementação no estágio plan e a run
// bloqueava com plan_stage_non_research_node. Agora esses nós viram achados e o estágio segue enxuto.
test('estágio plan no tier fast: nós de implementação do planner viram achados, sem bloquear nem subir de tier', async () => {
  const sketch = { ...LEAN_PLAN, nodes: [
    { id: 'N1', kind: 'implement', title: 'Soma', brief: 'implementar soma em src/a.js', deps: [], risk: 'low', acceptance: ['ok'], files: ['src/a.js'] },
    { id: 'N2', kind: 'implement', title: 'Testes', brief: 'cobrir a soma', deps: ['N1'], risk: 'low', acceptance: ['ok'], files: ['test/a.test.js'] },
  ] }
  const { result, calls, prepared } = await planStageRun('fast', sketch)
  assert.equal(result.status, 'plan_approved', JSON.stringify(result.feedback))
  assert.deepEqual(calls, ['plan'], JSON.stringify(calls))
  assert.equal(prepared[0].tier, 'fast')
  assert.deepEqual(prepared[0].content.researchNodes, [])
  const findings = prepared[0].content.research[0].findings
  assert.ok(findings.some(line => /N1/.test(line) && /implementar soma/.test(line)), JSON.stringify(findings))
})
