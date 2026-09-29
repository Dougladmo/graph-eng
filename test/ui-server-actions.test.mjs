// Rotas de pedido, sessão ouvindo e artefatos do painel (spec docs/specs/2026-09-28-acoes-no-painel.md
// C10 A1-A6, C11, C12; casos do D3 §8.1 com as correções da tabela do I5): travas de escrita, campos da A1,
// regra das ações (texto exato), execução superada, janela do `feito`, condição 5b, A2/A3/A4, path
// traversal nos artefatos, o gancho canDelete e o SSE. Tudo em dirs de os.tmpdir(); nada toca ~/.claude.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { runActions, nodeRerun } from '../bin/ui-server.mjs'
import { acceptRequest, doneRequest, listRequests, requestsDir } from '../bin/requests.mjs'
import { SESS, SLUG, addRun, mkRunDir, request, touch, world, writeListener } from './helpers/panel-fixture.mjs'

const RID = '20260101-0000-exemplo-acoes'
const T = {
  superseded: (cur) => `Essa execução foi retomada em ${cur}; use a mais nova.`,
  resumeDone: 'A run já terminou. Para rodar um nó de novo, use Refazer nó.',
  planOnly: 'Só o plano rodou. Aprovar o plano pelo painel está fora do escopo: aprove no chat.',
  resumeRunning: 'A run está rodando. Pare antes de retomar.',
  noRunDir: 'Essa run não tem pasta em .graph-runs; sem ela não há de onde retomar.',
  open: 'Espere o pedido aberto terminar, ou cancele.',
  openDone: 'A retomada foi feita; esperando a execução nova aparecer.',
  rearm: 'A sessão dona está rearmando a escuta do painel; tente de novo em instantes.',
  noProjectResume: 'Nenhuma sessão ouvindo este projeto. Use Copiar para retomar e cole numa sessão do Claude Code.',
  stopDone: 'A run já terminou.',
  stopGone: 'A sessão que rodou a run acabou; não há o que parar. Use Retomar.',
  stopNoOwner: 'A sessão que rodou esta run não está ouvindo. Use Copiar para parar e cole nela.',
  rerunRunning: 'A run está rodando. Pare antes de refazer um nó.',
  noProjectRerun: 'Nenhuma sessão ouvindo este projeto. Use Copiar para refazer e cole numa sessão do Claude Code.',
}

// Listagem recursiva (caminho, tamanho, mtime): prova que nada foi gravado.
function tree(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name)
      const st = fs.lstatSync(p)
      out.push(`${path.relative(dir, p)}:${st.size}:${st.mtimeMs}`)
      if (e.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out
}
const queueFiles = (W) => tree(requestsDir(W.stateDir))
const model = async (W, wf) => (await W.get(`/api/runs/${wf}`)).json

// ── 1. Travas de escrita (A1 e A3) ──

describe('rotas de pedido: travas iguais às do PUT /api/config', () => {
  let W
  before(async () => {
    W = await world()
    addRun(W.projectsDir, { wf: 'wf_trava-1', runId: RID, runDir: mkRunDir(W.graphRuns, RID), kind: 'stopped' })
    writeListener(W.stateDir, { session: SESS.b })
  })
  after(() => W.close())

  const ROUTES = [
    ['/api/requests', { type: 'resume', wf: 'wf_trava-1' }],
    ['/api/requests/req-20260101T000000-abcdef/cancel', {}],
  ]

  test('Host 403, método 405, Origin 403, 415, 413 (declarado e em chunks), JSON, corpo, __proto__', async () => {
    const before0 = queueFiles(W)
    for (const [p, body] of ROUTES) {
      const json = JSON.stringify(body)
      const base = { Origin: W.origin, 'Content-Type': 'application/json' }
      assert.equal((await request(W.port, 'POST', p, { ...base, Host: 'evil.example' }, json)).status, 403, `Host ${p}`)
      for (const m of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
        const r = await request(W.port, m, p, base, m === 'GET' ? undefined : json)
        assert.equal(r.status, 405, `${m} ${p}`)
        assert.equal(r.headers.allow, 'POST', `${m} ${p}`)
      }
      const origins = [undefined, 'null', `http://127.0.0.1:${W.port + 1}`, `https://127.0.0.1:${W.port}`, `http://localhost:${W.port}`, 'http://evil.test']
      for (const o of origins) {
        const h = { 'Content-Type': 'application/json' }
        if (o !== undefined) h.Origin = o
        assert.equal((await request(W.port, 'POST', p, h, json)).status, 403, `Origin ${o} ${p}`)
      }
      assert.equal((await W.post(p, json, { 'Content-Type': 'text/plain' })).status, 415, `415 ${p}`)
      assert.equal((await W.post(p, 'x'.repeat(10), { 'Content-Length': '5000' }).catch(() => ({ status: 413 }))).status, 413, `413 declarado ${p}`)
      assert.equal((await request(W.port, 'POST', p, base, Array.from({ length: 5 }, () => 'x'.repeat(1000)))).status, 413, `413 em chunks ${p}`)
      const bad = await W.post(p, '{')
      assert.equal(bad.status, 400)
      assert.equal(bad.json.error, 'JSON inválido')
      const arr = await W.post(p, '[]')
      assert.equal(arr.status, 400)
      assert.equal(arr.json.error, 'o corpo deve ser um objeto')
      const proto = await W.post(p, `{"__proto__":{"x":1},${json.slice(1)}`.replace(',}', '}'))
      assert.equal(proto.status, 400, `__proto__ ${p}`)
      assert.ok(Object.hasOwn(proto.json.fields, '__proto__'))
      assert.equal(proto.json.fields.__proto__, 'campo desconhecido')
      assert.equal({}.x, undefined, 'o protótipo fica intacto')
    }
    assert.deepEqual(queueFiles(W), before0, 'a fila fica byte a byte igual')
  })

  test('host localhost também passa quando o Origin bate com ele', async () => {
    const r = await request(W.port, 'POST', '/api/requests', { Host: `localhost:${W.port}`, Origin: `http://localhost:${W.port}`, 'Content-Type': 'application/json' }, '{"type":"x"}')
    assert.equal(r.status, 400)
  })
})

// ── 2. Campos da A1 ──

describe('POST /api/requests: campos', () => {
  let W
  before(async () => {
    W = await world()
    addRun(W.projectsDir, { wf: 'wf_campo-1', runId: RID, runDir: mkRunDir(W.graphRuns, RID), kind: 'stopped' })
    writeListener(W.stateDir, { session: SESS.b })
  })
  after(() => W.close())

  test('cada campo inválido volta em fields, com o motivo; nada é gravado', async () => {
    const cases = [
      [{ type: 'rm', wf: 'wf_campo-1' }, 'type', 'use resume, stop ou rerun-node'],
      [{ wf: 'wf_campo-1' }, 'type', 'use resume, stop ou rerun-node'],
      [{ type: 'resume', wf: '../x' }, 'wf', 'id de run inválido'],
      [{ type: 'resume' }, 'wf', 'id de run inválido'],
      [{ type: 'rerun-node', wf: 'wf_campo-1' }, 'node', 'obrigatório em rerun-node'],
      [{ type: 'resume', wf: 'wf_campo-1', node: 'A' }, 'node', 'só vale em rerun-node'],
      [{ type: 'stop', wf: 'wf_campo-1', dependents: true }, 'dependents', 'só vale em rerun-node'],
      [{ type: 'rerun-node', wf: 'wf_campo-1', node: 'a/b' }, 'node', 'id de nó inválido'],
      [{ type: 'rerun-node', wf: 'wf_campo-1', node: 7 }, 'node', 'id de nó inválido'],
      [{ type: 'rerun-node', wf: 'wf_campo-1', node: 'critic' }, 'node', 'plano, revisão, crítica, polimento e síntese não se refazem'],
      [{ type: 'rerun-node', wf: 'wf_campo-1', node: 'polish-1' }, 'node', 'plano, revisão, crítica, polimento e síntese não se refazem'],
      [{ type: 'rerun-node', wf: 'wf_campo-1', node: 'A', dependents: 'sim' }, 'dependents', 'use true ou false'],
      [{ type: 'resume', wf: 'wf_campo-1', runDir: '/' }, 'runDir', 'campo desconhecido'],
      [{ type: 'resume', wf: 'wf_campo-1', session: SESS.a }, 'session', 'campo desconhecido'],
    ]
    for (const [body, field, why] of cases) {
      const r = await W.post('/api/requests', body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal(r.json.error, 'pedido inválido')
      assert.equal(r.json.fields[field], why, JSON.stringify(body))
    }
    const nf = await W.post('/api/requests', { type: 'resume', wf: 'wf_nao-existe' })
    assert.equal(nf.status, 404)
    const nn = await W.post('/api/requests', { type: 'rerun-node', wf: 'wf_campo-1', node: 'ZZ' })
    assert.equal(nn.status, 404)
    assert.equal(nn.json.error, 'nó ZZ não existe em wf_campo-1')
    assert.deepEqual(queueFiles(W), [])
  })
})

// ── 3/4/5. Estado, A2 e A3 ──

describe('POST /api/requests: estado, A2 (transições) e A3 (cancelar e descartar)', () => {
  let W
  let runDir
  before(async () => {
    W = await world()
    runDir = mkRunDir(W.graphRuns, RID)
    addRun(W.projectsDir, { wf: 'wf_estado-1', runId: RID, runDir, kind: 'stopped', session: SESS.a })
    addRun(W.projectsDir, { wf: 'wf_rodando-1', runId: '20260101-0001-exemplo-rodando', runDir: mkRunDir(W.graphRuns, '20260101-0001-exemplo-rodando'), kind: 'running', session: SESS.c })
  })
  after(() => W.close())

  test('sem ouvinte: 409 com o texto da C12, e nada é gravado', async () => {
    const r = await W.post('/api/requests', { type: 'resume', wf: 'wf_estado-1' })
    assert.equal(r.status, 409)
    assert.equal(r.json.error, T.noProjectResume)
    const m = await model(W, 'wf_estado-1')
    assert.equal(m.actions.listening.project, false)
    assert.deepEqual(m.actions.resume, { ok: false, why: T.noProjectResume })
    assert.equal(m.actions.copy.resume.ok, true, 'copiar não depende de ouvinte')
    assert.deepEqual(queueFiles(W), [])
  })

  test('resume numa run rodando: 409 com o texto exato', async () => {
    writeListener(W.stateDir, { session: SESS.b })
    const r = await W.post('/api/requests', { type: 'resume', wf: 'wf_rodando-1' })
    assert.equal(r.status, 409)
    assert.equal(r.json.error, T.resumeRunning)
  })

  test('stop com ouvinte só de outra sessão do projeto: 409 "A sessão que rodou…"', async () => {
    writeListener(W.stateDir, { session: SESS.b })
    const r = await W.post('/api/requests', { type: 'stop', wf: 'wf_estado-1' })
    assert.equal(r.status, 409)
    assert.equal(r.json.error, T.stopNoOwner)
  })

  test('caso feliz, segundo pedido, A2 com aceito e feito, A3 em pedido encerrado', async () => {
    writeListener(W.stateDir, { session: SESS.b })
    const r = await W.post('/api/requests', { type: 'rerun-node', wf: 'wf_estado-1', node: 'A', dependents: true })
    assert.equal(r.status, 202)
    const q = r.json.request
    assert.equal(q.state, 'pendente')
    assert.equal(q.runId, RID)
    assert.equal(q.runKey, RID)
    assert.equal(q.runDir, runDir)
    assert.ok(path.isAbsolute(q.runDir))
    assert.equal(q.ownerSession, SESS.a)
    assert.equal(q.project, SLUG)
    assert.equal(q.route, 'project')
    assert.deepEqual(q.dependentsList, ['B', 'C', 'D'])
    const onDisk = JSON.parse(fs.readFileSync(path.join(requestsDir(W.stateDir), `${q.id}.json`), 'utf8'))
    assert.equal(onDisk.state, 'pendente')
    assert.equal((fs.statSync(path.join(requestsDir(W.stateDir), `${q.id}.json`)).mode & 0o777).toString(8), '600')

    // um pedido aberto por key; o copiar continua valendo
    const again = await W.post('/api/requests', { type: 'resume', wf: 'wf_estado-1' })
    assert.equal(again.status, 409)
    assert.equal(again.json.error, T.open)
    const m = await model(W, 'wf_estado-1')
    assert.equal(m.actions.open.id, q.id)
    assert.equal(m.actions.rerun.ok, false)
    assert.equal(m.actions.rerun.why, T.open)
    assert.equal(m.actions.copy.rerun.ok, true)
    assert.equal(m.actions.copy.resume.ok, true)
    assert.equal(m.actions.copy.stop.ok, true)
    assert.equal(m.requests[0].id, q.id)
    const list = (await W.get('/api/runs')).json
    assert.equal(list.runs.find((x) => x.key === RID).pending, 'rerun-node')
    assert.equal(list.runs.find((x) => x.key === RID).listening, true)

    // o apagar respeita o pedido aberto (canDelete ligado à fila)
    const del = await W.post('/api/org/delete', { wf: 'wf_estado-1', confirm: RID })
    assert.equal(del.status, 409)
    assert.equal(del.json.error, 'Espere o pedido em andamento terminar.')
    assert.ok(fs.existsSync(runDir))

    // A2: pendente → aceito → feito, gravados pelo módulo da fila (o que o CLI da sessão faz)
    assert.equal((await W.get(`/api/requests/${q.id}`)).json.request.state, 'pendente')
    assert.equal(acceptRequest(W.stateDir, q.id, { session: SESS.b }).ok, true)
    assert.equal((await W.get(`/api/requests/${q.id}`)).json.request.state, 'aceito')
    assert.equal(doneRequest(W.stateDir, q.id, { session: SESS.b, newWf: 'wf_novo-9' }).ok, true)
    const done = (await W.get(`/api/requests/${q.id}`)).json.request
    assert.equal(done.state, 'feito')
    assert.equal(done.newWf, 'wf_novo-9')

    // A2: id inválido e desconhecido
    assert.equal((await W.get('/api/requests/req-x')).status, 400)
    assert.equal((await W.get('/api/requests/req-x')).json.error, 'id de pedido inválido')
    assert.equal((await W.get('/api/requests/req-20260101T000000-abcdef')).status, 404)

    // A3 em pedido encerrado
    const c = await W.post(`/api/requests/${q.id}/cancel`, {})
    assert.equal(c.status, 409)
    assert.equal(c.json.error, 'o pedido já foi encerrado')
  })

  test('A3: cancelar pendente dá falhou; aceito com < 2 min dá 409 e com ≥ 2 min é descartado', async () => {
    // pedido feito da janela ainda bloqueia: usa outra run limpa
    const rid = '20260101-0002-exemplo-cancelar'
    addRun(W.projectsDir, { wf: 'wf_cancel-1', runId: rid, runDir: mkRunDir(W.graphRuns, rid), kind: 'stopped', session: SESS.a })
    writeListener(W.stateDir, { session: SESS.b })
    const p = (await W.post('/api/requests', { type: 'resume', wf: 'wf_cancel-1' })).json.request
    const bad = await W.post(`/api/requests/${p.id}/cancel`, { motivo: 'x' })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.fields.motivo, 'campo desconhecido')
    assert.equal((await W.post('/api/requests/req-x/cancel', {})).status, 400)
    assert.equal((await W.post('/api/requests/req-20260101T000000-abcdef/cancel', {})).status, 404)
    const c = await W.post(`/api/requests/${p.id}/cancel`, {})
    assert.equal(c.status, 200)
    assert.equal(c.json.request.state, 'falhou')
    assert.equal(c.json.request.reason, 'cancelado no painel')
    // o accept de uma sessão perde a corrida: o painel já tomou o claim
    assert.equal(acceptRequest(W.stateDir, p.id, { session: SESS.b }).code, 3)

    writeListener(W.stateDir, { session: SESS.b })
    const p2 = (await W.post('/api/requests', { type: 'resume', wf: 'wf_cancel-1' })).json.request
    const t0 = Date.now()
    assert.equal(acceptRequest(W.stateDir, p2.id, { session: SESS.b, now: t0 }).ok, true)
    W.clock.t = t0 + 60000
    const early = await W.post(`/api/requests/${p2.id}/cancel`, {})
    assert.equal(early.status, 409)
    assert.equal(early.json.error, 'a sessão acabou de aceitar; dá para descartar depois de 2 min')
    W.clock.t = t0 + 120000
    const late = await W.post(`/api/requests/${p2.id}/cancel`, {})
    assert.equal(late.status, 200)
    assert.equal(late.json.request.state, 'falhou')
    assert.equal(late.json.request.reason, 'descartado no painel: a sessão não confirmou')
    W.clock.t = null
  })

  test('pendente vencido (10 min) vira falhou na leitura', async () => {
    const rid = '20260101-0003-exemplo-vencido'
    addRun(W.projectsDir, { wf: 'wf_vence-1', runId: rid, runDir: mkRunDir(W.graphRuns, rid), kind: 'stopped', session: SESS.a })
    writeListener(W.stateDir, { session: SESS.b })
    const p = (await W.post('/api/requests', { type: 'resume', wf: 'wf_vence-1' })).json.request
    W.clock.t = Date.now() + 601000
    const r = (await W.get(`/api/requests/${p.id}`)).json.request
    W.clock.t = null
    assert.equal(r.state, 'falhou')
    assert.equal(r.reason, 'nenhuma sessão aceitou em 10 min')
  })
})

// ── 6. Regra das ações (C12), pura: cada linha, com o texto exato ──

describe('runActions e nodeRerun (C12)', () => {
  const base = { wf: 'wf_x', current: 'wf_x', status: 'parada?', planOnly: false, stopReason: 'sem-atividade', hasRunDir: true, open: null, presence: 'nunca', listenProject: true }
  const A = (o) => runActions({ ...base, ...o })

  test('execução superada: toda ação e todo copiar com o mesmo why', () => {
    const a = A({ wf: 'wf_velho', current: 'wf_novo' })
    const p = { ok: false, why: T.superseded('wf_novo') }
    assert.deepEqual(a, { resume: p, stop: p, rerun: p, copy: { resume: p, stop: p, rerun: p } })
    assert.deepEqual(nodeRerun({ id: 'A', state: 'pronto', round: 1 }, { superseded: true, current: 'wf_novo', status: 'parada?' }), p)
  })

  test('resume, stop e rerun por estado × ouvinte × pedido aberto', () => {
    const open = { state: 'pendente' }
    const rows = [
      // [ctx, resume, stop, rerun, copy.resume, copy.stop, copy.rerun]
      [{ status: 'rodando', stopReason: null, presence: 'ouvindo' }, T.resumeRunning, 'owner', T.rerunRunning, T.resumeRunning, true, T.rerunRunning],
      [{ status: 'rodando', stopReason: null, presence: 'nunca' }, T.resumeRunning, T.stopNoOwner, T.rerunRunning, T.resumeRunning, true, T.rerunRunning],
      [{ status: 'terminado', stopReason: null }, T.resumeDone, T.stopDone, 'project', T.resumeDone, T.stopDone, true],
      [{ status: 'terminado', stopReason: null, listenProject: false }, T.resumeDone, T.stopDone, T.noProjectRerun, T.resumeDone, T.stopDone, true],
      [{ status: 'terminado', stopReason: null, planOnly: true }, T.planOnly, T.stopDone, T.planOnly, T.planOnly, T.stopDone, T.planOnly],
      [{}, 'project', T.stopNoOwner, 'project', true, true, true],
      [{ listenProject: false }, T.noProjectResume, T.stopNoOwner, T.noProjectRerun, true, true, true],
      [{ hasRunDir: false }, T.noRunDir, T.stopNoOwner, T.noRunDir, T.noRunDir, true, T.noRunDir],
      [{ open }, T.open, T.open, T.open, true, true, true],
      [{ open: { state: 'feito' } }, T.openDone, T.openDone, T.openDone, true, true, true],
      [{ stopReason: 'sessao-encerrada', presence: 'encerrada' }, 'project', T.stopGone, 'project', true, T.stopGone, true],
      // 5b: dona ouvindo numa parada que não é interrompida → só a dona atende, mesmo sem outro ouvinte
      [{ presence: 'ouvindo' }, 'owner', 'owner', 'owner', true, true, true],
      [{ presence: 'ouvindo', listenProject: false }, 'owner', 'owner', 'owner', true, true, true],
      [{ presence: 'rearmando' }, T.rearm, T.stopNoOwner, T.rearm, true, true, true],
      [{ presence: 'ouvindo', stopReason: 'interrompida' }, 'project', 'owner', 'project', true, true, true],
      [{ presence: 'ouvindo', open }, T.open, T.open, T.open, true, true, true],
    ]
    const want = (v) => (v === true ? { ok: true, why: null } : v === 'project' || v === 'owner' ? { ok: true, why: null, route: v } : { ok: false, why: v })
    for (const [ctx, resume, stop, rerun, cr, cs, crr] of rows) {
      const a = A(ctx)
      const label = JSON.stringify(ctx)
      assert.deepEqual(a.resume, want(resume), `resume ${label}`)
      assert.deepEqual(a.stop, want(stop), `stop ${label}`)
      assert.deepEqual(a.rerun, want(rerun), `rerun ${label}`)
      assert.deepEqual(a.copy.resume, want(cr), `copy.resume ${label}`)
      assert.deepEqual(a.copy.stop, want(cs), `copy.stop ${label}`)
      assert.deepEqual(a.copy.rerun, want(crr), `copy.rerun ${label}`)
    }
  })

  test('nó: pela variante do estado, com o nó rodando liberado numa run parada', () => {
    const at = (state, status = 'parada?', round = 1) => nodeRerun({ id: 'X', state, round }, { superseded: false, current: 'wf_x', status })
    for (const s of ['pronto', 'pronto-sem-verif', 'pronto-sem-verif?', 'sem-reverificacao', 'falhou', 'falhou-check', 'bloqueado', 'erro']) assert.deepEqual(at(s), { ok: true, why: null }, s)
    assert.deepEqual(at('aguardando'), { ok: false, why: 'Esse nó ainda não rodou.' })
    assert.deepEqual(at('pulado'), { ok: false, why: 'Esse nó foi pulado. Refaça o nó de que ele depende, com os dependentes.' })
    for (const s of ['trabalhando', 'verificando', 'reparando']) {
      assert.deepEqual(at(s, 'rodando'), { ok: false, why: 'Esse nó está rodando.' }, s)
      assert.deepEqual(at(s, 'parada?'), { ok: true, why: null }, `${s} numa run parada`)
    }
    assert.deepEqual(at('pronto', 'terminado', 2), { ok: false, why: 'Nó da crítica: use Retomar, que a crítica decide de novo.' })
  })
})

describe('Modelo: actions, nodes[i].rerun e dependents (fixture)', () => {
  let W
  before(async () => {
    W = await world()
    addRun(W.projectsDir, { wf: 'wf_modelo-1', runId: RID, runDir: mkRunDir(W.graphRuns, RID), kind: 'stopped', session: SESS.a })
    addRun(W.projectsDir, { wf: 'wf_semdir-1', runId: '20260101-0004-exemplo-semdir', kind: 'stopped', session: SESS.a })
    addRun(W.projectsDir, { wf: 'wf_feita-1', runId: '20260101-0005-exemplo-feita', runDir: mkRunDir(W.graphRuns, '20260101-0005-exemplo-feita'), kind: 'done', session: SESS.a })
    addRun(W.projectsDir, { wf: 'wf_plano-1', runId: '20260101-0006-exemplo-plano', runDir: mkRunDir(W.graphRuns, '20260101-0006-exemplo-plano'), kind: 'plan', session: SESS.a })
    writeListener(W.stateDir, { session: SESS.b })
  })
  after(() => W.close())

  test('run parada: nó pronto e nó interrompido liberados, aguardando não; dependentes pelo fecho', async () => {
    const m = await model(W, 'wf_modelo-1')
    assert.equal(m.runId, RID)
    assert.equal(m.runKey, RID)
    assert.equal(m.current, 'wf_modelo-1')
    assert.equal(m.supersededBy, null)
    assert.ok(m.runDir)
    assert.deepEqual(m.requests, [])
    assert.deepEqual(m.actions.listening, { project: true, owner: false, ownerPresence: 'nunca', sessions: 1 })
    assert.deepEqual(m.actions.resume, { ok: true, why: null, route: 'project' })
    const by = Object.fromEntries(m.nodes.map((n) => [n.id, n]))
    assert.deepEqual([by.A.state, by.B.state, by.C.state], ['pronto', 'trabalhando', 'aguardando'])
    assert.equal(by.A.rerun.ok, true)
    assert.equal(by.B.rerun.ok, true, 'nó running numa run parada foi interrompido: dá para refazer')
    assert.equal(by.C.rerun.why, 'Esse nó ainda não rodou.')
    assert.deepEqual(by.A.dependents, ['B', 'C', 'D'])
    assert.deepEqual(by.B.dependents, ['C'])
    assert.deepEqual(by.D.dependents, [])
    const ok = await W.post('/api/requests', { type: 'rerun-node', wf: 'wf_modelo-1', node: 'C' })
    assert.equal(ok.status, 409)
    assert.equal(ok.json.error, 'Esse nó ainda não rodou.')
  })

  test('sem pasta, terminada e planOnly', async () => {
    const s = await model(W, 'wf_semdir-1')
    assert.equal(s.runDir, null)
    assert.equal(s.actions.resume.why, T.noRunDir)
    assert.equal(s.actions.copy.resume.why, T.noRunDir)
    const f = await model(W, 'wf_feita-1')
    assert.equal(f.status, 'terminado')
    assert.equal(f.actions.resume.why, T.resumeDone)
    assert.equal(f.actions.stop.why, T.stopDone)
    assert.deepEqual(f.actions.rerun, { ok: true, why: null, route: 'project' })
    const p = await model(W, 'wf_plano-1')
    assert.equal(p.planOnly, true)
    assert.equal(p.actions.resume.why, T.planOnly)
    assert.equal(p.actions.rerun.why, T.planOnly)
    assert.equal(p.actions.copy.rerun.why, T.planOnly)
  })
})

// ── 6b. Execução superada ──

describe('execução superada (C12 condição 0)', () => {
  let W
  before(async () => {
    W = await world()
    const runDir = mkRunDir(W.graphRuns, RID, { 'plan.md': '# plano\n', 'A.md': 'a\n' })
    const velhoPlan = { goal: 'velho', complexity: 'simple', doneWhen: [], assumptions: [], questions: [], nodes: [{ id: 'A', title: 'A', kind: 'research', brief: 'a', deps: [], risk: 'low', acceptance: [] }, { id: 'Z', title: 'Z', kind: 'implement', brief: 'z', deps: ['A'], risk: 'low', acceptance: [] }] }
    addRun(W.projectsDir, { wf: 'wf_velho-1', runId: RID, runDir, kind: 'stopped', session: SESS.a, plan: velhoPlan })
    addRun(W.projectsDir, { wf: 'wf_novo-1', runId: RID, runDir, kind: 'running', session: SESS.b })
    writeListener(W.stateDir, { session: SESS.a })
    writeListener(W.stateDir, { session: SESS.b })
  })
  after(() => W.close())

  test('o velho mostra tudo desabilitado; os POSTs dão 409 antes do 404 de nó; a leitura continua', async () => {
    const why = T.superseded('wf_novo-1')
    const v = await model(W, 'wf_velho-1')
    assert.equal(v.current, 'wf_novo-1')
    assert.equal(v.supersededBy, 'wf_novo-1')
    for (const k of ['resume', 'stop', 'rerun']) assert.deepEqual(v.actions[k], { ok: false, why })
    for (const k of ['resume', 'stop', 'rerun']) assert.deepEqual(v.actions.copy[k], { ok: false, why })
    assert.ok(v.nodes.length && v.nodes.every((n) => n.rerun.ok === false && n.rerun.why === why))
    const before0 = queueFiles(W)
    for (const body of [{ type: 'resume' }, { type: 'stop' }, { type: 'rerun-node', node: 'A' }, { type: 'rerun-node', node: 'Z' }]) {
      const r = await W.post('/api/requests', { ...body, wf: 'wf_velho-1' })
      assert.equal(r.status, 409, JSON.stringify(body))
      assert.equal(r.json.error, why)
    }
    assert.deepEqual(queueFiles(W), before0, 'a fila fica byte a byte igual')
    const n = await model(W, 'wf_novo-1')
    assert.equal(n.supersededBy, null)
    assert.equal(n.actions.resume.why, T.resumeRunning)
    const la = (await W.get('/api/runs/wf_velho-1/artifacts')).json
    const lb = (await W.get('/api/runs/wf_novo-1/artifacts')).json
    assert.deepEqual(la, lb)
    assert.deepEqual(
      la.files.map((f) => f.name),
      ['plan.md', 'A.md'],
    )
  })
})

// ── 6c. Janela do `feito` ──

describe('janela do feito: a retomada foi feita e o wf novo ainda não apareceu', () => {
  let W
  let runDir
  before(async () => {
    W = await world()
    runDir = mkRunDir(W.graphRuns, RID)
    addRun(W.projectsDir, { wf: 'wf_velho-2', runId: RID, runDir, kind: 'stopped', session: SESS.a })
    writeListener(W.stateDir, { session: SESS.b })
  })
  after(() => W.close())

  test('feito bloqueia por 10 min; o wf novo tira a execução velha de cena', async () => {
    const t0 = Date.now()
    const q = (await W.post('/api/requests', { type: 'resume', wf: 'wf_velho-2' })).json.request
    assert.equal(acceptRequest(W.stateDir, q.id, { session: SESS.b, now: t0 }).ok, true)
    assert.equal(doneRequest(W.stateDir, q.id, { session: SESS.b, now: t0 }).ok, true)
    const m = await model(W, 'wf_velho-2')
    assert.deepEqual(m.actions.resume, { ok: false, why: T.openDone })
    const again = await W.post('/api/requests', { type: 'resume', wf: 'wf_velho-2' })
    assert.equal(again.status, 409)
    assert.equal(again.json.error, T.openDone)

    // 11 min depois, sem wf novo: os botões voltam (o sinal de vida é regravado no relógio injetado)
    W.clock.t = t0 + 11 * 60000
    writeListener(W.stateDir, { session: SESS.b, beatAt: W.clock.t })
    assert.deepEqual((await model(W, 'wf_velho-2')).actions.resume, { ok: true, why: null, route: 'project' })
    W.clock.t = null
    writeListener(W.stateDir, { session: SESS.b })

    // com o wf novo, o velho cai na regra da execução superada
    addRun(W.projectsDir, { wf: 'wf_novo-2', runId: RID, runDir, kind: 'running', session: SESS.b })
    const v = await model(W, 'wf_velho-2')
    assert.equal(v.actions.resume.why, T.superseded('wf_novo-2'))
  })
})

// ── Condição 5b (P1): dona talvez viva ──

describe('condição 5b: parada com a dona ouvindo, rearmando ou encerrada', () => {
  let W
  before(async () => {
    W = await world()
  })
  after(() => W.close())

  const fresh = (W, rid, wf, kind = 'stopped') => addRun(W.projectsDir, { wf, runId: rid, runDir: mkRunDir(W.graphRuns, rid), kind, session: SESS.a })
  const clearListeners = (W) => fs.rmSync(path.join(W.stateDir, 'listeners'), { recursive: true, force: true })

  test('dona ouvindo e outra sessão do projeto ouvindo: route owner, gravado no pedido', async () => {
    clearListeners(W)
    fresh(W, '20260101-0010-exemplo-dona', 'wf_dona-1')
    writeListener(W.stateDir, { session: SESS.a })
    writeListener(W.stateDir, { session: SESS.b })
    const m = await model(W, 'wf_dona-1')
    assert.equal(m.stop.reason, 'sem-atividade')
    assert.deepEqual(m.actions.resume, { ok: true, why: null, route: 'owner' })
    assert.deepEqual(m.actions.rerun, { ok: true, why: null, route: 'owner' })
    const r = await W.post('/api/requests', { type: 'rerun-node', wf: 'wf_dona-1', node: 'A' })
    assert.equal(r.status, 202)
    assert.equal(r.json.request.route, 'owner')
    assert.deepEqual(r.json.request.dependentsList, [])
  })

  test('dona saiu há 30 s (rearmando): resume desabilitado; há 121 s: sessão encerrada e route project', async () => {
    clearListeners(W)
    fresh(W, '20260101-0011-exemplo-rearme', 'wf_rearme-1')
    const t = Date.now()
    writeListener(W.stateDir, { session: SESS.a, beatAt: t - 30000, exitedAt: t - 30000 })
    writeListener(W.stateDir, { session: SESS.b })
    const m = await model(W, 'wf_rearme-1')
    assert.equal(m.actions.listening.ownerPresence, 'rearmando')
    assert.deepEqual(m.actions.resume, { ok: false, why: T.rearm })
    writeListener(W.stateDir, { session: SESS.a, beatAt: t - 121000, exitedAt: t - 121000 })
    const g = await model(W, 'wf_rearme-1')
    assert.equal(g.stop.reason, 'sessao-encerrada')
    assert.equal(g.actions.stop.why, T.stopGone)
    assert.deepEqual(g.actions.resume, { ok: true, why: null, route: 'project' })
    const r = await W.post('/api/requests', { type: 'resume', wf: 'wf_rearme-1' })
    assert.equal(r.status, 202)
    assert.equal(r.json.request.route, 'project')
  })

  test('interrompida com a dona ouvindo: route project', async () => {
    clearListeners(W)
    fresh(W, '20260101-0012-exemplo-esc', 'wf_esc-1', 'interrupted')
    writeListener(W.stateDir, { session: SESS.a })
    writeListener(W.stateDir, { session: SESS.b })
    const m = await model(W, 'wf_esc-1')
    assert.equal(m.stop.reason, 'interrompida')
    assert.deepEqual(m.actions.resume, { ok: true, why: null, route: 'project' })
    // stop vai sempre para a dona
    const s = await W.post('/api/requests', { type: 'stop', wf: 'wf_esc-1' })
    assert.equal(s.status, 202)
    assert.equal(s.json.request.route, 'owner')
    assert.equal(s.json.request.ownerSession, SESS.a)
  })
})

// ── 7. Artefatos e path traversal ──

describe('artefatos da run (A5/A6): lista fechada e contenção', () => {
  let W
  let runDir
  before(async () => {
    W = await world()
    runDir = mkRunDir(W.graphRuns, RID, {
      'REPORT.md': '# relatório\n',
      'plan.md': '# plano\n',
      'PEDIDO.md': '# pedido\n',
      'A.md': 'saída A\n',
      'A.a.md': 'rascunho A\n',
      'x.png': 'png',
      '.oculto.md': 'oculto',
      'plan.md.bak': 'bak',
      'grande.md': 'g'.repeat(300 * 1024),
    })
    fs.mkdirSync(path.join(runDir, 'polish-1'))
    fs.writeFileSync(path.join(runDir, 'polish-1', 'A.md'), 'sub')
    fs.symlinkSync('/etc/hosts', path.join(runDir, 'evil.md'))
    fs.mkdirSync(path.join(runDir, 'dir.md'))
    addRun(W.projectsDir, { wf: 'wf_art-1', runId: RID, runDir, kind: 'done' })

    // run dir que é symlink para fora
    const outside = path.join(W.root, 'fora', '20260101-0020-exemplo-link')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'plan.md'), 'fora')
    fs.symlinkSync(outside, path.join(W.graphRuns, '20260101-0020-exemplo-link'))
    addRun(W.projectsDir, { wf: 'wf_link-1', runId: '20260101-0020-exemplo-link', runDir: path.join(W.graphRuns, '20260101-0020-exemplo-link'), kind: 'done' })

    // `Run dir` da transcrição apontando para fora
    const inProjects = mkRunDir(W.projectsDir, '20260101-0023-exemplo-proj')
    const noGraphRuns = mkRunDir(path.join(W.root, 'x'), '20260101-0024-exemplo-solto')
    const bad = [
      ['wf_etc-1', '20260101-0021-exemplo-etc', '/etc'],
      ['wf_home-1', '20260101-0022-exemplo-home', W.home],
      ['wf_proj-1', '20260101-0023-exemplo-proj', inProjects],
      ['wf_solto-1', '20260101-0024-exemplo-solto', noGraphRuns],
      ['wf_base-1', '20260101-0025-exemplo-base', runDir],
      ['wf_rel-1', '20260101-0026-exemplo-rel', '.graph-runs/20260101-0026-exemplo-rel'],
      ['wf_dots-1', RID.replace('acoes', 'dots'), `${W.graphRuns}/../.graph-runs/${RID.replace('acoes', 'dots')}`],
    ]
    for (const [wf, rid, dir] of bad) addRun(W.projectsDir, { wf, runId: rid, runDir: dir, kind: 'done', slug: `-exemplo-${wf.slice(3, -2)}` })
  })
  after(() => W.close())

  test('a listagem traz só os .md diretos, regulares e sem link, na ordem e com o kind', async () => {
    const r = await W.get('/api/runs/wf_art-1/artifacts')
    assert.equal(r.status, 200)
    assert.equal(r.json.runId, RID)
    assert.deepEqual(
      r.json.files.map((f) => [f.name, f.kind, f.node, f.variant]),
      [
        ['REPORT.md', 'report', undefined, undefined],
        ['plan.md', 'plan', undefined, undefined],
        ['PEDIDO.md', 'pedido', undefined, undefined],
        ['A.md', 'node', 'A', undefined],
        ['A.a.md', 'node', 'A', 'a'],
        ['grande.md', 'outro', undefined, undefined],
      ],
    )
    const t = await W.get('/api/runs/wf_art-1/artifacts/A.a.md')
    assert.equal(t.status, 200)
    assert.deepEqual([t.json.name, t.json.kind, t.json.text, t.json.truncated], ['A.a.md', 'node', 'rascunho A\n', false])
  })

  test('nomes fora da regra dão 400; link, pasta e subpasta dão 404; nada de fora aparece', async () => {
    const hosts = fs.readFileSync('/etc/hosts', 'utf8')
    for (const name of ['..%2F..%2Fetc%2Fpasswd', '%2e%2e%2fconfig', 'REPORT.md%00', '.oculto.md', 'plan.MD', 'plan.md.bak', 'x.png', '%2Eoculto.md']) {
      const r = await W.get(`/api/runs/wf_art-1/artifacts/${name}`)
      assert.equal(r.status, 400, name)
      assert.equal(r.json.error, 'nome de artefato inválido', name)
    }
    for (const name of ['evil.md', 'dir.md', 'nao-existe.md']) {
      const r = await W.get(`/api/runs/wf_art-1/artifacts/${name}`)
      assert.equal(r.status, 404, name)
      assert.ok(!r.body.includes(hosts.slice(0, 40)) || !hosts.trim(), name)
    }
    for (const p of ['/api/runs/wf_art-1/artifacts/polish-1/A.md', '/api/runs/wf_art-1/artifacts/%2e%2e/%2e%2e/config', '/api/runs/wf_art-1/artifacts//etc/passwd', '/api/runs/wf_art-1/artifacts/../../../etc/passwd']) {
      const r = await W.get(p)
      assert.notEqual(r.status, 200, p)
      assert.ok(!/root:|localhost/.test(r.body), p)
    }
    assert.equal((await W.get('/api/runs/wf_x!/artifacts')).status, 400)
    assert.equal((await W.get('/api/runs/wf_nao-existe/artifacts')).status, 404)
  })

  test('arquivo de 300 KB sai truncado em 256 KB', async () => {
    const r = await W.get('/api/runs/wf_art-1/artifacts/grande.md')
    assert.equal(r.status, 200)
    assert.equal(r.json.truncated, true)
    assert.equal(r.json.size, 300 * 1024)
    assert.equal(Buffer.byteLength(r.json.text), 262144)
  })

  test('run dir symlink ou fora da contenção: 404 sem pasta, e o Modelo leva runDir null', async () => {
    for (const wf of ['wf_link-1', 'wf_etc-1', 'wf_home-1', 'wf_proj-1', 'wf_solto-1', 'wf_base-1', 'wf_rel-1', 'wf_dots-1']) {
      const r = await W.get(`/api/runs/${wf}/artifacts`)
      assert.equal(r.status, 404, wf)
      assert.equal(r.json.error, 'essa run não tem pasta de artefatos', wf)
      assert.equal((await W.get(`/api/runs/${wf}/artifacts/plan.md`)).status, 404, wf)
      assert.equal((await model(W, wf)).runDir, null, wf)
    }
  })
})

// ── 8. A4 ──

describe('GET /api/listeners (A4)', () => {
  let W
  before(async () => {
    W = await world()
  })
  after(() => W.close())

  test('sinal fresco lista a sessão (8 chars); velho, encerrado ou de pid morto não', async () => {
    const t = Date.now()
    writeListener(W.stateDir, { session: SESS.a, wf: 'wf_x-1' })
    writeListener(W.stateDir, { session: SESS.b, beatAt: t - 31000 })
    writeListener(W.stateDir, { session: SESS.c, exitedAt: t })
    const r = await W.get('/api/listeners')
    assert.equal(r.status, 200)
    assert.equal(r.json.staleMs, 30000)
    assert.equal(r.json.sessions.length, 1)
    assert.deepEqual({ ...r.json.sessions[0], beatAt: typeof r.json.sessions[0].beatAt }, { session: SESS.a.slice(0, 8), project: SLUG, wf: 'wf_x-1', beatAt: 'number', until: null })
    assert.equal((await request(W.port, 'POST', '/api/listeners', { Origin: W.origin, 'Content-Type': 'application/json' }, '{}')).status, 405)
  })
})

// ── 9. SSE ──

describe('SSE: pedido e sinal de vida mudam o event: run', () => {
  let W
  before(async () => {
    W = await world()
    addRun(W.projectsDir, { wf: 'wf_sse-1', runId: RID, runDir: mkRunDir(W.graphRuns, RID), kind: 'stopped', session: SESS.a })
  })
  after(() => W.close())

  function openSse(port) {
    const events = []
    let res
    const ready = new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/events', agent: false }, (r) => {
        res = r
        r.setEncoding('utf8')
        let buf = ''
        r.on('data', (d) => {
          buf += d
          let i
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const ev = /^event: (\w+)$/m.exec(chunk)
            const data = /^data: (.*)$/m.exec(chunk)
            if (ev) events.push({ event: ev[1], data: data ? JSON.parse(data[1]) : null })
            if (ev && ev[1] === 'runs') resolve()
          }
        })
      })
      req.on('error', () => {})
    })
    return { events, ready, close: () => res && res.destroy() }
  }
  const waitFor = async (fn, ms = 3000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (fn()) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  }

  test('gravar o sinal de vida e criar o pedido fazem sair event: run { wf }', async () => {
    const s = openSse(W.port)
    await s.ready
    const runEvents = () => s.events.filter((e) => e.event === 'run' && e.data.wf === 'wf_sse-1').length
    writeListener(W.stateDir, { session: SESS.b })
    assert.ok(await waitFor(() => runEvents() >= 1), 'o sinal de vida muda o sig da run')
    const n = runEvents()
    const r = await W.post('/api/requests', { type: 'resume', wf: 'wf_sse-1' })
    assert.equal(r.status, 202)
    assert.ok(await waitFor(() => runEvents() > n), 'o pedido muda o sig da run')
    assert.ok(await waitFor(() => s.events.some((e) => e.event === 'runs' && e.data.runs.some((x) => x.pending === 'resume'))), 'a lista leva o pending')
    s.close()
  })
})

// ── Limpeza da fila ──

describe('limpeza: pedidos finais velhos e sinais de vida de mais de 24 h', () => {
  let W
  before(async () => {
    W = await world()
    addRun(W.projectsDir, { wf: 'wf_limpa-1', runId: RID, runDir: mkRunDir(W.graphRuns, RID), kind: 'stopped', session: SESS.a })
  })
  after(() => W.close())

  test('um pedido final com mais de 7 dias some com os arquivos dele; o pendente fica', async () => {
    writeListener(W.stateDir, { session: SESS.b })
    const q = (await W.post('/api/requests', { type: 'resume', wf: 'wf_limpa-1' })).json.request
    const t0 = Date.now()
    assert.equal(acceptRequest(W.stateDir, q.id, { session: SESS.b, now: t0 }).ok, true)
    assert.equal(doneRequest(W.stateDir, q.id, { session: SESS.b, now: t0 }).ok, true)
    writeListener(W.stateDir, { session: SESS.c, beatAt: t0 - 25 * 3600 * 1000 })
    const dir = requestsDir(W.stateDir)
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith(q.id)))
    // o relógio anda 8 dias: a limpeza roda no 1º scan (no máximo 1 vez por minuto)
    W.clock.t = t0 + 8 * 24 * 3600 * 1000
    await W.get('/api/runs')
    W.clock.t = null
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith(q.id)).length, 0)
    assert.deepEqual(listRequests(W.stateDir), [])
    const ls = fs.readdirSync(path.join(W.stateDir, 'listeners'))
    assert.ok(!ls.some((f) => f.startsWith(SESS.c)), 'o sinal de vida de mais de 24 h sumiu')
  })
})

// sanidade do helper: o mundo nunca cai no ~/.claude real
test('o fixture monta tudo em tmp', async () => {
  const W = await world()
  try {
    assert.ok(W.stateDir.startsWith(fs.realpathSync(os.tmpdir())))
    assert.equal(W.panel.server.stateDir, W.stateDir)
    touch(W.graphRuns, 1)
  } finally {
    await W.close()
  }
})
