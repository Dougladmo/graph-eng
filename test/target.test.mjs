import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runWorkflow, defaultScript } from './helpers/run-workflow.mjs'

function plan(level, nodes = [{ id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['evidence'] }]) {
  return { goal: 'g', complexity: 'moderate', mode: 'research', doneWhen: ['ok'], effort: { level, why: 'fixture' }, nodes }
}

test('política interna effort-only fixa largura e limite de nós', async () => {
  const expected = { low: { width: 1, nodeCap: 3 }, medium: { width: 2, nodeCap: 6 }, max: { width: 2, nodeCap: 10 } }
  for (const [effort, policy] of Object.entries(expected)) {
    const { result } = await runWorkflow({ task: 'política', mode: 'research', effort, planOnly: true, plan: plan(effort) }, defaultScript())
    assert.equal(result.planOnly, true)
    assert.deepEqual({ width: result.effort.width, nodeCap: result.effort.nodeCap }, policy)
    assert.equal(result.effort.level, effort)
  }
})

test('medium é o padrão único quando effort não é informado', async () => {
  const { result } = await runWorkflow({ task: 'padrão', mode: 'research', planOnly: true, plan: plan('medium') }, defaultScript())
  assert.equal(result.effort.level, 'medium')
  assert.equal(result.effort.source, 'default')
})

test('motor rejeita high/auto e todos os knobs antigos em vez de ignorá-los', async () => {
  for (const effort of ['high', 'auto', 'manual']) {
    const { result } = await runWorkflow({ task: 'esforço inválido', effort }, defaultScript())
    assert.equal(result.feedback.reason, 'invalid_effort')
  }
  for (const knob of ['ceiling', 'maxAgents', 'economy', 'workerModel', 'width', 'maxNodes', 'maxRounds', 'maxRepairs', 'planGate', 'roleModels']) {
    const { result } = await runWorkflow({ task: 'knob removido', [knob]: null }, defaultScript())
    assert.equal(result.feedback.reason, 'removed_budget_override', knob)
    assert.equal(result.feedback.detail, knob)
  }
})

test('plano aprovado acima do node cap bloqueia sem cortar nós nem arestas', async () => {
  const nodes = [1, 2, 3, 4].map(id => ({ id: `R${id}`, kind: 'research', title: `r${id}`, brief: 'b', deps: id === 1 ? [] : [`R${id - 1}`], risk: 'low', acceptance: ['evidence'] }))
  const { result, calls } = await runWorkflow({ task: 'plano completo', mode: 'research', effort: 'low', planOnly: true, plan: plan('low', nodes) }, defaultScript())
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'approved_plan_exceeds_effort_node_cap')
  assert.equal(result.feedback.affectedNodes.length, 4)
  assert.equal(result.plan.nodes.length, 4)
  assert.deepEqual(result.plan.nodes[3].deps, ['R3'])
  assert.ok(!calls.some(label => label.startsWith('work:')))
})
