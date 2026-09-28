// Testes estáticos da página do painel (bin/ui/) — item 7 da spec docs/specs/2026-09-27-painel-web.md.
// Não sobem servidor: só leem os três arquivos e conferem as invariantes de segurança/contrato visual.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.join(__dirname, '..', 'bin', 'ui')

const html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8')
const css = fs.readFileSync(path.join(UI_DIR, 'style.css'), 'utf8')
const layout = fs.readFileSync(path.join(UI_DIR, 'graph-layout.mjs'), 'utf8')

test('app.js e graph-layout.mjs não usam innerHTML (sem innerHTML nenhum)', () => {
  assert.equal(/innerHTML/.test(js + layout), false)
})

test('index.html referencia só app.js e style.css locais, sem URL externa', () => {
  const scriptSrcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1])
  const linkHrefs = [...html.matchAll(/<link[^>]*\shref="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(scriptSrcs, ['/app.js'])
  assert.match(html, /<script type="module" src="\/app.js">/)
  assert.deepEqual(linkHrefs, ['/style.css'])
  assert.equal(/https?:\/\//.test(html), false)
})

test('nenhuma URL externa (CDN) em bin/ui', () => {
  // O namespace XML do SVG (`http://www.w3.org/2000/svg`, exigido por createElementNS) não é uma
  // busca de rede e fica de fora desta checagem.
  for (const src of [html, js, css, layout]) {
    const withoutSvgNs = src.replaceAll('http://www.w3.org/2000/svg', '')
    assert.equal(/https?:\/\//.test(withoutSvgNs), false)
  }
})

test('sem caminho absoluto da máquina em bin/ui', () => {
  for (const src of [html, js, css, layout]) {
    assert.equal(/\/Users\/|\/Volumes\//.test(src), false)
  }
})

test('style.css tem @media (prefers-color-scheme: dark), a animação da bolinha e reduced-motion', () => {
  assert.match(css, /@media \(prefers-color-scheme: dark\)/)
  assert.match(css, /@keyframes pulse/)
  assert.match(css, /\[data-variant='running'\][^{]*\{[^}]*animation:/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
})

test('style.css estiliza as 5 variantes de bolinha por data-variant e a legenda usa as mesmas', () => {
  for (const v of ['empty', 'running', 'done', 'fail', 'skipped']) {
    assert.equal(css.includes(`[data-variant='${v}']`), true, `falta [data-variant='${v}'] em style.css`)
    assert.match(html, new RegExp(`class="dot" data-variant="${v}"`), `legenda sem ${v}`)
  }
})

test('empty-msg e conn não são filhos de run-header (renderHeader não pode apagá-los)', () => {
  const headerOpen = html.indexOf('<header id="run-header"')
  const headerClose = html.indexOf('</header>', headerOpen)
  assert.ok(headerOpen >= 0 && headerClose > headerOpen, 'header#run-header não encontrado')
  for (const id of ['empty-msg', 'conn']) {
    const idx = html.indexOf(`id="${id}"`)
    assert.ok(idx >= 0, `${id} não encontrado`)
    assert.ok(idx < headerOpen || idx > headerClose, `${id} está dentro de run-header`)
  }
})

test('arestas são div.edge (sem SVG nem canvas)', () => {
  assert.equal(/<svg|<canvas/.test(html), false)
  assert.equal(/createElementNS|getContext\(/.test(js), false)
  assert.match(css, /\.edge\s*\{/)
  assert.match(js, /el\('div', 'edge'\)/)
})

test('graph-layout.mjs mapeia todos os estados do modelo para uma das variantes visuais', async () => {
  const { VARIANT } = await import('../bin/ui/graph-layout.mjs')
  const states = ['trabalhando', 'verificando', 'reparando', 'pronto', 'pronto-sem-verif', 'pronto-sem-verif?', 'sem-reverificacao', 'falhou', 'falhou-check', 'bloqueado', 'erro', 'aguardando', 'pulado']
  for (const s of states) assert.ok(VARIANT[s], `estado ${s} sem variante`)
})

test('#edges e #nodes dividem o mesmo wrapper #graph (uma origem só para arestas e bolinhas)', () => {
  const m = html.match(/<div id="graph">\s*<div id="edges"[^>]*><\/div>\s*<div id="nodes"><\/div>\s*<\/div>/)
  assert.ok(m, 'index.html precisa de #graph envolvendo #edges e #nodes')
  assert.match(css, /#graph\s*\{[^}]*position:\s*relative/)
})

test('diâmetro da bolinha no CSS bate com LAYOUT.DOT (as arestas são aparadas por ele)', async () => {
  const { LAYOUT } = await import('../bin/ui/graph-layout.mjs')
  assert.match(css, new RegExp(`--dot:\\s*${LAYOUT.DOT}px`))
})

test('elementos do grafo e da lateral são reconciliados por chave, nunca recriados em bloco', () => {
  // replaceChildren() em #nodes/#edges/#sidebar reinicia a animação da bolinha e perde o foco
  assert.equal(/els\.(nodes|edges|sidebar)\.replaceChildren/.test(js), false)
  assert.match(js, /function reconcile\(/)
})
