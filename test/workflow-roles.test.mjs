import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runWorkflow, defaultScript } from './helpers/run-workflow.mjs'

// Pedido do Douglas (21/10): nós de pesquisa e de design eram escritos pelo Haiku do executor. Agora o modelo vem
// do papel researcher/designer (Sonnet); o orçamento de chamadas continua contado no executor.
const BASE = { task: 'papéis', mode: 'implement', effort: 'low', runDir: '.graph-runs/test', checks: [{ id: 'unit', command: 'node', args: ['--test'] }] }
const node = (id, kind, deps = [], file) => ({ id, kind, title: id, brief: id, deps, risk: 'low', acceptance: ['ok'], ...(file ? { files: [file] } : {}) })
const plan = { goal: 'entrega', complexity: 'moderate', doneWhen: ['ok'], effort: { level: 'low', why: 'teste' }, nodes: [node('R1', 'research'), node('D1', 'design', ['R1']), node('I1', 'implement', ['D1'], 'src/a.js')] }

test('nó research usa o papel researcher, design usa designer e implement usa executor', async () => {
  const seen = {}
  const base = defaultScript()
  const { result } = await runWorkflow({ ...BASE, plan }, async (label, prompt, opts) => {
    if (label.startsWith('work:')) seen[label] = { role: opts.role }
    return base(label, prompt, opts)
  })
  assert.equal(result.status, 'done')
  assert.equal(seen['work:R1'].role, 'researcher')
  assert.equal(seen['work:D1'].role, 'designer')
  assert.equal(seen['work:I1'].role, 'executor')
  assert.equal(result.budget.usedByRole.executor, 3, 'o orçamento segue contado no executor')
})
