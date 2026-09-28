// Testes de bin/requests.mjs: fila de pedidos (C2), sinal de vida (C3) e o CLI (C5). Tudo em
// dirs temporários de os.tmpdir() — nenhum teste toca ~/.claude.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REQ_RE,
  SESSION_RE,
  WF_RE,
  NODE_RE,
  REQUEST_TYPES,
  createRequest,
  readRequest,
  listRequests,
  acceptRequest,
  doneRequest,
  failRequest,
  isPendingExpired,
  isAcceptedExpired,
  isOpenForRunKey,
  discardAccepted,
  isEligible,
  markSeen,
  requestEventLine,
  writeHeartbeat,
  readListeners,
  projectListening,
  ownerPresence,
  ownerPathInfo,
  writeJsonAtomic,
  createExclusive,
} from '../bin/requests.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'bin', 'requests.mjs')

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'graph-eng-requests-'))

const SESSION = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
const OTHER_SESSION = 'ffffffff-1111-4222-8333-444455556666'
const PROJECT = '-Volumes-Test-project'

function baseInput(overrides = {}) {
  return {
    type: 'rerun-node',
    wf: 'wf_abc123',
    node: 'I3',
    dependents: false,
    dependentsList: [],
    runKey: '20260928-1146-acoes-no-painel',
    runId: '20260928-1146-acoes-no-painel',
    project: PROJECT,
    ownerSession: SESSION,
    runDir: '/tmp/algum/run',
    route: 'project',
    ...overrides,
  }
}

describe('regexes e constantes (C2)', () => {
  test('REQUEST_TYPES tem só os três tipos', () => {
    assert.deepEqual(REQUEST_TYPES, ['resume', 'stop', 'rerun-node'])
  })
  test('WF_RE e NODE_RE casam com os literais de hoje', () => {
    assert.match('wf_ccaa155a-747', WF_RE)
    assert.doesNotMatch('ccaa155a-747', WF_RE)
    assert.match('I3', NODE_RE)
    assert.match('design-review', NODE_RE)
    assert.doesNotMatch('nó com espaço', NODE_RE)
  })
  test('SESSION_RE casa uuid minúsculo', () => {
    assert.match(SESSION, SESSION_RE)
    assert.doesNotMatch(SESSION.toUpperCase(), SESSION_RE)
  })
})

describe('createRequest e escrita atômica (C1, C2)', () => {
  test('cria um pedido pendente válido, com id casando REQ_RE', () => {
    const stateDir = tmpDir()
    const req = createRequest(stateDir, baseInput(), Date.parse('2026-09-28T15:12:03.412Z'))
    assert.match(req.id, REQ_RE)
    assert.equal(req.state, 'pendente')
    assert.equal(req.node, 'I3')
    assert.equal(req.history.length, 1)
    assert.equal(req.history[0].state, 'pendente')
    const onDisk = readRequest(stateDir, req.id)
    assert.deepEqual(onDisk, req)
  })

  test('pedido inválido é recusado: tipo, wf e node', () => {
    const stateDir = tmpDir()
    assert.throws(() => createRequest(stateDir, baseInput({ type: 'apagar-tudo' })), /tipo de pedido inválido/)
    assert.throws(() => createRequest(stateDir, baseInput({ wf: 'não-é-wf' })), /id de run inválido/)
    assert.throws(() => createRequest(stateDir, baseInput({ node: 'nó/../etc' })), /id de nó inválido/)
  })

  test('escrita atômica: writeJsonAtomic nunca deixa arquivo pela metade e usa tmp+rename', () => {
    const stateDir = tmpDir()
    const file = path.join(stateDir, 'x', 'y.json')
    writeJsonAtomic(file, { a: 1 })
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 })
    // nenhum arquivo .tmp-* sobra depois de uma escrita bem-sucedida
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-'))
    assert.deepEqual(leftovers, [])
    const st = fs.statSync(file)
    assert.equal(st.mode & 0o777, 0o600)
  })

  test('createExclusive: a segunda chamada para o mesmo arquivo falha (EEXIST) sem sobrescrever', () => {
    const stateDir = tmpDir()
    const file = path.join(stateDir, 'requests', 'req-x.claim')
    assert.equal(createExclusive(file, { by: 'a' }), true)
    assert.equal(createExclusive(file, { by: 'b' }), false)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { by: 'a' })
  })

  test('um pedido lido sem `route` é lido como owner (o lado seguro)', () => {
    const stateDir = tmpDir()
    const req = createRequest(stateDir, baseInput({ route: 'owner' }), Date.now())
    // simula arquivo antigo sem `route`
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'requests', `${req.id}.json`), 'utf8'))
    delete raw.route
    fs.writeFileSync(path.join(stateDir, 'requests', `${req.id}.json`), JSON.stringify(raw))
    const [listed] = listRequests(stateDir)
    assert.equal(listed.route, 'owner')
  })
})

describe('máquina de estados pendente → aceito → feito|falhou (C2, C5)', () => {
  test('accept -> done: transições e history', () => {
    const stateDir = tmpDir()
    const req = createRequest(stateDir, baseInput())
    const a = acceptRequest(stateDir, req.id, { session: SESSION })
    assert.equal(a.ok, true)
    assert.equal(a.req.state, 'aceito')
    assert.equal(a.req.acceptedBy, SESSION)
    const d = doneRequest(stateDir, req.id, { session: SESSION, newWf: 'wf_novo999' })
    assert.equal(d.ok, true)
    assert.equal(d.req.state, 'feito')
    assert.equal(d.req.newWf, 'wf_novo999')
    assert.equal(d.req.history.at(-1).state, 'feito')
  })

  test('accept -> fail: grava o motivo', () => {
    const stateDir = tmpDir()
    const req = createRequest(stateDir, baseInput({ type: 'stop', node: null, route: 'owner' }))
    acceptRequest(stateDir, req.id, { session: SESSION })
    const f = failRequest(stateDir, req.id, { session: SESSION, reason: 'permissão negada' })
    assert.equal(f.ok, true)
    assert.equal(f.req.state, 'falhou')
    assert.equal(f.req.reason, 'permissão negada')
  })

  test('accept duas vezes: a segunda sessão perde a corrida (code 3)', () => {
    const stateDir = tmpDir()
    const req = createRequest(stateDir, baseInput())
    const a1 = acceptRequest(stateDir, req.id, { session: SESSION })
    assert.equal(a1.ok, true)
    const a2 = acceptRequest(stateDir, req.id, { session: OTHER_SESSION })
    assert.equal(a2.ok, false)
    assert.equal(a2.code, 3)
  })

  test('stop sempre grava route owner, mesmo pedido com route project (C2/C4)', () => {
    const stateDir = tmpDir()
    const req = createRequest(stateDir, baseInput({ type: 'stop', node: null, route: 'project', ownerSession: SESSION }))
    assert.equal(req.route, 'owner')
    assert.equal(readRequest(stateDir, req.id).route, 'owner')
    // só a ownerSession consegue aceitar: outra sessão do mesmo project sai com 4
    const wrong = acceptRequest(stateDir, req.id, { session: OTHER_SESSION })
    assert.equal(wrong.ok, false)
    assert.equal(wrong.code, 4)
    assert.equal(readRequest(stateDir, req.id).state, 'pendente')
    const right = acceptRequest(stateDir, req.id, { session: SESSION })
    assert.equal(right.ok, true)
  })

  test('route owner: só a ownerSession pode aceitar (code 4 para as outras)', () => {
    const stateDir = tmpDir()
    const req = createRequest(stateDir, baseInput({ type: 'stop', node: null, route: 'owner', ownerSession: SESSION }))
    const wrong = acceptRequest(stateDir, req.id, { session: OTHER_SESSION })
    assert.equal(wrong.ok, false)
    assert.equal(wrong.code, 4)
    // o pedido segue pendente para a dona
    assert.equal(readRequest(stateDir, req.id).state, 'pendente')
    const right = acceptRequest(stateDir, req.id, { session: SESSION })
    assert.equal(right.ok, true)
  })

  test('done sem claim desta sessão sai com 4', () => {
    const stateDir = tmpDir()
    const req = createRequest(stateDir, baseInput())
    acceptRequest(stateDir, req.id, { session: SESSION })
    const d = doneRequest(stateDir, req.id, { session: OTHER_SESSION })
    assert.equal(d.ok, false)
    assert.equal(d.code, 4)
  })

  test('done duas vezes: a segunda sai com 5 (já encerrado)', () => {
    const stateDir = tmpDir()
    const req = createRequest(stateDir, baseInput())
    acceptRequest(stateDir, req.id, { session: SESSION })
    const d1 = doneRequest(stateDir, req.id, { session: SESSION })
    assert.equal(d1.ok, true)
    const d2 = doneRequest(stateDir, req.id, { session: SESSION })
    assert.equal(d2.ok, false)
    assert.equal(d2.code, 5)
  })

  test('done sobre um pedido ainda pendente (sem accept) sai com 4', () => {
    const stateDir = tmpDir()
    const req = createRequest(stateDir, baseInput())
    const d = doneRequest(stateDir, req.id, { session: SESSION })
    assert.equal(d.ok, false)
    assert.equal(d.code, 4)
  })

  test('accept de um id inexistente sai com 2', () => {
    const stateDir = tmpDir()
    const a = acceptRequest(stateDir, 'req-20260928T151203-abcdef', { session: SESSION })
    assert.equal(a.ok, false)
    assert.equal(a.code, 2)
  })

  test('accept de um id fora da regex sai com 2, sem tocar o disco', () => {
    const stateDir = tmpDir()
    const a = acceptRequest(stateDir, '../etc/passwd', { session: SESSION })
    assert.equal(a.ok, false)
    assert.equal(a.code, 2)
    assert.deepEqual(listRequests(stateDir), [])
  })

  test('pedido pendente vencido (> 10 min): accept grava falhou e sai com 3', () => {
    const stateDir = tmpDir()
    const t0 = Date.parse('2026-09-28T15:00:00.000Z')
    const req = createRequest(stateDir, baseInput(), t0)
    const later = t0 + 601000
    const a = acceptRequest(stateDir, req.id, { session: SESSION, now: later })
    assert.equal(a.ok, false)
    assert.equal(a.code, 3)
    const onDisk = readRequest(stateDir, req.id)
    assert.equal(onDisk.state, 'falhou')
    assert.match(onDisk.reason, /10 min/)
  })

  test('isPendingExpired e isAcceptedExpired: prazos de 10 e 30 min', () => {
    const stateDir = tmpDir()
    const t0 = Date.now()
    const req = createRequest(stateDir, baseInput(), t0)
    assert.equal(isPendingExpired(req, t0 + 1000), false)
    assert.equal(isPendingExpired(req, t0 + 601000), true)
    const accepted = acceptRequest(stateDir, req.id, { session: SESSION, now: t0 }).req
    assert.equal(isAcceptedExpired(accepted, t0 + 1000), false)
    assert.equal(isAcceptedExpired(accepted, t0 + 1800001), true)
  })

  test('discardAccepted: só depois de 2 min de carência', () => {
    const stateDir = tmpDir()
    const t0 = Date.now()
    const req = createRequest(stateDir, baseInput(), t0)
    acceptRequest(stateDir, req.id, { session: SESSION, now: t0 })
    const early = discardAccepted(stateDir, req.id, { now: t0 + 1000 })
    assert.equal(early.ok, false)
    const late = discardAccepted(stateDir, req.id, { now: t0 + 121000 })
    assert.equal(late.ok, true)
    assert.equal(readRequest(stateDir, req.id).state, 'falhou')
  })

  test('isOpenForRunKey: aberto por pendente/aceito, e por feito recente com o mesmo wf', () => {
    const stateDir = tmpDir()
    const t0 = Date.now()
    const req = createRequest(stateDir, baseInput({ runKey: 'rk1' }), t0)
    assert.equal(isOpenForRunKey(req, 'rk1', 'wf_abc123', t0), true)
    assert.equal(isOpenForRunKey(req, 'rk-outra', 'wf_abc123', t0), false)
    acceptRequest(stateDir, req.id, { session: SESSION, now: t0 })
    const done = doneRequest(stateDir, req.id, { session: SESSION, now: t0, newWf: 'wf_novo' }).req
    assert.equal(isOpenForRunKey(done, 'rk1', 'wf_abc123', t0 + 1000), true) // ainda no wf antigo
    assert.equal(isOpenForRunKey(done, 'rk1', 'wf_abc123', t0 + 601000), false) // passou 10 min
  })
})

describe('elegibilidade de emissão (C4)', () => {
  test('route project: elegível pra sessão do mesmo project', () => {
    const req = { route: 'project', project: PROJECT, ownerSession: SESSION }
    assert.equal(isEligible(req, { session: OTHER_SESSION, project: PROJECT }), true)
    assert.equal(isEligible(req, { session: OTHER_SESSION, project: 'outro-project' }), false)
  })
  test('route owner: elegível só pra ownerSession', () => {
    const req = { route: 'owner', project: PROJECT, ownerSession: SESSION }
    assert.equal(isEligible(req, { session: SESSION, project: PROJECT }), true)
    assert.equal(isEligible(req, { session: OTHER_SESSION, project: PROJECT }), false)
  })
  test('markSeen: só a primeira chamada por sessão marca', () => {
    const stateDir = tmpDir()
    const req = createRequest(stateDir, baseInput())
    assert.equal(markSeen(stateDir, req.id, SESSION), true)
    assert.equal(markSeen(stateDir, req.id, SESSION), false)
    assert.equal(markSeen(stateDir, req.id, OTHER_SESSION), true)
  })
  test('requestEventLine: formato da linha (C4)', () => {
    const req = createRequest(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-eng-requests-')), baseInput({ node: 'D1', dependents: true }))
    const line = requestEventLine(req, { root: '/plugin', session: SESSION })
    assert.match(line, /^graph-eng pedido req-/)
    assert.match(line, /rerun-node/)
    assert.match(line, /run 20260928-1146-acoes-no-painel \(wf_abc123\)/)
    assert.match(line, /nó D1 \+ dependentes/)
    assert.match(line, /confirmado no painel/)
    assert.match(line, new RegExp(`aceite: node "/plugin/bin/requests.mjs" accept ${req.id} --session ${SESSION}`))
  })
})

describe('sinal de vida (C3)', () => {
  test('readListeners: live exige beat fresco e pid vivo', () => {
    const stateDir = tmpDir()
    const now = Date.now()
    writeHeartbeat(stateDir, { session: SESSION, project: PROJECT, pid: process.pid, startedAt: new Date(now).toISOString(), beatAt: new Date(now).toISOString(), plugin: '0.5.0' })
    const listeners = readListeners(stateDir, now + 1000)
    assert.equal(listeners.length, 1)
    assert.equal(listeners[0].live, true)

    const stale = readListeners(stateDir, now + 40000)
    assert.equal(stale[0].live, false, 'beat velho não conta como vivo')
  })

  test('readListeners: pid morto (ESRCH) não conta como vivo mesmo com beat fresco', () => {
    const stateDir = tmpDir()
    const now = Date.now()
    // um pid extremamente improvável de existir
    writeHeartbeat(stateDir, { session: SESSION, project: PROJECT, pid: 999999, startedAt: new Date(now).toISOString(), beatAt: new Date(now).toISOString() })
    const listeners = readListeners(stateDir, now + 100)
    assert.equal(listeners[0].live, false)
  })

  test('projectListening: true só com um listener live do mesmo project', () => {
    const stateDir = tmpDir()
    const now = Date.now()
    writeHeartbeat(stateDir, { session: SESSION, project: PROJECT, pid: process.pid, startedAt: new Date(now).toISOString(), beatAt: new Date(now).toISOString() })
    const listeners = readListeners(stateDir, now)
    assert.equal(projectListening(listeners, PROJECT), true)
    assert.equal(projectListening(listeners, 'outro'), false)
  })

  test('ownerPresence: ouvindo, rearmando, encerrada e nunca (os quatro valores)', () => {
    const stateDir = tmpDir()
    const now = Date.now()
    assert.equal(ownerPresence([], SESSION, now), 'nunca')

    writeHeartbeat(stateDir, { session: SESSION, project: PROJECT, pid: process.pid, startedAt: new Date(now).toISOString(), beatAt: new Date(now).toISOString() })
    let listeners = readListeners(stateDir, now)
    assert.equal(ownerPresence(listeners, SESSION, now), 'ouvindo')

    // sai por SIGTERM (rearme do Monitor): exitedAt gravado, mas dentro dos 2 min de carência
    writeHeartbeat(stateDir, { session: SESSION, project: PROJECT, pid: process.pid, startedAt: new Date(now).toISOString(), beatAt: new Date(now).toISOString(), exitedAt: new Date(now).toISOString() })
    listeners = readListeners(stateDir, now + 60000)
    assert.equal(ownerPresence(listeners, SESSION, now + 60000), 'rearmando')

    // passou a carência: sessão encerrada
    assert.equal(ownerPresence(listeners, SESSION, now + 121000), 'encerrada')
  })
})

describe('ownerPathInfo (C3): caminho do wf → project/session', () => {
  test('caminho real da sessão do Claude Code', () => {
    const runDir = `/Users/x/.claude/projects/-slug-do-projeto/${SESSION}/subagents/workflows/wf_abc123`
    const info = ownerPathInfo(runDir)
    assert.deepEqual(info, { project: '-slug-do-projeto', session: SESSION, wf: 'wf_abc123' })
  })
  test('--run-dir solto (sem a forma esperada) devolve null', () => {
    assert.equal(ownerPathInfo('/tmp/qualquer-coisa'), null)
    assert.equal(ownerPathInfo(`${SESSION}/subagents/workflows`), null) // faltam níveis antes (< 5 partes)
    assert.equal(ownerPathInfo(`/tmp/algo/${SESSION}/subagentes/workflows/wf_x`), null) // não é "subagents"
  })
  test('sessão fora de SESSION_RE devolve null', () => {
    assert.equal(ownerPathInfo('/a/b/projeto/não-e-uuid/subagents/workflows/wf_x'), null)
  })
})

describe('CLI bin/requests.mjs (C5)', () => {
  function cli(args, { stateDir } = {}) {
    return spawnSync(process.execPath, [CLI, ...args, '--state-dir', stateDir], { encoding: 'utf8' })
  }

  test('accept, done e list pela linha de comando', () => {
    const stateDir = tmpDir()
    const req = createRequest(stateDir, baseInput())
    const a = cli(['accept', req.id, '--session', SESSION], { stateDir })
    assert.equal(a.status, 0, a.stderr)
    assert.equal(JSON.parse(a.stdout).state, 'aceito')

    const d = cli(['done', req.id, '--session', SESSION, '--wf', 'wf_novo1'], { stateDir })
    assert.equal(d.status, 0, d.stderr)
    assert.equal(JSON.parse(d.stdout).newWf, 'wf_novo1')

    const l = cli(['list', '--json'], { stateDir })
    assert.equal(l.status, 0)
    const listed = JSON.parse(l.stdout)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].state, 'feito')
  })

  test('fail pela linha de comando grava o motivo', () => {
    const stateDir = tmpDir()
    const req = createRequest(stateDir, baseInput({ type: 'stop', node: null, route: 'owner' }))
    cli(['accept', req.id, '--session', SESSION], { stateDir })
    const f = cli(['fail', req.id, '--session', SESSION, '--reason', 'agente preso'], { stateDir })
    assert.equal(f.status, 0, f.stderr)
    assert.equal(JSON.parse(f.stdout).reason, 'agente preso')
  })

  test('accept de id inexistente sai com código 2 e mensagem em stderr', () => {
    const stateDir = tmpDir()
    const r = cli(['accept', 'req-20260928T151203-abcdef', '--session', SESSION], { stateDir })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /requests:/)
  })
})
