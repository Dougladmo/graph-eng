// Organização da lista no servidor (spec docs/specs/2026-09-28-acoes-no-painel.md C1, C10 O1-O9, C11;
// casos do D4 §8.2): travas das rotas novas, agrupamento por key, herança na retomada, grupos, arquivar,
// apagar (com contenção), apagar finalizadas, a regra fechada dos módulos .mjs e o isolamento do stateDir.
// Tudo em dirs de os.tmpdir(), com runs montadas aqui; nada lê nem grava em ~/.claude.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { ensurePanel } = await import('../bin/ui-server.mjs')

const RID = '20260101-0000-exemplo-org'
const PLAN = {
  goal: 'Objetivo inventado da run de organização.',
  complexity: 'simple',
  doneWhen: ['critério inventado'],
  assumptions: [],
  nodes: [{ id: 'X', title: 'Nó inventado X', kind: 'implement', brief: 'Fazer X.', deps: [], risk: 'low', acceptance: ['x'] }],
  questions: [],
}

// ── Montagem das runs ──
// kind: 'plan' (planOnly) | 'plan-running' (o plan ainda aberto) | 'running' | 'stopped' | 'done'
let agentSeq = 0
function addWf(projectsDir, { slug = '-exemplo-org', sess = 'sess-org', wf, runId, runDir, kind, ageSec = 5 }) {
  const dir = path.join(projectsDir, slug, sess, 'subagents', 'workflows', wf)
  fs.mkdirSync(dir, { recursive: true })
  const id = () => `org${String(++agentSeq).padStart(4, '0')}aaaaaaaaaaaa`
  const planId = id()
  const header = [runId ? `# Graph run ${runId}` : null, 'Task: tarefa inventada', runDir ? `Run dir (paper trail): ${runDir}` : null, 'Mode: implement', ''].filter((l) => l !== null).join('\n')
  const line = (o) => JSON.stringify(o) + '\n'
  fs.writeFileSync(path.join(dir, `agent-${planId}.jsonl`), line({ type: 'user', cwd: `/exemplo/${slug.replace(/^-/, '')}`, message: { role: 'user', content: header } }))
  const ev = [{ type: 'launched' }, { type: 'started', key: `v2:${planId}`, agentId: planId, label: 'plan', phase: 'Plan' }]
  if (kind !== 'plan-running') ev.push({ type: 'result', key: `v2:${planId}`, agentId: planId, result: PLAN })
  if (kind === 'running' || kind === 'stopped' || kind === 'done') {
    const w = id()
    fs.writeFileSync(
      path.join(dir, `agent-${w}.jsonl`),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo ok' } }] } }),
    )
    ev.push({ type: 'started', key: `v2:${w}`, agentId: w, label: 'work:X', phase: 'Execute' })
    if (kind === 'done') {
      const s = id()
      ev.push({ type: 'result', key: `v2:${w}`, agentId: w, result: { status: 'done', summary: 'x', checks: [] } })
      ev.push({ type: 'started', key: `v2:${s}`, agentId: s, label: 'synth', phase: 'Synthesize' })
      ev.push({ type: 'result', key: `v2:${s}`, agentId: s, result: { status: 'done', summary: 'fim' } })
    }
  }
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), ev.map(line).join(''))
  const t = new Date(Date.now() - ageSec * 1000)
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), t, t)
  return dir
}

function mkRunDir(root, runId = RID, parent = path.join(root, 'repo', '.graph-runs')) {
  const d = path.join(parent, runId)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'plan.md'), '# plano\n')
  return d
}

// Listagem recursiva (caminho, tamanho, mtime) para provar que o projectsDir não foi tocado.
function tree(dir) {
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

function request(port, method, p, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (text += d))
      res.on('end', () => {
        let json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          /* estático */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json })
      })
    })
    req.on('error', reject)
    if (Array.isArray(body)) {
      for (const chunk of body) req.write(chunk)
      req.end()
    } else req.end(body)
  })
}

// Um mundo isolado: projectsDir, repo com .graph-runs, stateDir e graph-runs global, todos em tmp.
async function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-eng-org-http-')))
  const projectsDir = path.join(root, 'projects')
  const stateDir = path.join(root, 'state')
  const home = path.join(root, 'home')
  const graphRunsHome = path.join(root, 'graph-runs')
  for (const d of [projectsDir, stateDir, home, graphRunsHome]) fs.mkdirSync(d, { recursive: true })
  const configPath = path.join(stateDir, 'config.json')
  const panel = await ensurePanel({ port: 0, projectsDir, pollMs: 100, configPath, graphRunsHome, home })
  const port = panel.port
  const origin = `http://127.0.0.1:${port}`
  const post = (p, body, headers = {}) =>
    request(port, 'POST', p, { Origin: origin, 'Content-Type': 'application/json', ...headers }, typeof body === 'string' ? body : JSON.stringify(body))
  const runs = async () => (await request(port, 'GET', '/api/runs')).json
  const orgFile = path.join(stateDir, 'organize.json')
  const readOrgFile = () => JSON.parse(fs.readFileSync(orgFile, 'utf8'))
  return { root, projectsDir, stateDir, home, graphRunsHome, configPath, panel, port, origin, post, runs, orgFile, readOrgFile }
}

const byKey = (list, key) => list.runs.find((r) => r.key === key)

describe('rotas de organização: travas iguais às do PUT /api/config', () => {
  let W
  before(async () => {
    W = await world()
    addWf(W.projectsDir, { wf: 'wf_trava-0001', runId: RID, runDir: mkRunDir(W.root), kind: 'done', ageSec: 600 })
  })
  after(async () => {
    await W.panel.close()
  })

  const GID = 'g-0000000a'
  const ROUTES = [
    ['/api/org/pin', { wf: 'wf_trava-0001', pinned: true }, true],
    ['/api/org/groups', { name: 'Trava' }, false],
    [`/api/org/groups/${GID}/rename`, { name: 'Outro' }, false],
    [`/api/org/groups/${GID}/move`, { index: 0 }, false],
    [`/api/org/groups/${GID}/delete`, {}, false],
    ['/api/org/move', { wf: 'wf_trava-0001', group: null }, true],
    ['/api/org/archive', { wf: 'wf_trava-0001', archived: true }, true],
    ['/api/org/delete', { wf: 'wf_trava-0001', confirm: RID }, true],
    ['/api/org/delete-finished', { wfs: ['wf_trava-0001'], confirm: 'apagar 1' }, false],
  ]

  test('Host, método, Origin, Content-Type, 413, JSON, corpo, campo extra, wf inválido e wf fora da lista', async () => {
    const snap = () => [fs.existsSync(W.orgFile), fs.readdirSync(W.stateDir).join(','), tree(W.root).join('\n')]
    const before0 = snap()
    for (const [p, body, hasWf] of ROUTES) {
      const json = JSON.stringify(body)
      const base = { Origin: W.origin, 'Content-Type': 'application/json' }
      assert.equal((await request(W.port, 'POST', p, { ...base, Host: 'evil.example' }, json)).status, 403, `Host ${p}`)
      for (const m of ['GET', 'PUT', 'OPTIONS', 'DELETE']) {
        const r = await request(W.port, m, p, base, m === 'GET' ? undefined : json)
        assert.equal(r.status, 405, `${m} ${p}`)
        assert.equal(r.headers.allow, 'POST', `${m} ${p}`)
      }
      for (const o of [undefined, 'null', 'http://evil', `http://localhost:${W.port}`]) {
        const h = { 'Content-Type': 'application/json' }
        if (o !== undefined) h.Origin = o
        assert.equal((await request(W.port, 'POST', p, h, json)).status, 403, `Origin ${o} ${p}`)
      }
      assert.equal((await W.post(p, json, { 'Content-Type': 'text/plain' })).status, 415, `415 ${p}`)
      assert.equal((await W.post(p, 'x'.repeat(10), { 'Content-Length': '5000' }).catch(() => ({ status: 413 }))).status, 413, `413 declarado ${p}`)
      const chunked = await request(W.port, 'POST', p, base, Array.from({ length: 5 }, () => 'x'.repeat(1000)))
      assert.equal(chunked.status, 413, `413 em chunks ${p}`)
      const bad = await W.post(p, '{')
      assert.equal(bad.status, 400)
      assert.equal(bad.json.error, 'JSON inválido')
      const arr = await W.post(p, '[]')
      assert.equal(arr.status, 400)
      assert.equal(arr.json.error, 'o corpo deve ser um objeto')
      const extra = await W.post(p, { ...body, extra: 1 })
      assert.equal(extra.status, 400, `extra ${p}`)
      assert.equal(extra.json.fields.extra, 'campo desconhecido')
      if (hasWf) {
        const w = await W.post(p, { ...body, wf: '../x' })
        assert.equal(w.status, 400)
        assert.equal(w.json.fields.wf, 'id de run inválido')
        assert.equal((await W.post(p, { ...body, wf: 'wf_nao-existe' })).status, 404, `404 ${p}`)
      }
    }
    const gid = await W.post('/api/org/groups/g-zz/rename', { name: 'x' })
    assert.equal(gid.status, 400)
    assert.equal(gid.json.error, 'id de grupo inválido')
    assert.equal((await W.post('/api/org/groups/__proto__/rename', { name: 'x' })).status, 400)
    assert.equal((await W.post('/api/org/__proto__', {})).status, 405) // fora da tabela: regra GET-only
    assert.deepEqual(snap(), before0, 'nada foi gravado nem apagado')
  })
})

describe('GET /api/runs: agrupamento por key e herança na retomada', () => {
  let W
  before(async () => {
    W = await world()
  })
  after(async () => {
    await W.panel.close()
  })

  test('planOnly + execução com o mesmo runId: uma entrada, wf = execução, planOnly false', async () => {
    const runDir = mkRunDir(W.root)
    addWf(W.projectsDir, { wf: 'wf_plano-0001', runId: RID, runDir, kind: 'plan', ageSec: 900 })
    addWf(W.projectsDir, { wf: 'wf_exec-0001', runId: RID, runDir, kind: 'stopped', ageSec: 3600 })
    const list = await W.runs()
    assert.ok(list.org && Array.isArray(list.org.groups) && Array.isArray(list.org.pinned) && Array.isArray(list.org.warnings))
    const r = byKey(list, RID)
    assert.deepEqual(r.wfs, ['wf_plano-0001', 'wf_exec-0001'])
    assert.equal(r.wf, 'wf_exec-0001')
    assert.equal(r.planOnly, false)
    assert.equal(r.status, 'parada?')
    assert.equal(r.runId, RID)
    assert.equal(r.name, RID)
    assert.equal(r.runDir, runDir) // fora do home injetado: caminho inteiro
    assert.equal(r.pinned, false)
    assert.equal(r.group, null)
    assert.equal(r.archived, false)
    for (const k of ['dir', 'sig', 'runDirRaw', 'entries', 'slug']) assert.equal(r[k], undefined, k)
    assert.equal(list.runs.filter((x) => x.key === RID).length, 1)
  })

  test('grupo só com planOnly sai terminado e planOnly: true (não parada)', async () => {
    const rid = '20260101-0001-so-plano'
    addWf(W.projectsDir, { wf: 'wf_soplano-0001', runId: rid, runDir: mkRunDir(W.root, rid), kind: 'plan', ageSec: 7200 })
    const r = byKey(await W.runs(), rid)
    assert.equal(r.status, 'terminado')
    assert.equal(r.planOnly, true)
    assert.equal(r.stop, null)
  })

  test('um plan ainda aberto sai rodando, e não planOnly', async () => {
    const rid = '20260101-0002-plano-rodando'
    addWf(W.projectsDir, { wf: 'wf_planrun-0001', runId: rid, runDir: mkRunDir(W.root, rid), kind: 'plan-running', ageSec: 5 })
    const r = byKey(await W.runs(), rid)
    assert.equal(r.status, 'rodando')
    assert.equal(r.planOnly, false)
  })

  test('herança: fixada e em grupo, a retomada sob outro slug herda o lugar; wf sem runId fica à parte', async () => {
    const rid = '20260101-0003-heranca'
    const runDir = mkRunDir(W.root, rid)
    addWf(W.projectsDir, { wf: 'wf_her-0001', runId: rid, runDir, kind: 'plan', ageSec: 3000 })
    addWf(W.projectsDir, { wf: 'wf_her-0002', runId: rid, runDir, kind: 'stopped', ageSec: 2000 })
    assert.equal((await W.post('/api/org/pin', { wf: 'wf_her-0002', pinned: true })).status, 200)
    const g = await W.post('/api/org/groups', { name: 'Herança' })
    assert.equal(g.status, 200)
    const gid = g.json.group.id
    // mover desafixa; fixa de novo para ficar com os dois (fixada vence grupo na página)
    assert.equal((await W.post('/api/org/move', { wf: 'wf_her-0001', group: gid })).status, 200)
    assert.equal((await W.post('/api/org/pin', { wf: 'wf_her-0001', pinned: true })).status, 200)
    // retomada colada numa sessão aberta no repo da run: outro slug, mesmo runId, mais nova
    addWf(W.projectsDir, { slug: '-repo-da-run', sess: 'sess-nova', wf: 'wf_her-0003', runId: rid, runDir, kind: 'running', ageSec: 3 })
    // wf sem runId sob o slug do 1º: nunca entra na mesma entrada
    addWf(W.projectsDir, { wf: 'wf_her-0004', kind: 'stopped', ageSec: 1000 })
    const list = await W.runs()
    const r = byKey(list, rid)
    assert.deepEqual(r.wfs, ['wf_her-0003', 'wf_her-0002', 'wf_her-0001'])
    assert.equal(r.wf, 'wf_her-0003')
    assert.equal(r.status, 'rodando')
    assert.equal(r.pinned, true)
    assert.equal(r.group, gid)
    assert.equal(r.project, 'repo-da-run')
    const solo = list.runs.find((x) => x.wf === 'wf_her-0004')
    assert.equal(solo.key, '-exemplo-org/wf_her-0004')
    assert.equal(solo.name, 'her-0004')
    assert.equal(solo.runId, null)
    assert.deepEqual(solo.wfs, ['wf_her-0004'])
    // o wf superado continua abrível por URL, com o estado dele
    const old = await request(W.port, 'GET', '/api/runs/wf_her-0002')
    assert.equal(old.status, 200)
    assert.equal(old.json.wf, 'wf_her-0002')
    assert.equal(old.json.status, 'parada?')
  })
})

describe('grupos e arquivar persistem no organize.json ao lado da config', () => {
  let W
  before(async () => {
    W = await world()
    addWf(W.projectsDir, { wf: 'wf_grp-0001', runId: RID, runDir: mkRunDir(W.root), kind: 'done', ageSec: 600 })
  })
  after(async () => {
    await W.panel.close()
  })

  test('stateDir = pasta do configPath, e o arquivo fica lá', async () => {
    assert.equal(W.panel.server.stateDir, W.stateDir)
    assert.equal(W.panel.server.organizePath, W.orgFile)
    assert.equal((await W.post('/api/org/pin', { wf: 'wf_grp-0001', pinned: true })).status, 200)
    assert.deepEqual(W.readOrgFile().pinned, [RID])
    assert.equal(fs.statSync(W.orgFile).mode & 0o777, 0o600)
    const off = await W.post('/api/org/pin', { wf: 'wf_grp-0001', pinned: false })
    assert.deepEqual(off.json.org.pinned, [])
  })

  test('criar, renomear, mover e apagar grupo; duplicado 400; 21º 409; 404; move para grupo inexistente', async () => {
    const a = await W.post('/api/org/groups', { name: 'Salesbud', wf: 'wf_grp-0001' })
    assert.equal(a.status, 200)
    const ga = a.json.group.id
    assert.match(ga, /^g-[a-f0-9]{8}$/)
    assert.equal(W.readOrgFile().placement[RID], ga)
    assert.equal(byKey(await W.runs(), RID).group, ga)
    const dup = await W.post('/api/org/groups', { name: 'salesbud' })
    assert.equal(dup.status, 400)
    assert.equal(dup.json.fields.name, 'já existe um grupo com esse nome')
    const b = (await W.post('/api/org/groups', { name: 'graph-eng' })).json.group.id
    assert.equal((await W.post(`/api/org/groups/${ga}/rename`, { name: 'Salesbud 2' })).status, 200)
    assert.equal((await W.post(`/api/org/groups/${b}/move`, { index: 0 })).status, 200)
    assert.deepEqual(
      W.readOrgFile().groups.map((g) => g.name),
      ['graph-eng', 'Salesbud 2'],
    )
    const badIndex = await W.post(`/api/org/groups/${b}/move`, { index: 5 })
    assert.equal(badIndex.status, 400)
    assert.equal(badIndex.json.fields.index, 'posição inválida')
    assert.equal((await W.post('/api/org/groups/g-ffffffff/rename', { name: 'x' })).status, 404)
    assert.equal((await W.post('/api/org/groups/g-ffffffff/delete', {})).status, 404)
    const mv = await W.post('/api/org/move', { wf: 'wf_grp-0001', group: 'g-ffffffff' })
    assert.equal(mv.status, 400)
    assert.equal(mv.json.fields.group, 'esse grupo não existe')
    const del = await W.post(`/api/org/groups/${ga}/delete`, {})
    assert.equal(del.status, 200)
    assert.equal(del.json.released, 1)
    assert.equal(byKey(await W.runs(), RID).group, null)
    for (let i = W.readOrgFile().groups.length; i < 20; i++) assert.equal((await W.post('/api/org/groups', { name: `G${i}` })).status, 200)
    const over = await W.post('/api/org/groups', { name: 'G21' })
    assert.equal(over.status, 409)
    assert.equal(over.json.error, 'limite de 20 grupos')
  })

  test('arquivar sai no GET; desarquivar volta', async () => {
    assert.equal((await W.post('/api/org/archive', { wf: 'wf_grp-0001', archived: true })).status, 200)
    assert.equal(byKey(await W.runs(), RID).archived, true)
    assert.equal(typeof W.readOrgFile().archived[RID], 'number')
    assert.equal((await W.post('/api/org/archive', { wf: 'wf_grp-0001', archived: false })).status, 200)
    assert.equal(byKey(await W.runs(), RID).archived, false)
  })
})

describe('apagar uma run (O8)', () => {
  let W
  before(async () => {
    W = await world()
  })
  after(async () => {
    await W.panel.close()
  })

  test('nome errado → 400 e a pasta fica; rodando → 409', async () => {
    const runDir = mkRunDir(W.root)
    addWf(W.projectsDir, { wf: 'wf_del-0001', runId: RID, runDir, kind: 'done', ageSec: 600 })
    for (const confirm of ['acoes', RID.toUpperCase(), `${RID} `, 'exemplo-org']) {
      const r = await W.post('/api/org/delete', { wf: 'wf_del-0001', confirm })
      assert.equal(r.status, 400, confirm)
      assert.equal(r.json.fields.confirm, 'digite o nome da run exatamente como aparece')
    }
    assert.ok(fs.existsSync(runDir))
    const rid = '20260101-0010-rodando'
    const rd = mkRunDir(W.root, rid)
    addWf(W.projectsDir, { wf: 'wf_del-0002', runId: rid, runDir: rd, kind: 'running', ageSec: 2 })
    const r = await W.post('/api/org/delete', { wf: 'wf_del-0002', confirm: rid })
    assert.equal(r.status, 409)
    assert.equal(r.json.error, 'Pare a run antes de apagar.')
    assert.ok(fs.existsSync(rd))
  })

  test('contenção ruim (symlink, pai que não é .graph-runs) → 409 e nada é removido', async () => {
    const rid1 = '20260101-0011-symlink'
    const real = mkRunDir(W.root, rid1, path.join(W.root, 'alvo'))
    const linkParent = path.join(W.root, 'repo-link', '.graph-runs')
    fs.mkdirSync(linkParent, { recursive: true })
    fs.symlinkSync(real, path.join(linkParent, rid1))
    addWf(W.projectsDir, { wf: 'wf_del-0003', runId: rid1, runDir: path.join(linkParent, rid1), kind: 'done', ageSec: 600 })
    const rid2 = '20260101-0012-solta'
    const loose = mkRunDir(W.root, rid2, path.join(W.root, 'solta'))
    addWf(W.projectsDir, { wf: 'wf_del-0004', runId: rid2, runDir: loose, kind: 'done', ageSec: 600 })
    const list = await W.runs()
    assert.equal(byKey(list, rid1).runDir, null)
    assert.equal(byKey(list, rid2).runDir, null)
    for (const [wf, rid] of [
      ['wf_del-0003', rid1],
      ['wf_del-0004', rid2],
    ]) {
      const r = await W.post('/api/org/delete', { wf, confirm: rid })
      assert.equal(r.status, 409, wf)
      assert.match(r.json.error, /^não apago: /)
    }
    assert.ok(fs.existsSync(path.join(real, 'plan.md')))
    assert.ok(fs.lstatSync(path.join(linkParent, rid1)).isSymbolicLink())
    assert.ok(fs.existsSync(path.join(loose, 'plan.md')))
    assert.ok(byKey(await W.runs(), rid1))
  })

  test('certo → a pasta some, a run sai do GET e o projectsDir fica idêntico; um wf novo traz a run de volta', async () => {
    const runDir = path.join(W.root, 'repo', '.graph-runs', RID)
    const beforeTree = tree(W.projectsDir)
    const r = await W.post('/api/org/delete', { wf: 'wf_del-0001', confirm: RID })
    assert.equal(r.status, 200)
    assert.equal(r.json.deleted, RID)
    assert.equal(r.json.removedDir, true)
    assert.equal(fs.existsSync(runDir), false)
    assert.ok(fs.existsSync(path.join(W.root, 'repo', '.graph-runs')))
    assert.deepEqual(tree(W.projectsDir), beforeTree)
    assert.equal(byKey(await W.runs(), RID), undefined)
    assert.equal(typeof W.readOrgFile().deleted[RID], 'number')
    // rodar de novo com o mesmo runId traz a run de volta, e a próxima escrita limpa o `deleted`
    await new Promise((r) => setTimeout(r, 5)) // o wf novo nasce depois do apagar
    addWf(W.projectsDir, { slug: '-outro', wf: 'wf_del-0009', runId: RID, runDir, kind: 'running', ageSec: 0 })
    const back = byKey(await W.runs(), RID)
    assert.ok(back)
    assert.equal(back.wf, 'wf_del-0009')
    assert.equal((await W.post('/api/org/archive', { wf: 'wf_del-0009', archived: false })).status, 200)
    assert.equal(W.readOrgFile().deleted[RID], undefined)
  })

  test('sem pasta (sem runId) → 200 removedDir false, e a run some do GET', async () => {
    addWf(W.projectsDir, { wf: 'wf_del-0005', kind: 'done', ageSec: 600 })
    const beforeTree = tree(W.root)
    const r = await W.post('/api/org/delete', { wf: 'wf_del-0005', confirm: 'del-0005' })
    assert.equal(r.status, 200)
    assert.equal(r.json.removedDir, false)
    assert.equal((await W.runs()).runs.find((x) => x.wf === 'wf_del-0005'), undefined)
    // nada fora do stateDir mudou
    const strip = (t) => t.filter((l) => !l.startsWith('state'))
    assert.deepEqual(strip(tree(W.root)), strip(beforeTree))
  })
})

describe('apagar finalizadas (O9)', () => {
  let W
  const rids = ['20260101-0020-fim-a', '20260101-0021-fim-b', '20260101-0022-fim-c']
  before(async () => {
    W = await world()
    rids.forEach((rid, i) => addWf(W.projectsDir, { wf: `wf_fim-000${i}`, runId: rid, runDir: mkRunDir(W.root, rid), kind: 'done', ageSec: 600 + i }))
  })
  after(async () => {
    await W.panel.close()
  })

  const all = ['wf_fim-0000', 'wf_fim-0001', 'wf_fim-0002']
  const dirs = () => rids.map((rid) => fs.existsSync(path.join(W.root, 'repo', '.graph-runs', rid)))

  test('confirmação errada → 400; fixada, em grupo, arquivada, rodando ou fora da lista → 409 e nada é apagado', async () => {
    const bad = await W.post('/api/org/delete-finished', { wfs: all, confirm: 'apagar 1' })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.fields.confirm, 'digite apagar 3')
    const stale = async (wfs) => {
      const r = await W.post('/api/org/delete-finished', { wfs, confirm: `apagar ${wfs.length}` })
      assert.equal(r.status, 409, JSON.stringify(wfs))
      assert.equal(r.json.error, 'a lista de finalizadas mudou; reabra o dialog')
    }
    await W.post('/api/org/pin', { wf: 'wf_fim-0000', pinned: true })
    await stale(all)
    await W.post('/api/org/pin', { wf: 'wf_fim-0000', pinned: false })
    const g = (await W.post('/api/org/groups', { name: 'G', wf: 'wf_fim-0001' })).json.group.id
    await stale(all)
    await W.post(`/api/org/groups/${g}/delete`, {})
    await W.post('/api/org/archive', { wf: 'wf_fim-0002', archived: true })
    await stale(all)
    await W.post('/api/org/archive', { wf: 'wf_fim-0002', archived: false })
    await stale([...all, 'wf_nao-existe'])
    // um plan ainda aberto (status rodando) nunca entra
    const rid = '20260101-0023-plano-vivo'
    addWf(W.projectsDir, { wf: 'wf_fim-0009', runId: rid, runDir: mkRunDir(W.root, rid), kind: 'plan-running', ageSec: 2 })
    await stale([...all, 'wf_fim-0009'])
    assert.ok(fs.existsSync(path.join(W.root, 'repo', '.graph-runs', rid)))
    assert.deepEqual(dirs(), [true, true, true])
  })

  test('uma com contenção ruim vai para failed, e as outras são apagadas', async () => {
    const rid = '20260101-0024-solta'
    const loose = mkRunDir(W.root, rid, path.join(W.root, 'solta'))
    addWf(W.projectsDir, { wf: 'wf_fim-0004', runId: rid, runDir: loose, kind: 'done', ageSec: 700 })
    const wfs = [...all, 'wf_fim-0004']
    const beforeTree = tree(W.projectsDir)
    const r = await W.post('/api/org/delete-finished', { wfs, confirm: 'apagar 4' })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.deleted.sort(), [...rids].sort())
    assert.equal(r.json.failed.length, 1)
    assert.equal(r.json.failed[0].wf, 'wf_fim-0004')
    assert.match(r.json.failed[0].reason, /^não apago: /)
    assert.deepEqual(dirs(), [false, false, false])
    assert.ok(fs.existsSync(path.join(loose, 'plan.md')))
    assert.deepEqual(tree(W.projectsDir), beforeTree)
    const list = await W.runs()
    for (const rid2 of rids) assert.equal(byKey(list, rid2), undefined)
    assert.ok(byKey(list, rid))
  })
})

describe('regra fechada dos módulos .mjs (C10)', () => {
  let W
  before(async () => {
    W = await world()
  })
  after(async () => {
    await W.panel.close()
  })

  test('só [a-z0-9-]+.mjs existente e regular em bin/ui/', async () => {
    for (const p of ['/agent-target.mjs', '/graph-layout.mjs', '/config-modal.mjs']) {
      const r = await request(W.port, 'GET', p)
      assert.equal(r.status, 200, p)
      assert.match(r.headers['content-type'], /^text\/javascript/)
    }
    for (const p of ['/nao-existe.mjs', '/Agent-Target.mjs', '/fonts/x.mjs', '/../graph-watch.mjs', '/%2e%2e%2fconfig.mjs', '/app.mjs.map', '/graph-watch.mjs', '/organize.mjs', '/ui-server.mjs', '/agent_target.mjs', '/.mjs', '/src/x.mjs']) {
      assert.equal((await request(W.port, 'GET', p)).status, 404, p)
    }
    assert.equal((await request(W.port, 'POST', '/agent-target.mjs', {}, '')).status, 405)
  })
})

// Guarda de isolamento (C1): nenhum painel de teste sobe sem configPath/stateDir, e nenhum processo `ui`
// ou `live` do BIN sobe sem GRAPH_ENG_STATE_DIR no env. Lê o fonte: olhar o ~/.claude real antes e depois
// ficaria instável (um painel instalado grava lá a cada 10 s).
test('guarda: todo painel e todo `ui`/`live` dos testes usam estado em dir temporário', () => {
  const me = path.basename(fileURLToPath(import.meta.url))
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory() && e.name !== 'fixtures') walk(p)
      else if (e.isFile() && e.name.endsWith('.mjs') && e.name !== me) files.push(p)
    }
  }
  walk(__dirname)
  const problems = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/(ensurePanel|createPanelServer)\(\{([^}]*)\}/g)) {
      if (!/\b(configPath|stateDir)\b/.test(m[2])) problems.push(`${path.basename(f)}: ${m[1]}({${m[2].trim()}}) sem configPath/stateDir`)
    }
    for (const m of src.matchAll(/spawn\(\s*process\.execPath\s*,\s*\[\s*BIN\s*,\s*'(ui|live)'[^\n]*/g)) {
      const env = /env:\s*([A-Za-z_$][\w$]*)\(\)/.exec(m[0])
      const envOk = env && new RegExp(`${env[1]}[^\\n]*=>[\\s\\S]{0,400}GRAPH_ENG_STATE_DIR`).test(src)
      if (!/GRAPH_ENG_STATE_DIR/.test(m[0]) && !envOk) problems.push(`${path.basename(f)}: spawn '${m[1]}' sem GRAPH_ENG_STATE_DIR no env`)
    }
  }
  assert.deepEqual(problems, [])
  assert.ok(files.some((f) => f.endsWith('ui-server.test.mjs')), 'a guarda precisa ver o ui-server.test.mjs')
})
