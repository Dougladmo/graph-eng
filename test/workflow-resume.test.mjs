import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEvidence } from '../bin/run-evidence.mjs'
import { resolveNodeCheckSelection, NODE_CHECK_POLICY_ID, NODE_CHECK_MAPPING_HASH } from '../bin/node-check-policy.mjs'
import { runWorkflow, defaultScript, runGraphScripted } from './helpers/run-workflow.mjs'
import { compileWorkflow } from '../bin/workflow-source.mjs'

const approve = kind => ({ kind, reason: 'teste controlado', severity: kind === 'APPROVE' || kind === 'DONE' ? 'none' : 'high', affectedNodes: kind === 'REPLAN' ? ['A'] : [], evidenceIds: [] })
const fixturePlan = () => ({
  goal: 'preservar nós semanticamente válidos', complexity: 'moderate', mode: 'research', doneWhen: ['resultado íntegro'], effort: { level: 'max', why: 'controle' },
  nodes: [
    { id: 'A', kind: 'research', title: 'A', brief: 'entrada e saída sobrepostas', deps: [], risk: 'low', acceptance: ['A válido'], files: ['src/a.txt'], inputs: ['src/a.txt'], outputs: ['src/a.txt'] },
    { id: 'C', kind: 'research', title: 'C', brief: 'consome A', deps: ['A'], risk: 'low', acceptance: ['C válido'], files: [], inputs: ['src/a.txt'], outputs: ['src/c.txt'] },
    { id: 'B', kind: 'research', title: 'B', brief: 'independente', deps: [], risk: 'low', acceptance: ['B válido'], files: [], inputs: ['src/b.txt'], outputs: ['src/b.txt'] },
    { id: 'D', kind: 'research', title: 'D', brief: 'integra A e B', deps: ['A', 'B', 'C'], risk: 'low', acceptance: ['D válido'], files: [], inputs: ['src/a.txt', 'src/b.txt'], outputs: ['src/d.txt'] },
  ],
})

async function withDiskRuntime(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graph-eng-3a-'))
  const state = path.join(root, '.graph-runs', 'controlled')
  try {
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src/a.txt'), 'A antigo\n')
    await writeFile(path.join(root, 'src/b.txt'), 'B íntegro\n')
    await writeFile(path.join(root, 'src/c.txt'), 'C antigo\n')
    await writeFile(path.join(root, 'src/d.txt'), 'D antigo\n')
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid'])
    execFileSync('git', ['-C', root, 'add', 'src'])
    execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture inicial'])
    const evidence = createEvidence({ cwd: root, runDir: state })
    const outputDir = path.join(state, 'outputs')
    let outputSeq = 0
    const persistOutput = async ({ nodeId, kind, value }) => {
      await mkdir(outputDir, { recursive: true })
      const bytes = Buffer.from(JSON.stringify(value))
      const identity = createHash('sha256').update(`graph-eng:structured-output:v2\0${JSON.stringify({ schemaVersion: 2, kind, value })}`).digest('hex')
      const evidencePath = `outputs/${nodeId}-${kind}-${++outputSeq}.json`
      await writeFile(path.join(state, evidencePath), JSON.stringify({ schemaVersion: 2, runId: 'controlled-run', nodeId, kind, identity, value }), { flag: 'wx' })
      const persisted = await readFile(path.join(state, evidencePath))
      return { schemaVersion: 2, runId: 'controlled-run', nodeId, kind, identity, evidencePath, evidenceHash: createHash('sha256').update(persisted).digest('hex') }
    }
    const verifyOutput = async ref => {
      try {
        const bytes = await readFile(path.join(state, ref.evidencePath))
        const envelope = JSON.parse(bytes.toString())
        const value = envelope.value
        const identity = createHash('sha256').update(`graph-eng:structured-output:v2\0${JSON.stringify({ schemaVersion: 2, kind: envelope.kind, value })}`).digest('hex')
        return { valid: envelope.schemaVersion === 2 && envelope.runId === ref.runId && envelope.nodeId === ref.nodeId && envelope.kind === ref.kind && identity === ref.identity && createHash('sha256').update(bytes).digest('hex') === ref.evidenceHash, identity, value }
      } catch { return { valid: false } }
    }
    let seq = 0
    const checkpoints = []
    const runtime = {
      host: 'test', models: {}, capabilities: { checks: true, fingerprint: true, readOnlyEnforced: true },
      snapshot: evidence.snapshot, fingerprint: evidence.fingerprint, runChecks: evidence.runChecks, verifyArtifact: evidence.verifyArtifact, persistOutput, verifyOutput,
      emit: async event => ({ ...event, seq: ++seq }), saveState: async value => { checkpoints.push(structuredClone(value)); return value },
    }
    return await run({ root, runtime, checkpoints })
  } finally { await rm(root, { recursive: true, force: true }) }
}

function scriptFor({ changedA = false, changedB = false, deleteB = false, changeHead = false } = {}) {
  let criticRound = 0
  const calls = []
  const script = async (label, _prompt, opts) => {
    calls.push(label)
    const [kind, id] = label.split(':')
    if (kind === 'plan-review') return { feedback: approve('APPROVE') }
    if (kind === 'work') {
      // O agente falso controla mutações determinísticas; a evidência vem do fingerprint/hash real em disco.
      if (id === 'A') await writeFile(path.join(globalThis.__fixtureRoot, 'src/a.txt'), 'A novo\n')
      if (id === 'D' && changedA) await writeFile(path.join(globalThis.__fixtureRoot, 'src/a.txt'), 'A alterado depois do ready\n')
      if (id === 'D' && changedB) await writeFile(path.join(globalThis.__fixtureRoot, 'src/b.txt'), 'B adulterado\n')
      if (id === 'D' && deleteB) await rm(path.join(globalThis.__fixtureRoot, 'src/b.txt'), { force: true })
      if (id === 'D' && changeHead) {
        await writeFile(path.join(globalThis.__fixtureRoot, 'src/unrelated.txt'), 'HEAD mudou\n')
        execFileSync('git', ['-C', globalThis.__fixtureRoot, 'add', 'src/unrelated.txt'])
        execFileSync('git', ['-C', globalThis.__fixtureRoot, 'commit', '-qm', 'HEAD mudou'])
      }
      return { status: 'done', summary: `${id} estruturado`, confidence: 'high' }
    }
    if (kind === 'verify' || kind === 'escalate') return { pass: true, confidence: 'high', blocking: [] }
    if (kind === 'critic') {
      criticRound++
      if (criticRound === 1) {
        return { feedback: approve('REPLAN'), done: false, gaps: [] }
      }
      return { feedback: approve('DONE'), done: true, gaps: [] }
    }
    if (kind === 'plan') {
      const replacement = fixturePlan()
      replacement.nodes.find(node => node.id === 'A').brief = 'contrato A corrigido'
      return replacement
    }
    if (kind === 'synth') return { summary: 'controle concluído', humanGate: [] }
    if (kind === 'design-review') return { feedback: approve('APPROVE'), pass: true, confidence: 'high', blocking: [], checked: { assumptions: true, acceptance: true, stories: false, bestPractices: true } }
    return null
  }
  return { script, calls }
}

async function runReplan({ changedA = false, changedB = false, deleteB = false, changeHead = false, unknownB = false } = {}) {
  return withDiskRuntime(async ({ root, runtime, checkpoints }) => {
    globalThis.__fixtureRoot = root
    const { script, calls } = scriptFor({ changedA, changedB, deleteB, changeHead })
    const originalPlan = fixturePlan()
    if (unknownB) originalPlan.nodes.find(node => node.id === 'B').outputs = undefined
    const result = await runWorkflow({ task: 'controle A-C/B', mode: 'research', effort: 'max', runDir: '.graph-runs/controlled', plan: originalPlan }, script, { runtime })
    delete globalThis.__fixtureRoot
    return { result: result.result, calls, checkpoints, logs: result.logs }
  })
}

test('replan troca contrato de A, refaz A e C e preserva B íntegro; overlap input=output usa identidade pronta pós-validação', async () => {
  const { result, calls, checkpoints } = await runReplan({ changeHead: true })
  assert.ok(calls.includes('work:A') && calls.includes('work:C'))
  assert.equal(calls.filter(label => label === 'work:B').length, 1)
  assert.equal(calls.filter(label => label === 'verify:B').length, 1)
  assert.equal(result.planVersion, 2)
  const savedB = checkpoints.flatMap(state => state.nodeRecords || []).find(record => record.id === 'B' && record.nodeRecord)
  assert.ok(savedB.nodeRecord.preflightFingerprint.identity)
  assert.ok(savedB.nodeRecord.readyFingerprint.identity)
  assert.deepEqual(savedB.nodeRecord.inputSpecs, ['src/b.txt'])
  assert.deepEqual(savedB.nodeRecord.outputSpecs, ['src/b.txt'])
})

test('replan detecta adulteração de saída B e o executa e verifica novamente', async () => {
  const { calls } = await runReplan({ changedB: true })
  assert.equal(calls.filter(label => label === 'work:B').length, 2)
  assert.equal(calls.filter(label => label === 'verify:B').length, 2)
})

// B não tem grant (files: []), então src/b.txt é input externo. Removido, ele não tem fingerprint:
// o replan invalida o record de B e o bloqueia antes do work, sem gastar uma segunda execução.
test('replan com input externo de B removido bloqueia B com external_inputs_unfingerprintable, sem refazer o work', async () => {
  const { result, calls } = await runReplan({ deleteB: true })
  assert.equal(calls.filter(label => label === 'work:B').length, 1)
  const b = result.nodes?.find(node => node.id === 'B')
  assert.equal(b?.status, 'blocked')
  assert.equal(b?.note, 'external_inputs_unfingerprintable')
})

test('mudança observável na saída A depois de ready invalida A e C, mas mantém B', async () => {
  const { calls } = await runReplan({ changedA: true })
  assert.equal(calls.filter(label => label === 'work:A').length, 2)
  assert.equal(calls.filter(label => label === 'work:C').length, 2)
  assert.equal(calls.filter(label => label === 'work:B').length, 1)
})

test('manifesto desconhecido não preserva B durante replan', async () => {
  const { calls } = await runReplan({ unknownB: true })
  assert.equal(calls.filter(label => label === 'work:B').length, 2)
})

test('saída B que ainda não existia vira READY após criação verificada e é preservada no replan', async () => {
  await withDiskRuntime(async ({ root, runtime, checkpoints }) => {
    globalThis.__fixtureRoot = root
    await rm(path.join(root, 'src/b.txt'))
    const plan = fixturePlan()
    plan.nodes = [plan.nodes[0], plan.nodes[2]]
    plan.nodes[1].inputs = []
    const calls = []
    let criticRound = 0
    const script = async (label, prompt, opts) => {
      calls.push(label)
      if (label === 'plan-review:r1') return { feedback: approve('APPROVE') }
      if (label === 'work:A') { await writeFile(path.join(root, 'src/a.txt'), 'A novo\n'); return { status: 'done', summary: 'A', confidence: 'high' } }
      if (label === 'work:B') { await writeFile(path.join(root, 'src/b.txt'), 'B criado pelo worker\n'); return { status: 'done', summary: 'B', confidence: 'high' } }
      if (label.startsWith('verify:')) return { pass: true, confidence: 'high', blocking: [] }
      if (label === 'critic:r1') { criticRound++; return { feedback: approve('REPLAN'), done: false, gaps: [] } }
      if (label === 'plan') { const replacement = structuredClone(plan); replacement.nodes[0].brief = 'contrato A corrigido'; return replacement }
      if (label === 'critic:r2') return { feedback: approve('DONE'), done: true, gaps: [] }
      return defaultScript()(label, prompt, opts)
    }
    const execution = await runWorkflow({ task: 'output criado durante o trabalho', mode: 'research', effort: 'max', runDir: '.graph-runs/controlled', plan }, script, { runtime })
    delete globalThis.__fixtureRoot
    assert.equal(execution.result.nodes.find(node => node.id === 'B').status, 'done')
    assert.equal(calls.filter(label => label === 'work:B').length, 1, JSON.stringify(calls))
    assert.ok(checkpoints.flatMap(state => state.nodeRecords || []).some(record => record.id === 'B' && record.nodeRecord?.readyFingerprint?.outputs?.some(output => output.path === 'src/b.txt')))
  })
})

test('booleans legados done/verified não tornam nó pronto', async () => {
  await withDiskRuntime(async ({ runtime }) => {
    const plan = fixturePlan()
    plan.nodes = [plan.nodes[0]]
    const { calls } = await runWorkflow({ task: 'legado conservador', mode: 'research', effort: 'max', runDir: '.graph-runs/controlled', plan,
      resume: { id: 'rs-20261018-120000', done: { A: { verified: true, artifact: '.graph-runs/controlled/A.md' } }, rerun: [] } }, defaultScript(), { runtime })
    assert.ok(calls.includes('work:A'))
    assert.ok(calls.includes('verify:A'))
  })
})

test('resume v2 preserva B validado e refaz os gates finais', async () => {
  await withDiskRuntime(async ({ root, runtime, checkpoints }) => {
    const plan = fixturePlan()
    const calls = []
    let finalCheckRuns = 0
    const originalRunChecks = runtime.runChecks
    const finalCheck = { id: 'final', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', timeoutMs: 30000, heavy: false }
    runtime.runChecks = async ({ snapshot, checks }) => { finalCheckRuns++; return originalRunChecks({ runId: 'controlled-run', snapshot, checks }) }
    const script = async label => {
      calls.push(label)
      const kind = label.split(':')[0]
      if (kind === 'plan-review') return { feedback: approve('APPROVE') }
      if (kind === 'work') return { status: 'done', summary: `${label} validado`, confidence: 'high' }
      if (kind === 'verify' || kind === 'escalate') return { pass: true, confidence: 'high', blocking: [] }
      if (kind === 'critic') return { feedback: approve('DONE'), done: true, assessment: 'critérios atendidos', gaps: [] }
      if (kind === 'synth') return { summary: 'entrega íntegra', humanGate: [] }
      return defaultScript()(label)
    }
    const args = { task: 'retomar preservando registros validados', mode: 'research', effort: 'max', runDir: '.graph-runs/controlled', checks: [finalCheck], plan }
    const first = await runWorkflow(args, script, { runtime })
    const firstCalls = [...calls]
    let checkpoint = checkpoints.at(-1)
    const diagnostic = (result, currentCalls, cp = checkpoints.at(-1)) => JSON.stringify({
      result: { status: result?.result?.status, feedback: result?.result?.feedback, error: result?.result?.error },
      logs: result?.logs,
      calls: [...currentCalls],
      stages: checkpoints.map(item => item.control?.stage),
      ledger: cp?.ledger,
    })
    assert.equal(first.result.status, 'done', diagnostic(first, firstCalls, checkpoint))
    assert.equal(checkpoint?.control?.stage, 'done-approved', diagnostic(first, firstCalls, checkpoint))
    assert.equal(checkpoint?.ledger?.usedByRole?.synth, 1, diagnostic(first, firstCalls, checkpoint))
    assert.ok(checkpoint?.nodeRecords?.some(record => record.id === 'B' && record.nodeRecord))
    assert.ok(firstCalls.includes('work:B'))
    const fixedLimits = first.result.budget.limitsByRole
    for (let attempt = 1; attempt <= 2; attempt++) {
      calls.length = 0
      const checkRunsBeforeResume = finalCheckRuns
      Object.assign(runtime, {
        resumeCheckpoint: structuredClone(checkpoint),
        resumeAppliedSeq: checkpoint.lastSeq,
        resumeRequest: { requestedRerunIds: [] },
        resumeInvalidatedNodeIds: [],
        resumeId: `rs-20261018-12000${attempt}`,
      })
      const resumed = await runWorkflow(args, script, { runtime })
      checkpoint = checkpoints.at(-1)
      const expectedSynthCalls = attempt + 1
      assert.equal(resumed.result.status, 'done', diagnostic(resumed, calls, checkpoint))
      assert.equal(checkpoint?.control?.stage, 'done-approved', diagnostic(resumed, calls, checkpoint))
      assert.equal(checkpoint?.ledger?.usedByRole?.synth, expectedSynthCalls, diagnostic(resumed, calls, checkpoint))
      assert.equal(calls.filter(label => label === 'work:B').length, 0, diagnostic(resumed, calls, checkpoint))
      assert.ok(calls.some(label => label.startsWith('critic:')), diagnostic(resumed, calls, checkpoint))
      assert.ok(calls.includes('synth'), diagnostic(resumed, calls, checkpoint))
      assert.ok(finalCheckRuns > checkRunsBeforeResume)
      assert.deepEqual(resumed.result.budget.limitsByRole, fixedLimits)
    }

    assert.equal(checkpoint?.control?.stage, 'done-approved', JSON.stringify({ checkpointStage: checkpoint?.control?.stage, ledger: checkpoint?.ledger }))
    assert.equal(checkpoint?.ledger?.usedByRole?.synth, 3, JSON.stringify({ checkpointStage: checkpoint?.control?.stage, ledger: checkpoint?.ledger }))
    calls.length = 0
    Object.assign(runtime, {
      resumeCheckpoint: structuredClone(checkpoint),
      resumeAppliedSeq: checkpoint.lastSeq,
      resumeRequest: { requestedRerunIds: [] },
      resumeInvalidatedNodeIds: [],
      resumeId: 'rs-20261018-120003',
    })
    const exhausted = await runWorkflow(args, script, { runtime })
    assert.equal(exhausted.result.status, 'blocked', diagnostic(exhausted, calls))
    assert.equal(exhausted.result.feedback.reason, 'resume_final_gate_budget_exhausted', diagnostic(exhausted, calls))
    assert.deepEqual(calls, [], diagnostic(exhausted, calls))
    assert.deepEqual(exhausted.result.budget.limitsByRole, fixedLimits)
  })
})

// FIX_LOCAL 4: artifact foi removido do contrato de trabalho. Um journal antigo que traz um caminho escolhido pelo
// modelo não pode levar esse caminho ao relatório da retomada.
test('resume de journal com artifact "/etc/passwd" não leva artifact ao relatório', async () => {
  await withDiskRuntime(async ({ root, runtime, checkpoints }) => {
    const plan = fixturePlan()
    const calls = []
    const script = async label => {
      calls.push(label)
      const kind = label.split(':')[0]
      if (kind === 'plan-review') return { feedback: approve('APPROVE') }
      if (kind === 'work') return { status: 'done', summary: `${label} validado`, confidence: 'high' }
      if (kind === 'verify' || kind === 'escalate') return { pass: true, confidence: 'high', blocking: [] }
      if (kind === 'critic') return { feedback: approve('DONE'), done: true, assessment: 'critérios atendidos', gaps: [] }
      if (kind === 'synth') return { summary: 'entrega íntegra', humanGate: [] }
      return defaultScript()(label)
    }
    const originalRunChecks = runtime.runChecks
    runtime.runChecks = async ({ snapshot, checks }) => originalRunChecks({ runId: 'controlled-run', snapshot, checks })
    const finalCheck = { id: 'final', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', timeoutMs: 30000, heavy: false }
    const args = { task: 'retomar sem artifact do journal', mode: 'research', effort: 'max', runDir: '.graph-runs/controlled', checks: [finalCheck], plan }
    const first = await runWorkflow(args, script, { runtime })
    assert.equal(first.result.status, 'done', JSON.stringify(first.result.feedback))
    const tampered = structuredClone(checkpoints.at(-1))
    const record = tampered.nodeRecords.find(item => item.id === 'B')
    assert.ok(record, 'B precisa estar no checkpoint')
    record.work = { ...(record.work || {}), artifact: '/etc/passwd' }
    calls.length = 0
    Object.assign(runtime, {
      resumeCheckpoint: tampered,
      resumeAppliedSeq: tampered.lastSeq,
      resumeRequest: { requestedRerunIds: [] },
      resumeInvalidatedNodeIds: [],
      resumeId: 'rs-20261018-120010',
    })
    const resumed = await runWorkflow(args, script, { runtime })
    assert.equal(resumed.result.status, 'done', JSON.stringify({ feedback: resumed.result.feedback, calls }))
    assert.equal(calls.includes('work:B'), false, 'B precisa vir do registro reutilizado para o teste medir o relatório')
    assert.equal(JSON.stringify(resumed.result).includes('/etc/passwd'), false, 'artifact do journal vazou para o relatório')
    for (const node of resumed.result.nodes) assert.equal(node.artifact, undefined, `nó ${node.id} levou artifact ao relatório`)
  })
})

test('resumes repetidos não mintam saldo executor/verifier esgotado nem aumentam os tetos', async () => {
  await withDiskRuntime(async ({ runtime, checkpoints }) => {
    const plan = fixturePlan()
    const calls = []
    const script = async label => { calls.push(label); return defaultScript()(label) }
    const first = await runWorkflow({ task: 'cap imutável', mode: 'research', effort: 'max', runDir: '.graph-runs/controlled', plan }, script, { runtime })
    const fixedLimits = structuredClone(first.result.budget.limitsByRole)
    let checkpoint = structuredClone(checkpoints.at(-1))
    checkpoint.ledger.usedByRole.executor = checkpoint.ledger.limitsByRole.executor
    checkpoint.ledger.usedByRole.verifier = checkpoint.ledger.limitsByRole.verifier
    checkpoint.ledger.reservedByRole.executor = 0
    checkpoint.ledger.reservedByRole.verifier = 0
    for (let attempt = 0; attempt < 2; attempt++) {
      calls.length = 0
      Object.assign(runtime, {
        resumeCheckpoint: structuredClone(checkpoint), resumeAppliedSeq: checkpoint.lastSeq,
        resumeRequest: { requestedRerunIds: [] }, resumeInvalidatedNodeIds: ['B'],
        resumeId: `rs-20261018-13000${attempt}`,
      })
      const resumed = await runWorkflow({ task: 'cap imutável', mode: 'research', effort: 'max', runDir: '.graph-runs/controlled', plan }, script, { runtime })
      assert.equal(resumed.result.status, 'blocked')
      assert.equal(resumed.result.feedback.reason, 'resume_node_budget_exhausted')
      assert.deepEqual(calls, [])
      assert.deepEqual(resumed.result.budget.limitsByRole, fixedLimits)
      assert.equal(resumed.result.budget.usedByRole.executor, fixedLimits.executor)
      assert.equal(resumed.result.budget.usedByRole.verifier, fixedLimits.verifier)
    }
  })
})

test('entrada fora do writeGrant alterada durante o trabalho bloqueia e não cria registro ready', async () => {
  await withDiskRuntime(async ({ root, runtime }) => {
    globalThis.__fixtureRoot = root
    const plan = fixturePlan()
    plan.nodes = [{ id: 'A', kind: 'research', title: 'A', brief: 'depende de entrada externa', deps: [], risk: 'low', acceptance: ['não muda entrada'], files: [], inputs: ['src/b.txt'], outputs: ['src/c.txt'] }]
    const script = async label => {
      if (label.startsWith('work:')) {
        await writeFile(path.join(root, 'src/b.txt'), 'entrada alterada durante work\n')
        return { status: 'done', summary: 'tentou trabalhar', confidence: 'high' }
      }
      return defaultScript()(label)
    }
    const { result, calls } = await runWorkflow({ task: 'entrada externa imutável', mode: 'research', effort: 'max', runDir: '.graph-runs/controlled', plan }, script, { runtime })
    delete globalThis.__fixtureRoot
    assert.ok(calls.includes('work:A'))
    assert.equal(result.nodes.find(node => node.id === 'A').status, 'blocked')
    assert.match(result.nodes.find(node => node.id === 'A').note, /external_input_changed_during_work/)
  })
})

test('entrada externa alterada durante verify bloqueia e não persiste ready', async () => {
  await withDiskRuntime(async ({ root, runtime, checkpoints }) => {
    const plan = fixturePlan()
    plan.nodes = [{ id: 'A', kind: 'research', title: 'A', brief: 'entrada externa', deps: [], risk: 'low', acceptance: ['estável'], files: [], inputs: ['src/b.txt'], outputs: ['src/c.txt'] }]
    const script = async label => {
      if (label === 'work:A') return { status: 'done', summary: 'A', confidence: 'high' }
      if (label === 'verify:A') { await writeFile(path.join(root, 'src/b.txt'), 'mutado durante verify\n'); return { pass: true, confidence: 'high', blocking: [] } }
      return defaultScript()(label)
    }
    const { result } = await runWorkflow({ task: 'estabilidade na verificação', mode: 'research', effort: 'max', runDir: '.graph-runs/controlled', plan }, script, { runtime })
    const node = result.nodes.find(entry => entry.id === 'A')
    assert.equal(node.status, 'blocked')
    assert.match(node.note, /external_input_changed:A/)
    assert.equal(checkpoints.flatMap(state => state.nodeRecords || []).some(entry => entry.id === 'A' && entry.nodeRecord), false)
  })
})

test('FIX_LOCAL no design persiste work novo antes da aprovação', async t => {
  const plan = {
    goal: 'corrigir saída de design antes da implementação', complexity: 'moderate', mode: 'architecture',
    doneWhen: ['design íntegro'], effort: { level: 'medium', why: 'reparo de design' },
    nodes: [
      { id: 'R', kind: 'research', title: 'R', brief: 'pesquisar', deps: [], risk: 'low', acceptance: ['fonte'], files: [], inputs: [], outputs: [] },
      { id: 'D', kind: 'design', title: 'D', brief: 'propor design', deps: ['R'], risk: 'low', acceptance: ['decisão corrigida'], files: [], inputs: [], outputs: [] },
    ],
  }
  // Só guarda a referência do runtime real para ler a saída de D depois; não altera nada.
  let runtime = null
  const workflowCompiler = async () => {
    const workflow = await compileWorkflow()
    return (args, agent, log, phase, parallel, budget, suppliedRuntime) => { runtime = suppliedRuntime; return workflow(args, agent, log, phase, parallel, budget, suppliedRuntime) }
  }
  const calls = []
  let approvedPrompt = ''
  const { result, events } = await runGraphScripted(t, { args: { plan, mode: 'architecture', effort: 'medium' }, workflowCompiler, script: async (label, prompt) => {
    calls.push(label)
    if (label === 'work:R') return { status: 'done', summary: 'pesquisa', confidence: 'high' }
    if (label === 'work:D') return { status: 'done', summary: 'design incompleto', confidence: 'high' }
    if (label === 'design-repair:D') return { status: 'done', summary: 'design corrigido', evidence: ['decisão nova'], confidence: 'high' }
    if (label === 'design-review:r1') return { feedback: { ...approve('FIX_LOCAL'), affectedNodes: ['D'] }, pass: false, confidence: 'high', blocking: [{ node: 'D', issue: 'decisão incompleta', where: 'D', fix: 'registrar nova decisão' }], checked: {} }
    if (label === 'design-review:r2') { approvedPrompt = prompt; return { feedback: approve('APPROVE'), pass: true, confidence: 'high', blocking: [], checked: { assumptions: true, acceptance: true, stories: false, bestPractices: true } } }
    return defaultScript()(label, prompt)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, calls }))
  assert.equal(calls.filter(label => label === 'design-repair:D').length, 1, JSON.stringify(calls))
  assert.match(approvedPrompt, /design corrigido/)
  const checkpoint = events.filter(event => event.type === 'control.transition').at(-1).payload.checkpoint
  const record = checkpoint.nodeRecords.find(entry => entry.id === 'D')?.nodeRecord
  assert.equal(record.result.work.summary, 'design corrigido')
  const output = await runtime.verifyOutput(record.supervisorOutput)
  assert.equal(output.valid, true)
  assert.equal(output.value.summary, 'design corrigido')
})

// 374 migrado (ratificado no gate final do lote 3b): mesmo cenário (A, C, B com área de polish compartilhada,
// replan de A, polish local de A), agora no runner real com evidência real. verify:B = 2 é o voto do selo único
// da área {A,B}: B tem src/a.js no grant e a polish de A o editou. Contagens literais, sem >=.
const IMPLEMENT_RECEIPTS_PLAN = {
  goal: 'implementar e preservar semântica', mode: 'implement', complexity: 'moderate', doneWhen: ['evidências íntegras'], effort: { level: 'max', why: 'teste controlado' }, nodes: [
    { id: 'R', title: 'R', kind: 'research', brief: 'R', deps: [], files: [], inputs: [], outputs: [], risk: 'low', acceptance: ['R'] },
    { id: 'D', title: 'D', kind: 'design', brief: 'D', deps: ['R'], files: [], inputs: [], outputs: [], risk: 'low', acceptance: ['D'] },
    { id: 'A', title: 'A', kind: 'implement', brief: 'A', deps: ['D'], files: ['src/a.js'], inputs: ['src/a.js'], outputs: ['src/a.js'], risk: 'low', acceptance: ['ok'] },
    { id: 'C', title: 'C', kind: 'implement', brief: 'C', deps: ['A'], files: ['src/c.js'], inputs: ['src/a.js'], outputs: ['src/c.js'], risk: 'low', acceptance: ['ok'] },
    { id: 'B', title: 'B', kind: 'implement', brief: 'B', deps: ['D'], files: ['src/a.js', 'src/b.js'], inputs: [], outputs: ['src/b.js'], risk: 'low', acceptance: ['ok'] },
  ],
}
test('IMPLEMENT prova receipts reais, saída B nova e reuso de B após replan e polish local de A', async t => {
  let replanUsed = false
  const { result, calls, events } = await runGraphScripted(t, { args: { plan: IMPLEMENT_RECEIPTS_PLAN }, fixtureOptions: { withB: true }, script: async (label, prompt, opts, ctx) => {
    if (label === 'work:A') await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 2\n')
    if (label === 'work:C') await writeFile(path.join(ctx.cwd, 'src/c.js'), 'export const c = 2\n')
    if (label === 'work:B') await writeFile(path.join(ctx.cwd, 'src/b.js'), 'export const b = 2\n')
    if (label === 'polish:2' || (label.startsWith('polish:') && prompt.includes('Area (only these files): src/a.js'))) await writeFile(path.join(ctx.cwd, 'src/a.js'), 'export const a = 3\n')
    if (label === 'critic:r1' && !replanUsed) { replanUsed = true; return { feedback: { kind: 'REPLAN', reason: 'replanejar A', severity: 'high', affectedNodes: ['A'], evidenceIds: [] }, done: false, gaps: [] } }
    if (label === 'plan') { const replacement = structuredClone(IMPLEMENT_RECEIPTS_PLAN); replacement.nodes.find(item => item.id === 'A').brief = 'A contrato atualizado'; return replacement }
    return defaultScript()(label, prompt, opts, ctx)
  } })
  assert.equal(result.status, 'done', JSON.stringify({ feedback: result.feedback, critic: result.critic?.feedback, calls }).slice(0, 1200))
  assert.equal(calls.filter(label => label === 'work:B').length, 1, JSON.stringify(calls))
  assert.equal(calls.filter(label => label === 'verify:B').length, 2, JSON.stringify(calls))
  assert.equal(calls.filter(label => label === 'work:A').length, 2, JSON.stringify(calls))
  assert.equal(calls.filter(label => label === 'work:C').length, 2, JSON.stringify(calls))
  assert.equal(calls.filter(label => label === 'verify:A').length, 4, JSON.stringify(calls))
  assert.equal(calls.filter(label => label === 'verify:C').length, 4, JSON.stringify(calls))
  const receipts = events.filter(event => event.type === 'check.receipt').map(event => event.payload)
  assert.ok(receipts.length >= 10, `receipts reais emitidos: ${receipts.length}`)
  assert.ok(receipts.every(receipt => receipt.valid && receipt.evidencePath && receipt.evidenceHash))
})
