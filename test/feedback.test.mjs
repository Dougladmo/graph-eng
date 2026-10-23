import assert from 'node:assert/strict'
import test from 'node:test'
import { runWorkflow, defaultScript } from './helpers/run-workflow.mjs'

const BASE = { task: 'validar controle', mode: 'research', effort: 'low', runDir: '.graph-runs/test' }
const researchPlan = { goal: 'g', complexity: 'moderate', mode: 'research', doneWhen: ['ok'], nodes: [{ id: 'R1', title: 'Pesquisa', kind: 'research', brief: 'pesquisar', deps: [], risk: 'low', acceptance: ['ok'] }], effort: { level: 'low', why: 'teste' } }
const approval = kind => ({ kind, reason: 'teste', severity: kind === 'APPROVE' || kind === 'DONE' ? 'none' : 'high', affectedNodes: [], evidenceIds: [] })

test('DAG cru inválido bloqueia antes de qualquer agente', async () => {
  const invalid = structuredClone(researchPlan)
  invalid.nodes[0].deps = ['desconhecido']
  const { result, calls } = await runWorkflow({ ...BASE, plan: invalid }, defaultScript())
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'invalid_dag')
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), [])
})

test('plano com ciclo ou IDs que colidem após normalização é rejeitado antes da revisão', async () => {
  const cyclic = structuredClone(researchPlan)
  cyclic.nodes.push({ id: 'R2', title: 'Outra', kind: 'research', deps: ['R1'], risk: 'low', acceptance: [] })
  cyclic.nodes[0].deps = ['R2']
  const cycleRun = await runWorkflow({ ...BASE, plan: cyclic }, defaultScript())
  assert.equal(cycleRun.result.feedback.reason, 'invalid_dag')
  assert.deepEqual(cycleRun.calls.filter(label => !label.startsWith('#')), [])
  const collision = structuredClone(researchPlan)
  collision.nodes.push({ id: 'R.1', title: 'Colisão', kind: 'research', deps: [], risk: 'low', acceptance: [] })
  const collisionRun = await runWorkflow({ ...BASE, plan: collision }, defaultScript())
  assert.equal(collisionRun.result.status, 'blocked')
  assert.deepEqual(collisionRun.calls.filter(label => !label.startsWith('#')), [])
})

test('resposta de plan-review sem feedback enum bloqueia em runtime de produção', async () => {
  const calls = []
  const runtime = { host: 'codex', models: { planner: 'gpt-6.1-sol', planReviewer: 'gpt-6.1-sol', designReviewer: 'gpt-6.1-sol', executor: 'gpt-6-luna', verifier: 'gpt-6-luna', critic: 'gpt-6.1-sol', synth: 'gpt-6-luna', researcher: 'gpt-6.1-sol', designer: 'gpt-6.1-sol', notetaker: 'gpt-6-luna' }, capabilities: { readOnlyEnforced: true } }
  const { result } = await runWorkflow({ ...BASE, plan: researchPlan }, async label => { calls.push(label); return { pass: true } }, { runtime })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'plan_review_failed_or_invalid')
  assert.deepEqual(calls, ['plan-review:r1'])
})

test('REPLAN no gate do plano chama planner forte e instala versão somente após nova revisão aprovada', async () => {
  const persisted = []
  const emitted = []
  let eventSeq = 0
  const runtime = { host: 'test', models: {}, capabilities: { readOnlyEnforced: true }, fingerprint: async () => ({ identity: 'semantic-test' }), emit: async event => { emitted.push(event); return { ...event, seq: ++eventSeq } }, saveState: async state => persisted.push(structuredClone(state)) }
  const replacement = structuredClone(researchPlan)
  replacement.nodes[0].brief = 'pesquisar novamente'
  const script = async label => {
    if (label === 'plan-review:r1') return { feedback: { ...approval('REPLAN'), affectedNodes: ['R1'] } }
    if (label === 'plan') return replacement
    if (label === 'plan-review:r2') return { feedback: approval('APPROVE') }
    return null
  }
  const { result, calls } = await runWorkflow({ ...BASE, planOnly: true, plan: researchPlan }, script, { runtime })
  assert.equal(result.planVersion, 2)
  assert.equal(result.budget.structuralReplansUsed, 1)
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), ['plan-review:r1', 'plan', 'plan-review:r2'])
  assert.ok(emitted.some(event => event.type === 'control.transition' && event.payload.stage === 'feedback-dispatch'))
  assert.ok(persisted.some(state => state.control.seenPairs.length === 1 && state.control.history.length === 1))
  assert.equal(persisted.at(-1).planVersion, 2)
})

test('APPROVE não instala versão por mudança apenas em questions e effort.why', async () => {
  const metadataOnly = structuredClone(researchPlan)
  metadataOnly.questions = ['pergunta diferente']
  metadataOnly.effort.why = 'explicação diferente'
  const persisted = []
  let seq = 0
  const runtime = { host: 'test', models: {}, capabilities: { readOnlyEnforced: true }, emit: async event => ({ ...event, seq: ++seq }), saveState: async state => persisted.push(structuredClone(state)) }
  const script = async label => {
    if (label === 'plan-review:r1') return { feedback: { ...approval('REPLAN'), affectedNodes: ['R1'] } }
    if (label === 'plan') return metadataOnly
    if (label === 'plan-review:r2') return { feedback: approval('APPROVE') }
    return null
  }
  const { result, calls } = await runWorkflow({ ...BASE, planOnly: true, plan: researchPlan }, script, { runtime })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'plan_no_progress')
  assert.equal(persisted.length, 1)
  assert.equal(persisted.at(-1).planVersion, 1)
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), ['plan-review:r1', 'plan', 'plan-review:r2'])
  assert.ok(!calls.includes('synth'))
})

test('REPLAN→FIX_LOCAL→REPLAN A-B-A bloqueia por ciclo sem consumir outra chamada', async () => {
  const candidateB = structuredClone(researchPlan)
  candidateB.nodes[0].brief = 'contrato B'
  let plannerCalls = 0
  const persisted = []
  let seq = 0
  const runtime = { host: 'test', models: {}, capabilities: { readOnlyEnforced: true }, fingerprint: async ({ contracts }) => ({ identity: JSON.stringify(contracts) }), emit: async event => ({ ...event, seq: ++seq }), saveState: async state => persisted.push(structuredClone(state)) }
  const script = async label => {
    if (label === 'plan-review:r1') return { feedback: { ...approval('REPLAN'), reason: 'A', affectedNodes: ['R1'] } }
    if (label === 'plan-review:r2') return { feedback: { ...approval('FIX_LOCAL'), reason: 'B', affectedNodes: ['R1'] } }
    if (label === 'plan-review:r3') return { feedback: { ...approval('REPLAN'), reason: 'A', affectedNodes: ['R1'] } }
    if (label === 'plan') return plannerCalls++ === 0 ? candidateB : structuredClone(researchPlan)
    return null
  }
  const { result, calls } = await runWorkflow({ ...BASE, planOnly: true, plan: researchPlan }, script, { runtime })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'no_progress_feedback_loop')
  assert.equal(persisted.at(-1).planVersion, 1)
  assert.equal(result.budget.structuralReplansUsed, 1)
  assert.equal(result.budget.localRepairsUsed, 1)
  assert.equal(plannerCalls, 2)
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), ['plan-review:r1', 'plan', 'plan-review:r2', 'plan', 'plan-review:r3'])
  assert.equal(persisted.at(-1).control.history.length, 2)
  assert.equal(persisted.at(-1).control.seenPairs.length, 2)
  assert.deepEqual(persisted.at(-1).control.counters, { structuralReplansUsed: 1, localRepairsUsed: 1 })
})

test('reserva local sob concorrência não autoriza um terceiro reparo', async () => {
  const initial = {
    goal: 'g', complexity: 'moderate', mode: 'research', doneWhen: ['ok'],
    nodes: [
      { id: 'R1', title: 'Pesquisa 1', kind: 'research', brief: 'A', deps: [], risk: 'low', acceptance: ['ok'] },
      { id: 'R2', title: 'Pesquisa 2', kind: 'research', brief: 'B', deps: [], risk: 'low', acceptance: ['ok'] },
    ],
    effort: { level: 'max', why: 'teste' },
  }
  const corrected = structuredClone(initial)
  corrected.nodes[0].brief = 'A corrigido pelo planner'
  const persisted = []
  let seq = 0
  let verifyStarted = 0
  let releaseVerifiers
  const bothVerifiers = new Promise(resolve => { releaseVerifiers = resolve })
  let fingerprintCalls = 0
  let releaseFingerprints
  const bothFingerprints = new Promise(resolve => { releaseFingerprints = resolve })
  const runtime = {
    host: 'test', models: {}, capabilities: { checks: true, fingerprint: true, readOnlyEnforced: true },
    snapshot: async () => ({ identity: 'stable', evidencePath: 'snapshot.json', evidenceHash: 'snapshot-hash' }),
    verifyArtifact: async artifact => Boolean(artifact?.evidencePath && artifact?.evidenceHash),
    fingerprint: async ({ contracts }) => {
      if (verifyStarted < 2) return { identity: `before-${contracts[0].value.id}` }
      const call = ++fingerprintCalls
      if (fingerprintCalls === 2) releaseFingerprints()
      await bothFingerprints
      return { identity: `concurrent-output-observation-${call}` }
    },
    emit: async event => ({ ...event, seq: ++seq }),
    saveState: async state => persisted.push(structuredClone(state)),
  }
  const verifierCalls = new Map()
  const script = async label => {
    if (label === 'plan-review:r1') return { feedback: { ...approval('FIX_LOCAL'), affectedNodes: ['R1'] } }
    if (label === 'plan') return corrected
    if (label === 'plan-review:r2') return { feedback: approval('APPROVE') }
    if (label.startsWith('verify:R')) {
      const id = label.slice('verify:'.length)
      const count = (verifierCalls.get(id) || 0) + 1
      verifierCalls.set(id, count)
      if (count === 1) {
        verifyStarted++
        if (verifyStarted === 2) releaseVerifiers()
        await bothVerifiers
        return { pass: false, confidence: 'high', blocking: [{ issue: 'contrato incompleto', fix: 'completar' }] }
      }
      return { pass: true, confidence: 'high', blocking: [] }
    }
    return defaultScript()(label)
  }
  const { result, calls } = await runWorkflow({ ...BASE, mode: 'research', effort: 'max', plan: initial }, script, { runtime })
  assert.equal(result.budget.localRepairsUsed, 2)
  assert.equal(calls.filter(label => label.startsWith('repair:')).length, 1)
  assert.equal(calls.filter(label => label.startsWith('verify:R')).length, 3)
  assert.equal(persisted.filter(state => state.control?.stage === 'node-fix-intent').length, 1)
  assert.ok(persisted.some(state => state.control?.stage === 'feedback-dispatch' && state.control.counters.localRepairsUsed === 2))
  assert.ok(!persisted.some(state => state.control?.stage === 'node-fix-intent' && state.control.counters.localRepairsUsed > 2))
})

test('FIX_LOCAL no gate do plano usa planner forte e só aceita após reviewer repetir', async () => {
  const candidate = structuredClone(researchPlan)
  candidate.nodes[0].brief = 'pesquisar com a lacuna corrigida'
  const script = async label => {
    if (label === 'plan-review:r1') return { feedback: { ...approval('FIX_LOCAL'), affectedNodes: ['R1'] } }
    if (label === 'plan') return candidate
    if (label === 'plan-review:r2') return { feedback: approval('APPROVE') }
    return null
  }
  const { result, calls } = await runWorkflow({ ...BASE, planOnly: true, plan: researchPlan }, script)
  assert.equal(result.planOnly, true)
  assert.equal(result.planVersion, 2)
  assert.equal(result.budget.localRepairsUsed, 1)
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), ['plan-review:r1', 'plan', 'plan-review:r2'])
})

test('feedback seguinte vê o plano candidato novo e não bloqueia progresso semântico legítimo', async () => {
  const candidate = structuredClone(researchPlan)
  candidate.nodes[0].brief = 'contrato atualizado após replan'
  const correction = structuredClone(candidate)
  correction.nodes[0].acceptance = ['evidência atualizada']
  const script = async label => {
    if (label === 'plan-review:r1') return { feedback: { ...approval('REPLAN'), affectedNodes: ['R1'] } }
    if (label === 'plan') return callsPlan++ === 0 ? candidate : correction
    if (label === 'plan-review:r2') return { feedback: { ...approval('FIX_LOCAL'), affectedNodes: ['R1'] } }
    if (label === 'plan-review:r3') return { feedback: approval('APPROVE') }
    return null
  }
  let callsPlan = 0
  const runtime = {
    host: 'test', models: {}, capabilities: { readOnlyEnforced: true },
    fingerprint: async ({ contracts }) => ({ identity: JSON.stringify(contracts) }),
    emit: async (event) => ({ ...event, seq: ++seq }), saveState: async state => persisted.push(structuredClone(state)),
  }
  const persisted = []
  let seq = 0
  const { result, calls } = await runWorkflow({ ...BASE, planOnly: true, plan: researchPlan }, script, { runtime })
  assert.equal(result.planVersion, 2)
  assert.equal(result.budget.structuralReplansUsed, 1)
  assert.equal(result.budget.localRepairsUsed, 1)
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), ['plan-review:r1', 'plan', 'plan-review:r2', 'plan', 'plan-review:r3'])
  assert.ok(persisted.some(state => state.control.history.length === 2 && state.control.counters.localRepairsUsed === 1))
})

test('falha ao persistir feedback de REPLAN bloqueia antes do planner', async () => {
  let seq = 0
  const runtime = { host: 'test', models: {}, capabilities: { readOnlyEnforced: true }, fingerprint: async () => ({ identity: 'stable' }), emit: async event => ({ ...event, seq: ++seq }), saveState: async state => { if (state.control.stage === 'feedback-dispatch') throw new Error('falha'); return state } }
  const { result, calls } = await runWorkflow({ ...BASE, plan: researchPlan }, async label => label === 'plan-review:r1' ? { feedback: { ...approval('REPLAN'), affectedNodes: ['R1'] } } : null, { runtime })
  assert.equal(result.feedback.reason, 'control_persistence_failed')
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), ['plan-review:r1'])
})

test('feedback com nó desconhecido bloqueia sem chamar planner', async () => {
  const { result, calls } = await runWorkflow({ ...BASE, plan: researchPlan }, label => label === 'plan-review:r1'
    ? { feedback: { ...approval('FIX_LOCAL'), affectedNodes: ['missing'] } }
    : null)
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'feedback_scope_invalid')
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), ['plan-review:r1'])
})

test('planOnly passa pela revisão forte e prevalece sobre implement sem evidência', async () => {
  const plan = { ...researchPlan, mode: 'implement', nodes: [...researchPlan.nodes, { id: 'I1', title: 'Implementação', kind: 'implement', brief: 'alterar', deps: ['R1'], risk: 'medium', acceptance: ['ok'] }] }
  const runtime = { host: 'test', models: {}, capabilities: { checks: false, fingerprint: false, readOnlyEnforced: true } }
  const { result, calls } = await runWorkflow({ ...BASE, mode: 'implement', planOnly: true, plan }, defaultScript(), { runtime })
  assert.equal(result.planOnly, true)
  assert.ok(calls.includes('plan-review:r1'))
  assert.ok(!calls.some(label => label.startsWith('work:') || label.startsWith('polish:')))
})

test('ausência de runtime bloqueia antes do planner, sem chamadas', async () => {
  const { result, calls } = await runWorkflow({ ...BASE, plan: researchPlan }, defaultScript(), { runtime: null })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'trusted_runtime_unavailable')
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), [])
})

test('implement sem checks/fingerprint bloqueia antes de qualquer nó; planOnly já retornou antes', async () => {
  const plan = { ...researchPlan, mode: 'implement', nodes: [...researchPlan.nodes, { id: 'D1', title: 'Design', kind: 'design', brief: 'decidir', deps: ['R1'], risk: 'low', acceptance: ['decisão'] }, { id: 'I1', title: 'Implementação', kind: 'implement', brief: 'alterar', deps: ['D1'], files: ['x.js'], risk: 'medium', acceptance: ['ok'] }] }
  const runtime = { host: 'test', models: {}, capabilities: { checks: false, fingerprint: false, readOnlyEnforced: true } }
  const { result, calls } = await runWorkflow({ ...BASE, mode: 'implement', plan }, defaultScript(), { runtime })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'runtime_evidence_unavailable')
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), ['plan-review:r1'])
})

test('critic contraditório e síntese legacy done nunca promovem a execução', async () => {
  const plan = structuredClone(researchPlan)
  const script = defaultScript({ critic: { feedback: approval('DONE'), done: false, assessment: 'não concluído', gaps: [] }, synth: { status: 'done', summary: 'synth tentou promover', humanGate: [] } })
  const { result } = await runWorkflow({ ...BASE, plan }, script)
  assert.notEqual(result.status, 'done')
})

// Regressão (benchmark real Claude, 20/10/2026): o Opus aprovou o plano listando os nós revisados em
// affectedNodes; readFeedback descarta APPROVE com nós afetados e a run bloqueou com plan_review_failed_or_invalid.
// Nada no schema dizia a regra ao modelo. O schema enviado a todo revisor precisa dizê-la.
test('schema de feedback enviado ao revisor declara que APPROVE e DONE exigem severity none e affectedNodes vazio', async () => {
  const schemas = []
  await runWorkflow({ ...BASE, plan: researchPlan }, async (label, prompt, opts) => {
    if (label.startsWith('plan-review')) schemas.push(opts.schema)
    return label.startsWith('plan-review') ? { feedback: approval('BLOCK') } : null
  })
  const feedback = schemas[0].properties.feedback
  assert.match(feedback.properties.affectedNodes.description || '', /APPROVE[^.]*DONE[^.]*\[\]|vazi|empty/i)
  assert.match(feedback.properties.severity.description || '', /APPROVE[^.]*none/i)
})

// Regressão (benchmark real Claude b0d8d, 21/10/2026): pedido medium, o planner devolveu effort.level low e a run
// bloqueou com plan_effort_mismatch. O esforço é do usuário: o schema do planner só aceita o nível pedido.
test('schema do planner só aceita o esforço pedido pelo usuário', async () => {
  for (const effort of [undefined, 'low', 'max']) {
    const schemas = []
    await runWorkflow({ ...BASE, effort }, async (label, prompt, opts) => {
      if (label === 'plan') schemas.push(opts.schema)
      return null
    })
    assert.ok(schemas.length, 'o planner precisa ser chamado')
    const level = schemas[0].properties.effort.properties.level
    assert.deepEqual(level.enum, [effort ?? 'medium'])
    assert.match(level.description || '', /user|usuário/i)
  }
})

// Regressão (benchmark real Claude 0e5c, 21/10/2026): plan-review FIX_LOCAL no estágio tasks; o planner de correção trocou
// o doneWhen travado por critérios novos e a run bloqueou com original_plan_criteria_changed. O prompt não dizia quais eram.
test('correção do plano recebe o doneWhen travado no prompt e no schema', async () => {
  const plan = { ...researchPlan, doneWhen: ['critério um', 'critério dois'] }
  const fix = { ...approval('FIX_LOCAL'), affectedNodes: ['R1'] }
  let reviews = 0
  let correction = null
  await runWorkflow({ ...BASE, plan }, async (label, prompt, opts) => {
    if (label.startsWith('plan-review')) return { feedback: reviews++ === 0 ? fix : approval('BLOCK') }
    if (label === 'plan') { correction = { prompt, schema: opts.schema }; return { ...plan, doneWhen: ['critério dois', 'critério um'] } }
    return null
  })
  assert.ok(correction, 'o planner de correção precisa rodar')
  assert.match(correction.prompt, /critério um/)
  assert.match(correction.prompt, /locked|travad/i)
  const doneWhen = correction.schema.properties.doneWhen
  assert.deepEqual([...doneWhen.items.enum].sort(), ['critério dois', 'critério um'])
  assert.equal(doneWhen.minItems, 2)
  assert.equal(doneWhen.maxItems, 2)
  assert.equal(reviews, 2, 'a ordem dos critérios não pode bloquear a correção antes da nova revisão')
})

// Regressão (benchmark real Claude chess 3474, 21/10/2026): o plan-review Opus pediu ajuste no N1 no texto do reason, mas listou
// só N2 em affectedNodes. A correção seguiu o texto, mexeu no N1 e a run bloqueou com local_plan_correction_changed_structure.
test('correção local pode mexer em nó citado no reason mesmo fora de affectedNodes', async () => {
  const plan = structuredClone(researchPlan)
  plan.nodes.push({ id: 'R2', title: 'Outra', kind: 'research', brief: 'pesquisar mais', deps: ['R1'], risk: 'low', acceptance: ['ok'] })
  const fix = { ...approval('FIX_LOCAL'), reason: 'Ajustar o R2. Risco menor no R1: manter a validação leniente.', affectedNodes: ['R2'] }
  const candidate = structuredClone(plan)
  candidate.nodes[0].brief = 'pesquisar com validação leniente'
  candidate.nodes[1].acceptance = ['ok', 'mais um']
  let correctionPrompt = ''
  const { result, calls } = await runWorkflow({ ...BASE, planOnly: true, plan }, async (label, prompt) => {
    if (label === 'plan-review:r1') return { feedback: fix }
    if (label === 'plan') { correctionPrompt = prompt; return candidate }
    if (label === 'plan-review:r2') return { feedback: approval('APPROVE') }
    return null
  })
  assert.notEqual(result.feedback?.reason, 'local_plan_correction_changed_structure')
  assert.equal(result.planVersion, 2)
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), ['plan-review:r1', 'plan', 'plan-review:r2'])
  assert.match(correctionPrompt, /Editable nodes: \["R1","R2"\]|Editable nodes: \["R2","R1"\]/)
})

test('correção local continua bloqueando mudança em nó que o feedback não cita', async () => {
  const plan = structuredClone(researchPlan)
  plan.nodes.push({ id: 'R2', title: 'Outra', kind: 'research', brief: 'pesquisar mais', deps: ['R1'], risk: 'low', acceptance: ['ok'] })
  const fix = { ...approval('FIX_LOCAL'), reason: 'Ajustar o aceite do R2.', affectedNodes: ['R2'] }
  const candidate = structuredClone(plan)
  candidate.nodes[0].brief = 'mudança fora do escopo'
  const { result } = await runWorkflow({ ...BASE, planOnly: true, plan }, async label => {
    if (label === 'plan-review:r1') return { feedback: fix }
    if (label === 'plan') return candidate
    return { feedback: approval('APPROVE') }
  })
  assert.equal(result.feedback.reason, 'local_plan_correction_changed_structure')
})

// Regressão (benchmark Minecraft MVP, 21/10/2026): o plan-review Opus pediu FIX_LOCAL com "adicione deps:[N1] ao N2" e listou
// N1, N2 e N3 em affectedNodes. A correção fez exatamente isso e a run bloqueou com local_plan_correction_changed_structure
// antes de qualquer nó rodar, porque a correção local não podia mudar deps nem de nó citado.
test('correção local pode mudar as deps de nó citado antes de ele rodar', async () => {
  const plan = structuredClone(researchPlan)
  plan.nodes.push({ id: 'R2', title: 'Outra', kind: 'research', brief: 'pesquisar mais', deps: [], risk: 'low', acceptance: ['ok'] })
  const fix = { ...approval('FIX_LOCAL'), reason: 'O R2 usa o resultado do R1: adicione deps ["R1"] ao R2.', affectedNodes: ['R1', 'R2'] }
  const candidate = structuredClone(plan)
  candidate.nodes[1].deps = ['R1']
  let correctionPrompt = ''
  const { result, calls } = await runWorkflow({ ...BASE, planOnly: true, plan }, async (label, prompt) => {
    if (label === 'plan-review:r1') return { feedback: fix }
    if (label === 'plan') { correctionPrompt = prompt; return candidate }
    if (label === 'plan-review:r2') return { feedback: approval('APPROVE') }
    return null
  })
  assert.notEqual(result.feedback?.reason, 'local_plan_correction_changed_structure')
  assert.equal(result.planVersion, 2)
  assert.deepEqual(calls.filter(label => !label.startsWith('#')), ['plan-review:r1', 'plan', 'plan-review:r2'])
  assert.match(correctionPrompt, /deps/)
})

test('correção local continua bloqueando mudança de deps em nó que o feedback não cita', async () => {
  const plan = structuredClone(researchPlan)
  plan.nodes.push({ id: 'R2', title: 'Outra', kind: 'research', brief: 'pesquisar mais', deps: [], risk: 'low', acceptance: ['ok'] })
  plan.nodes.push({ id: 'R3', title: 'Mais', kind: 'research', brief: 'pesquisar ainda', deps: [], risk: 'low', acceptance: ['ok'] })
  const fix = { ...approval('FIX_LOCAL'), reason: 'Ajustar o aceite do R2.', affectedNodes: ['R2'] }
  const candidate = structuredClone(plan)
  candidate.nodes[2].deps = ['R1']
  const { result } = await runWorkflow({ ...BASE, planOnly: true, plan }, async label => {
    if (label === 'plan-review:r1') return { feedback: fix }
    if (label === 'plan') return candidate
    return { feedback: approval('APPROVE') }
  })
  assert.equal(result.feedback.reason, 'local_plan_correction_changed_structure')
})

test('plan reviewer é avisado que doneWhen é travado e que affectedNodes lista todo nó a corrigir', async () => {
  let reviewPrompt = ''
  await runWorkflow({ ...BASE, planOnly: true, plan: researchPlan }, async (label, prompt) => {
    if (label === 'plan-review:r1') { reviewPrompt = prompt; return { feedback: approval('APPROVE') } }
    return null
  })
  assert.match(reviewPrompt, /doneWhen is locked/)
  assert.match(reviewPrompt, /affectedNodes must list every node/)
})
