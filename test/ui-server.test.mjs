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
  const child = spawn(process.execPath, [BIN, 'ui', '--no-open', ...args], { cwd: ROOT, env: { ...process.env } })
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
    panel = await ensurePanel({ port: 0, projectsDir, pollMs: 100 })
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
    writeConfig(configPath, { stallMinutes: 1 })
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

  test('GET sem arquivo: config efetiva de fábrica (24/auto), limites e origem default', async () => {
    const r = await request(port, 'GET', '/api/config')
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /application\/json/)
    assert.equal(r.headers['access-control-allow-origin'], undefined)
    assert.equal(r.json.config.ceiling, 24)
    assert.equal(r.json.config.effort, 'auto')
    assert.equal(r.json.source.ceiling, 'default')
    assert.equal(r.json.limits.ceiling.min, 8)
    assert.equal(r.json.limits.ceiling.max, 100)
    assert.deepEqual(r.json.defaults, { effort: 'auto', ceiling: 24, economy: 'balanced', planGate: false, maxRounds: 3, maxRepairs: 2, stallMinutes: 5 })
    assert.deepEqual(r.json.warnings, [])
    assert.equal(fs.existsSync(configPath), false, 'GET não grava nada')
  })

  test('PUT válido grava o arquivo (atômico, sem sobra de tmp) e o GET seguinte mostra origem config', async () => {
    const r = await put({ ceiling: 30, effort: 'high' })
    assert.equal(r.status, 200, r.body)
    assert.equal(r.json.config.ceiling, 30)
    assert.equal(r.json.config.effort, 'high')
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { effort: 'high', ceiling: 30 })
    assert.deepEqual(fs.readdirSync(cfgDir), ['config.json'])
    const g = await request(port, 'GET', '/api/config')
    assert.equal(g.json.source.ceiling, 'config')
    assert.equal(g.json.source.economy, 'default')
    // localhost também é origem do painel; charset no Content-Type é aceito; PUT substitui (effort volta ao padrão)
    const l = await request(port, 'PUT', '/api/config', { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Content-Type': 'application/json; charset=utf-8' }, '{"ceiling":40}')
    assert.equal(l.status, 200, l.body)
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { ceiling: 40 })
    assert.equal(l.json.source.effort, 'default')
    // C6: stallMinutes (padrão de parada) grava e volta como número
    const s = await put({ stallMinutes: 12 })
    assert.equal(s.status, 200, s.body)
    assert.equal(s.json.config.stallMinutes, 12)
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { stallMinutes: 12 })
  })

  test('PUT com Origin ausente, null, de fora ou de outra porta → 403 e o arquivo fica igual', async () => {
    const before = snapshot()
    for (const o of [undefined, 'null', 'http://evil.example', 'http://127.0.0.1:1', `https://127.0.0.1:${port}`]) {
      const headers = { 'Content-Type': 'application/json' }
      if (o !== undefined) headers.Origin = o
      const r = await request(port, 'PUT', '/api/config', headers, '{"ceiling":50}')
      assert.equal(r.status, 403, `esperava 403 para Origin ${o}`)
      assert.equal(r.json.error, 'Origin não permitido')
    }
    assert.deepEqual(snapshot(), before)
  })

  test('PUT com Host de fora → 403 (antes de tudo), mesmo com corpo e Origin válidos', async () => {
    const before = snapshot()
    const r = await put({ ceiling: 50 }, { Host: 'evil.example' })
    assert.equal(r.status, 403)
    assert.equal(r.json.error, 'Host não permitido')
    assert.deepEqual(snapshot(), before)
  })

  test('PUT com Content-Type que não é JSON → 415', async () => {
    const before = snapshot()
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
      const headers = { Origin: origin }
      if (ct) headers['Content-Type'] = ct
      const r = await request(port, 'PUT', '/api/config', headers, '{"ceiling":50}')
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
    const low = await put({ ceiling: 7 })
    assert.equal(low.status, 400)
    assert.equal(low.json.error, 'config inválida')
    assert.equal(low.json.fields.ceiling, 'mínimo 8')
    assert.equal((await put({ ceiling: 101 })).json.fields.ceiling, 'máximo 100')
    assert.equal((await put({ ceiling: '24' })).json.fields.ceiling, 'use um número inteiro')
    const unknown = await put({ foo: 1, ceiling: 30 })
    assert.equal(unknown.status, 400)
    assert.deepEqual(unknown.json.fields, { foo: 'campo desconhecido' })
    // C6: stallMinutes (padrão de parada) segue a mesma trava do resto da config
    assert.equal((await put({ stallMinutes: 0 })).json.fields.stallMinutes, 'de 1 a 60')
    assert.equal((await put({ stallMinutes: 61 })).json.fields.stallMinutes, 'de 1 a 60')
    const many = await put({ effort: 'xhigh', maxRounds: 9, planGate: 'sim' })
    assert.deepEqual(Object.keys(many.json.fields).sort(), ['effort', 'maxRounds', 'planGate'])
    assert.deepEqual(snapshot(), before, 'nada gravado em caminho de erro')
  })

  test('PUT com corpo acima de 4096 bytes → 413 (declarado ou em chunks) e o arquivo fica igual', async () => {
    const before = snapshot()
    const big = JSON.stringify({ ceiling: 30, pad: 'x'.repeat(5000) })
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
      const r = await request(port, m, '/api/config', { Origin: origin, 'Content-Type': 'application/json' }, '{"ceiling":50}')
      assert.equal(r.status, 405, m)
      assert.equal(r.headers.allow, 'GET, PUT')
      assert.equal(r.headers['access-control-allow-origin'], undefined)
    }
    for (const p of ['/api/runs', '/api/config/x', '/', '/api/health']) {
      const r = await request(port, 'PUT', p, { Origin: origin, 'Content-Type': 'application/json' }, '{"ceiling":50}')
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
    fs.writeFileSync(configPath, JSON.stringify({ ceiling: 5, economy: 'lean' }))
    const r = await request(port, 'GET', '/api/config')
    assert.equal(r.status, 200)
    assert.equal(r.json.config.ceiling, 24)
    assert.equal(r.json.config.economy, 'lean')
    assert.deepEqual(r.json.warnings, ['ceiling: mínimo 8 (ignorado)'])
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
    const panel = await ensurePanel({ port: 0, projectsDir, pollMs: 100 })
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
})

describe('`live --svg` vira alias do painel (item 9)', () => {
  test('imprime a URL com ?run=<wf> e segue como live, sem D2', async () => {
    const projectsDir = copyMulti()
    // porta ocupada por um graph-watch já de pé: o live --svg reaproveita e não sobe outro.
    const panel = await ensurePanel({ port: 0, projectsDir, pollMs: 100 })
    try {
      const runDir = runDirOf(projectsDir, 'wf_aaaa0000-alfa-ativo')
      const child = spawn(process.execPath, [BIN, 'live', '--svg', '--run-dir', runDir, '--port', String(panel.port), '--projects-dir', projectsDir, '--no-color'], { cwd: ROOT })
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
