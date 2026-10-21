// D1 §12: trilhos (R1..R6), revisão do design que bloqueia a implementação, paralelo por arquivos
// disjuntos, síntese com polidores e o fim do atalho trivial — contra o motor real, via
// test/helpers/run-workflow.mjs (agent() simulado).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow, defaultScript } from './helpers/run-workflow.mjs'

const BASE = { task: 'tarefa de teste', runDir: '.graph-runs/test', checks: [{ id: 'test', command: 'node', args: ['--test'] }] }

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
  const { result, calls } = await runWorkflow({ ...BASE, mode: 'implement', plan }, defaultScript(routes))
  assert.ok(!calls.some((c) => c.startsWith('work:I1')), 'work:I1 não devia rodar')
  assert.ok(!calls.some((c) => c.startsWith('verify:I1')))
  assert.equal(result.status, 'blocked')
  assert.equal(result.designReview.pass, false)
  assert.equal(calls.filter((c) => c === 'design-repair:D1').length, 1, 'reparo de design consome o banco local global')
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

test('orçamento low reserva o esqueleto e todos os gates', async () => {
  const plan = planWith([
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ], { effort: { level: 'low', why: 'teste' } })
  const { calls, result } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'low', plan }, defaultScript())
  assert.equal(result.status, 'done')
  assert.deepEqual(result.stats.dropped, [])
  for (const gate of ['plan-review:r1', 'design-review:r1', 'verify:I1', 'critic:r1', 'polish:1', 'synth']) assert.ok(calls.includes(gate), `${gate} não foi reservado`)
  assert.equal(result.budget.limitsByRole.executor, 6)
  assert.equal(result.budget.limitsByRole.verifier, 6)
})

test('orçamento: 2 implementações paralelas (arquivos disjuntos) reservam verify para as duas', async () => {
  // O orçamento medium cobre plan-review, os dois verifies, polish e o gate final.
  const plan = planWith([
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i1', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['a.js'] },
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['b.js'] },
  ])
  const { calls, result } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'medium', plan }, defaultScript())
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

test('plano acima do node cap bloqueia sem remover implementações aprovadas', async () => {
  const plan = planWith([
    { id: 'I1', kind: 'implement', title: 'i1', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['a.js'] },
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['b.js'] },
    { id: 'I3', kind: 'implement', title: 'i3', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['c.js'] },
  ], { effort: { level: 'low', why: 'teste' } })
  const { result, calls } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'low', plan }, defaultScript())
  assert.equal(result.feedback.reason, 'approved_plan_exceeds_effort_node_cap')
  assert.equal(result.feedback.affectedNodes.length, 5)
  assert.equal(result.plan.nodes.filter((n) => n.kind === 'implement').length, 3)
  assert.ok(!calls.some((label) => label.startsWith('work:')))
})

test('crítica sempre roda no piso, em implement e em architecture', async () => {
  const planImpl = planWith([
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ])
  const implRun = await runWorkflow({ ...BASE, mode: 'implement', effort: 'low', plan: planWith(planImpl.nodes, { effort: { level: 'low', why: 'teste' } }) }, defaultScript())
  assert.ok(implRun.calls.includes('critic:r1'))
  assert.ok(implRun.calls.includes('design-review:r1'))
  assert.ok(implRun.calls.includes('synth'))

  const planArch = planWith([
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
  ])
  const archRun = await runWorkflow({ ...BASE, mode: 'architecture', effort: 'low', plan: planWith(planArch.nodes, { effort: { level: 'low', why: 'teste' } }) }, defaultScript())
  assert.ok(archRun.calls.includes('critic:r1'))
  assert.ok(archRun.calls.includes('design-review:r1'))
  assert.ok(archRun.calls.includes('synth'))
})

test('implementações são serializadas para atribuir diffs; arquivos sobrepostos também nunca rodam juntos', async () => {
  const plan = planWith([
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['a.js'] },
    { id: 'I3', kind: 'implement', title: 'i3', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['b.js'] },
  ])
  const { maxLive } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'medium', plan }, defaultScript())
  assert.equal(maxLive, 1, `implementações disjuntas devem preservar a escrita serial, veio ${maxLive}`)

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
  await runWorkflow({ ...BASE, mode: 'implement', effort: 'medium', plan: overlapPlan }, defaultScript(routes))
  assert.equal(sawConcurrentWork, false, 'work:I2 e work:I3 rodaram juntos apesar de compartilhar arquivo')
})

test('polidores: 3 implementações prontas com arquivos disjuntos geram 2 rótulos polish antes do synth', async () => {
  const plan = planWith([
    { id: 'I1', kind: 'implement', title: 'i1', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['a.js'] },
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['b.js'] },
    { id: 'I3', kind: 'implement', title: 'i3', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['c.js'] },
  ])
  const { calls } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'medium', plan }, defaultScript())
  const polishCalls = calls.filter((c) => c.startsWith('polish:'))
  assert.equal(polishCalls.length, 2, `esperado 2 polidores (ceil(2*3/3)), veio ${polishCalls.length}: ${polishCalls}`)
  assert.ok(calls.indexOf('synth') > calls.indexOf(polishCalls[polishCalls.length - 1]))
})

test('polidor: prompt não usa git checkout, cita só as refs de backup do supervisor e não manda copiar para RUN_DIR', async () => {
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
  await runWorkflow({ ...BASE, mode: 'implement', effort: 'medium', plan }, defaultScript(routes))
  assert.ok(polishPrompt, 'rótulo polish:1 não disparou')
  assert.ok(!/git checkout/.test(polishPrompt), 'prompt do polidor ainda manda git checkout')
  assert.ok(!/git (restore|stash|reset)/.test(polishPrompt), 'prompt do polidor ainda manda git restore/stash/reset')
  // (1) cita a ref real do backup criado pelo supervisor e manda restaurar a partir dela
  assert.ok(polishPrompt.includes(`a.js <- ${BASE.runDir}/polish-backups/fake/a.js`), 'prompt do polidor não cita a ref do backup do supervisor')
  assert.match(polishPrompt, /restore each of your area files from the backup/, 'prompt do polidor não manda restaurar a partir do backup')
  // (2) não manda copiar nem escrever nada em RUN_DIR
  assert.ok(!/Before editing, copy/.test(polishPrompt), 'prompt do polidor ainda manda copiar antes de editar')
  assert.ok(!/into \S*polish-\d/.test(polishPrompt), 'prompt do polidor ainda manda gravar em polish-N dentro de RUN_DIR')
  assert.match(polishPrompt, /read-only for you: do not create, edit or delete any backup/, 'refs de backup não são declaradas somente leitura')
})

test('effort high é rejeitado pelo motor', async () => {
  const plan = planWith([
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['x.js'] },
  ])
  const { result, calls } = await runWorkflow({ ...BASE, mode: 'implement', effort: 'high', plan }, defaultScript())
  assert.equal(result.feedback.reason, 'invalid_effort')
  assert.deepEqual(calls, [])
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

// Os nós de uma run dividem a árvore de trabalho, e nada da run está commitado. Um `git stash` de um
// nó (para medir a linha de base) leva junto o trabalho dos outros, e a pilha de stash é uma só para
// todos os worktrees do repo. Aconteceu na run 20260928-1146-acoes-no-painel: um executor e um
// verificador fizeram stash e pop ao mesmo tempo, e um levou o trabalho do outro. A regra vai no
// prefixo que todo agente recebe.
test('todo agente recebe a regra de não usar stash, reset, checkout, restore nem clean', async () => {
  const plan = planWith([
    { id: 'R1', kind: 'research', title: 'r', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i', brief: 'b', deps: ['D1'], risk: 'high', acceptance: ['a'], files: ['x.js'] },
  ])
  const prompts = new Map()
  const base = defaultScript()
  const script = (label, prompt, opts) => {
    prompts.set(label, prompt)
    return base(label, prompt, opts)
  }
  await runWorkflow({ ...BASE, mode: 'implement', effort: 'medium', plan }, script)
  const kinds = new Set([...prompts.keys()].map((l) => l.split(':')[0]))
  for (const k of ['work', 'verify', 'design-review', 'critic', 'synth']) assert.ok(kinds.has(k), `nenhum agente ${k} rodou`)
  for (const [label, prompt] of prompts) {
    assert.match(prompt, /Never use git's stash, reset, checkout, restore or clean commands/, `${label} sem a regra`)
    // Sem shell de agente (Claude), a saída pela linha de base vira o aviso de que o supervisor roda os checks.
    assert.match(prompt, /git worktree add --detach <tmp> HEAD|You cannot run commands\. The supervisor runs the approved checks/, `${label} sem a saída pela linha de base`)
  }
})

// C8: o motor não manda o modelo escrever relatório privado em RUN_DIR; o resultado estruturado é a prova.
test('C8: prompt de implement e de repair não manda escrever arquivo em RUN_DIR', async () => {
  const plan = planWith([
    { id: 'I1', kind: 'implement', title: 'i1', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['a.js'] },
  ])
  const defaults = defaultScript()
  const prompts = {}
  const script = (label, prompt, opts) => {
    if (label === 'work:I1' || label === 'repair:I1') prompts[label] = prompt
    if (label === 'verify:I1') return { pass: false, confidence: 'high', blocking: [{ issue: 'falha real', where: 'I1', fix: 'reparar' }] }
    return defaults(label, prompt, opts)
  }
  await runWorkflow({ ...BASE, mode: 'implement', effort: 'medium', plan }, script)
  const runDirMd = new RegExp(`${BASE.runDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^\\s\`"]*\\.md`)
  for (const label of ['work:I1', 'repair:I1']) {
    assert.ok(prompts[label], `${label} não disparou`)
    assert.ok(!/Write the full output to/.test(prompts[label]), `${label} ainda manda escrever o relatório`)
    assert.ok(!runDirMd.test(prompts[label]), `${label} cita arquivo .md dentro de RUN_DIR como destino`)
  }
})

test('C8: artifact devolvido pelo modelo não vira caminho nos prompts de verify nem de dependente', async () => {
  const plan = planWith([
    { id: 'I1', kind: 'implement', title: 'i1', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], files: ['a.js'] },
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: ['I1'], risk: 'low', acceptance: ['a'], files: ['b.js'] },
  ])
  const defaults = defaultScript()
  const prompts = {}
  const script = (label, prompt, opts) => {
    if (label === 'verify:I1' || label === 'work:I2') prompts[label] = prompt
    if (label === 'work:I1') return { status: 'done', summary: 'feito', confidence: 'high', checks: [], artifact: `${BASE.runDir}/state.json`, filesChanged: ['a.js'] }
    return defaults(label, prompt, opts)
  }
  await runWorkflow({ ...BASE, mode: 'implement', effort: 'medium', plan }, script)
  assert.ok(prompts['verify:I1'], 'verify:I1 não disparou')
  assert.ok(prompts['work:I2'], 'work:I2 não disparou')
  for (const label of ['verify:I1', 'work:I2']) {
    assert.ok(!prompts[label].includes('state.json'), `${label} trata artifact do modelo como caminho`)
  }
})

test('C8: judge de rascunhos não cita .a.md/.b.md quando os rascunhos não trazem artifact', async () => {
  const plan = planWith([
    { id: 'D1', kind: 'design', title: 'd', brief: 'b', deps: [], risk: 'low', acceptance: ['a'], explore: true },
  ], { effort: { level: 'max', why: 't' } })
  const defaults = defaultScript()
  let judgePrompt = null
  const script = (label, prompt, opts) => {
    if (label === 'judge:D1') judgePrompt = prompt
    if (label.startsWith('draft-')) return { status: 'done', summary: `rascunho ${label}`, confidence: 'high', checks: [] }
    return defaults(label, prompt, opts)
  }
  await runWorkflow({ ...BASE, mode: 'architecture', effort: 'max', plan }, script)
  assert.ok(judgePrompt, 'judge:D1 não disparou')
  assert.ok(!/\.[ab]\.md/.test(judgePrompt), 'judge cita arquivo de rascunho que nunca foi escrito')
})
