// Testes de "achar a run" do graph-watch (spec §6.8, §8.2 item 5).
//
// Interface esperada (ver o topo de model.test.mjs para o contrato completo; aqui usamos):
//   function findRun({ projectsDir, cwd, run, runId, mode, waitMs }) -> Promise<{ runDir, wf, terminated: bool }>
//     mode: 'default' (snapshot/live/agent: pega a run mais recente, aceita terminada) ou
//           'events' (nunca escolhe run com result de synth; sem candidato aberto, espera até
//           waitMs e lança GraphWatchError(3)).
//     projectsDir substitui `~/.claude/projects` (flag --projects-dir, só de teste).
//     Lança GraphWatchError(3) quando nada é encontrado.
//   class GraphWatchError extends Error { code }
//
// bin/graph-watch.mjs ainda não existe: todo teste abaixo falha na chamada (red esperado).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')

const mod = await import('../bin/graph-watch.mjs').catch((e) => ({ __importError: e }))
const { findRun, GraphWatchError } = mod

const CWD = '/exemplo/repo'
const SLUG = '-exemplo-repo'

function mkProjectsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-projects-'))
  return dir
}

function copyFixtureAsRun(projectsDir, fixtureName, wf, { mtimeOffsetSec = 0 } = {}) {
  const dest = path.join(projectsDir, SLUG, 'sess', 'subagents', 'workflows', wf)
  fs.mkdirSync(dest, { recursive: true })
  for (const f of fs.readdirSync(path.join(FIXTURES, fixtureName))) {
    fs.copyFileSync(path.join(FIXTURES, fixtureName, f), path.join(dest, f))
  }
  if (mtimeOffsetSec) {
    const t = new Date(Date.now() - mtimeOffsetSec * 1000)
    fs.utimesSync(path.join(dest, 'journal.jsonl'), t, t)
  }
  return dest
}

describe('achar a run (§6.8, §8.2 item 5)', () => {
  test('slug com duas runs: ignora a de outro workflow mesmo sendo a mais nova (mtime), escolhe a graph-eng', async () => {
    const projectsDir = mkProjectsDir()
    // other-wf é a MAIS NOVA (offset menor) — se a busca escolhesse só por mtime, ela venceria.
    // O filtro do §6.8 item 3 (labels fora do padrão graph-eng) precisa descartá-la mesmo assim.
    copyFixtureAsRun(projectsDir, 'other-wf', 'wf_aaaa0000-aaa', { mtimeOffsetSec: 1 })
    const wantedDir = copyFixtureAsRun(projectsDir, 'happy', 'wf_bbbb0000-bbb', { mtimeOffsetSec: 5 })
    const found = await findRun({ projectsDir, cwd: CWD })
    assert.equal(found.runDir, wantedDir)
  })

  test('slug inexistente: acha pela reserva (cwd gravado no transcript de um agente)', async () => {
    const projectsDir = mkProjectsDir()
    const otherSlug = '-outro-slug-qualquer'
    const dest = path.join(projectsDir, otherSlug, 'sess', 'subagents', 'workflows', 'wf_cccc0000-ccc')
    fs.mkdirSync(dest, { recursive: true })
    for (const f of fs.readdirSync(path.join(FIXTURES, 'happy'))) {
      fs.copyFileSync(path.join(FIXTURES, 'happy', f), path.join(dest, f))
    }
    // grava um agent-*.jsonl com "cwd" batendo no cwd atual, mesmo com o slug não batendo
    fs.writeFileSync(
      path.join(dest, 'agent-reserva0000000.jsonl'),
      JSON.stringify({ type: 'assistant', cwd: CWD, message: { role: 'assistant', content: [] } }) + '\n',
    )
    const found = await findRun({ projectsDir, cwd: CWD })
    assert.equal(found.runDir, dest)
  })

  test('nada encontrado: GraphWatchError com code 3', async () => {
    const projectsDir = mkProjectsDir()
    await assert.rejects(
      () => findRun({ projectsDir, cwd: CWD, waitMs: 5 }),
      (err) => err instanceof GraphWatchError && err.code === 3,
    )
  })

  test('run antiga terminada mais nova no slug: modo events escolhe a aberta, não a terminada', async () => {
    const projectsDir = mkProjectsDir()
    copyFixtureAsRun(projectsDir, 'happy', 'wf_dddd0000-ddd', { mtimeOffsetSec: 1 }) // terminada (tem synth), mais nova
    const openDir = copyFixtureAsRun(projectsDir, 'interrupted', 'wf_eeee0000-eee', { mtimeOffsetSec: 30 }) // aberta, mais velha
    const found = await findRun({ projectsDir, cwd: CWD, mode: 'events', waitMs: 50 })
    assert.equal(found.runDir, openDir)
    assert.equal(found.terminated, false)
  })

  test('só há run(s) terminada(s): modo events nunca escolhe, espera e sai com code 3', async () => {
    const projectsDir = mkProjectsDir()
    copyFixtureAsRun(projectsDir, 'happy', 'wf_ffff0000-fff')
    await assert.rejects(
      () => findRun({ projectsDir, cwd: CWD, mode: 'events', waitMs: 20 }),
      (err) => err instanceof GraphWatchError && err.code === 3,
    )
  })

  test('--run-id escolhe a run cujo transcript do plan cita .graph-runs/<runId>', async () => {
    const projectsDir = mkProjectsDir()
    const dest = copyFixtureAsRun(projectsDir, 'happy', 'wf_gggg0000-ggg')
    const planAgentFile = fs.readdirSync(dest).find((f) => f.endsWith('.meta.json') && JSON.parse(fs.readFileSync(path.join(dest, f))).description === 'plan')
    const planAgentId = planAgentFile.replace(/^agent-/, '').replace(/\.meta\.json$/, '')
    fs.writeFileSync(
      path.join(dest, `agent-${planAgentId}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'runDir: .graph-runs/20260101-0000-exemplo-runid' }] } }) + '\n',
    )
    const found = await findRun({ projectsDir, cwd: CWD, runId: '20260101-0000-exemplo-runid' })
    assert.equal(found.runDir, dest)
    await assert.rejects(
      () => findRun({ projectsDir, cwd: CWD, runId: 'inexistente-0000' }),
      (err) => err instanceof GraphWatchError && err.code === 3,
    )
  })

  test('snapshot sem --run sobre run terminada: acha e avisa "(terminada)"', async () => {
    const projectsDir = mkProjectsDir()
    const dest = copyFixtureAsRun(projectsDir, 'happy', 'wf_hhhh0000-hhh')
    const found = await findRun({ projectsDir, cwd: CWD, mode: 'default' })
    assert.equal(found.runDir, dest)
    assert.equal(found.terminated, true)
  })
})
