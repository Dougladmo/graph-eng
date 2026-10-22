import assert from 'node:assert/strict'
import test from 'node:test'
import { runWorkflow, defaultScript, criticDoneFromPrompt } from './helpers/run-workflow.mjs'
import { questionSetIdOf } from '../bin/phase-artifacts.mjs'

// Estágio de pesquisa (fluxo adaptativo, tier full): nós research em raia própria e mais larga (só leem) e um notetaker
// (Haiku) que junta os achados para o decomposer. O notetaker nunca bloqueia o plano.
function runtime(prepared) {
  let seq = 0
  return {
    preparePhaseArtifact: async input => { prepared.push(input); return { contentHash: `hash-${prepared.length}`, status: input.status, questionSetId: input.content?.openQuestions?.length ? questionSetIdOf(input.content.openQuestions) : null } },
    host: 'test',
    models: { planner: 'test-strong', planReviewer: 'test-strong', designReviewer: 'test-strong', executor: 'test-cheap', verifier: 'test-cheap', critic: 'test-strong', synth: 'test-cheap' },
    capabilities: { checks: true, fingerprint: true, readOnlyEnforced: true },
    snapshot: async () => ({ schemaVersion: 2, identity: 'id', evidencePath: 'test/snapshot.json', evidenceHash: 'h', manifestSpecs: {} }),
    fingerprint: async () => ({ schemaVersion: 2, identity: 'node-id' }),
    runChecks: async () => [],
    verifyArtifact: async () => true,
    emit: async event => ({ ...event, seq: ++seq }),
    saveState: async value => value,
  }
}
const research = id => ({ id, kind: 'research', title: id, brief: `pesquisar ${id}`, deps: [], risk: 'low', acceptance: ['fonte'], files: [] })
const planWith = ids => ({ goal: 'entender', complexity: 'moderate', mode: 'research', doneWhen: ['ok'], effort: { level: 'medium', why: 'teste' }, nodes: ids.map(research) })
const critic = (label, prompt) => ({ feedback: { kind: 'DONE', reason: 'ok', severity: 'none', affectedNodes: [], evidenceIds: [] }, done: true, assessment: 'ok', gaps: [], ...criticDoneFromPrompt(prompt) })

async function planStage(ids, { notes } = {}) {
  const prepared = []
  const seen = {}
  let live = 0
  let maxLive = 0
  const base = defaultScript({ plan: planWith(ids), critic })
  const script = async (label, prompt, opts) => {
    if (label === 'notes') { seen.notes = { prompt, opts }; return notes === undefined ? { summary: 'resumo único', findings: ['src/a.js:1 exporta soma'], conflicts: ['R1 e R2 divergem sobre o formato'] } : notes }
    if (label.startsWith('work:')) {
      live++; maxLive = Math.max(maxLive, live)
      await new Promise(resolve => setTimeout(resolve, 5))
      live--
      return { status: 'done', summary: `${label} ok`, confidence: 'high', checks: [], evidence: [`${label}: achado`] }
    }
    return base(label, prompt, opts)
  }
  const { result, calls } = await runWorkflow({ task: 'entender', mode: 'research', effort: 'medium', stage: 'plan', planReviewDeferred: true, tier: 'full' }, script, { runtime: runtime(prepared) })
  return { result, calls, prepared, seen, maxLive }
}

test('notetaker junta a pesquisa de dois ou mais nós, com o papel notetaker, e vai primeiro no plano publicado', async () => {
  const { result, prepared, seen } = await planStage(['R1', 'R2'])
  assert.equal(result.status, 'plan_approved', JSON.stringify(result.feedback))
  assert.equal(seen.notes.opts.role, 'notetaker')
  assert.equal(seen.notes.opts.readOnly, true)
  assert.match(seen.notes.prompt, /untrusted data/)
  assert.match(seen.notes.prompt, /work:R1: achado/)
  const notes = prepared[0].content.research[0]
  assert.deepEqual(notes, { nodeId: 'notetaker', summary: 'resumo único', findings: ['src/a.js:1 exporta soma', 'CONFLITO: R1 e R2 divergem sobre o formato'] })
  assert.deepEqual(prepared[0].content.research.slice(1).map(item => item.nodeId), ['R1', 'R2'])
})

test('com um só nó de pesquisa não há notetaker; saída inválida do notetaker não bloqueia o plano', async () => {
  const single = await planStage(['R1'])
  assert.equal(single.calls.includes('notes'), false)
  assert.deepEqual(single.prepared[0].content.research.map(item => item.nodeId), ['R1'])
  const broken = await planStage(['R1', 'R2'], { notes: null })
  assert.equal(broken.result.status, 'plan_approved')
  assert.deepEqual(broken.prepared[0].content.research.map(item => item.nodeId), ['R1', 'R2'])
})

test('nós de pesquisa rodam numa raia mais larga que a do effort (medium: 4 em vez de 2) e nunca passam dela', async () => {
  const { result, maxLive } = await planStage(['R1', 'R2', 'R3', 'R4', 'R5', 'R6'])
  assert.equal(result.status, 'plan_approved', JSON.stringify(result.feedback))
  assert.equal(maxLive, 4)
})
