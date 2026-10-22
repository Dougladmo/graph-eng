import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runWorkflow, defaultScript } from './helpers/run-workflow.mjs'

const BASE = { task: 'orçamento', mode: 'implement', runDir: '.graph-runs/test', checks: [{ id: 'unit', command: 'node', args: ['--test'] }] }
const node = (id, kind, deps = [], file) => ({ id, kind, title: id, brief: id, deps, risk: 'low', acceptance: ['ok'], ...(file ? { files: [file] } : {}) })
const plan = (effort, nodes) => ({ goal: 'entrega', complexity: 'moderate', doneWhen: ['ok'], effort: { level: effort, why: 'teste' }, nodes })

test('low reserva o plano mínimo completo e conclui todos os gates sem dropped calls', async () => {
  const p = plan('low', [node('R1', 'research'), node('D1', 'design', ['R1']), node('I1', 'implement', ['D1'], 'src/a.js')])
  const { result, calls } = await runWorkflow({ ...BASE, effort: 'low', plan: p }, defaultScript())
  assert.equal(result.status, 'done')
  assert.ok(calls.includes('plan-review:r1'))
  assert.ok(calls.includes('design-review:r1'))
  assert.ok(calls.includes('verify:I1'))
  assert.ok(calls.includes('critic:r1'))
  assert.equal(calls.includes('polish:1'), false) // polish só no effort max
  assert.ok(calls.includes('synth'))
  assert.deepEqual(result.stats.dropped, [])
  assert.equal(result.budget.limitsByRole.executor, 7) // 3 nós + polish + 2 reparos do pool da run + 1 reparo próprio do I1
  assert.equal(result.budget.limitsByRole.verifier, 8) // inclui 2 votos do reparo próprio do I1; manifesto unknown não gera READY nem reserva uma revalidação local reutilizável
  assert.equal(result.budget.usedByRole.planner, 0)
  assert.equal(result.budget.usedByRole.planReviewer, 1)
  assert.equal(result.budget.usedByRole.designReviewer, 1)
  assert.equal(result.budget.usedByRole.critic, 1)
  assert.equal(result.budget.usedByRole.synth, 1)
  assert.equal(result.budget.localRepairsUsed, 0)
  assert.equal(result.budget.structuralReplansUsed, 0)
  assert.equal(result.budget.tokenUsageByRole.critic, null)
})

test('duas implementações disjuntas são serializadas e têm chamadas/verificações reservadas', async () => {
  const p = plan('medium', [
    node('R1', 'research'),
    node('D1', 'design', ['R1']),
    node('I1', 'implement', ['D1'], 'src/a.js'),
    node('I2', 'implement', ['D1'], 'src/b.js'),
  ])
  const { result, calls, maxLive } = await runWorkflow({ ...BASE, effort: 'medium', plan: p }, defaultScript())
  assert.equal(result.status, 'done')
  assert.equal(maxLive, 1, 'nós de escrita são serializados para atribuir o diff ao grant individual')
  assert.ok(calls.includes('verify:I1') && calls.includes('verify:I2'))
  for (const role of ['executor', 'verifier']) {
    assert.ok(result.budget.usedByRole[role] <= result.budget.limitsByRole[role], `${role} excedeu o ledger`)
    assert.ok(result.budget.reservedByRole[role] >= 0, `${role} ficou com reserva negativa`)
  }
  assert.deepEqual(result.stats.dropped, [])
})

test('low cobre dois reparos com votos adaptativos sem iniciar escrita sem orçamento de verificação', async () => {
  const p = plan('low', [node('R1', 'research'), node('D1', 'design', ['R1']), node('I1', 'implement', ['D1'], 'src/a.js')])
  const votes = [
    { pass: false, confidence: 'low', blocking: [{ issue: 'a' }, { issue: 'b' }] },
    { pass: false, confidence: 'low', blocking: [{ issue: 'a' }, { issue: 'b' }] },
    { pass: false, confidence: 'low', blocking: [{ issue: 'b' }] },
    { pass: false, confidence: 'low', blocking: [{ issue: 'b' }] },
    { pass: true, confidence: 'low', blocking: [] },
    { pass: true, confidence: 'low', blocking: [] },
  ]
  let version = 0
  let seq = 0
  const runtime = {
    host: 'test', models: { planner: 'test', planReviewer: 'test', designReviewer: 'test', executor: 'test', verifier: 'test', critic: 'test', synth: 'test' },
    capabilities: { checks: true, fingerprint: true, readOnlyEnforced: true },
    snapshot: async () => ({ identity: 'delivery', evidencePath: 'snap.json', evidenceHash: 'snap-hash' }),
    fingerprint: async () => ({ identity: `node-${version}` }),
    runChecks: async ({ snapshot, checks }) => checks.map(check => ({ id: `receipt-${check.id}`, runId: 'test', checkId: check.id, identity: snapshot.identity, valid: true, evidencePath: 'receipt.json', evidenceHash: 'receipt-hash' })),
    verifyArtifact: async artifact => Boolean(artifact?.evidencePath && artifact?.evidenceHash),
    emit: async event => ({ ...event, seq: ++seq }), saveState: async state => state, backupPolishArea: async ({ files }) => ({ backupDir: '.graph-runs/test/polish-backups/fake', files: files.map(file => ({ path: file, kind: 'file', executable: false, sha256: 'a'.repeat(64), backupPath: `.graph-runs/test/polish-backups/fake/${file}` })) }), // C9: fixture de backup do polish
  }
  const { result, calls } = await runWorkflow(
    { ...BASE, effort: 'low', plan: p },
    (label, prompt, opts) => { if (label === 'repair:I1') version++; return defaultScript({ verify: () => votes.shift(), escalate: () => votes.shift() })(label, prompt, opts) },
    { runtime },
  )
  assert.equal(result.status, 'done')
  assert.equal(calls.filter(label => label === 'repair:I1').length, 2)
  assert.equal(calls.filter(label => label === 'verify:I1' || label === 'escalate:I1').length, 6)
  assert.equal(result.budget.localRepairsUsed, 0) // reparo de nó de código não gasta o pool da run
  assert.equal(result.budget.usedByRole.verifier, 6)
  assert.deepEqual(result.stats.dropped, [])
})

test('falha de chamada consome a tentativa do papel e mantém as reservas dos gates', async () => {
  const p = plan('low', [node('R1', 'research'), node('D1', 'design', ['R1']), node('I1', 'implement', ['D1'], 'src/a.js')])
  const { result } = await runWorkflow({ ...BASE, effort: 'low' }, defaultScript({ plan: () => null }))
  assert.equal(result.feedback.reason, 'planner_failed')
  assert.equal(result.stats.usedByRole.planner, 1)
  assert.equal(result.stats.limitsByRole.planner, 5)
})

test('polish só roda no effort max; em medium a entrega vai direto ao gate final', async () => {
  // Regressão (xadrez, 21/10): em medium, 4 polidores reabriram 13 verificações (~6 min) só para ajuste de estilo.
  const nodes = [node('R1', 'research'), node('D1', 'design', ['R1']), node('I1', 'implement', ['D1'], 'src/a.js')]
  const medium = await runWorkflow({ ...BASE, effort: 'medium', plan: plan('medium', nodes) }, defaultScript())
  assert.equal(medium.result.status, 'done')
  assert.equal(medium.calls.some(label => label.startsWith('polish:')), false, JSON.stringify(medium.calls))
  assert.ok(medium.calls.includes('critic:r1'))
  const max = await runWorkflow({ ...BASE, effort: 'max', plan: plan('max', nodes) }, defaultScript())
  assert.equal(max.result.status, 'done')
  assert.ok(max.calls.includes('polish:1'), JSON.stringify(max.calls))
})

test('esforço de raciocínio: medium em todo papel por padrão; effort max sobe só os papéis fortes para high', async () => {
  // Regressão (xadrez, 21/10): revisores e critic pediam high fixo e o Opus respondia por 89% do custo.
  const nodes = [node('R1', 'research'), node('D1', 'design', ['R1']), node('I1', 'implement', ['D1'], 'src/a.js')]
  const effortsFor = async effort => {
    const seen = {}
    const base = defaultScript()
    await runWorkflow({ ...BASE, effort, plan: plan(effort, nodes) }, async (label, prompt, opts) => { seen[label] = opts.effort; return base(label, prompt, opts) })
    return seen
  }
  const medium = await effortsFor('medium')
  for (const label of ['plan-review:r1', 'design-review:r1', 'critic:r1', 'work:I1', 'verify:I1', 'synth']) assert.equal(medium[label], 'medium', `${label}: ${JSON.stringify(medium)}`)
  const max = await effortsFor('max')
  for (const label of ['plan-review:r1', 'design-review:r1', 'critic:r1']) assert.equal(max[label], 'high', `${label}: ${JSON.stringify(max)}`)
  assert.equal(max['work:I1'], 'medium')
})
