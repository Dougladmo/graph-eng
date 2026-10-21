// Testes do painel web (`graph-watch ui`, docs/specs/2026-09-27-painel-web.md itens 1-6, 8, 9, 12).
// Tudo roda sobre uma cópia de test/fixtures/multi em os.tmpdir() (2 projetos inventados), com os
// mtimes fixados aqui — o git não preserva mtime, e a ordem/status da lista dependem dele.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const BIN = path.join(ROOT, 'bin', 'graph-watch.mjs')
const MULTI = path.join(__dirname, 'fixtures', 'multi')

const { ensurePanel, createRunIndex } = await import('../bin/ui-server.mjs')
const { writeConfig } = await import('../bin/config.mjs')
const { registerRun } = await import('../bin/run-registry.mjs')

const RUNS = {
  'wf_aaaa0000-alfa-ativo': ['-exemplo-projeto-alfa', 'sess-alfa', 10], // rodando
  'wf_aaaa0000-alfa-feito': ['-exemplo-projeto-alfa', 'sess-alfa', 60], // terminado, mais novo que a beta
  'wf_bbbb0000-beta-ativo': ['-exemplo-projeto-beta', 'sess-beta', 3600], // sem evento há 1 h: parada?
  'wf_bbbb0000-beta-outro': ['-exemplo-projeto-beta', 'sess-beta', 5], // não é graph-eng: fora da lista
}

function copyMulti() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ui-'))
  fs.cpSync(MULTI, dir, { recursive: true })
  for (const [wf, [slug, sess, ageSec]] of Object.entries(RUNS)) {
    const d = path.join(dir, slug, sess, 'subagents', 'workflows', wf)
    const t = new Date(Date.now() - ageSec * 1000)
    for (const f of fs.readdirSync(d)) fs.utimesSync(path.join(d, f), t, t)
  }
  return dir
}

// Estado do painel (config.json, organize.json) sempre num dir temporário: nenhum teste lê nem
// grava em ~/.claude (spec C1).
function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-eng-ui-state-'))
  return { dir, configPath: path.join(dir, 'config.json') }
}
const tmpEnv = () => {
  const { dir, configPath } = tmpState()
  return { ...process.env, GRAPH_ENG_CONFIG: configPath, GRAPH_ENG_STATE_DIR: dir }
}

function runDirOf(projectsDir, wf) {
  const [slug, sess] = RUNS[wf]
  return path.join(projectsDir, slug, sess, 'subagents', 'workflows', wf)
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function getJson(port, p) {
  const r = await get(port, p)
  return { ...r, json: r.body ? JSON.parse(r.body) : null }
}

// Sobe `graph-watch ui` como subprocesso e resolve quando a URL aparece no stdout (ou quando ele sai).
function spawnUi(args) {
  const child = spawn(process.execPath, [BIN, 'ui', '--no-open', ...args], { cwd: ROOT, env: tmpEnv() })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  let closed = false
  const exited = new Promise((resolve) =>
    child.on('close', (code) => {
      closed = true
      resolve(code)
    }),
  )
  // resolve com a URL, ou com null se o processo sair antes de imprimir (sem timer pendurado)
  const urlReady = new Promise((resolve) => {
    const tick = () => {
      const m = stdout.match(/graph-eng: painel: (http:\/\/127\.0\.0\.1:(\d+))/)
      if (m) return resolve({ url: m[1], port: Number(m[2]) })
      if (closed) return resolve(null)
      setTimeout(tick, 10)
    }
    tick()
  })
  return { child, exited, urlReady, out: () => ({ stdout, stderr }) }
}

describe('painel web: API (itens 3, 4, 5, 8)', () => {
  let projectsDir
  let panel
  before(async () => {
    projectsDir = copyMulti()
    panel = await ensurePanel({ port: 0, projectsDir, pollMs: 100, configPath: tmpState().configPath })
  })
  after(async () => {
    await panel.close()
  })

  test('ensurePanel: URL em 127.0.0.1 com a porta real e /api/health identifica o graph-watch', async () => {
    assert.match(panel.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(panel.url, `http://127.0.0.1:${panel.port}`)
    assert.equal(panel.reused, false)
    const r = await getJson(panel.port, '/api/health')
    assert.equal(r.status, 200)
    assert.equal(r.json.app, 'graph-watch')
  })

  test('/api/runs: multi-projeto, só graph-eng, rodando primeiro e depois mtime desc, com os campos', async () => {
    const r = await getJson(panel.port, '/api/runs')
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /application\/json/)
    const runs = r.json.runs
    assert.deepEqual(
      runs.map((x) => x.wf),
      ['wf_aaaa0000-alfa-ativo', 'wf_aaaa0000-alfa-feito', 'wf_bbbb0000-beta-ativo'],
    )
    assert.deepEqual(
      runs.map((x) => x.status),
      ['rodando', 'terminado', 'parada?'],
    )
    assert.deepEqual(
      runs.map((x) => x.project),
      ['projeto-alfa', 'projeto-alfa', 'beta'],
    )
    const ativo = runs[0]
    assert.equal(ativo.goal, 'Objetivo inventado da run ativa do projeto alfa.')
    assert.equal(ativo.done, 1)
    assert.equal(ativo.total, 3)
    assert.equal(typeof ativo.mtime, 'number')
    assert.ok(runs[0].mtime > runs[1].mtime && runs[1].mtime > runs[2].mtime)
    assert.deepEqual(
      ativo.nodes.map((n) => [n.id, n.state]),
      [
        ['A1', 'pronto'],
        ['A2', 'trabalhando'],
        ['A3', 'aguardando'],
      ],
    )
  })

  // C6: a lista usa computeStop (mesma regra e motivo do buildModel), sem a janela fixa de 2 min.
  test('/api/runs: status "parada?" vem de computeStop, com o motivo (stop.text) — sem ACTIVE_WINDOW_MS', async () => {
    const r = await getJson(panel.port, '/api/runs')
    const beta = r.json.runs.find((x) => x.wf === 'wf_bbbb0000-beta-ativo')
    assert.equal(beta.status, 'parada?')
    assert.equal(beta.stop.reason, 'sem-atividade')
    assert.match(beta.stop.text, /^sem atividade há \d+ min$/)
    assert.equal(beta.planOnly, false)
    const ativo = r.json.runs.find((x) => x.wf === 'wf_aaaa0000-alfa-ativo')
    assert.equal(ativo.stop, null)
    const feito = r.json.runs.find((x) => x.wf === 'wf_aaaa0000-alfa-feito')
    assert.equal(feito.stop, null)
    // /api/runs/:wf: o Modelo (buildModel) dá o mesmo motivo que a lista, para o mesmo wf
    const m = await getJson(panel.port, '/api/runs/wf_bbbb0000-beta-ativo')
    assert.equal(m.json.stop.reason, beta.stop.reason)
  })

  test('/api/runs: o limiar vem da config (stallMinutes), não de uma janela fixa em código', async () => {
    // wf_aaaa0000-alfa-ativo está com 10 s de idade (RUNS acima): com stallMinutes:1 (L = 60 s) segue
    // rodando; a prova de que não há mais ACTIVE_WINDOW_MS é o teste anterior, com beta a 1 h de idade.
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-stall-cfg-'))
    const configPath = path.join(cfgDir, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, effort: 'medium', operational: { stallMinutes: 1 } }))
    const index = createRunIndex(projectsDir, { configPath })
    const runs = await index.scan()
    const ativo = runs.find((r) => r.wf === 'wf_aaaa0000-alfa-ativo')
    assert.equal(ativo.status, 'rodando')
    const beta = runs.find((r) => r.wf === 'wf_bbbb0000-beta-ativo')
    assert.equal(beta.status, 'parada?')
    assert.equal(beta.stop.text, 'sem atividade há 60 min')
  })

  test('/api/runs/:wf: 200 com o modelo do buildModel (nós, deps, estado) e o modo inferido do plan', async () => {
    const r = await getJson(panel.port, '/api/runs/wf_aaaa0000-alfa-ativo')
    assert.equal(r.status, 200)
    const m = r.json
    assert.equal(m.wf, 'wf_aaaa0000-alfa-ativo')
    assert.equal(m.project, 'projeto-alfa')
    assert.equal(m.goal, 'Objetivo inventado da run ativa do projeto alfa.')
    assert.equal(m.mode, 'implement')
    assert.equal(m.round, 1)
    const byId = Object.fromEntries(m.nodes.map((n) => [n.id, n]))
    assert.deepEqual(byId.A2.deps, ['A1'])
    assert.equal(byId.A2.state, 'trabalhando')
    assert.equal(byId.A2.running.label, 'work:A2')
    assert.ok(Array.isArray(m.warns))
    assert.equal(m.synth, 'aguardando')
  })

  test('/api/runs/:wf: economy vem da linha Economy: do prompt (sem ela, fica ausente)', async () => {
    const ativo = (await getJson(panel.port, '/api/runs/wf_aaaa0000-alfa-ativo')).json
    assert.equal(ativo.economy, 'balanced')
    assert.equal(ativo.ceiling, 24)
    const feito = (await getJson(panel.port, '/api/runs/wf_aaaa0000-alfa-feito')).json
    assert.equal(feito.economy, undefined)
  })

  test('/api/runs/:wf: id fora da regex → 400; válido mas fora da lista → 404 (inclusive run que não é graph-eng)', async () => {
    for (const bad of ['wf_..', 'x_123', 'wf_a%2F..%2Fb', 'wf_a.b']) {
      const r = await get(panel.port, `/api/runs/${bad}`)
      assert.equal(r.status, 400, `esperava 400 para ${bad}`)
    }
    assert.equal((await get(panel.port, '/api/runs/wf_zzzz9999-nada')).status, 404)
    assert.equal((await get(panel.port, '/api/runs/wf_bbbb0000-beta-outro')).status, 404)
  })

  test('/api/runs/:wf/nodes/:id: 200 JSON com agentes, prompt, tool calls com ts ISO e resultado', async () => {
    const r = await getJson(panel.port, '/api/runs/wf_aaaa0000-alfa-ativo/nodes/A1')
    assert.equal(r.status, 200)
    const d = r.json
    assert.equal(d.id, 'A1')
    assert.equal(d.title, 'Nó inventado um')
    assert.equal(d.state, 'pronto')
    assert.deepEqual(
      d.agents.map((a) => [a.label, a.status]),
      [
        ['work:A1', 'terminou'],
        ['verify:A1', 'terminou'],
      ],
    )
    const work = d.agents[0]
    assert.equal(work.prompt, 'Prompt inventado do nó A1.')
    assert.equal(work.toolCalls.length, 1)
    assert.equal(work.toolCalls[0].name, 'Read')
    assert.equal(work.toolCalls[0].ts, '2026-01-01T10:01:05.000Z')
    assert.equal(work.result.summary, 'Resumo inventado de A1.')
    assert.deepEqual(work.checks, [{ cmd: 'comando inventado', ok: true, output: 'saída inventada' }])
    const ver = d.agents[1]
    assert.equal(ver.prompt, 'Prompt inventado da verificação de A1.')
    assert.equal(ver.verdict.pass, true)

    const a2 = (await getJson(panel.port, '/api/runs/wf_aaaa0000-alfa-ativo/nodes/A2')).json
    assert.equal(a2.agents[0].status, 'rodando')
    assert.equal(a2.agents[0].lastText, 'Texto livre inventado.')

    const a3 = await getJson(panel.port, '/api/runs/wf_aaaa0000-alfa-ativo/nodes/A3')
    assert.equal(a3.status, 200)
    assert.equal(a3.json.state, 'aguardando')
    assert.deepEqual(a3.json.agents, [])

    const plan = await getJson(panel.port, '/api/runs/wf_aaaa0000-alfa-ativo/nodes/plan')
    assert.equal(plan.status, 200)
    assert.equal(plan.json.agents[0].label, 'plan')

    assert.equal((await get(panel.port, '/api/runs/wf_aaaa0000-alfa-ativo/nodes/ZZ9')).status, 404)
    assert.equal((await get(panel.port, '/api/runs/wf_aaaa0000-alfa-ativo/nodes/a.b')).status, 400)
  })

  test('Host fora de 127.0.0.1:<porta>/localhost:<porta> → 403 (DNS rebinding)', async () => {
    for (const host of ['evil.example', `evil.example:${panel.port}`, '127.0.0.1:1', `127.0.0.1.evil.example:${panel.port}`]) {
      const r = await get(panel.port, '/api/runs', { Host: host })
      assert.equal(r.status, 403, `esperava 403 para Host ${host}`)
    }
    assert.equal((await get(panel.port, '/api/health', { Host: `localhost:${panel.port}` })).status, 200)
  })

  test('estáticos por lista fixa (página, tema, ícone, fontes) com content-type; fora da lista → 404', async () => {
    const idx = await get(panel.port, '/')
    assert.equal(idx.status, 200)
    assert.match(idx.headers['content-type'], /text\/html/)
    const js = await get(panel.port, '/app.js')
    assert.equal(js.status, 200)
    assert.match(js.headers['content-type'], /javascript/)
    const css = await get(panel.port, '/style.css')
    assert.equal(css.status, 200)
    assert.match(css.headers['content-type'], /text\/css/)
    // tema, ícone e fontes saem do próprio painel: a CSP não libera nenhuma origem de fora
    for (const [p, type] of [
      ['/theme.js', /javascript/],
      ['/favicon.svg', /image\/svg\+xml/],
      ['/favicon-32.png', /image\/png/],
      ['/apple-touch-icon.png', /image\/png/],
      ['/fonts/geist-latin.woff2', /font\/woff2/],
      ['/fonts/geist-mono-latin.woff2', /font\/woff2/],
    ]) {
      const r = await get(panel.port, p)
      assert.equal(r.status, 200, p)
      assert.match(r.headers['content-type'], type)
    }
    assert.equal(/https?:/.test(idx.headers['content-security-policy']), false)
    for (const p of ['/fonts/OFL.txt', '/fonts/x.woff2', '/../graph-watch.mjs', '/%2e%2e/graph-watch.mjs', '/x.js', '/ui/app.js', '/graph-watch.mjs', '/..%2fgraph-watch.mjs']) {
      assert.equal((await get(panel.port, p)).status, 404, `esperava 404 para ${p}`)
    }
  })

  test('/favicon.ico devolve um ícone de verdade (o PNG de 32px), não mais 204 vazio (7º pedido do PEDIDO.md)', async () => {
    const r = await get(panel.port, '/favicon.ico')
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /image\/png/)
    assert.ok(r.body && r.body.length > 0)
  })

  test('só GET: POST → 405 e nada muda', async () => {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: panel.port, path: '/api/runs', method: 'POST' }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end('{}')
    })
    assert.equal(r, 405)
  })
})

// Requisição com método, cabeçalhos e corpo livres (Host vai certo, a menos que o teste o troque). Uma
// conexão por requisição (agent: false): o servidor HTTP do Node fecha o socket depois de um DELETE com
// corpo, e o keep-alive do cliente reaproveitaria o socket fechado (ECONNRESET), o que também acontece
// no painel sem /api/config.
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
          /* corpo que não é JSON (estático) */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('painel web: /api/config (GET/PUT, única escrita)', () => {
  let projectsDir
  let cfgDir
  let configPath
  let panel
  let port
  let origin
  const put = (body, headers = {}) =>
    request(port, 'PUT', '/api/config', { Origin: origin, 'Content-Type': 'application/json', ...headers }, typeof body === 'string' ? body : JSON.stringify(body))
  // conteúdo + mtime + lista do diretório: prova que um PUT recusado não tocou o arquivo
  const snapshot = () => {
    try {
      return [fs.readFileSync(configPath, 'utf8'), fs.statSync(configPath).mtimeMs, fs.readdirSync(cfgDir).join(',')]
    } catch {
      return ['(ausente)', 0, fs.readdirSync(cfgDir).join(',')]
    }
  }

  before(async () => {
    projectsDir = copyMulti()
    cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-eng-ui-config-'))
    configPath = path.join(cfgDir, 'config.json') // nunca o ~/.claude real
    panel = await ensurePanel({ port: 0, projectsDir, pollMs: 100, configPath })
    port = panel.port
    origin = `http://127.0.0.1:${port}`
  })
  after(async () => {
    await panel.close()
  })

  test('GET sem arquivo: config effort medium, limites e origem default', async () => {
    const r = await request(port, 'GET', '/api/config')
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /application\/json/)
    assert.equal(r.headers['access-control-allow-origin'], undefined)
    assert.deepEqual(r.json.config, { effort: 'medium' })
    assert.deepEqual(r.json.source, { effort: 'default' })
    assert.deepEqual(r.json.limits, { effort: ['low', 'medium', 'max'] })
    assert.deepEqual(r.json.defaults, { effort: 'medium' })
    assert.equal(JSON.stringify(r.json).includes('stallMinutes'), false)
    assert.deepEqual(r.json.warnings, [])
    assert.equal(fs.existsSync(configPath), false, 'GET não grava nada')
  })

  test('PUT válido grava o arquivo (atômico, sem sobra de tmp) e o GET seguinte mostra origem config', async () => {
    const r = await put({ effort: 'max' })
    assert.equal(r.status, 200, r.body)
    assert.deepEqual(r.json.config, { effort: 'max' })
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { schemaVersion: 2, effort: 'max', operational: { stallMinutes: 5 } })
    assert.deepEqual(fs.readdirSync(cfgDir).sort(), ['config.json'])
    const g = await request(port, 'GET', '/api/config')
    assert.equal(g.json.source.effort, 'config')
    // localhost também é origem do painel; charset no Content-Type é aceito.
    const l = await request(port, 'PUT', '/api/config', { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Content-Type': 'application/json; charset=utf-8' }, '{"effort":"low"}')
    assert.equal(l.status, 200, l.body)
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { schemaVersion: 2, effort: 'low', operational: { stallMinutes: 5 } })
    assert.equal(l.json.source.effort, 'config')
    assert.equal((await put({ stallMinutes: 12 })).status, 400)
    fs.writeFileSync(configPath, '{"effort":"low","stallMinutes":12,"ceiling":30}')
    const migrated = await put({ effort: 'medium' })
    assert.equal(migrated.status, 200, migrated.body)
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { schemaVersion: 2, effort: 'medium', operational: { stallMinutes: 12 } })
  })

  test('PUT com Origin ausente, null, de fora ou de outra porta → 403 e o arquivo fica igual', async () => {
    const before = snapshot()
    for (const o of [undefined, 'null', 'http://evil.example', 'http://127.0.0.1:1', `https://127.0.0.1:${port}`]) {
      const headers = { 'Content-Type': 'application/json' }
      if (o !== undefined) headers.Origin = o
      const r = await request(port, 'PUT', '/api/config', headers, '{"effort":"medium"}')
      assert.equal(r.status, 403, `esperava 403 para Origin ${o}`)
      assert.equal(r.json.error, 'Origin não permitido')
    }
    assert.deepEqual(snapshot(), before)
  })

  test('PUT com Host de fora → 403 (antes de tudo), mesmo com corpo e Origin válidos', async () => {
    const before = snapshot()
    const r = await put({ effort: 'medium' }, { Host: 'evil.example' })
    assert.equal(r.status, 403)
    assert.equal(r.json.error, 'Host não permitido')
    assert.deepEqual(snapshot(), before)
  })

  test('PUT com Content-Type que não é JSON → 415', async () => {
    const before = snapshot()
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
      const headers = { Origin: origin }
      if (ct) headers['Content-Type'] = ct
      const r = await request(port, 'PUT', '/api/config', headers, '{"effort":"medium"}')
      assert.equal(r.status, 415, `esperava 415 para ${ct}`)
    }
    assert.deepEqual(snapshot(), before)
  })

  test('PUT com JSON inválido, corpo que não é objeto, campo desconhecido ou inválido → 400 com os campos', async () => {
    const before = snapshot()
    const bad = await put('{')
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error, 'JSON inválido')
    for (const body of ['[]', 'null', '3', '"x"']) {
      const r = await put(body)
      assert.equal(r.status, 400, body)
      assert.equal(r.json.error, 'o corpo deve ser um objeto')
    }
    const unknown = await put({ foo: 1, effort: 'low' })
    assert.equal(unknown.status, 400)
    assert.deepEqual(unknown.json.fields, { foo: 'campo desconhecido' })
    const removed = await put({ stallMinutes: 12 })
    assert.equal(removed.status, 400)
    const many = await put({ effort: 'high', maxRounds: 9, planGate: false })
    assert.deepEqual(Object.keys(many.json.fields).sort(), ['effort', 'maxRounds', 'planGate'])
    assert.deepEqual(snapshot(), before, 'nada gravado em caminho de erro')
  })

  test('PUT com corpo acima de 4096 bytes → 413 (declarado ou em chunks) e o arquivo fica igual', async () => {
    const before = snapshot()
    const big = JSON.stringify({ effort: 'medium', pad: 'x'.repeat(5000) })
    assert.equal((await put(big)).status, 413)
    // sem Content-Length (chunked): o limite vale na leitura
    const chunked = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/config', method: 'PUT', agent: false, headers: { Origin: origin, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      for (let i = 0; i < 5; i++) req.write('x'.repeat(1000))
      req.end()
    })
    assert.equal(chunked, 413)
    assert.deepEqual(snapshot(), before)
  })

  test('métodos: POST/DELETE/OPTIONS em /api/config → 405 com Allow GET, PUT; PUT em outra rota → 405 com Allow GET', async () => {
    const before = snapshot()
    for (const m of ['POST', 'DELETE', 'PATCH', 'OPTIONS']) {
      const r = await request(port, m, '/api/config', { Origin: origin, 'Content-Type': 'application/json' }, '{"effort":"medium"}')
      assert.equal(r.status, 405, m)
      assert.equal(r.headers.allow, 'GET, PUT')
      assert.equal(r.headers['access-control-allow-origin'], undefined)
    }
    for (const p of ['/api/runs', '/api/config/x', '/', '/api/health']) {
      const r = await request(port, 'PUT', p, { Origin: origin, 'Content-Type': 'application/json' }, '{"effort":"medium"}')
      assert.equal(r.status, 405, `PUT ${p}`)
      assert.equal(r.headers.allow, 'GET')
    }
    assert.deepEqual(snapshot(), before)
  })

  test('rotas desconhecidas → 404 (inclusive GET /api/config/x)', async () => {
    for (const p of ['/api/config/x', '/api/configs', '/api/nada', '/config.json']) {
      assert.equal((await request(port, 'GET', p)).status, 404, p)
    }
  })

  test('GET com arquivo inválido no disco: 200 com o padrão e o aviso', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ effort: 'auto', ceiling: 5, stallMinutes: 12 }))
    const r = await request(port, 'GET', '/api/config')
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.config, { effort: 'medium' })
    assert.ok(r.json.warnings.some((warning) => warning.includes('effort')))
    assert.equal(JSON.stringify(r.json).includes('stallMinutes'), false)
  })

  test('estático /agent-target.mjs sai do painel como JavaScript', async () => {
    const r = await request(port, 'GET', '/agent-target.mjs')
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /javascript/)
    assert.match(r.body, /export function targetFor/)
  })

  test('pseudo-nós novos: design-review e polish-<k> respondem 200 (sem agentes nesta run antiga)', async () => {
    const dr = await request(port, 'GET', '/api/runs/wf_aaaa0000-alfa-ativo/nodes/design-review')
    assert.equal(dr.status, 200)
    assert.equal(dr.json.pseudo, true)
    const p2 = await request(port, 'GET', '/api/runs/wf_aaaa0000-alfa-ativo/nodes/polish-2')
    assert.equal(p2.status, 200)
    assert.equal(p2.json.pseudo, true)
    assert.equal(p2.json.id, 'polish-2')
    assert.equal(p2.json.title, 'polimento 2')
    assert.equal((await request(port, 'GET', '/api/runs/wf_aaaa0000-alfa-ativo/nodes/polish-x')).status, 404)
    assert.equal((await request(port, 'GET', '/api/runs/wf_aaaa0000-alfa-ativo/nodes/polish:2')).status, 400)
  })
})

describe('painel web: SSE /api/events (item 6)', () => {
  test('emite `runs` ao conectar e `run` com o wf depois de um append no journal', async () => {
    const projectsDir = copyMulti()
    const panel = await ensurePanel({ port: 0, projectsDir, pollMs: 100, configPath: tmpState().configPath })
    const events = []
    let req
    try {
      await new Promise((resolve, reject) => {
        req = http.get({ host: '127.0.0.1', port: panel.port, path: '/api/events' }, (res) => {
          assert.equal(res.statusCode, 200)
          assert.match(res.headers['content-type'], /text\/event-stream/)
          let buf = ''
          res.setEncoding('utf8')
          res.on('data', (d) => {
            buf += d
            let i
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i)
              buf = buf.slice(i + 2)
              const ev = (block.match(/^event: (.+)$/m) || [])[1]
              const data = (block.match(/^data: (.+)$/m) || [])[1]
              if (ev) events.push({ ev, data: data ? JSON.parse(data) : null })
            }
          })
          resolve()
        })
        req.on('error', reject)
      })
      const waitFor = async (pred, ms = 3000) => {
        const end = Date.now() + ms
        while (Date.now() < end) {
          if (events.some(pred)) return true
          await new Promise((r) => setTimeout(r, 20))
        }
        return false
      }
      assert.ok(await waitFor((e) => e.ev === 'runs'), 'esperava o evento runs inicial')
      const first = events.find((e) => e.ev === 'runs')
      assert.equal(first.data.runs.length, 3)
      // deixa o poller registrar o estado inicial antes de mexer no journal
      await new Promise((r) => setTimeout(r, 250))
      const journal = path.join(runDirOf(projectsDir, 'wf_aaaa0000-alfa-ativo'), 'journal.jsonl')
      fs.appendFileSync(
        journal,
        JSON.stringify({ type: 'result', key: 'v2:0004' + 'c'.repeat(60), agentId: 'c0004ccccccccccccc', result: { status: 'done', summary: 'x', checks: [] } }) + '\n',
      )
      assert.ok(await waitFor((e) => e.ev === 'run' && e.data && e.data.wf === 'wf_aaaa0000-alfa-ativo'), `esperava run com o wf; veio ${JSON.stringify(events.map((e) => e.ev))}`)
    } finally {
      if (req) req.destroy()
      await panel.close()
    }
  })
})

describe('painel web: descoberta v2 e bloqueio 6C3', () => {
  test('mescla fixture no formato real, projeta dados seguros e não expõe ações nem grava fila', async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-eng-ui-v2-'))
    const projectsDir = copyMulti()
    const stateDir = path.join(base, 'state')
    const configPath = path.join(stateDir, 'config.json')
    const cwd = path.join(base, 'workspace')
    const runDir = path.join(cwd, '.graph-runs', 'opaque-run')
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(path.join(runDir, '.graph-eng-state-root'), 'graph-eng trusted run state v2\n', { mode: 0o600 })
    fs.writeFileSync(path.join(runDir, 'identity.json'), JSON.stringify({ schemaVersion: 2, runId: 'opaque-run' }) + '\n', { mode: 0o600 })
    fs.writeFileSync(path.join(runDir, 'run.meta.json'), JSON.stringify({ schemaVersion: 2, runId: 'opaque-run', host: 'codex', cwd, runDir, task: 'Tarefa v2 fixture' }) + '\n', { mode: 0o600 })
    const registered = await registerRun({ stateDir, cwd, runDir, runId: 'opaque-run', host: 'codex' })
    assert.equal(registered.registered, true)
    const feedback = { kind: 'BLOCK', reason: 'receipt pendente', severity: 'high', affectedNodes: ['A1'], evidenceIds: ['receipt-1'] }
    const agentA = 'a' + '1'.repeat(16)
    const agentB = 'a' + '2'.repeat(16)
    const agentC = 'a' + '3'.repeat(16)
    const agentD = 'a' + '4'.repeat(16)
    const keyA = 'v2:' + 'a'.repeat(32)
    const keyB = 'v2:' + 'b'.repeat(32)
    const keyC = 'v2:' + 'c'.repeat(32)
    const keyD = 'v2:' + 'd'.repeat(32)
    const events = [
      { type: 'started', agentId: agentA, key: keyA, payload: { role: 'executor', model: 'alias-nao-usado-como-efetivo', requestedModel: 'modelo-solicitado', effectiveModel: null } },
      { type: 'result', agentId: agentA, key: keyA, payload: { role: 'executor', model: 'alias-nao-usado-como-efetivo', requestedModel: 'modelo-solicitado', effectiveModel: null, usage: { input_tokens: 12, output_tokens: 3 }, feedback, checkId: 'check-1', identity: 'a'.repeat(64), valid: false } },
      { type: 'started', agentId: agentB, key: keyB, payload: { role: 'executor', requestedModel: 'modelo-solicitado', effectiveModel: null } },
      { type: 'result', agentId: agentB, key: keyB, payload: { role: 'executor', usage: { input_tokens: 5 } } },
      { type: 'started', agentId: agentC, key: keyC, payload: { role: 'planner', requestedModel: 'modelo-falha', effectiveModel: null } },
      { type: 'failed', agentId: agentC, key: keyC, payload: { role: 'planner', model: 'modelo-falha' } },
      { type: 'started', agentId: agentD, key: keyD, payload: { role: 'executor', requestedModel: 'modelo-zero', effectiveModel: null } },
      { type: 'result', agentId: agentD, key: keyD, payload: { role: 'executor', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
    ].map((event, index) => ({ schemaVersion: 2, runId: 'opaque-run', seq: index + 1, at: `2026-10-18T04:00:0${index}.000Z`, planVersion: 2, ...event }))
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 })
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ schemaVersion: 2, runId: 'opaque-run', lastSeq: events.length, planVersion: 2, feedback }) + '\n', { mode: 0o600 })
    const identityBefore = fs.readFileSync(path.join(runDir, 'identity.json'))
    const panel = await ensurePanel({ port: 0, projectsDir, pollMs: 100, configPath, stateDir })
    t.after(async () => {
      await panel.close()
      fs.rmSync(base, { recursive: true, force: true })
      fs.rmSync(projectsDir, { recursive: true, force: true })
    })

    const listing = await getJson(panel.port, '/api/runs')
    const v2Run = listing.json.runs.find((run) => run.generation === 'v2')
    assert.equal(listing.json.runs.filter((run) => run.generation === 'legacy').length, 3)
    assert.ok(v2Run)
    assert.match(v2Run.wf, /^v2-[a-f0-9]{64}$/)
    assert.equal(v2Run.runId, 'opaque-run')
    assert.equal(v2Run.status, 'desconhecida')
    assert.equal(v2Run.runDir, null)
    assert.equal(v2Run.wf.startsWith('wf_'), false)

    const detail = await getJson(panel.port, `/api/runs/${v2Run.wf}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.json.generation, 'v2')
    assert.equal(detail.json.status, 'desconhecida')
    assert.equal(detail.json.v2.planVersion, 2)
    assert.equal(detail.json.v2.feedback.kind, 'BLOCK')
    assert.match(detail.json.v2.supportWarning, /Os dados por nó e de preservação ainda não estão disponíveis/)
    assert.match(detail.json.goal, /Dados de preservação e invalidação indisponíveis para esta execução/)
    assert.doesNotMatch(detail.json.goal, /contrato B3|supervisor/)
    assert.match(detail.json.stop.text, /status final desta execução ainda não está disponível/)
    assert.equal(detail.json.v2.callCount, 4, 'started/result/failed da mesma agentId contam uma chamada cada')
    assert.deepEqual(detail.json.v2.roleCounts, [{ role: 'executor', count: 3 }, { role: 'planner', count: 1 }])
    assert.equal(detail.json.v2.usage.inputTokens, 17)
    assert.equal(detail.json.v2.usage.outputTokens, 3)
    assert.equal(detail.json.v2.usage.totalTokens, 0, 'zero informado é dado observado, não ausência')
    assert.equal(detail.json.v2.usage.partial, true, 'uso do segundo result e da chamada com falha não pode parecer completo')
    assert.deepEqual(detail.json.v2.usage.coverage.inputTokens, { observedCalls: 3, totalCalls: 4 })
    assert.deepEqual(detail.json.v2.usage.coverage.outputTokens, { observedCalls: 2, totalCalls: 4 })
    assert.deepEqual(detail.json.v2.usage.coverage.totalTokens, { observedCalls: 1, totalCalls: 4 })
    assert.equal(detail.json.v2.modelCounts.some((item) => item.label.includes('solicitado · modelo-solicitado')), true)
    assert.equal(detail.json.v2.modelCounts.some((item) => item.label.includes('efetivo · não informado')), true)
    assert.equal(detail.json.actions, undefined, 'o Modelo não traz mais ações (painel só de visualização)')
    assert.equal(JSON.stringify(detail.json).includes('alias-nao-usado-como-efetivo'), false)
    const gone = await request(panel.port, 'POST', '/api/requests', { Origin: `http://127.0.0.1:${panel.port}`, 'Content-Type': 'application/json' }, JSON.stringify({ type: 'stop', wf: v2Run.wf }))
    assert.equal(gone.status, 405, 'a rota de pedidos saiu do painel: POST fora das rotas de escrita é 405 (só leitura)')
    const org = await request(panel.port, 'POST', '/api/org/delete', { Origin: `http://127.0.0.1:${panel.port}`, 'Content-Type': 'application/json' }, JSON.stringify({ wf: v2Run.wf, confirm: 'opaque-run' }))
    assert.equal(org.status, 409)
    assert.match(org.json.error, /Exclusão física.*bloqueada/)
    const pin = await request(panel.port, 'POST', '/api/org/pin', { Origin: `http://127.0.0.1:${panel.port}`, 'Content-Type': 'application/json' }, JSON.stringify({ wf: v2Run.wf, pinned: true }))
    assert.equal(pin.status, 409)
    assert.equal(fs.existsSync(path.join(stateDir, 'requests')), false)
    assert.deepEqual(fs.readFileSync(path.join(runDir, 'identity.json')), identityBefore)
  })
})

describe('painel web: CLI `ui` e instância única (itens 1, 2)', () => {
  test('segundo `ui` na mesma porta imprime a mesma URL e sai 0 sem subir outro', async () => {
    const projectsDir = copyMulti()
    const first = spawnUi(['--port', '0', '--projects-dir', projectsDir])
    try {
      const { url, port } = await first.urlReady
      assert.equal(url, `http://127.0.0.1:${port}`)
      const second = spawnUi(['--port', String(port), '--projects-dir', projectsDir])
      const code = await second.exited
      assert.equal(code, 0, second.out().stderr)
      assert.match(second.out().stdout, new RegExp(`graph-eng: painel: http://127\\.0\\.0\\.1:${port}\\b`))
      // o primeiro segue de pé
      assert.equal((await getJson(port, '/api/health')).json.app, 'graph-watch')
    } finally {
      first.child.kill('SIGTERM')
      await first.exited
    }
  })

  test('porta ocupada por outro programa → `graph-eng: erro:` e código ≠ 0', async () => {
    const other = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"app":"outro"}')
    })
    await new Promise((r) => other.listen(0, '127.0.0.1', r))
    const port = other.address().port
    try {
      const ui = spawnUi(['--port', String(port), '--projects-dir', copyMulti()])
      const code = await ui.exited
      assert.notEqual(code, 0)
      assert.match(ui.out().stderr, /graph-eng: erro: .*porta/)
    } finally {
      await new Promise((r) => other.close(r))
    }
  })

  test('--port inválida → erro de uso, código ≠ 0', async () => {
    const ui = spawnUi(['--port', 'abc'])
    const code = await ui.exited
    assert.notEqual(code, 0)
    assert.match(ui.out().stderr, /graph-eng: /)
  })

  test('--detach sai 0 com o servidor de pé em outro processo, e --stop derruba ele', async () => {
    const state = tmpState()
    const run = (args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN, 'ui', '--no-open', ...args], { cwd: ROOT, env: { ...process.env, GRAPH_ENG_CONFIG: state.configPath, GRAPH_ENG_STATE_DIR: state.dir } })
        let stdout = ''
        child.stdout.on('data', (d) => (stdout += d))
        child.on('close', (code) => resolve({ code, stdout, pid: child.pid }))
      })
    const up = await run(['--detach', '--port', '0', '--projects-dir', copyMulti()])
    assert.equal(up.code, 0)
    const port = Number(up.stdout.match(/graph-eng: painel: http:\/\/127\.0\.0\.1:(\d+)/)[1])
    const health = (await getJson(port, '/api/health')).json
    assert.equal(health.app, 'graph-watch')
    assert.notEqual(health.pid, up.pid)
    assert.match(fs.readFileSync(path.join(state.dir, 'painel.log'), 'utf8'), /graph-eng: painel:/)

    const again = await run(['--detach', '--port', String(port)])
    assert.equal(again.code, 0)
    assert.match(again.stdout, new RegExp(`graph-eng: painel: http://127\\.0\\.0\\.1:${port}\\b`))

    const down = await run(['--stop', '--port', String(port)])
    assert.equal(down.code, 0)
    assert.match(down.stdout, new RegExp(`painel parado \\(pid ${health.pid}\\)`))
    await new Promise((r) => setTimeout(r, 300))
    assert.throws(() => process.kill(health.pid, 0))
  })
})

describe('`live --svg` vira alias do painel (item 9)', () => {
  test('imprime a URL com ?run=<wf> e segue como live, sem D2', async () => {
    const projectsDir = copyMulti()
    // porta ocupada por um graph-watch já de pé: o live --svg reaproveita e não sobe outro.
    const panel = await ensurePanel({ port: 0, projectsDir, pollMs: 100, configPath: tmpState().configPath })
    try {
      const runDir = runDirOf(projectsDir, 'wf_aaaa0000-alfa-ativo')
      const child = spawn(process.execPath, [BIN, 'live', '--svg', '--run-dir', runDir, '--port', String(panel.port), '--projects-dir', projectsDir, '--no-color'], { cwd: ROOT, env: tmpEnv() })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !(/\?run=wf_aaaa0000-alfa-ativo/.test(out) && /graph-eng · wf_aaaa0000-alfa-ativo/.test(out))) {
        await new Promise((r) => setTimeout(r, 20))
      }
      child.kill('SIGTERM')
      await new Promise((r) => child.on('close', r))
      assert.match(out, new RegExp(`http://127\\.0\\.0\\.1:${panel.port}/\\?run=wf_aaaa0000-alfa-ativo`))
      assert.match(out, /graph-eng · wf_aaaa0000-alfa-ativo/)
      assert.doesNotMatch(out, /\bd2\b/i)
    } finally {
      await panel.close()
    }
  })
})

describe('painel web: resumo v2 com reparos, replanejamentos, feedback, memória e status terminal', () => {
  test('conta reparos e replanos pelos control.transition, lista feedback e memória só por ID e mostra concluída', async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-eng-ui-v2-resumo-'))
    const projectsDir = copyMulti()
    const stateDir = path.join(base, 'state')
    const configPath = path.join(stateDir, 'config.json')
    const cwd = path.join(base, 'workspace')
    const runDir = path.join(cwd, '.graph-runs', 'resumo-run')
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(path.join(runDir, '.graph-eng-state-root'), 'graph-eng trusted run state v2\n', { mode: 0o600 })
    fs.writeFileSync(path.join(runDir, 'identity.json'), JSON.stringify({ schemaVersion: 2, runId: 'resumo-run' }) + '\n', { mode: 0o600 })
    fs.writeFileSync(path.join(runDir, 'run.meta.json'), JSON.stringify({ schemaVersion: 2, runId: 'resumo-run', host: 'codex', cwd, runDir, task: 'Tarefa resumo' }) + '\n', { mode: 0o600 })
    const registered = await registerRun({ stateDir, cwd, runDir, runId: 'resumo-run', host: 'codex' })
    assert.equal(registered.registered, true)
    const selA = `sel-${'a'.repeat(64)}`
    const selB = `sel-${'b'.repeat(64)}`
    const agent = 'a' + '1'.repeat(16)
    const events = [
      { type: 'started', agentId: agent, key: 'v2:' + 'a'.repeat(32), planVersion: 1, payload: { role: 'executor' } },
      { type: 'control.transition', planVersion: 1, payload: { stage: 'plan-approved' } },
      { type: 'control.transition', planVersion: 2, payload: { stage: 'plan-approved', previousPlanVersion: 1 } },
      { type: 'control.transition', planVersion: 2, payload: { stage: 'design-fix-intent' } },
      { type: 'control.transition', planVersion: 3, payload: { stage: 'plan-approved', previousPlanVersion: 2 } },
      { type: 'result', agentId: agent, key: 'v2:' + 'a'.repeat(32), planVersion: 3, payload: { role: 'critic', feedback: { kind: 'FIX_LOCAL', reason: '<script>x</script> falha', severity: 'medium', affectedNodes: ['A1'] } } },
      { type: 'memory.selected', planVersion: 3, payload: { role: 'planner', selectionId: selA, records: [{ id: 'mem-1' }], summary: 'texto livre não aparece' } },
      { type: 'memory.selected', planVersion: 3, payload: { role: 'worker', selectionId: selB, reused: true } },
      { type: 'run.finished', planVersion: 3, payload: { status: 'done', feedback: { kind: 'DONE', reason: 'concluído' } } },
    ].map((event, index) => ({ schemaVersion: 2, runId: 'resumo-run', seq: index + 1, at: `2026-10-18T05:00:0${index}.000Z`, ...event }))
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 })
    const panel = await ensurePanel({ port: 0, projectsDir, pollMs: 100, configPath, stateDir })
    t.after(async () => {
      await panel.close()
      fs.rmSync(base, { recursive: true, force: true })
      fs.rmSync(projectsDir, { recursive: true, force: true })
    })

    const listing = await getJson(panel.port, '/api/runs')
    const v2Run = listing.json.runs.find((run) => run.generation === 'v2')
    assert.ok(v2Run)
    assert.equal(v2Run.status, 'concluída')
    const detail = await getJson(panel.port, `/api/runs/${v2Run.wf}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.json.status, 'concluída')
    assert.equal(detail.json.statusReason, 'run_finished_event')
    assert.equal(detail.json.v2.repairs, 1, 'um design-fix-intent conta como reparo')
    assert.equal(detail.json.v2.replans, 2, 'dois plan-approved com previousPlanVersion são replanos')
    assert.deepEqual(detail.json.v2.feedbackHistory.map((item) => item.kind), ['FIX_LOCAL', 'DONE'])
    assert.equal(detail.json.v2.feedbackHistory[0].reason, '<script>x</script> falha', 'texto de feedback é dado, a página o exibe como texto')
    assert.equal(detail.json.v2.feedbackHistory[0].severity, 'medium')
    assert.deepEqual(detail.json.v2.feedbackHistory[0].affectedNodes, ['A1'])
    assert.equal(detail.json.v2.memorySelections.total, 2)
    assert.deepEqual(detail.json.v2.memorySelections.byRole, [{ role: 'planner', count: 1 }, { role: 'worker', count: 1 }])
    assert.deepEqual(detail.json.v2.memorySelections.selectionIds, [selA, selB])
    assert.equal(detail.json.v2.memorySelections.reused, 1)
    assert.equal(JSON.stringify(detail.json).includes('texto livre não aparece'), false)
    assert.match(detail.json.goal, /Reparos 1 · Replanejamentos 2/)
    assert.doesNotMatch(detail.json.goal, /Reparos e replanejamentos ainda não estão disponíveis/)
    assert.equal(detail.json.actions, undefined, 'o Modelo não traz ações, nem com status terminal')
  })
})
