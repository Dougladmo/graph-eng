// D1 §12: trilhos (R1..R6), revisão do design que bloqueia a implementação, paralelo por arquivos
// disjuntos, síntese com polidores e o fim do atalho trivial — contra o motor real, via
// test/helpers/run-workflow.mjs (agent() simulado).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, defaultScript } from './helpers/run-workflow.mjs'

const BASE = { task: 'tarefa de teste', runDir: '.graph-runs/test', checks: [] }

function planWith(nodes, extra) {
  return Object.assign({ goal: 'g', complexity: 'moderate', doneWhen: ['ok'], nodes, effort: { level: 'medium', why: 't' } }, extra)
}

test('R1: plano sem pesquisa ganha research-base na raiz', async () => {
  const plan = planWith([
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ])
  const { result } = await runWorkflow({ ...BASE, mode: 'implement', planOnly: true, plan }, defaultScript())
  const ids = result.plan.nodes.map((n) => n.id)
  assert.ok(ids.includes('research-base'), 'research-base não foi injetado')
  const base = result.plan.nodes.find((n) => n.id === 'research-base')
  assert.equal(base.injected, true)
  assert.equal(base.deps.length, 0)
  const d1 = result.plan.nodes.find((n) => n.id === 'D1')
  assert.ok(d1.deps.includes('research-base'), 'D1 não passou a depender de research-base')
  assert.ok(result.rails.some((r) => r.rule === 'R1'))
})

test('R1: log do motor registra o trilho', async () => {
  const plan = planWith([
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ])
  const { logs } = await runWorkflow({ ...BASE, mode: 'implement', planOnly: true, plan }, defaultScript())
  assert.ok(logs.some((l) => l.includes('trilho R1:')))
})

test('R4: implementação sem design ganha dependência em todos os designs do round', async () => {
  const plan = planWith([
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ])
  const { result } = await runWorkflow({ ...BASE, mode: 'implement', planOnly: true, plan }, defaultScript())
  const i1 = result.plan.nodes.find((n) => n.id === 'I1')
  assert.ok(i1.deps.includes('D1'), 'I1 não passou a depender de D1')
  assert.ok(result.rails.some((r) => r.rule === 'R4'))
})

test('R5: pesquisa perde dependência de design', async () => {
  const plan = planWith([
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'] },
  ])
  const { result } = await runWorkflow({ ...BASE, mode: 'implement', planOnly: true, plan }, defaultScript())
  const r1 = result.plan.nodes.find((n) => n.id === 'R1')
  assert.equal(r1.deps.length, 0, 'R1 continuou dependendo de D1')
  const d1 = result.plan.nodes.find((n) => n.id === 'D1')
  assert.ok(d1.deps.includes('R1'), 'D1 devia ganhar dep em R1 via R2 (design sem pesquisa nos ancestrais)')
  assert.ok(result.rails.some((r) => r.rule === 'R5'))
})

test('R6: design perde dependência de implement (evita deadlock)', async () => {
  const plan = planWith([
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'], files: ['x.js'] },
    { id: 'D2', kind: 'design', title: 'd', brief: 'b', deps: ['I1', 'R1'], risk: 'low', acceptance: ['a'] },
  ])
  const { result } = await runWorkflow({ ...BASE, mode: 'implement', planOnly: true, plan }, defaultScript())
  const d2 = result.plan.nodes.find((n) => n.id === 'D2')
  assert.ok(!d2.deps.includes('I1'), 'D2 continuou dependendo de I1')
  assert.ok(result.rails.some((r) => r.rule === 'R6'))
})

test('idempotência: reenviar o plano devolvido não gera trilho novo', async () => {
  const plan = planWith([
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ])
  const first = await runWorkflow({ ...BASE, mode: 'implement', planOnly: true, plan }, defaultScript())
  assert.ok(first.result.rails.length > 0)
  const resent = { ...BASE, mode: 'implement', planOnly: true, plan: first.result.plan }
  const second = await runWorkflow(resent, defaultScript())
  assert.deepEqual(second.result.rails, [])
  const base = second.result.plan.nodes.find((n) => n.id === 'research-base')
  assert.ok(base, 'research-base não sobreviveu ao reenvio (id trocou)')
  assert.equal(base.injected, true)
  assert.ok(base.reason && base.reason.length > 0)
  const d1 = second.result.plan.nodes.find((n) => n.id === 'D1')
  assert.ok(d1.deps.includes('research-base'))
})

test('id reservado usado pelo planner (sem injected) é renomeado e não conta como trilho', async () => {
  const plan = planWith([
    { id: 'research-base', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: ['research-base'], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ])
  const { result } = await runWorkflow({ ...BASE, mode: 'implement', planOnly: true, plan }, defaultScript())
  assert.ok(!result.plan.nodes.some((n) => n.id === 'research-base'), 'id reservado não foi renomeado')
  assert.ok(result.plan.nodes.some((n) => n.id === 'research-base_'))
  assert.ok(!result.rails.some((r) => r.rule === 'R1'), 'R1 não devia disparar: já havia pesquisa')
})

test('revisão reprovada impede qualquer agente work de implementação', async () => {
  const plan = planWith([
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ])
  const routes = {
    'design-review': () => ({ pass: false, confidence: 'high', blocking: [{ issue: 'falta contrato', where: 'D1', fix: 'definir', node: 'D1' }], checked: {} }),
  }
  const { result, calls } = await runWorkflow({ ...BASE, mode: 'implement', plan, maxRepairs: 1 }, defaultScript(routes))
  assert.ok(!calls.some((c) => c.startsWith('work:I1')), 'work:I1 não devia rodar')
  assert.ok(!calls.some((c) => c.startsWith('verify:I1')))
  assert.equal(result.status, 'blocked')
  assert.equal(result.designReview.pass, false)
  assert.equal(calls.filter((c) => c === 'design-repair:D1').length, 1, 'exatamente 1 reparo de design (maxRepairs:1)')
  assert.ok(calls.includes('synth'))
  assert.ok(!calls.some((c) => c.startsWith('critic:')), 'crítica não devia rodar')
})

test('sem atalho trivial: 1 nó implement ainda passa por design-review, critic e synth', async () => {
  const plan = planWith([
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ], { complexity: 'trivial' })
  const { calls } = await runWorkflow({ ...BASE, mode: 'implement', plan }, defaultScript())
  assert.ok(calls.includes('design-review:r1'))
  assert.ok(calls.includes('critic:r1'))
  assert.ok(calls.includes('synth'))
})

test('orçamento: esforço low com teto 24 (alvo 8) gasta no máximo 8 agentes', async () => {
  const plan = planWith([
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ])
  const { calls } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'low', ceiling: 24, plan }, defaultScript())
  const agentCalls = calls.filter((c) => !c.startsWith('#'))
  assert.ok(agentCalls.length <= 8, `gastou ${agentCalls.length} agentes, esperado <= 8`)
})

test('orçamento: 2 implementações paralelas (arquivos disjuntos) reservam verify para as duas', async () => {
  // effort medium / ceiling 30 -> alvo 12, exatamente o necessário: plan + R1 + D1 + design-review
  // + (I1,I2 work+verify) + critic + 2 polidores + synth = 12. Sem a reserva de (a), work:I2 (que
  // roda em paralelo por arquivo disjunto) podia gastar a vaga que garantia verify:I1.
  const plan = planWith([
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i1', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['a.js'] },
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['b.js'] },
  ])
  const { calls, result } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'medium', ceiling: 30, plan }, defaultScript())
  const impl = result.nodes.filter((n) => n.kind === 'implement')
  assert.equal(impl.length, 2)
  for (const n of impl) {
    if (n.status === 'done') assert.ok(n.verified, `${n.id} saiu done sem verified`)
    assert.notEqual(n.status, 'not run')
  }
  assert.ok(calls.includes('verify:I1'), 'verify:I1 não rodou')
  assert.ok(calls.includes('verify:I2'), 'verify:I2 não rodou')
  assert.equal(result.status, 'done')
})

test('orçamento: implementação excedente ao teto não sai "done" sem verificação', async () => {
  // effort medium / ceiling 24 -> alvo 10, max 3 nós; com R1/R3 injetando research-base e
  // design-base (plano só com 3 implementações), o trilho maxNodes corta o excedente antes de
  // rodar. Nenhuma implementação sobrevivente pode terminar "done" sem estar verified, e nem
  // todas as 3 pedidas pelo usuário conseguem rodar.
  const plan = planWith([
    { id: 'I1', kind: 'implement', title: 'i1', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['a.js'] },
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['b.js'] },
    { id: 'I3', kind: 'implement', title: 'i3', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['c.js'] },
  ])
  const { result } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'medium', ceiling: 24, plan }, defaultScript())
  const impl = result.nodes.filter((n) => n.kind === 'implement')
  for (const n of impl) {
    if (n.status === 'done') assert.ok(n.verified, `${n.id} saiu done sem verified (orçamento insuficiente)`)
  }
  const doneVerified = impl.filter((n) => n.status === 'done' && n.verified)
  assert.ok(doneVerified.length < 3, 'as 3 implementações pedidas não podiam caber e sair verificadas com esse teto')
  assert.ok(result.rails.some((r) => r.rule === 'maxNodes'), 'trilho maxNodes não registrou o corte')
})

test('crítica sempre roda no piso, em implement e em architecture', async () => {
  const planImpl = planWith([
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ])
  const implRun = await runWorkflow({ ...BASE, mode: 'implement', effort: 'low', ceiling: 24, plan: planImpl }, defaultScript())
  assert.ok(implRun.calls.includes('critic:r1'))
  assert.ok(implRun.calls.includes('design-review:r1'))
  assert.ok(implRun.calls.includes('synth'))

  const planArch = planWith([
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
  ])
  const archRun = await runWorkflow({ ...BASE, mode: 'architecture', effort: 'low', ceiling: 24, plan: planArch }, defaultScript())
  assert.ok(archRun.calls.includes('critic:r1'))
  assert.ok(archRun.calls.includes('design-review:r1'))
  assert.ok(archRun.calls.includes('synth'))
})

test('paralelo: implementações com arquivos disjuntos rodam juntas; com sobreposição, nunca simultâneas', async () => {
  const plan = planWith([
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['a.js'] },
    { id: 'I3', kind: 'implement', title: 'i3', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['b.js'] },
  ])
  const { maxLive } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'max', ceiling: 24, plan }, defaultScript())
  assert.ok(maxLive >= 2, `esperado paralelo (maxLive >= 2), veio ${maxLive}`)

  const overlapPlan = planWith([
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['a.js'] },
    { id: 'I3', kind: 'implement', title: 'i3', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['a.js'] },
  ])
  let concurrentWork = 0
  let sawConcurrentWork = false
  const routes = {
    work: async (label) => {
      if (label.startsWith('work:I')) {
        concurrentWork++
        if (concurrentWork > 1) sawConcurrentWork = true
        await new Promise((r) => setTimeout(r, 5))
        concurrentWork--
      }
      return { status: 'done', summary: label + ' ok', confidence: 'high', checks: [] }
    },
  }
  await runWorkflow({ ...BASE, mode: 'implement', effort: 'max', ceiling: 24, plan: overlapPlan }, defaultScript(routes))
  assert.equal(sawConcurrentWork, false, 'work:I2 e work:I3 rodaram juntos apesar de compartilhar arquivo')
})

test('polidores: 3 implementações prontas com arquivos disjuntos geram 2 rótulos polish antes do synth', async () => {
  const plan = planWith([
    { id: 'I1', kind: 'implement', title: 'i1', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['a.js'] },
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['b.js'] },
    { id: 'I3', kind: 'implement', title: 'i3', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['c.js'] },
  ])
  const { calls } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'max', ceiling: 48, plan }, defaultScript())
  const polishCalls = calls.filter((c) => c.startsWith('polish:'))
  assert.equal(polishCalls.length, 2, `esperado 2 polidores (ceil(2*3/3)), veio ${polishCalls.length}: ${polishCalls}`)
  assert.ok(calls.indexOf('synth') > calls.indexOf(polishCalls[polishCalls.length - 1]))
})

test('polidor: prompt não usa git checkout e manda restaurar do backup em polish-1', async () => {
  const plan = planWith([
    { id: 'I1', kind: 'implement', title: 'i1', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['a.js'] },
  ])
  let polishPrompt = null
  const routes = {
    polish: (label, prompt) => {
      if (label === 'polish:1') polishPrompt = prompt
      return { status: 'done', summary: label + ' ok', confidence: 'high', checks: [] }
    },
  }
  await runWorkflow({ ...BASE, mode: 'implement', effort: 'max', ceiling: 48, plan }, defaultScript(routes))
  assert.ok(polishPrompt, 'rótulo polish:1 não disparou')
  assert.ok(!/git checkout/.test(polishPrompt), 'prompt do polidor ainda manda git checkout')
  assert.ok(!/git (restore|stash|reset)/.test(polishPrompt), 'prompt do polidor ainda manda git restore/stash/reset')
  assert.ok(polishPrompt.includes('polish-1'), 'prompt do polidor não cita o backup em polish-1')
})

test('manual: esforço manual chega ao workflow e vira auto, registrado no log', async () => {
  const plan = planWith([
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ])
  const { logs } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'manual', plan }, defaultScript())
  assert.ok(logs.some((l) => l.includes('tratado como auto')))
})

test('architecture sem implementação: nó implement do planner vira design', async () => {
  const plan = planWith([
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ])
  const { result, calls } = await runWorkflow({ ...BASE, mode: 'architecture', plan }, defaultScript())
  const i1 = result.nodes.find((n) => n.id === 'I1')
  assert.equal(i1.kind, 'design')
  assert.ok(!result.nodes.some((n) => n.kind === 'implement'))
  assert.ok(!calls.some((c) => c.startsWith('polish:')))
  assert.ok(calls.includes('design-review:r1'))
  assert.ok(calls.includes('critic:r1'))
  assert.ok(calls.includes('synth'))
})

test('maxNodes: 3 research + 2 design + 3 implement com maxNodes 3 mantém ao menos 1 de cada kind', async () => {
  // ceiling 8 é o mínimo para implement (MODE_FLOOR.implement), o que força maxNodes a cair no
  // piso de sizing() (minNodes=3) independente do effort — exatamente o teto que a spec pede
  // testar (3), igual ao piso de 1 nó por kind obrigatório (research+design+implement).
  const plan = planWith([
    { id: 'R1', kind: 'research', title: 'r1', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'R2', kind: 'research', title: 'r2', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'R3', kind: 'research', title: 'r3', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd1', brief: 'b', deps: ['R1', 'R2', 'R3'], risk: 'low', acceptance: ['a'] },
    { id: 'D2', kind: 'design', title: 'd2', brief: 'b', deps: ['R1', 'R2', 'R3'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i1', brief: 'b', deps: ['D1', 'D2'], risk: 'low', acceptance: ['a'], files: ['a.js'] },
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: ['D1', 'D2'], risk: 'low', acceptance: ['a'], files: ['b.js'] },
    { id: 'I3', kind: 'implement', title: 'i3', brief: 'b', deps: ['D1', 'D2'], risk: 'low', acceptance: ['a'], files: ['c.js'] },
  ])
  const { result } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'low', ceiling: 8, planOnly: true, plan }, defaultScript())
  const nodes = result.plan.nodes
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const kinds = new Set(nodes.map((n) => n.kind))
  assert.ok(kinds.has('research'), 'perdeu todo research')
  assert.ok(kinds.has('design'), 'perdeu todo design')
  assert.ok(kinds.has('implement'), 'perdeu todo implement')
  assert.ok(result.rails.some((r) => r.rule === 'maxNodes'), 'trilho maxNodes não registrado')

  const ancestorsOf = (n) => {
    const seen = new Set()
    const stack = [...n.deps]
    while (stack.length) {
      const id = stack.pop()
      if (seen.has(id)) continue
      seen.add(id)
      const m = byId.get(id)
      if (m) stack.push(...m.deps)
    }
    return seen
  }
  for (const n of nodes) {
    if (n.kind === 'design') {
      const anc = ancestorsOf(n)
      assert.ok([...anc].some((id) => byId.get(id).kind === 'research'), `${n.id} (design) sem pesquisa entre os ancestrais`)
    }
    if (n.kind === 'implement') {
      const anc = ancestorsOf(n)
      assert.ok([...anc].some((id) => byId.get(id).kind === 'design'), `${n.id} (implement) sem design entre os ancestrais`)
    }
  }
})

test('auto: plano maior que o nível escolhido sobe o esforço em vez de cortar entrega', async () => {
  // Teto 24, implement: low comporta 3 nós, medium 3, high 6. O planner escolheu low, mas montou 5
  // nós; no automático quem manda no tamanho é o plano, então o nível sobe para high e nada é cortado.
  const plan = planWith([
    { id: 'R1', kind: 'research', title: 'r1', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd1', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i1', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['a.js'] },
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['b.js'] },
    { id: 'I3', kind: 'implement', title: 'i3', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['c.js'] },
  ], { effort: { level: 'low', why: 'parece simples' } })
  const { result } = await runWorkflow({ ...BASE, mode: 'implement', ceiling: 24, planOnly: true, plan }, defaultScript())
  assert.equal(result.effort.level, 'high')
  assert.equal(result.effort.target, 17)
  assert.equal(result.plan.nodes.filter((n) => n.kind === 'implement').length, 3, 'cortou implementação')
  assert.ok(result.rails.some((r) => r.rule === 'effort'), 'trilho effort não registrado')
  assert.ok(!result.rails.some((r) => r.rule === 'maxNodes'), 'não devia cortar nada')
  assert.match(result.effort.why, /subiu de low para high/)
})

test('nível fixado pelo usuário não sobe: o plano grande é cortado, mantendo o esqueleto', async () => {
  const plan = planWith([
    { id: 'R1', kind: 'research', title: 'r1', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd1', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i1', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['a.js'] },
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['b.js'] },
  ])
  const { result } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'low', ceiling: 24, planOnly: true, plan }, defaultScript())
  assert.equal(result.effort.level, 'low')
  assert.ok(!result.rails.some((r) => r.rule === 'effort'))
  assert.ok(result.rails.some((r) => r.rule === 'maxNodes'))
  assert.equal(result.plan.nodes.length, 3)
})
