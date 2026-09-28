// Testes estáticos da página do painel (bin/ui/) — item 7 da spec docs/specs/2026-09-27-painel-web.md.
// Não sobem servidor: só leem os arquivos e conferem as invariantes de segurança/contrato visual.

import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.join(__dirname, '..', 'bin', 'ui')

const html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8')
// contrato visual lido da fonte (Tailwind); bin/ui/style.css é o gerado, conferido no fim deste arquivo
const css = fs.readFileSync(path.join(UI_DIR, 'src', 'style.css'), 'utf8')
const builtCss = fs.readFileSync(path.join(UI_DIR, 'style.css'), 'utf8')
const layout = fs.readFileSync(path.join(UI_DIR, 'graph-layout.mjs'), 'utf8')
const theme = fs.readFileSync(path.join(UI_DIR, 'theme.js'), 'utf8')
const configModal = fs.readFileSync(path.join(UI_DIR, 'config-modal.mjs'), 'utf8')
const agentTarget = fs.readFileSync(path.join(UI_DIR, 'agent-target.mjs'), 'utf8')
const favicon = fs.readFileSync(path.join(UI_DIR, 'favicon.svg'), 'utf8')
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'bin', 'ui-server.mjs'), 'utf8')
const graphHtml = html.slice(html.indexOf('<div id="graph">'), html.indexOf('<ul id="legend">'))

test('app.js, graph-layout.mjs, theme.js e config-modal.mjs não usam innerHTML (sem innerHTML nenhum)', () => {
  assert.equal(/innerHTML/.test(js + layout + theme + configModal), false)
})

test('index.html referencia só arquivos locais: theme.js antes do CSS, app.js como módulo', () => {
  const scriptSrcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1])
  const linkHrefs = [...html.matchAll(/<link[^>]*\shref="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(scriptSrcs, ['/theme.js', '/app.js'])
  assert.match(html, /<script type="module" src="\/app.js">/)
  assert.ok(html.indexOf('/theme.js') < html.indexOf('/style.css'), 'o tema tem que ser aplicado antes do CSS pintar')
  assert.deepEqual(linkHrefs, ['/favicon.svg', '/style.css'])
  assert.equal(/https?:\/\//.test(html), false)
})

test('nenhuma URL externa (CDN) em bin/ui; fontes servidas pelo próprio painel', () => {
  // O namespace XML do SVG (`http://www.w3.org/2000/svg`) não é uma busca de rede e fica de fora.
  // comentário (o cabeçalho de licença do Tailwind cita o site) não é busca de rede e fica de fora
  for (const src of [html, js, css, builtCss, layout, theme, configModal, agentTarget, favicon]) {
    const withoutSvgNs = src.replaceAll('http://www.w3.org/2000/svg', '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.equal(/https?:\/\//.test(withoutSvgNs), false)
  }
  for (const m of css.matchAll(/url\('([^']+)'\)/g)) {
    assert.match(m[1], /^\/fonts\/[a-z-]+\.woff2$/)
    assert.ok(fs.existsSync(path.join(UI_DIR, m[1])), `${m[1]} não existe em bin/ui`)
  }
  assert.ok(fs.existsSync(path.join(UI_DIR, 'fonts', 'OFL.txt')), 'licença das fontes ausente')
})

test('sem caminho absoluto da máquina em bin/ui', () => {
  for (const src of [html, js, css, layout, theme, configModal, agentTarget]) {
    assert.equal(/\/Users\/|\/Volumes\//.test(src), false)
  }
})

test('tema claro/escuro: tokens por data-theme, switch acessível, escolha salva e padrão do sistema', () => {
  assert.match(css, /:root\[data-theme='dark'\]\s*\{/)
  assert.match(html, /id="theme-switch"[^>]*class="switch"[^>]*role="switch"[^>]*aria-checked=/)
  assert.match(theme, /prefers-color-scheme: dark/)
  assert.match(theme, /localStorage\.getItem/)
  // localStorage pode lançar (navegação privada, site bloqueado): leitura e escrita protegidas
  assert.equal((theme.match(/localStorage\./g) || []).length, (theme.match(/try \{\s*(var v = )?localStorage\./g) || []).length)
  assert.match(configModal, /aria-checked/)
})

test('modal de engrenagem: botão na lateral, dialog com as quatro seções e tema saiu do rodapé', () => {
  assert.match(html, /<button id="settings-open"[^>]*aria-haspopup="dialog"[^>]*aria-controls="settings"/)
  assert.match(html, /<dialog id="settings"[^>]*aria-labelledby="settings-title"[^>]*aria-describedby="settings-desc"/)
  const dialogOpen = html.indexOf('<dialog id="settings"')
  const dialogClose = html.indexOf('</dialog>')
  assert.ok(dialogOpen >= 0 && dialogClose > dialogOpen, 'dialog#settings não encontrado')
  const dialogHtml = html.slice(dialogOpen, dialogClose)
  for (const legend of ['Agentes', 'Modelos', 'Execução', 'Aparência']) {
    assert.ok(dialogHtml.includes(`<legend>${legend}</legend>`), `seção "${legend}" ausente no modal`)
  }
  // o switch de tema saiu de #sidebar-foot e mora dentro do dialog
  const footOpen = html.indexOf('<div id="sidebar-foot">')
  const footClose = html.indexOf('</div>', footOpen)
  assert.equal(html.slice(footOpen, footClose).includes('theme-switch'), false, '#theme-switch ainda está em #sidebar-foot')
  const themeIdx = html.indexOf('id="theme-switch"')
  assert.ok(themeIdx > dialogOpen && themeIdx < dialogClose, '#theme-switch devia estar dentro do dialog#settings')
  assert.equal(footClose < dialogOpen, true, '#sidebar-foot devia vir antes do dialog#settings')
})

test('config-modal.mjs: importa a fórmula, prende o foco, fecha com Esc/animação e mostra a config sem HTML bruto', () => {
  assert.match(configModal, /from '\.\/agent-target\.mjs'/)
  assert.match(configModal, /'cancel'/)
  assert.match(configModal, /'Tab'/)
  assert.match(configModal, /showModal/)
  assert.match(configModal, /\.focus\(/)
  assert.match(configModal, /aria-checked/)
})

test('app.js não referencia mais o switch de tema direto; a lógica mora no modal', () => {
  assert.equal(/theme-switch/.test(js), false)
  assert.match(js, /initSettings/)
  assert.match(js, /from '\.\/config-modal\.mjs'/)
})

test('bin/ui/style.css (gerado) prova que o css:build rodou depois do modal', () => {
  assert.match(builtCss, /#settings\b/)
  assert.match(builtCss, /--scrim/)
})

test('/config-modal.mjs está no STATIC do servidor e o arquivo existe em bin/ui/', () => {
  assert.match(serverSrc, /'\/config-modal\.mjs'/)
  assert.ok(fs.existsSync(path.join(UI_DIR, 'config-modal.mjs')))
})

test('lateral e gaveta são cards que abrem e fecham com transição (sem display: none, que corta a saída)', () => {
  assert.match(html, /id="rail-close"[^>]*aria-controls="rail"[^>]*aria-expanded=/)
  assert.match(html, /id="rail-open"[^>]*aria-controls="rail"[^>]*aria-expanded=/)
  assert.equal(/id="drawer"[^>]*hidden/.test(html), false)
  assert.match(theme, /graphEngRail/)
  assert.match(css, /:root\[data-rail='closed'\] #rail\s*\{[^}]*visibility: hidden/)
  assert.match(css, /#app\[data-drawer='closed'\] #drawer\s*\{[^}]*visibility: hidden/)
  // o grafo desliza junto quando um card abre ou fecha
  assert.match(css, /\.node\s*\{[^}]*transition:[^}]*left var\(--dur\)/)
  assert.match(js, /reserveLeft: railIsOpen\(\)/)
})

test('style.css tem a animação da bolinha, o estado congelado e reduced-motion', () => {
  // nome próprio: `pulse` é do Tailwind (animate-pulse) e substituiria o do painel
  assert.match(css, /@keyframes node-glow/)
  assert.match(builtCss, /@keyframes node-glow/)
  assert.match(css, /#graph\[data-status='parada\?'\] \.node\[data-variant='running'\]/)
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

test('grafo em HTML: arestas são div.edge, sem SVG nem canvas (SVG só no logo)', () => {
  assert.ok(graphHtml.length > 0)
  assert.equal(/<svg|<canvas/.test(graphHtml), false)
  assert.equal(/createElementNS|getContext\(/.test(js), false)
  assert.match(css, /\.edge\s*\{/)
  assert.match(js, /el\('div', 'edge'\)/)
})

test('graph-layout.mjs mapeia todos os estados do modelo para uma das variantes visuais', async () => {
  const { VARIANT } = await import('../bin/ui/graph-layout.mjs')
  const states = ['trabalhando', 'verificando', 'reparando', 'pronto', 'pronto-sem-verif', 'pronto-sem-verif?', 'sem-reverificacao', 'falhou', 'falhou-check', 'bloqueado', 'erro', 'aguardando', 'pulado']
  for (const s of states) assert.ok(VARIANT[s], `estado ${s} sem variante`)
})

test('#lanes, #edges e #nodes dividem o mesmo wrapper #graph (uma origem só), nessa ordem de pintura', () => {
  const m = html.match(/<div id="graph">\s*<div id="lanes"[^>]*><\/div>\s*<div id="edges"[^>]*><\/div>\s*<div id="nodes"><\/div>\s*<\/div>/)
  assert.ok(m, 'index.html precisa de #graph envolvendo #lanes, #edges e #nodes')
  assert.match(css, /#graph\s*\{[^}]*position:\s*relative/)
})

test('bolinha e aresta: left/top do nó é o centro, a aresta vai de centro a centro', () => {
  // o CSS centra a bolinha no ponto (margens negativas de metade do diâmetro) e a aresta gira pela ponta
  assert.match(css, /\.node \.dot\s*\{[^}]*margin:\s*calc\(var\(--d\) \/ -2\) 0 0 calc\(var\(--d\) \/ -2\)/)
  assert.match(css, /\.edge\s*\{[^}]*transform-origin:\s*0 50%/)
  // anel e brilho ficam atrás da bolinha mas na frente das arestas
  assert.match(css, /\.node\s*\{[^}]*isolation:\s*isolate/)
})

test('elementos do grafo e da lateral são reconciliados por chave, nunca recriados em bloco', () => {
  // replaceChildren() em #nodes/#edges/#sidebar reinicia a animação da bolinha e perde o foco
  assert.equal(/els\.(nodes|edges|lanes|sidebar)\.replaceChildren/.test(js), false)
  assert.match(js, /function reconcile\(/)
})

test('bin/ui/style.css (gerado) está em dia com bin/ui/src/style.css', { skip: !fs.existsSync(path.join(UI_DIR, '..', '..', 'node_modules', '.bin', 'tailwindcss')) && 'sem node_modules (rode npm install)' }, () => {
  const root = path.join(UI_DIR, '..', '..')
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ge-css-')), 'style.css')
  execFileSync(path.join(root, 'node_modules', '.bin', 'tailwindcss'), ['-i', 'bin/ui/src/style.css', '-o', out], { cwd: root, stdio: 'pipe' })
  assert.equal(fs.readFileSync(out, 'utf8'), builtCss, 'rode npm run css:build e versione bin/ui/style.css')
})

test('loadDetail mapeia polish:<k> para o id da API polish-<k> (como critic: → critic)', () => {
  assert.match(js, /id\.startsWith\('polish:'\)\s*\?\s*`polish-\$\{id\.slice\('polish:'\.length\)\}`/)
})

test('nó injetado: setData leva injected e a gaveta mostra o motivo', () => {
  assert.match(js, /injected: v\.injected \? '1' : ''/)
  assert.match(js, /injetado pelo motor: \$\{detail\.reason \|\| ''\}/)
})

test('style.css: nó injetado tem contorno tracejado com --accent; design-review e polish nas listas de pseudo-kind', () => {
  assert.match(css, /\.node\[data-injected='1'\] \.dot\s*\{[^}]*outline:[^}]*dashed var\(--accent\)/)
  assert.match(builtCss, /\.node\[data-injected='1'\]/)
  for (const kind of ['design-review', 'polish']) {
    assert.ok(css.includes(`[data-kind='${kind}']`), `falta [data-kind='${kind}'] em style.css`)
  }
})

test('tokens do painel viram utilitários do Tailwind e dark: segue o switch de tema', () => {
  assert.match(css, /@import 'tailwindcss'/)
  assert.match(css, /@custom-variant dark \(&:where\(\[data-theme='dark'\]/)
  for (const t of ['bg', 'fg', 'fg3', 'surface', 'line', 'accent', 'red']) assert.match(css, new RegExp(`--color-${t}: var\\(--${t}\\)`))
})
