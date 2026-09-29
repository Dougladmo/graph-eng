// API do painel sobre o esqueleto de fases (D3 §10, DR-8/A2/A3): pseudo-nós `design-review` e
// `polish-<k>` de uma run real, com a fixture test/fixtures/wf_phases (D1-D3, revisão do design e
// polidores). Fica separado de test/ui-server.test.mjs porque depende da fixture e de agentsOfNode
// (I3), que roda em paralelo com I2 — DR-8 moveu este caso para I4. Não altera nenhuma asserção de
// test/ui-server.test.mjs.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, 'fixtures', 'wf_phases')
const WF = 'wf_phases'

const { ensurePanel } = await import('../bin/ui-server.mjs')

// Mesma forma que o painel espera achar: <projectsDir>/<slug>/<sessão>/subagents/workflows/<wf>/.
function copyPhases() {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ui-phases-'))
  const dir = path.join(projectsDir, '-exemplo-projeto-fases', 'sess-fases', 'subagents', 'workflows', WF)
  fs.mkdirSync(dir, { recursive: true })
  fs.cpSync(FIXTURE, dir, { recursive: true })
  return { projectsDir, dir }
}

// Conexão por requisição (agent: false), como em test/ui-server.test.mjs: o servidor do Node fecha o
// socket depois de algumas respostas e o keep-alive do cliente reaproveitaria um socket morto.
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('painel web: pseudo-nós da fase (design-review, polish-<k>) sobre wf_phases', () => {
  let projectsDir
  let panel
  let port

  before(async () => {
    ;({ projectsDir } = copyPhases())
    // estado do painel num dir temporário: nunca ~/.claude (spec C1)
    const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-eng-ui-state-')), 'config.json')
    panel = await ensurePanel({ port: 0, projectsDir, pollMs: 100, configPath })
    port = panel.port
  })
  after(async () => {
    await panel.close()
  })

  test('GET /api/runs/:wf: a run aparece, terminada, com 16 agentes gastos (D1 §9.1/D3 §9)', async () => {
    const { status, json } = await getJson(port, `/api/runs/${WF}`)
    assert.equal(status, 200)
    assert.equal(json.status, 'terminado')
    assert.equal(json.spent, 16)
    assert.ok(json.nodes.every((n) => n.state === 'pronto'))
  })

  test('GET .../nodes/design-review: 200, pseudo, estado pronto e agentes das duas revisões', async () => {
    const { status, json } = await getJson(port, `/api/runs/${WF}/nodes/design-review`)
    assert.equal(status, 200)
    assert.equal(json.pseudo, true)
    assert.equal(json.state, 'pronto')
    assert.ok(json.agents.length >= 2, 'revisão + reparo deviam aparecer como agentes do pseudo-nó')
  })

  test('GET .../nodes/polish-1 e polish-2: 200, pseudo, título "polimento <k>"', async () => {
    const p1 = await getJson(port, `/api/runs/${WF}/nodes/polish-1`)
    assert.equal(p1.status, 200)
    assert.equal(p1.json.pseudo, true)
    assert.equal(p1.json.title, 'polimento 1')
    assert.equal(p1.json.state, 'pronto')

    const p2 = await getJson(port, `/api/runs/${WF}/nodes/polish-2`)
    assert.equal(p2.status, 200)
    assert.equal(p2.json.title, 'polimento 2')
  })

  test('GET .../nodes/polish-x: 404 (não casa POLISH_API_RE); .../nodes/polish:2: 400 (formato de id inválido)', async () => {
    assert.equal((await getJson(port, `/api/runs/${WF}/nodes/polish-x`)).status, 404)
    assert.equal((await getJson(port, `/api/runs/${WF}/nodes/polish:2`)).status, 400)
  })

  test('GET .../nodes/D1: nó real (não pseudo), reparado uma vez, com agentes', async () => {
    const { status, json } = await getJson(port, `/api/runs/${WF}/nodes/D1`)
    assert.equal(status, 200)
    assert.equal(json.pseudo, false)
    assert.equal(json.reps, 1)
    assert.ok(json.agents.length > 0)
  })

  test('GET .../nodes/research-base: nó injetado, sem vazar como pseudo', async () => {
    const { status, json } = await getJson(port, `/api/runs/${WF}/nodes/research-base`)
    assert.equal(status, 200)
    assert.equal(json.pseudo, false)
    assert.equal(json.injected, true)
  })
})
