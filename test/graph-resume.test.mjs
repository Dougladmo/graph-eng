// CLI de retomada (spec docs/specs/2026-09-28-acoes-no-painel.md C8, D2 §5.3, §9.2, §9.3): casos com
// fixture em dir temporário. Nada aqui toca ~/.claude.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildResumeArgs, RESUME_ID_RE } from '../bin/graph-resume.mjs'
import { writeHeartbeat } from '../bin/requests.mjs'
import { runWorkflow, defaultScript } from './helpers/run-workflow.mjs'

const RUN_ID = '20260928-0000-teste-retomada'
const SESS_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const SESS_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const SLUG = '-exemplo-resume'

const PLAN = {
  goal: 'g',
  complexity: 'moderate',
  mode: 'implement',
  doneWhen: ['ok'],
  effort: { level: 'high', why: 'x' },
  nodes: [
    { id: 'R1', kind: 'research', title: 'r1', brief: 'b', deps: [], risk: 'low', acceptance: ['a'] },
    { id: 'D1', kind: 'design', title: 'd1', brief: 'b', deps: ['R1'], risk: 'low', acceptance: ['a'] },
    { id: 'I1', kind: 'implement', title: 'i1', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['src/a.js'] },
    { id: 'I2', kind: 'implement', title: 'i2', brief: 'b', deps: ['D1'], risk: 'low', acceptance: ['a'], files: ['src/b.js'] },
    { id: 'I3', kind: 'implement', title: 'i3', brief: 'b', deps: ['I1'], risk: 'low', acceptance: ['a'], files: ['src/a.js'] },
  ],
}

function iso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString()
}

// Uma execução (wf) sob <projectsDir>/<slug>/<session>/subagents/workflows/<wf>. `agents` é uma lista de
// { id, label, result, failed }, escrita em ordem crescente de tempo (o 1º é o mais velho).
function makeWf({ projectsDir, slug = SLUG, session = SESS_A, wf, runDir, resumeOf = null, agents, ageMs = 3600000 }) {
  const dir = path.join(projectsDir, slug, session, 'subagents', 'workflows', wf)
  fs.mkdirSync(dir, { recursive: true })
  const header = [`Run dir (paper trail): ${runDir}`, resumeOf ? `Resume: ${resumeOf}` : null].filter(Boolean).join('\n')
  const ev = [{ type: 'launched' }]
  agents.forEach((a, i) => {
    const t = ageMs - agents.length + i // ordem crescente, valores distintos
    fs.writeFileSync(path.join(dir, `agent-${a.id}.jsonl`), JSON.stringify({ type: 'user', timestamp: iso(t), message: { role: 'user', content: `${header}\n${a.label}` } }) + '\n')
    ev.push({ type: 'started', key: `v2:${a.id}`, agentId: a.id, label: a.label, phase: 'x' })
    if (a.result !== undefined) ev.push({ type: a.failed ? 'failed' : 'result', key: `v2:${a.id}`, agentId: a.id, result: a.result })
  })
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), ev.map((e) => JSON.stringify(e) + '\n').join(''))
  touch(dir, ageMs)
  return dir
}

// Põe o mtime de tudo em `dir` (sem descer) a `ageMs` ms atrás, para as travas de "escrita recente"
// (ACTIVE_GUARD_MS) não confundirem um fixture recém-escrito com uma sessão viva.
function touch(dir, ageMs) {
  const t = new Date(Date.now() - ageMs)
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), t, t)
}

const work = (id, extra) => ({ status: 'done', summary: `feito ${id}`, confidence: 'high', artifact: `<runDir>/${id}.md`, checks: [], ...extra })
const pass = { pass: true, confidence: 'high', blocking: [] }

function mkArtifact(runDir, id, text = `# ${id}\n`) {
  fs.writeFileSync(path.join(runDir, `${id}.md`), text)
}

function withArtifact(runDir, id) {
  return `${runDir}/${id}.md`
}

describe('graph-resume: buildResumeArgs (D2 §9.2)', () => {
  let root, projectsDir, stateDir, home, graphRunsHome, runDir

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-resume-')))
    projectsDir = path.join(root, 'projects')
    stateDir = path.join(root, 'state')
    home = path.join(root, 'home')
    graphRunsHome = path.join(root, 'graph-runs-home')
    runDir = path.join(root, 'repo', '.graph-runs', RUN_ID)
    for (const d of [projectsDir, stateDir, home, graphRunsHome, runDir]) fs.mkdirSync(d, { recursive: true })
  })
  after(() => fs.rmSync(root, { recursive: true, force: true }))

  test('caso principal: 3 prontos, 2 pendentes (1 reprovado, 1 sem verify), revisão do design aprovada', () => {
    mkArtifact(runDir, 'R1')
    mkArtifact(runDir, 'D1')
    mkArtifact(runDir, 'I1')
    mkArtifact(runDir, 'I3') // work sem verify: existe, mas não conta como pronto
    const wf = 'wf_principal'
    makeWf({
      projectsDir,
      wf,
      runDir,
      agents: [
        { id: 'a1', label: 'plan', result: PLAN },
        { id: 'a2', label: 'work:R1', result: work('R1', { artifact: withArtifact(runDir, 'R1') }) },
        { id: 'a3', label: 'verify:R1', result: pass },
        { id: 'a4', label: 'work:D1', result: work('D1', { artifact: withArtifact(runDir, 'D1') }) },
        { id: 'a5', label: 'verify:D1', result: pass },
        { id: 'a6', label: 'work:I1', result: work('I1', { artifact: withArtifact(runDir, 'I1'), filesChanged: ['src/a.js'] }) },
        { id: 'a7', label: 'verify:I1', result: pass },
        { id: 'a8', label: 'work:I2', result: work('I2') },
        { id: 'a9', label: 'verify:I2', result: { pass: false, confidence: 'high', blocking: [{ issue: 'x', where: 'y', fix: 'z', node: 'I2' }] } },
        { id: 'a10', label: 'work:I3', result: work('I3', { artifact: withArtifact(runDir, 'I3') }) },
        { id: 'a11', label: 'design-review:r1', result: { pass: true, confidence: 'high', blocking: [], nits: [], checked: {} } },
      ],
    })

    const r = buildResumeArgs({ runDir, projectsDir, stateDir, now: Date.now() })
    assert.equal(r.ok, true)
    assert.match(r.resumeId, RESUME_ID_RE)
    assert.deepEqual(new Set(r.summary.ready), new Set(['R1', 'D1', 'I1']))
    assert.deepEqual(new Set(r.summary.pending), new Set(['I2', 'I3']))
    assert.equal(r.summary.designReview, 'pula')
    assert.equal(r.args.resume.designReview.pass, true)
    assert.equal(r.args.plan.nodes.length, 5)
    const st = fs.statSync(r.argsFile)
    assert.equal(st.mode & 0o777, 0o600)
    const onDisk = JSON.parse(fs.readFileSync(r.argsFile, 'utf8'))
    assert.equal(onDisk.resume.id, r.resumeId)
  })

  test('--rerun com nó fora do plano sai com código 1', () => {
    const r = buildResumeArgs({ runDir, projectsDir, stateDir, rerun: ['I9'] })
    assert.equal(r.ok, false)
    assert.equal(r.code, 1)
  })

  test('sem R1.md: R1 não fica pronto, com warning', () => {
    const wf = 'wf_sem_artefato'
    const dir2 = path.join(root, 'repo2', '.graph-runs', '20260928-0001-run2')
    fs.mkdirSync(dir2, { recursive: true })
    mkArtifact(dir2, 'D1')
    makeWf({
      projectsDir,
      wf,
      runDir: dir2,
      agents: [
        { id: 'b1', label: 'plan', result: PLAN },
        { id: 'b2', label: 'work:R1', result: work('R1', { artifact: withArtifact(dir2, 'R1') }) },
        { id: 'b3', label: 'verify:R1', result: pass },
        { id: 'b4', label: 'work:D1', result: work('D1', { artifact: withArtifact(dir2, 'D1') }) },
        { id: 'b5', label: 'verify:D1', result: pass },
      ],
    })
    const r = buildResumeArgs({ runDir: dir2, projectsDir, stateDir })
    assert.equal(r.ok, true)
    assert.ok(!r.summary.ready.includes('R1'))
    assert.ok(r.summary.ready.includes('D1'))
    assert.ok(r.warnings.some((w) => w.includes('R1')))
  })

  test('sem journal nenhum: pesquisa e design ficam prontos com verified:false, e a implementação roda', () => {
    const dir3 = path.join(root, 'repo3', '.graph-runs', '20260928-0002-run3')
    fs.mkdirSync(dir3, { recursive: true })
    mkArtifact(dir3, 'R1')
    mkArtifact(dir3, 'D1')
    fs.writeFileSync(path.join(dir3, 'args.json'), JSON.stringify({ task: 't', mode: 'implement', runDir: dir3, plan: PLAN }))
    const r = buildResumeArgs({ runDir: dir3, projectsDir, stateDir })
    assert.equal(r.ok, true)
    assert.deepEqual(new Set(r.summary.ready), new Set(['R1', 'D1']))
    assert.ok(!r.args.resume.done.R1.verified)
    assert.deepEqual(new Set(r.summary.pending), new Set(['I1', 'I2', 'I3']))
  })

  test('work:R1 com status blocked não conta como pronto (pesquisa que travou não pode voltar como pronta)', () => {
    const dirB = path.join(root, 'repoB', '.graph-runs', '20260928-0006-runb')
    fs.mkdirSync(dirB, { recursive: true })
    mkArtifact(dirB, 'R1', '# R1 bloqueado, mas o artefato não é vazio\n')
    makeWf({
      projectsDir,
      wf: 'wf_r1_bloqueado',
      runDir: dirB,
      agents: [
        { id: 'g1', label: 'plan', result: PLAN },
        { id: 'g2', label: 'work:R1', result: work('R1', { status: 'blocked', artifact: withArtifact(dirB, 'R1') }) },
      ],
    })
    const r = buildResumeArgs({ runDir: dirB, projectsDir, stateDir })
    assert.equal(r.ok, true)
    assert.ok(!r.summary.ready.includes('R1'), 'R1 bloqueado não pode estar pronto')
    assert.ok(r.summary.pending.includes('R1'), 'R1 bloqueado precisa rodar de novo')
  })

  test('work:D1 com status failed não conta como pronto (design que falhou não pode voltar como pronto)', () => {
    const dirC = path.join(root, 'repoC', '.graph-runs', '20260928-0007-runc')
    fs.mkdirSync(dirC, { recursive: true })
    mkArtifact(dirC, 'R1')
    mkArtifact(dirC, 'D1', '# D1 falhou, mas escreveu algo\n')
    makeWf({
      projectsDir,
      wf: 'wf_d1_falhou',
      runDir: dirC,
      agents: [
        { id: 'h1', label: 'plan', result: PLAN },
        { id: 'h2', label: 'work:R1', result: work('R1', { artifact: withArtifact(dirC, 'R1') }) },
        { id: 'h3', label: 'verify:R1', result: pass },
        { id: 'h4', label: 'work:D1', result: work('D1', { status: 'failed', artifact: withArtifact(dirC, 'D1') }) },
      ],
    })
    const r = buildResumeArgs({ runDir: dirC, projectsDir, stateDir })
    assert.equal(r.ok, true)
    assert.deepEqual(new Set(r.summary.ready), new Set(['R1']))
    assert.ok(r.summary.pending.includes('D1'), 'D1 com falha precisa rodar de novo')
  })

  test('runId prefixo de outro: findWfsOfRun casa a linha inteira, não pega o wf da run maior', () => {
    const shortId = '20260928-0008-run'
    const longId = '20260928-0008-run-maior'
    const dirShort = path.join(root, 'repoD', '.graph-runs', shortId)
    const dirLong = path.join(root, 'repoD', '.graph-runs', longId)
    fs.mkdirSync(dirShort, { recursive: true })
    fs.mkdirSync(dirLong, { recursive: true })
    const planLonga = { ...PLAN, goal: 'run maior, não é a que estamos retomando' }
    makeWf({
      projectsDir,
      wf: 'wf_run_maior',
      runDir: dirLong,
      agents: [{ id: 'i1', label: 'plan', result: planLonga }],
    })
    // A run curta nunca rodou (sem wf próprio): sem journal, cai no caminho "sem W" via args.json.
    fs.writeFileSync(path.join(dirShort, 'args.json'), JSON.stringify({ task: 't', mode: 'implement', runDir: dirShort, plan: PLAN }))
    const r = buildResumeArgs({ runDir: dirShort, projectsDir, stateDir })
    assert.equal(r.ok, true)
    assert.equal(r.args.plan.goal, 'g', 'não pode pegar o plano da run maior (prefixo)')
  })

  test('cwd fora da raiz do projeto: checks ganham prefixo cd', () => {
    const dir4 = path.join(root, 'repo4', '.graph-runs', '20260928-0003-run4')
    fs.mkdirSync(dir4, { recursive: true })
    fs.writeFileSync(path.join(dir4, 'args.json'), JSON.stringify({ task: 't', mode: 'implement', runDir: dir4, plan: PLAN, checks: ['node --test'] }))
    const r = buildResumeArgs({ runDir: dir4, projectsDir, stateDir, cwd: root })
    assert.equal(r.ok, true)
    assert.ok(r.args.checks[0].startsWith('cd '))
    assert.ok(r.args.context.includes('Retomada disparada de outra pasta'))
  })

  test('resume encadeado: wf B com Resume: rs-1 herda o estado de resume/rs-1.json, menos o que B refez', () => {
    const dir5 = path.join(root, 'repo5', '.graph-runs', '20260928-0004-run5')
    fs.mkdirSync(path.join(dir5, 'resume'), { recursive: true })
    mkArtifact(dir5, 'R1')
    mkArtifact(dir5, 'D1')
    mkArtifact(dir5, 'I1')
    const rs1 = {
      task: 't',
      mode: 'implement',
      runDir: dir5,
      plan: PLAN,
      resume: {
        id: 'rs-20260101-000000',
        from: ['wf_a'],
        done: { R1: { summary: 's', artifact: withArtifact(dir5, 'R1'), verified: true, attempts: 1 }, D1: { summary: 's', artifact: withArtifact(dir5, 'D1'), verified: true, attempts: 1 } },
        rerun: [],
        dependents: false,
        designReview: { pass: true, attempts: 1, blocking: [] },
      },
    }
    fs.writeFileSync(path.join(dir5, 'resume', 'rs-20260101-000000.json'), JSON.stringify(rs1))
    makeWf({
      projectsDir,
      wf: 'wf_b_resumida',
      runDir: dir5,
      resumeOf: 'rs-20260101-000000',
      agents: [
        { id: 'c1', label: 'work:I1', result: work('I1', { artifact: withArtifact(dir5, 'I1'), filesChanged: ['src/a.js'] }) },
        { id: 'c2', label: 'verify:I1', result: pass },
      ],
    })
    const r = buildResumeArgs({ runDir: dir5, projectsDir, stateDir })
    assert.equal(r.ok, true)
    assert.deepEqual(new Set(r.summary.ready), new Set(['R1', 'D1', 'I1']))
    assert.equal(r.summary.designReview, 'pula') // herdado do rs-1, ninguém não-implement rodou em B
  })

  test('refazer I1 + dependentes -> parar durante verify:I1 -> retomar: I1 e I3 ficam pendentes', () => {
    const dir6 = path.join(root, 'repo6', '.graph-runs', '20260928-0005-run6')
    fs.mkdirSync(dir6, { recursive: true })
    mkArtifact(dir6, 'R1')
    mkArtifact(dir6, 'D1')
    mkArtifact(dir6, 'I1')
    mkArtifact(dir6, 'I2')
    mkArtifact(dir6, 'I3')
    // 1ª execução: tudo pronto.
    makeWf({
      projectsDir,
      wf: 'wf_r1_full',
      runDir: dir6,
      agents: [
        { id: 'd1', label: 'plan', result: PLAN },
        { id: 'd2', label: 'work:R1', result: work('R1', { artifact: withArtifact(dir6, 'R1') }) },
        { id: 'd3', label: 'verify:R1', result: pass },
        { id: 'd4', label: 'work:D1', result: work('D1', { artifact: withArtifact(dir6, 'D1') }) },
        { id: 'd5', label: 'verify:D1', result: pass },
        { id: 'd6', label: 'work:I1', result: work('I1', { artifact: withArtifact(dir6, 'I1'), filesChanged: ['src/a.js'] }) },
        { id: 'd7', label: 'verify:I1', result: pass },
        { id: 'd8', label: 'work:I2', result: work('I2', { artifact: withArtifact(dir6, 'I2'), filesChanged: ['src/b.js'] }) },
        { id: 'd9', label: 'verify:I2', result: pass },
        { id: 'd10', label: 'work:I3', result: work('I3', { artifact: withArtifact(dir6, 'I3'), filesChanged: ['src/a.js'] }) },
        { id: 'd11', label: 'verify:I3', result: pass },
        { id: 'd12', label: 'design-review:r1', result: { pass: true, confidence: 'high', blocking: [], nits: [], checked: {} } },
      ],
      ageMs: 7200000,
    })
    // 1ª retomada: pede refazer I1 (+dependentes, que inclui I3). O work:I1 roda de novo, mas o verify:I1
    // fica interrompido (sem result): I1 e I3 ficam pendentes.
    const r1 = buildResumeArgs({ runDir: dir6, projectsDir, stateDir, rerun: ['I1'], dependents: true, now: Date.now() - 3600000 })
    assert.equal(r1.ok, true)
    assert.deepEqual(new Set(r1.args.resume.rerun), new Set(['I1', 'I3']))
    makeWf({
      projectsDir,
      wf: 'wf_r2_interrompida',
      runDir: dir6,
      resumeOf: r1.resumeId,
      agents: [{ id: 'e1', label: 'work:I1', result: work('I1', { artifact: withArtifact(dir6, 'I1'), filesChanged: ['src/a.js'] }) }, { id: 'e2', label: 'verify:I1', result: undefined }],
      ageMs: 1800000,
    })

    const r2 = buildResumeArgs({ runDir: dir6, projectsDir, stateDir })
    assert.equal(r2.ok, true)
    assert.deepEqual(new Set(r2.summary.pending), new Set(['I1', 'I3']))
    assert.deepEqual(new Set(r2.summary.ready), new Set(['R1', 'D1', 'I2']))
  })
})

describe('graph-resume: trava contra dois Workflows (C8)', () => {
  let root, projectsDir, stateDir, runDir

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-resume-lock-')))
    projectsDir = path.join(root, 'projects')
    stateDir = path.join(root, 'state')
    runDir = path.join(root, 'repo', '.graph-runs', RUN_ID)
    fs.mkdirSync(projectsDir, { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    fs.mkdirSync(runDir, { recursive: true })
  })
  after(() => fs.rmSync(root, { recursive: true, force: true }))

  function wfNotTerminated(now) {
    return makeWf({
      projectsDir,
      slug: SLUG,
      session: SESS_A,
      wf: 'wf_travado',
      runDir,
      agents: [
        { id: 'f1', label: 'plan', result: PLAN },
        { id: 'f2', label: 'work:R1', result: work('R1', { artifact: withArtifact(runDir, 'R1') }) },
      ],
      ageMs: 20000,
    })
  }

  test('dona ouvindo: sai com 4 e nada é gravado em resume/', () => {
    mkArtifact(runDir, 'R1')
    const now = Date.now()
    const dir = wfNotTerminated(now)
    void dir
    writeHeartbeat(stateDir, { session: SESS_A, project: SLUG, pid: process.pid, startedAt: new Date(now).toISOString(), beatAt: new Date(now).toISOString() })
    const before0 = fs.existsSync(path.join(runDir, 'resume')) ? fs.readdirSync(path.join(runDir, 'resume')).length : 0
    const r = buildResumeArgs({ runDir, projectsDir, stateDir, now: now + 100000 })
    assert.equal(r.ok, false)
    assert.equal(r.code, 4)
    const after0 = fs.existsSync(path.join(runDir, 'resume')) ? fs.readdirSync(path.join(runDir, 'resume')).length : 0
    assert.equal(after0, before0)
  })

  test('o mesmo, com --owner-ok: passa', () => {
    const now = Date.now()
    const r = buildResumeArgs({ runDir, projectsDir, stateDir, now: now + 200000, ownerOk: true })
    assert.equal(r.ok, true)
  })

  test('agent-*.jsonl escrito há 10s, sem sinal de vida: sai com 4 mesmo assim (ACTIVE_GUARD_MS)', () => {
    const runDir2 = path.join(root, 'repo', '.graph-runs', '20260928-0001-teste-guard')
    fs.mkdirSync(runDir2, { recursive: true })
    mkArtifact(runDir2, 'R1')
    makeWf({ projectsDir, slug: SLUG, session: SESS_B, wf: 'wf_recente', runDir: runDir2, agents: [{ id: 'g1', label: 'plan', result: PLAN }, { id: 'g2', label: 'work:R1', result: work('R1', { artifact: withArtifact(runDir2, 'R1') }) }], ageMs: 10000 })
    const r = buildResumeArgs({ runDir: runDir2, projectsDir, stateDir })
    assert.equal(r.ok, false)
    assert.equal(r.code, 4)
  })

  test('W terminada (com synth): passa mesmo sem --owner-ok', () => {
    const runDir3 = path.join(root, 'repo', '.graph-runs', '20260928-0002-teste-done')
    fs.mkdirSync(runDir3, { recursive: true })
    mkArtifact(runDir3, 'R1')
    makeWf({
      projectsDir,
      slug: SLUG,
      session: SESS_A,
      wf: 'wf_pronta',
      runDir: runDir3,
      agents: [
        { id: 'h1', label: 'plan', result: PLAN },
        { id: 'h2', label: 'work:R1', result: work('R1', { artifact: withArtifact(runDir3, 'R1') }) },
        { id: 'h3', label: 'verify:R1', result: pass },
        { id: 'h4', label: 'synth', result: { status: 'done', summary: 'ok', humanGate: [] } },
      ],
      ageMs: 30000,
    })
    const r = buildResumeArgs({ runDir: runDir3, projectsDir, stateDir })
    assert.equal(r.ok, true)
  })
})

// ── 9.3: a ponte entre o CLI e o motor ──
describe('graph-resume -> motor: só os agentes esperados', () => {
  test('args montados pelo buildResumeArgs alimentam runWorkflow e geram só o trabalho pendente', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-resume-bridge-')))
    try {
      const projectsDir = path.join(root, 'projects')
      const stateDir = path.join(root, 'state')
      const runDir = path.join(root, 'repo', '.graph-runs', RUN_ID)
      fs.mkdirSync(projectsDir, { recursive: true })
      fs.mkdirSync(stateDir, { recursive: true })
      fs.mkdirSync(runDir, { recursive: true })
      for (const id of ['R1', 'D1', 'I1', 'I2', 'I3']) mkArtifact(runDir, id)
      makeWf({
        projectsDir,
        wf: 'wf_ponte',
        runDir,
        agents: [
          { id: 'i1', label: 'plan', result: PLAN },
          { id: 'i2', label: 'work:R1', result: work('R1', { artifact: withArtifact(runDir, 'R1') }) },
          { id: 'i3', label: 'verify:R1', result: pass },
          { id: 'i4', label: 'work:D1', result: work('D1', { artifact: withArtifact(runDir, 'D1') }) },
          { id: 'i5', label: 'verify:D1', result: pass },
          { id: 'i6', label: 'work:I1', result: work('I1', { artifact: withArtifact(runDir, 'I1'), filesChanged: ['src/a.js'] }) },
          { id: 'i7', label: 'verify:I1', result: pass },
          { id: 'i8', label: 'work:I3', result: work('I3', { artifact: withArtifact(runDir, 'I3'), filesChanged: ['src/a.js'] }) },
          { id: 'i9', label: 'verify:I3', result: pass },
          { id: 'i10', label: 'design-review:r1', result: { pass: true, confidence: 'high', blocking: [], nits: [], checked: {} } },
        ],
      })
      const r = buildResumeArgs({ runDir, projectsDir, stateDir })
      assert.equal(r.ok, true)
      assert.deepEqual(new Set(r.summary.pending), new Set(['I2']))

      const args = { task: 'tarefa', runDir, mode: 'implement', effort: 'high', ceiling: 24, checks: [], ...r.args }
      const script = defaultScript({
        work: (label) => work(label.split(':')[1]),
        verify: () => pass,
        critic: () => ({ done: true, gaps: [] }),
        synth: () => ({ status: 'done', summary: 'fim', humanGate: [] }),
      })
      const { result, calls } = await runWorkflow(args, script)
      const agentCalls = calls.filter((c) => !c.startsWith('#'))
      assert.deepEqual(new Set(agentCalls.filter((c) => c.startsWith('work:') || c.startsWith('verify:'))), new Set(['work:I2', 'verify:I2']))
      assert.ok(!agentCalls.some((c) => c === 'plan'))
      assert.ok(!agentCalls.includes('design-review:r1'))
      assert.equal(result.resume.ready.length, 4)
      assert.ok(result.resume.ready.includes('I1'))
      assert.ok(!result.resume.ready.includes('I2'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
