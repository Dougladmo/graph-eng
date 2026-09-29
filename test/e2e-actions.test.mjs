// Ponta a ponta das três ações do painel (spec docs/specs/2026-09-28-acoes-no-painel.md, C1-C5, C10-C12,
// C8/C9; I8): POST no painel -> fila -> linha do `graph-watch events` -> accept/done -> GET mostra o
// estado. A verificação visual (Playwright) é do I6/I7; este teste é só na API do servidor + na fila,
// como o brief do nó pede. Tudo em dirs de os.tmpdir(); nada toca ~/.claude nem o painel real da 4477.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { acceptRequest, doneRequest, failRequest, requestEventLine, SESSION_RE } from '../bin/requests.mjs'
import { SESS, SLUG, addRun, mkRunDir, touch, world, writeListener } from './helpers/panel-fixture.mjs'

const RID = '20260101-0100-exemplo-e2e'

describe('e2e: resume, stop e rerun-node (POST -> fila -> events -> accept/done -> GET)', () => {
  let W

  before(async () => {
    W = await world()
  })
  after(() => W.close())

  // Simula a linha que `graph-watch events` imprimiria para este pedido, e o CLI de aceite que ela sugere.
  function assertEventLine(req) {
    const line = requestEventLine(req, { root: '/plugin-root', session: SESS.a })
    assert.match(line, /^graph-eng pedido req-\d{8}T\d{6}-[0-9a-f]{6} · /)
    assert.ok(line.includes(req.type))
    assert.ok(line.includes(`run ${req.runId || req.wf} (${req.wf})`))
    assert.ok(line.includes(`accept ${req.id} --session ${SESS.a}`))
    if (req.type === 'rerun-node' && req.node) assert.ok(line.includes(`nó ${req.node}`))
  }

  test('resume: a sessão dona atende, dispara e grava feito; o painel mostra a cada passo', async () => {
    const wf = 'wf_e2e_resume'
    const runDir = mkRunDir(W.graphRuns, RID)
    addRun(W.projectsDir, { wf, runId: RID, runDir, kind: 'stopped', session: SESS.a })
    writeListener(W.stateDir, { session: SESS.a, wf, beatAt: Date.now() })

    const post = await W.post('/api/requests', { type: 'resume', wf })
    assert.equal(post.status, 202)
    const id = post.json.request.id
    assert.equal(post.json.request.state, 'pendente')
    assert.match(post.json.request.id, /^req-\d{8}T\d{6}-[0-9a-f]{6}$/)

    assertEventLine(post.json.request)

    // GET reflete pendente (o painel mostra o pedido aberto na run).
    let modelR = (await W.get(`/api/runs/${wf}`)).json
    assert.equal(modelR.requests[0].id, id)
    assert.equal(modelR.requests[0].state, 'pendente')

    // A sessão dona aceita (é ela que ouve o `events`, route === 'owner' por 5b: dona ouvindo).
    const acc = acceptRequest(W.stateDir, id, { session: SESS.a })
    assert.equal(acc.ok, true)
    assert.equal(acc.req.state, 'aceito')

    let getR = await W.get(`/api/requests/${id}`)
    assert.equal(getR.json.request.state, 'aceito')

    // A sessão dispara o Workflow(...) de retomada e grava o novo wf.
    const wfNovo = 'wf_e2e_resume_novo'
    const done = doneRequest(W.stateDir, id, { session: SESS.a, newWf: wfNovo })
    assert.equal(done.ok, true)
    assert.equal(done.req.state, 'feito')
    assert.equal(done.req.newWf, wfNovo)

    getR = await W.get(`/api/requests/${id}`)
    assert.equal(getR.json.request.state, 'feito')
  })

  test('stop: só a sessão dona pode aceitar; outra sessão recebe código 4', async () => {
    const wf = 'wf_e2e_stop'
    const runDir = mkRunDir(W.graphRuns, RID + '-stop')
    addRun(W.projectsDir, { wf, runId: RID + '-stop', runDir, kind: 'running', session: SESS.a })
    writeListener(W.stateDir, { session: SESS.a, wf, beatAt: Date.now() })

    const post = await W.post('/api/requests', { type: 'stop', wf })
    assert.equal(post.status, 202)
    const id = post.json.request.id
    assert.equal(post.json.request.route, 'owner')

    const wrong = acceptRequest(W.stateDir, id, { session: SESS.b })
    assert.equal(wrong.ok, false)
    assert.equal(wrong.code, 4)

    const right = acceptRequest(W.stateDir, id, { session: SESS.a })
    assert.equal(right.ok, true)

    const done = doneRequest(W.stateDir, id, { session: SESS.a })
    assert.equal(done.ok, true)
    const getR = await W.get(`/api/requests/${id}`)
    assert.equal(getR.json.request.state, 'feito')
  })

  test('rerun-node: falha da sessão vira `falhou` com o motivo, e o painel mostra', async () => {
    const wf = 'wf_e2e_rerun'
    const runDir = mkRunDir(W.graphRuns, RID + '-rerun')
    addRun(W.projectsDir, { wf, runId: RID + '-rerun', runDir, kind: 'stopped', session: SESS.a })
    writeListener(W.stateDir, { session: SESS.a, wf, beatAt: Date.now() })

    const post = await W.post('/api/requests', { type: 'rerun-node', wf, node: 'A', dependents: true })
    assert.equal(post.status, 202)
    const id = post.json.request.id
    assert.equal(post.json.request.node, 'A')
    assert.equal(post.json.request.dependents, true)

    assertEventLine(post.json.request)

    const acc = acceptRequest(W.stateDir, id, { session: SESS.a })
    assert.equal(acc.ok, true)

    const fail = failRequest(W.stateDir, id, { session: SESS.a, reason: 'graph-resume saiu com 1: runDir inválido' })
    assert.equal(fail.ok, true)
    assert.equal(fail.req.state, 'falhou')
    assert.equal(fail.req.reason, 'graph-resume saiu com 1: runDir inválido')

    const getR = await W.get(`/api/requests/${id}`)
    assert.equal(getR.json.request.state, 'falhou')
    assert.equal(getR.json.request.reason, fail.req.reason)
  })

  test('duas sessões correndo pelo mesmo `done`: só uma vence (C2, regra única de escrita)', async () => {
    const wf = 'wf_e2e_corrida'
    const runDir = mkRunDir(W.graphRuns, RID + '-corrida')
    addRun(W.projectsDir, { wf, runId: RID + '-corrida', runDir, kind: 'stopped', session: SESS.a })
    writeListener(W.stateDir, { session: SESS.a, wf, beatAt: Date.now() })

    const post = await W.post('/api/requests', { type: 'resume', wf })
    const id = post.json.request.id
    acceptRequest(W.stateDir, id, { session: SESS.a })

    const r1 = doneRequest(W.stateDir, id, { session: SESS.a, newWf: 'wf_a' })
    const r2 = failRequest(W.stateDir, id, { session: SESS.a, reason: 'tarde demais' })
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, false)
    assert.equal(r2.code, 5)
  })
})
