// I2 (brief 3D, §6 casos 1–10 e extras 5 e 7): plan, clarify, tasks e implemente pelo runner e pelo motor reais.
// Host roteirizado por papel (helpers de test/helpers/run-workflow.mjs); evidência real numa fixture git com node --test.
import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createB5Fixture, defaultScript, runGraphScripted, withScriptedCriticEvidence } from './helpers/run-workflow.mjs'
import { contentHashOf, readSlot, sealArtifact, workspaceOf, writeSlot } from '../bin/phase-artifacts.mjs'
import { executeGrapheng, exitCodeOf } from '../bin/grapheng.mjs'
import { runGraph } from '../bin/graph-run.mjs'
import { createEvidence } from '../bin/run-evidence.mjs'
// D-E1: o dataDir padrão vem de GRAPH_ENG_STATE_DIR; os testes usam um diretório por processo para não tocar o estado real do usuário.
process.env.GRAPH_ENG_STATE_DIR ??= path.join(os.tmpdir(), `graph-eng-test-datadir-${process.pid}`)

const RESEARCH = (id, brief = 'pesquisar') => ({ id, kind: 'research', title: id, brief, deps: [], risk: 'low', acceptance: ['fonte'], files: [], inputs: [], outputs: [] })
const PLAN = (nodes = [RESEARCH('R1'), RESEARCH('R2')], extra = {}) => ({ goal: 'pipeline', complexity: 'moderate', mode: 'research', doneWhen: ['ok'], effort: { level: 'medium', why: 'teste' }, nodes, questions: [], ...extra })
const Q1 = [{ id: 'Q1', text: 'Qual banco?', options: ['pg', 'sqlite'] }]
const TASKS = { goal: 'pipeline', complexity: 'moderate', mode: 'implement', doneWhen: ['ok'], effort: { level: 'medium', why: 'teste' }, nodes: [
  { id: 'D1', kind: 'design', title: 'design', brief: 'd', deps: [], files: [], inputs: [], outputs: [], risk: 'low', acceptance: ['decisão'] },
  { id: 'I1', kind: 'implement', title: 'implementação', brief: 'i', deps: ['D1'], files: ['src/a.js'], inputs: ['src/a.js'], outputs: ['src/a.js'], risk: 'low', acceptance: ['ok'] },
] }
const BLOCKING = { kind: 'FIX_LOCAL', reason: 'falta fonte', severity: 'medium', affectedNodes: ['R1'], evidenceIds: [] }
const REPLAN = reason => ({ feedback: { kind: 'REPLAN', reason, severity: 'high', affectedNodes: ['R1'], evidenceIds: [] }, done: false, assessment: 'x', gaps: [] })

// Roteiro do host por papel. plan: planner (e decompositor de tasks, pelo prompt); critics: saídas em ordem, depois DONE.
function scripted({ plan = () => PLAN(), critics = [], clarify = () => ({ questions: [] }), tasks = () => TASKS } = {}) {
  const base = defaultScript()
  const prompts = { plan: [] }
  let planN = 0
  let criticN = 0
  const script = async (label, prompt, opts) => {
    if (label === 'plan') {
      if (prompt.includes('## Role: task decomposer')) return tasks(prompt)
      prompts.plan.push(prompt)
      planN++
      return plan(planN, prompt)
    }
    if (label === 'clarify') return clarify(prompt)
    if (label.startsWith('critic:') && criticN < critics.length) return critics[criticN++]
    return base(label, prompt, opts)
  }
  return { script, prompts }
}

// Argumentos por estágio. Estágios só de leitura não recebem checks; implement recebe os checks reais da fixture.
const stageArgs = (runId, pipeline, extra = {}) => ({
  runId, runDir: `.graph-runs/${runId}`, effort: 'medium', pipeline,
  ...(pipeline.from === 'auto' ? {} : { checks: [], checkContract: undefined, nodeCheckPolicy: undefined }),
  ...extra,
})
const PLAN_STAGE = { from: 'plan', to: 'plan' }
const TASKS_STAGE = { from: 'tasks', to: 'tasks' }
const CLARIFY_STAGE = { from: 'clarify', to: 'clarify' }
const ONE_SHOT = { from: 'auto', to: 'implement' }

const transitions = events => events.filter(event => event.type === 'control.transition').map(event => event.payload?.stage)
const starts = events => events.filter(event => event.type === 'phase.stage.started').map(event => event.payload.stage)
const reuseOf = events => events.find(event => event.type === 'phase.reuse.resolved')?.payload
const count = (calls, pattern) => calls.filter(label => pattern.test(label)).length

// Um plano aprovado + tasks aprovadas para ele, na mesma fixture (usado pela maioria dos casos).
async function approvedPlanAndTasks(t, tag, scriptOptions = {}) {
  const plan = await runGraphScripted(t, { args: stageArgs(`${tag}-plan`, PLAN_STAGE), script: scripted(scriptOptions).script })
  assert.equal(plan.result.status, 'plan_approved', JSON.stringify(plan.result).slice(0, 400))
  const tasks = await runGraphScripted(t, { fixture: plan.fixture, args: stageArgs(`${tag}-tasks`, TASKS_STAGE), script: scripted(scriptOptions).script })
  assert.equal(tasks.result.status, 'tasks_approved', JSON.stringify(tasks.result).slice(0, 400))
  return { plan, tasks, fixture: plan.fixture, cwd: plan.fixture.cwd }
}

const journalPath = (cwd, runId) => path.join(cwd, '.graph-runs', runId, 'journal.jsonl')
const readEvents = async (cwd, runId) => (await readFile(journalPath(cwd, runId), 'utf8')).trim().split('\n').map(line => JSON.parse(line))

// Driver real: executeGrapheng com runGraph real (motor e runner), host roteirizado e cada spawn registrado com o readOnly pedido.
// O runId é gerado pelo driver; a pasta da run é achada pelo prefixo grapheng- dentro de .graph-runs.
async function runDriver(t, invocation, { script = scripted().script, fixture } = {}) {
  const fx = fixture || await createB5Fixture(t)
  const spawns = []
  const calls = []
  const host = {
    capabilities: () => ({ structuredOutput: true, host: 'codex', readOnlyEnforced: true, readOnlyEnforcement: 'stub de teste' }),
    spawn: async request => {
      spawns.push({ label: request.label, role: request.role, readOnly: request.readOnly })
      return { request }
    },
    wait: async handle => {
      const { request } = handle
      calls.push(request.label)
      let output = await script(request.label, request.prompt, request, { cwd: fx.cwd })
      output = withScriptedCriticEvidence(request.label, output, request.prompt)
      return { output, requestedModel: request.model, effectiveModel: request.model, usage: null }
    },
  }
  const result = await executeGrapheng({
    invocation, cwd: fx.cwd, host: 'codex',
    configImpl: async () => ({ effort: 'medium', effortSource: 'default' }),
    runGraphImpl: call => runGraph({ ...call, stateDir: path.join(fx.base, 'state'), hostFactory: () => host }),
  })
  const runId = (await readdir(path.join(fx.cwd, '.graph-runs')).catch(() => [])).find(name => name.startsWith('grapheng-'))
  // Bloqueio antes da primeira escrita não cria journal: sem journal, não há eventos.
  const events = runId ? await readEvents(fx.cwd, runId).catch(() => []) : []
  return { result, spawns, calls, events, fixture: fx, cwd: fx.cwd }
}

// §6.1 plan: publica plan.json, sem fases de implementação; FIX_LOCAL refaz só o nó afetado; REPLAN chama o planner; terceiro REPLAN bloqueia com tombstone.
test('§6.1a plan publica plan.json sem design-review, polish nem work de implementação', async t => {
  const { script } = scripted()
  const run = await runGraphScripted(t, { args: stageArgs('c1a', PLAN_STAGE), script })
  assert.equal(run.result.status, 'plan_approved', JSON.stringify(run.result).slice(0, 400))
  assert.equal(count(run.calls, /^(design-review|polish|synth|verify|escalate)/), 0, JSON.stringify(run.calls))
  assert.equal(count(run.calls, /^work:(?!R\d+$)/), 0, JSON.stringify(run.calls))
  assert.ok(transitions(run.events).includes('plan-artifact-approved'), JSON.stringify(transitions(run.events)))
  const slot = await readSlot({ repo: run.cwd, kind: 'plan' })
  assert.equal(slot.artifact?.status, 'approved')
})

test('§6.1b critic FIX_LOCAL de research refaz só o nó afetado e não relança o planner', async t => {
  const { script, prompts } = scripted({ critics: [{ feedback: BLOCKING, done: false, assessment: 'falta', gaps: [] }] })
  const run = await runGraphScripted(t, { args: stageArgs('c1b', PLAN_STAGE), script })
  assert.equal(run.result.status, 'plan_approved', JSON.stringify(run.result).slice(0, 400))
  assert.equal(count(run.calls, /^work:R1$/), 2, JSON.stringify(run.calls))
  assert.equal(count(run.calls, /^work:R2$/), 1, JSON.stringify(run.calls))
  assert.equal(prompts.plan.length, 1, 'FIX_LOCAL não pode chamar o planner de novo')
  const fix = run.events.filter(event => event.type === 'control.transition' && event.payload?.stage === 'critic-fix-complete')
  assert.deepEqual(fix.map(event => event.payload.targets), [['R1']])
})

test('§6.1c REPLAN chama o planner de novo; terceiro REPLAN bloqueia e grava tombstone do plano', async t => {
  const variant = n => PLAN([RESEARCH('R1', `v${n}`), RESEARCH('R2')])
  const ok = await runGraphScripted(t, { args: stageArgs('c1c-ok', PLAN_STAGE), script: scripted({ plan: variant, critics: [REPLAN('r1')] }).script })
  assert.equal(ok.result.status, 'plan_approved', JSON.stringify(ok.result).slice(0, 400))
  assert.equal(count(ok.calls, /^plan$/), 2, JSON.stringify(ok.calls))

  const blocked = await runGraphScripted(t, { args: stageArgs('c1c-block', PLAN_STAGE), script: scripted({ plan: variant, critics: [REPLAN('r1'), REPLAN('r2'), REPLAN('r3')] }).script })
  assert.equal(blocked.result.status, 'blocked')
  assert.equal(blocked.result.feedback?.reason, 'structural_replan_budget_exhausted', JSON.stringify(blocked.result).slice(0, 400))
  assert.ok(transitions(blocked.events).includes('plan-artifact-rejected'), JSON.stringify(transitions(blocked.events)))
  assert.equal((await readSlot({ repo: blocked.cwd, kind: 'plan' })).artifact?.status, 'rejected')
})

// Driver (§6.1 reescrito pela decisão 5): plan pelo executeGrapheng com motor e runner reais. A research roda como work:R* read-only;
// nenhuma fase de escrita, nenhum check e nenhuma mudança na identidade do workspace (mesmo cálculo do runner: workspaceOf do snapshot).
test('plan pelo driver não escreve: todo work readOnly, sem design-review/polish/synth, sem checks.*, identidade do workspace igual', async t => {
  const fixture = await createB5Fixture(t)
  // createEvidence resolve runDir pelo cwd do processo: o caminho da sonda é absoluto, dentro da fixture.
  const probe = async () => workspaceOf(await createEvidence({ cwd: fixture.cwd, runDir: path.join(fixture.cwd, '.graph-runs', 'identity-probe') }).snapshot())
  const before = await probe()
  const run = await runDriver(t, ['plan', 'tarefa do driver'], { fixture })
  const after = await probe()
  assert.equal(run.result.status, 'plan_approved', JSON.stringify(run.result).slice(0, 400))
  const work = run.spawns.filter(spawn => /^work:/.test(spawn.label))
  assert.ok(work.length >= 2, JSON.stringify(run.spawns))
  assert.deepEqual(work.filter(spawn => spawn.readOnly !== true).map(spawn => spawn.label), [], 'todo work:* do plan precisa pedir readOnly true')
  assert.deepEqual(run.spawns.filter(spawn => /^(design-review|polish|synth)/.test(spawn.label)).map(spawn => spawn.label), [], JSON.stringify(run.spawns))
  const checkEvents = run.events.filter(event => String(event.type).startsWith('checks.')).map(event => event.type)
  assert.deepEqual(checkEvents, [], 'plan não abre janela de check')
  assert.equal(after.identity, before.identity, 'plan não pode mudar a identidade do workspace')
})

// §6.2 plano com perguntas: needs_clarification, pendente no slot, e o driver devolve código de saída 2.
test('§6.2 plano com perguntas termina needs_clarification, fica pendente no slot e sai com código 2', async t => {
  const run = await runGraphScripted(t, { args: stageArgs('c2', PLAN_STAGE), script: scripted({ plan: () => PLAN(undefined, { questions: Q1 }) }).script })
  assert.equal(run.result.status, 'needs_clarification', JSON.stringify(run.result).slice(0, 400))
  assert.match(run.result.clarification.questionSetId, /^[a-f0-9]{64}$/)
  assert.equal(run.result.clarification.questions.length, 1)
  const slot = await readSlot({ repo: run.cwd, kind: 'plan' })
  assert.equal(slot.artifact?.status, 'needs_clarification')
  assert.equal(exitCodeOf(run.result), 2)
})

// §6.3 clarify: sem respostas com perguntas pendentes não gasta nada; com respostas, o planner recebe Q/A como dado e a revisão roda de novo.
test('§6.3a clarify sem respostas e com perguntas pendentes não faz nenhuma chamada', async t => {
  const first = await runGraphScripted(t, { args: stageArgs('c3a-plan', PLAN_STAGE), script: scripted({ plan: () => PLAN(undefined, { questions: Q1 }) }).script })
  assert.equal(first.result.status, 'needs_clarification')
  const asked = await runGraphScripted(t, { fixture: first.fixture, args: stageArgs('c3a-clarify', CLARIFY_STAGE), script: scripted().script })
  assert.equal(asked.calls.length, 0, JSON.stringify(asked.calls))
  assert.equal(asked.result.status, 'needs_clarification', JSON.stringify(asked.result).slice(0, 400))
})

test('§6.3b clarify com respostas: Q/A entram como dado no planner, há nova revisão e o plano novo fica aprovado', async t => {
  const first = await runGraphScripted(t, { args: stageArgs('c3b-plan', PLAN_STAGE), script: scripted({ plan: () => PLAN(undefined, { questions: Q1 }) }).script })
  const questionSetId = first.result.clarification.questionSetId
  const answers = { questionSetId, answers: [{ questionId: 'Q1', answer: 'pg' }] }
  const { script, prompts } = scripted({ plan: () => PLAN() })
  const run = await runGraphScripted(t, { fixture: first.fixture, args: stageArgs('c3b-clarify', CLARIFY_STAGE, { clarification: answers }), script })
  assert.equal(run.result.status, 'plan_approved', JSON.stringify(run.result).slice(0, 400))
  assert.ok(prompts.plan.some(prompt => prompt.includes('Qual banco?') && prompt.includes('pg')), 'Q/A precisa aparecer no prompt do planner')
  assert.ok(run.calls.includes('plan-review:r1'), JSON.stringify(run.calls))
  const slot = await readSlot({ repo: run.cwd, kind: 'plan' })
  assert.equal(slot.artifact?.status, 'approved')
})

// §6.4 tasks: sem plano bloqueia sem chamada; com plano, decompõe com revisão e sem executor; DAG inválido bloqueia com tombstone.
test('§6.4a tasks sem plano aprovado bloqueia com plan_missing_or_incompatible sem nenhuma chamada', async t => {
  const run = await runGraphScripted(t, { args: stageArgs('c4a', TASKS_STAGE), script: scripted().script })
  assert.equal(run.calls.length, 0, JSON.stringify(run.calls))
  assert.equal(run.result.status, 'blocked')
  assert.equal(run.result.feedback?.reason, 'plan_missing_or_incompatible:absent', JSON.stringify(run.result).slice(0, 400))
})

test('§6.4b tasks com plano aprovado: decompõe, revisa, sem executor e publica tasks.json', async t => {
  const plan = await runGraphScripted(t, { args: stageArgs('c4b-plan', PLAN_STAGE), script: scripted().script })
  const run = await runGraphScripted(t, { fixture: plan.fixture, args: stageArgs('c4b-tasks', TASKS_STAGE), script: scripted().script })
  assert.equal(run.result.status, 'tasks_approved', JSON.stringify(run.result).slice(0, 400))
  assert.equal(count(run.calls, /^work:/), 0, JSON.stringify(run.calls))
  assert.equal(count(run.calls, /^plan-review:/), 1, JSON.stringify(run.calls))
  assert.equal((await readSlot({ repo: run.cwd, kind: 'tasks' })).artifact?.status, 'approved')
})

test('§6.4c tasks com DAG inválido bloqueia com invalid_dag e grava tombstone de tasks', async t => {
  const plan = await runGraphScripted(t, { args: stageArgs('c4c-plan', PLAN_STAGE), script: scripted().script })
  const cyclic = { ...TASKS, nodes: [{ ...TASKS.nodes[0], deps: ['I1'] }, TASKS.nodes[1]] }
  const run = await runGraphScripted(t, { fixture: plan.fixture, args: stageArgs('c4c-tasks', TASKS_STAGE), script: scripted({ tasks: () => cyclic }).script })
  assert.equal(run.result.feedback?.reason, 'invalid_dag', JSON.stringify(run.result).slice(0, 400))
  assert.ok(transitions(run.events).includes('tasks-rejected'), JSON.stringify(transitions(run.events)))
  assert.equal(count(run.calls, /^work:/), 0)
})

// Guarda do runner (bin/phase-pipeline.mjs, preparePipeline): plan sem tarefa bloqueia plan_task_required antes de qualquer spawn.
// O parser já recusa `plan` sem tarefa ('plan exige uma tarefa'); este caso cobre a guarda que fica atrás dele.
test('plan sem tarefa bloqueia plan_task_required sem spawn', async t => {
  const run = await runGraphScripted(t, { args: stageArgs('ptr', PLAN_STAGE, { task: undefined }), script: scripted().script })
  assert.equal(run.calls.length, 0, JSON.stringify(run.calls))
  assert.equal(run.result.status, 'blocked', JSON.stringify(run.result).slice(0, 400))
  assert.equal(run.result.feedback?.reason, 'plan_task_required', JSON.stringify(run.result).slice(0, 400))
})

// §6.5 implemente com tasks compatíveis: sem planner, uma revisão de vínculo e checks reais; ledger da nova run começa zerado.
test('§6.5 implemente com tasks compatíveis não chama planner, faz uma plan-review de vínculo e roda checks reais', async t => {
  const { fixture } = await approvedPlanAndTasks(t, 'c5')
  const run = await runGraphScripted(t, { fixture, args: stageArgs('c5-impl', ONE_SHOT), script: scripted().script })
  assert.equal(count(run.calls, /^plan$/), 0, JSON.stringify(run.calls))
  assert.equal(count(run.calls, /^plan-review:/), 1, JSON.stringify(run.calls))
  assert.ok(run.calls.includes('work:I1'), JSON.stringify(run.calls))
  assert.ok(run.events.some(event => event.type === 'checks.selection.completed'))
  assert.deepEqual(starts(run.events), ['implement'])
  assert.equal(reuseOf(run.events).rejected.length, 0, JSON.stringify(reuseOf(run.events)))
  const firstCheckpoint = run.events.find(event => event.type === 'control.transition' && event.payload?.checkpoint)
  assert.equal(firstCheckpoint?.payload.checkpoint.ledger.usedByRole.planner, 0, 'ledger da run nova começa com planner zerado')
})

// §6.6 editar arquivo depois do plano: o reuso recusa workspace_changed e o planner roda de novo.
test('§6.6 implemente depois de editar arquivo rejeita o reuso com workspace_changed e chama o planner', async t => {
  const { fixture, cwd } = await approvedPlanAndTasks(t, 'c6')
  await writeFile(path.join(cwd, 'src/a.js'), 'export const a = 2\n')
  const run = await runGraphScripted(t, { fixture, args: stageArgs('c6-impl', ONE_SHOT), script: scripted().script })
  assert.equal(reuseOf(run.events).rejected[0]?.reason, 'workspace_changed', JSON.stringify(reuseOf(run.events)))
  assert.ok(count(run.calls, /^plan$/) >= 1, JSON.stringify(run.calls))
})

// §6.7 implemente com plano em needs_clarification: bloqueia sem nenhuma chamada.
test('§6.7 implemente com plano em needs_clarification bloqueia sem spawn', async t => {
  const first = await runGraphScripted(t, { args: stageArgs('c7-plan', PLAN_STAGE), script: scripted({ plan: () => PLAN(undefined, { questions: Q1 }) }).script })
  assert.equal(first.result.status, 'needs_clarification')
  const run = await runGraphScripted(t, { fixture: first.fixture, args: stageArgs('c7-impl', ONE_SHOT), script: scripted().script })
  assert.equal(run.calls.length, 0, JSON.stringify(run.calls))
  assert.equal(run.result.feedback?.reason, 'needs_clarification', JSON.stringify(run.result).slice(0, 400))
})

// Driver com runner real (complementa 'implemente sem tarefa dá erro' em grapheng.test.mjs, que só vê o runGraph fake):
// implemente sem tarefa e sem plan.json é bloqueado pelo runner com plan_missing_or_incompatible:absent e nenhum agente é chamado.
test('implemente sem tarefa e sem plan.json bloqueia plan_missing_or_incompatible:absent sem spawn', async t => {
  const run = await runDriver(t, ['implemente'])
  assert.equal(run.spawns.length, 0, JSON.stringify(run.spawns))
  assert.equal(run.result.status, 'blocked', JSON.stringify(run.result).slice(0, 400))
  assert.equal(run.result.feedback?.reason, 'plan_missing_or_incompatible:absent', JSON.stringify(run.result).slice(0, 400))
})

// §6.8 one-shot sem artefatos: plan, revisão, research, critic, decomposição, revisão, design, implementação, critic e publicação.
test('§6.8 one-shot sem artefatos segue a ordem plan -> research -> critic -> tasks -> design -> work -> critic e publica plan e tasks', async t => {
  const run = await runGraphScripted(t, { args: stageArgs('c8', ONE_SHOT), script: scripted().script })
  assert.equal(run.result.status, 'done', JSON.stringify(run.result).slice(0, 400))
  const first = label => run.calls.indexOf(label)
  const planA = first('plan')
  const researchA = first('work:R1')
  const criticA = run.calls.findIndex(label => label.startsWith('critic:'))
  const planB = run.calls.indexOf('plan', planA + 1)
  const designA = run.calls.findIndex(label => label.startsWith('design-review'))
  const workI1 = first('work:I1')
  assert.ok(planA >= 0 && planA < researchA && researchA < criticA && criticA < planB && planB < designA && designA < workI1, JSON.stringify(run.calls))
  assert.equal((await readSlot({ repo: run.cwd, kind: 'plan' })).artifact?.status, 'approved')
  assert.equal((await readSlot({ repo: run.cwd, kind: 'tasks' })).artifact?.status, 'approved')
})

// §6.9 e extra 7: origem adulterada ou artefato com hash recalculado nunca é reutilizado em silêncio.
test('§6.9 journal de origem adulterado rejeita o reuso com source_unverified e planeja de novo', async t => {
  const { fixture, cwd } = await approvedPlanAndTasks(t, 'c9')
  const file = journalPath(cwd, 'c9-plan')
  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  const cut = lines.findIndex(line => JSON.parse(line).payload?.stage === 'plan-artifact-approved')
  const event = JSON.parse(lines[cut])
  event.payload.contentHash = 'f'.repeat(64)
  lines[cut] = JSON.stringify(event)
  await writeFile(file, lines.join('\n') + '\n')
  const run = await runGraphScripted(t, { fixture, args: stageArgs('c9-impl', ONE_SHOT), script: scripted().script })
  assert.ok(reuseOf(run.events).rejected.some(item => item.reason === 'source_unverified'), JSON.stringify(reuseOf(run.events)))
  assert.ok(count(run.calls, /^plan$/) >= 1, JSON.stringify(run.calls))
})

test('extra 7: artefato com hash recalculado e conteúdo trocado é rejeitado com source_unverified', async t => {
  const { fixture, cwd } = await approvedPlanAndTasks(t, 'x7')
  const slot = await readSlot({ repo: cwd, kind: 'plan' })
  const { contentHash, ...body } = slot.artifact
  const forged = sealArtifact({ ...body, content: { ...body.content, goal: 'adulterado com hash novo' } })
  assert.notEqual(forged.contentHash, contentHashOf(slot.artifact))
  await writeSlot({ repo: cwd, kind: 'plan', artifact: forged, expectedPrevContentHash: slot.hash })
  const run = await runGraphScripted(t, { fixture, args: stageArgs('x7-impl', ONE_SHOT), script: scripted().script })
  assert.ok(reuseOf(run.events).rejected.some(item => item.reason === 'source_unverified'), JSON.stringify(reuseOf(run.events)))
})

// §6.10 do brief (resume de run to:'plan'|'tasks' bloqueia) foi superado pela rejeição da D4: run com pipeline é retomável.
// Não há teste deste arquivo para ele. A retomada de plan e tasks é coberta pelos casos R10 em test/graph-run-boundary.test.mjs:
//   caso A (aprovação do estágio corrente, próximo estágio decidido): 'R10c caso A devolve a aprovação e o próximo estágio decidido, sem bloqueio';
//   caso B (checkpoint depois da fronteira sem aprovação): 'R10d caso B: checkpoint depois da fronteira sem aprovação devolve B com o checkpoint, sem bloqueio';
//   caso C (fronteira de estágio 2 sem gasto nem checkpoint): 'R10d caso C: fronteira de estágio 2 sem gasto nem checkpoint devolve C com o carry gravado na fronteira'.
// Os casos D e E bloqueiam e ficam em 'R10b caso D' e 'R10b caso E' do mesmo arquivo.

// extra 5: plano novo reprovado deixa as tasks antigas sem vínculo: tasks_plan_mismatch e planejamento de novo.
test('extra 5 plano novo reprovado faz as tasks antigas virarem tasks_plan_mismatch', async t => {
  const { fixture, cwd } = await approvedPlanAndTasks(t, 'x5')
  const variant = n => PLAN([RESEARCH('R1', `v${n}`), RESEARCH('R2')])
  const rejected = await runGraphScripted(t, { fixture, args: stageArgs('x5-plan2', PLAN_STAGE), script: scripted({ plan: variant, critics: [REPLAN('r1'), REPLAN('r2'), REPLAN('r3')] }).script })
  assert.equal(rejected.result.status, 'blocked')
  assert.equal((await readSlot({ repo: cwd, kind: 'plan' })).artifact?.status, 'rejected')
  const run = await runGraphScripted(t, { fixture, args: stageArgs('x5-impl', ONE_SHOT), script: scripted().script })
  assert.ok(reuseOf(run.events).rejected.some(item => item.kind === 'tasks' && item.reason === 'tasks_plan_mismatch'), JSON.stringify(reuseOf(run.events)))
  assert.ok(count(run.calls, /^plan$/) >= 1, JSON.stringify(run.calls))
})

test('extra 5 clarify com respostas deixa tasks antigas como tasks_plan_mismatch', async t => {
  const plan = await runGraphScripted(t, { args: stageArgs('x5b-plan', PLAN_STAGE), script: scripted().script })
  const tasks = await runGraphScripted(t, { fixture: plan.fixture, args: stageArgs('x5b-tasks', TASKS_STAGE), script: scripted().script })
  assert.equal(tasks.result.status, 'tasks_approved')
  const asked = await runGraphScripted(t, { fixture: plan.fixture, args: stageArgs('x5b-plan2', PLAN_STAGE), script: scripted({ plan: () => PLAN(undefined, { questions: Q1 }) }).script })
  assert.equal(asked.result.status, 'needs_clarification')
  const answers = { questionSetId: asked.result.clarification.questionSetId, answers: [{ questionId: 'Q1', answer: 'sqlite' }] }
  const clarified = await runGraphScripted(t, { fixture: plan.fixture, args: stageArgs('x5b-clarify', CLARIFY_STAGE, { clarification: answers }), script: scripted().script })
  assert.equal(clarified.result.status, 'plan_approved', JSON.stringify(clarified.result).slice(0, 400))
  const run = await runGraphScripted(t, { fixture: plan.fixture, args: stageArgs('x5b-impl', ONE_SHOT), script: scripted().script })
  assert.ok(reuseOf(run.events).rejected.some(item => item.kind === 'tasks' && item.reason === 'tasks_plan_mismatch'), JSON.stringify(reuseOf(run.events)))
})
