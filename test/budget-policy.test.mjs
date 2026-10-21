import test from 'node:test'
import assert from 'node:assert/strict'
import { allocateBudget, normalizeBudgetNodes, polishRevalidationBudget, resolveBudgetMode, sameBudgetValue, validateBudgetDag } from '../bin/budget-policy.mjs'

const ledger = {
  usedByRole: { planner: 1, planReviewer: 1, designReviewer: 0, critic: 0, synth: 0, executor: 0, verifier: 0 },
  baseLimitsByRole: { planner: 5, planReviewer: 5, designReviewer: 5, critic: 5, synth: 3, executor: 0, verifier: 0 },
  baseReservedByRole: { planner: 0, planReviewer: 0, designReviewer: 1, critic: 1, synth: 1, executor: 0, verifier: 0 },
}

test('policy compartilha auto mode, ausência de manifests e rails efetivos', () => {
  const raw = { mode: undefined, nodes: [{ id: 'x', kind: 'implement', files: ['src/x.js'], inputs: [], outputs: [] }] }
  const mode = resolveBudgetMode('auto', raw)
  assert.equal(mode, 'implement')
  const normalized = normalizeBudgetNodes({ list: raw.nodes, mode, rails: true }).nodes
  assert.equal(normalized.find(node => node.id === 'x').inputsDeclared, true)
  assert.equal(normalized.find(node => node.id === 'x').outputsDeclared, true)
  assert.deepEqual(normalized.find(node => node.id === 'x').deps, ['design-base'])
  const unknown = normalizeBudgetNodes({ list: [{ id: 'y', kind: 'research' }], mode: 'research', rails: true }).nodes.find(node => node.id === 'y')
  assert.equal(unknown.inputsDeclared, false)
  assert.equal(unknown.outputsDeclared, false)
})

test('policy calcula closures de polish e não aumenta saldo em retomadas', () => {
  const nodes = normalizeBudgetNodes({ mode: 'implement', rails: true, list: [
    { id: 'r', kind: 'research', files: ['src/a.js'], inputs: [], outputs: [] },
    { id: 'd', kind: 'design', deps: ['r'], files: ['src/a.js'], inputs: [], outputs: [] },
    { id: 'a', kind: 'implement', deps: ['d'], files: ['src/a.js'], inputs: ['src/a.js'], outputs: ['dist/a.js'] },
    { id: 'b', kind: 'implement', deps: ['d'], files: ['src/b.js'], inputs: ['src/a.js'], outputs: ['dist/b.js'] },
    { id: 'c', kind: 'implement', deps: ['a', 'b'], files: ['src/c.js'], inputs: ['dist/b.js'], outputs: [] },
  ] }).nodes
  assert.ok(polishRevalidationBudget(nodes) >= 6)
  const allocated = allocateBudget({ planVersion: 1, reason: 'initial', mode: 'implement', effort: 'medium', nodes, pendingNodeIds: nodes.map(node => node.id), localRepairsUsed: 0, structuralReplansUsed: 0, ...ledger })
  const resumed = allocateBudget({ planVersion: 1, reason: 'approved-replan', mode: 'implement', effort: 'medium', nodes, pendingNodeIds: nodes.map(node => node.id), localRepairsUsed: 0, structuralReplansUsed: 1, usedByRole: allocated.allocation.baseUsedByRole, baseLimitsByRole: allocated.limitsByRole, baseReservedByRole: allocated.reservedByRole })
  assert.equal(resumed.limitsByRole.synth, allocated.limitsByRole.synth)
  assert.equal(resumed.limitsByRole.executor, allocated.limitsByRole.executor)
  assert.equal(sameBudgetValue(resumed.allocation.limitsByRole, allocated.allocation.limitsByRole), true)
})

test('research-base e design-base injetados declaram inputs e outputs vazios (defeito e)', () => {
  const { nodes } = normalizeBudgetNodes({ list: [], mode: 'architecture', rails: true, existingIds: [] })
  const base = Object.fromEntries(nodes.map(node => [node.id, node]))
  for (const id of ['research-base', 'design-base']) {
    assert.ok(base[id], `${id} deve ser injetado`)
    assert.equal(base[id].outputsDeclared, true, `${id} precisa declarar outputs`)
    assert.equal(base[id].inputsDeclared, true, `${id} precisa declarar inputs`)
    assert.deepEqual(base[id].outputs, [])
    assert.deepEqual(base[id].inputs, [])
  }
})

test('researchImported não injeta research-base e o design-base nasce sem deps de pesquisa (M3)', () => {
  const list = [
    { id: 'a', kind: 'implement', deps: [], files: ['src/a.js'], inputs: [], outputs: ['dist/a.js'] },
  ]
  const legacy = normalizeBudgetNodes({ list, mode: 'implement', rails: true, existingIds: [] }).nodes
  assert.ok(legacy.some(node => node.id === 'research-base'), 'legado continua injetando research-base')
  const imported = normalizeBudgetNodes({ list, mode: 'implement', rails: true, researchImported: true, existingIds: [] }).nodes
  assert.equal(imported.some(node => node.id === 'research-base'), false, JSON.stringify(imported.map(node => node.id)))
  const design = imported.find(node => node.id === 'design-base')
  assert.ok(design, 'design-base continua sendo criado')
  assert.deepEqual(design.deps, [])
})

test('validateBudgetDag rejeita manifesto em texto livre citando nó e campo, sem normalizar', () => {
  // Três casos reais do benchmark: o planner pôs prosa, linhas e símbolos nos manifestos.
  const cases = [
    { field: 'inputs', value: 'R1 findings: src/a.mjs:2-4, acceptance.md:6-14' },
    { field: 'outputs', value: 'src/a.mjs exports normalizarRegistro' },
    { field: 'files', value: 'I1 normalizarRegistro' },
  ]
  for (const { field, value } of cases) {
    const nodes = [{ id: 'I1', kind: 'implement', deps: [], files: [], inputs: [], outputs: [], [field]: [value] }]
    const problems = validateBudgetDag(nodes)
    assert.ok(problems.includes(`manifesto inválido em I1.${field}: "${value}"`), JSON.stringify(problems))
  }
})

test('validateBudgetDag rejeita vírgula, faixa de linha, absoluto e .. e aceita caminhos canônicos', () => {
  const bad = ['src/a.mjs,src/b.mjs', 'src/a.mjs:12', '/etc/passwd', '../fora.mjs', 'src/a b.mjs', './src/a.mjs']
  for (const value of bad) {
    const problems = validateBudgetDag([{ id: 'I1', kind: 'implement', deps: [], files: [value], inputs: [], outputs: [] }])
    assert.ok(problems.some(problem => problem.startsWith('manifesto inválido em I1.files')), `${value}: ${JSON.stringify(problems)}`)
  }
  assert.deepEqual(validateBudgetDag([{ id: 'I1', kind: 'implement', deps: [], files: ['src/a.mjs'], inputs: ['test/a.test.mjs'], outputs: ['dist/a.js'] }]), [])
})
