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
const sidebar = fs.readFileSync(path.join(UI_DIR, 'sidebar.mjs'), 'utf8')
const confirmMod = fs.readFileSync(path.join(UI_DIR, 'confirm.mjs'), 'utf8')
const actionsMod = fs.readFileSync(path.join(UI_DIR, 'actions.mjs'), 'utf8')
const commandsMod = fs.readFileSync(path.join(UI_DIR, 'commands.mjs'), 'utf8')
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'bin', 'ui-server.mjs'), 'utf8')
const graphHtml = html.slice(html.indexOf('<div id="graph">'), html.indexOf('<ul id="legend">'))

test('app.js, graph-layout.mjs, theme.js, config-modal.mjs, sidebar.mjs, confirm.mjs e actions.mjs não usam innerHTML (sem innerHTML nenhum)', () => {
  assert.equal(/innerHTML/.test(js + layout + theme + configModal + sidebar + confirmMod + actionsMod), false)
})

test('sidebar.mjs, confirm.mjs e actions.mjs: sem createElementNS/getContext (SVG só no logo e no ícone estático)', () => {
  assert.equal(/createElementNS|getContext\(/.test(sidebar + confirmMod + actionsMod), false)
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
  for (const src of [html, js, css, builtCss, layout, theme, configModal, agentTarget, favicon, sidebar, confirmMod, actionsMod, commandsMod]) {
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
  for (const src of [html, js, css, layout, theme, configModal, agentTarget, sidebar, confirmMod, actionsMod, commandsMod]) {
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

// ── I6: lista lateral organizada (sidebar.mjs, confirm.mjs) — docs/specs/2026-09-28-acoes-no-painel.md C13 ──

test('sidebar.mjs e confirm.mjs existem em bin/ui/ e são servidos pela regra fechada dos módulos da UI (C10)', () => {
  assert.ok(fs.existsSync(path.join(UI_DIR, 'sidebar.mjs')))
  assert.ok(fs.existsSync(path.join(UI_DIR, 'confirm.mjs')))
  assert.match(serverSrc, /UI_MODULE_RE\s*=\s*\/\^\\\/\(\[a-z0-9-\]\+\\\.mjs\)\$\//)
})

test('app.js importa sidebar.mjs e confirm.mjs, e não reimplementa a lógica de seção/ordenação', () => {
  assert.match(js, /from '\.\/sidebar\.mjs'/)
  assert.match(js, /from '\.\/confirm\.mjs'/)
  assert.match(js, /buildSections\(/)
  assert.match(js, /openConfirm\(/)
})

test('index.html tem o cabeçalho da lista (busca, filtro, novo grupo), #run-lists e o dialog#confirm', () => {
  assert.match(html, /id="runs-search-btn"[^>]*aria-label="Buscar runs"/)
  assert.match(html, /id="runs-filter-btn"[^>]*aria-haspopup="menu"/)
  assert.match(html, /id="runs-new-group-btn"[^>]*aria-label="Novo grupo"/)
  assert.match(html, /id="run-lists"/)
  assert.match(html, /<dialog id="confirm"/)
  assert.match(html, /id="confirm-typed"/)
  assert.equal(/id="group-active"|id="group-done"/.test(html), false, 'as seções fixas antigas saíram; sidebar.mjs monta as seções dinamicamente')
})

test('sidebar.mjs exporta o contrato de C13/D4 §4.12', () => {
  assert.match(sidebar, /export const PAGE = 10/)
  assert.match(sidebar, /export const STEP = 20/)
  assert.match(sidebar, /export const STRIP_MAX = 10/)
  assert.match(sidebar, /export const DEFAULT_OPEN = /)
  assert.match(sidebar, /export function sectionOf\(/)
  assert.match(sidebar, /export function titleOf\(/)
  assert.match(sidebar, /export function metaOf\(/)
  assert.match(sidebar, /export function stripOf\(/)
  assert.match(sidebar, /export function buildSections\(/)
})

test('confirm.mjs exporta openConfirm no formato de C13/D4 §4.8', () => {
  assert.match(confirmMod, /export function openConfirm\(\{\s*title,\s*body,\s*typed = null,\s*check = null,\s*confirmText/)
})

test('accordion: seta com aria-expanded, giro em CSS e memória no localStorage (D4 §4.2)', () => {
  assert.match(js, /aria-expanded/)
  assert.match(js, /graph-eng-sections/)
  assert.match(css, /\.sec-toggle\[aria-expanded='true'\] \.chev/)
  assert.match(css, /\.chev\s*\{[^}]*transition: transform/)
})

test('run-row: bolinha + título + fileira, ⋯ no hover/foco, sem botão dentro de botão (D4 §4.4)', () => {
  assert.match(js, /class="run-row"|'run-row'/)
  assert.match(js, /row-dot/)
  assert.match(css, /\.run-row:hover \.run-more,\s*\n\s*\.run-row:focus-within \.run-more/)
  // .run-more nunca fica aninhado dentro de .run-btn (button dentro de button é inválido)
  const rowRowBlock = js.slice(js.indexOf("el('div', 'run-row')"), js.indexOf('function updateRunRow'))
  assert.doesNotMatch(rowRowBlock, /btn\.append\([^)]*more/)
})

test('drag and drop: dataTransfer com o mimetype do contrato (D4 §4.6)', () => {
  assert.match(js, /application\/x-graph-eng-run/)
})

test('updateSectionEl grava s.kind: sem isso onSectionDrop nunca reconhece uma seção de grupo (arrastar para grupo desagrupa/desfixa em vez de mover)', () => {
  const updateBlock = js.slice(js.indexOf('function updateSectionEl'), js.indexOf('function renderSectionActions'))
  assert.match(updateBlock, /s\.kind\s*=\s*sec\.kind/)
  const dropBlock = js.slice(js.indexOf('function onSectionDrop'), js.indexOf('function onSectionDrop') + 800)
  assert.match(dropBlock, /s\.kind === 'group'/)
})

test('organização chama as rotas POST /api/org/\\* (C10 O1-O9), nunca PUT nem GET para escrever', () => {
  for (const op of ['pin', '/api/org/groups', 'move', 'archive', 'delete', 'delete-finished']) {
    assert.ok(js.includes(op), `rota/operação ${op} não encontrada em app.js`)
  }
  assert.match(js, /method: 'POST'/)
})

// ── I7: ações da run (actions.mjs, commands.mjs) — docs/specs/2026-09-28-acoes-no-painel.md C14 ──

test('actions.mjs e commands.mjs existem em bin/ui/ e são servidos pela regra fechada dos módulos da UI (C10)', () => {
  assert.ok(fs.existsSync(path.join(UI_DIR, 'actions.mjs')))
  assert.ok(fs.existsSync(path.join(UI_DIR, 'commands.mjs')))
})

test('commands.mjs não importa bin/requests.mjs: no navegador isso resolveria para /requests.mjs (I5, pendência do I3)', () => {
  assert.equal(/from ['"]\.\.\/requests\.mjs['"]/.test(commandsMod), false)
  assert.match(commandsMod, /WF_RE\s*=\s*\/\^wf_/)
  assert.match(commandsMod, /NODE_RE\s*=/)
})

test('app.js importa actions.mjs e chama initActions/render/renderNodeActions, sem reimplementar a fila', () => {
  assert.match(js, /from '\.\/actions\.mjs'/)
  assert.match(js, /Actions\.initActions\(/)
  assert.match(js, /Actions\.render\(/)
  assert.match(js, /Actions\.renderNodeActions\(/)
})

test('index.html tem #run-actions, #act-why, #req-status fora de run-header, e o campo do limiar de parada no modal', () => {
  const headerOpen = html.indexOf('<header id="run-header"')
  const headerClose = html.indexOf('</header>', headerOpen)
  for (const id of ['run-actions', 'act-why', 'req-status']) {
    const idx = html.indexOf(`id="${id}"`)
    assert.ok(idx >= 0, `${id} não encontrado`)
    assert.ok(idx < headerOpen || idx > headerClose, `${id} está dentro de run-header`)
  }
  assert.match(html, /id="cfg-stall"[^>]*type="number"/)
  assert.match(html, /id="cfg-stall-err"[^>]*class="field-err"/)
})

test('config-modal.mjs lê e grava stallMinutes como os outros campos numéricos, com erro inline do PUT', () => {
  assert.match(configModal, /cfg-stall/)
  assert.match(configModal, /stallMinutes/)
  assert.match(configModal, /els\.stall\.value = String\(config\.stallMinutes\)/)
})

test('textos-chave das ações estão presentes (D3 §8.2)', () => {
  for (const text of [
    'Retomar',
    'Parar…',
    'Refazer nó…',
    'Refazer também os dependentes',
    'Copiar para retomar',
    'Copiar para parar',
    'Copiar para refazer',
    'sessão ouvindo',
    'nenhuma sessão ouvindo',
    'Artefatos',
    'Considerar parada depois de',
  ]) {
    assert.ok((actionsMod + html).includes(text), `texto "${text}" não encontrado em actions.mjs/index.html`)
  }
})

test('selo "retomado": chip-resumed só aparece com node.resumed === true (P3, herdado do I8)', () => {
  assert.match(actionsMod, /chip-resumed/)
  assert.match(actionsMod, /retomado/)
  assert.match(actionsMod, /node\.resumed === true/)
})

test('style.css (fonte e gerado) tem as classes novas do item 1/4/5 (C14 §4.8)', () => {
  for (const sel of ['.chip-listen', '.chip-reason', '#run-actions', 'pre.artifact', '.danger']) {
    assert.ok(css.includes(sel), `falta ${sel} em bin/ui/src/style.css`)
    assert.ok(builtCss.includes(sel.replace(/^\./, '.').replace('#', '#')) || builtCss.includes(sel), `falta ${sel} em bin/ui/style.css (rode npm run css:build)`)
  }
})

test('clipboard: writeText dentro do handler de clique, com fallback textarea+execCommand e dialog final', () => {
  assert.match(actionsMod, /navigator\.clipboard\.writeText/)
  assert.match(actionsMod, /execCommand\('copy'\)/)
  assert.match(actionsMod, /Copie o comando/)
})

test('dialogs de Parar e Refazer reaproveitam openConfirm (confirm.mjs), sem reimplementar o dialog', () => {
  assert.match(actionsMod, /from '\.\/confirm\.mjs'/)
  assert.match(actionsMod, /openConfirm\(\{/)
  assert.match(actionsMod, /Parar a run\?/)
  assert.match(actionsMod, /Refazer /)
})

// REPAIR (I7.md): o refresh de ~1 s não pode fechar "Saída do nó" nem descartar o arquivo escolhido na
// gaveta de artefatos, #req-status não pode vazar o pedido de outra run, e falta o histórico (E2).

test('renderDetail (app.js) escreve num wrapper próprio, sem apagar .node-actions-slot a cada refresh', () => {
  // app.js não pode voltar a fazer `els.drawerBody.replaceChildren()` dentro de renderDetail: isso
  // apagaria o bloco que actions.mjs mantém entre polls (details aberto + arquivo carregado).
  assert.match(js, /function agentContentEl\s*\(/)
  assert.match(js, /\.querySelector\('\.agent-content'\)/)
  const renderDetailBody = js.slice(js.indexOf('function renderDetail(detail)'), js.indexOf('function renderDetail(detail)') + 400)
  assert.doesNotMatch(renderDetailBody, /els\.drawerBody\.replaceChildren\(\)/)
})

test('openDetail (app.js) põe o "Carregando…" dentro de .agent-content, nunca solto em #drawer-body', () => {
  // renderDetail só reescreve .agent-content; um .drawer-note filho direto de #drawer-body ficaria para
  // sempre entre as ações e os agentes (regressão apontada no REPAIR do I7).
  const start = js.indexOf('async function openDetail(')
  assert.ok(start >= 0)
  const openDetailBody = js.slice(start, js.indexOf('\n}\n', start))
  assert.match(openDetailBody, /agentContentEl\(\)\.replaceChildren\(el\('p', 'drawer-note', 'Carregando…'\)\)/)
  assert.doesNotMatch(openDetailBody, /els\.drawerBody\.(replaceChildren|append|prepend)\(el\(/)
})

test('openDetail (app.js) sai do modo run antes de montar a gaveta do nó', () => {
  // Vindo dos Artefatos sem fechar a gaveta, o artifactsState seguia preenchido e cada refresh
  // anexava a lista "Pedidos" (E2) na gaveta do nó (achado da última verificação do I7).
  const start = js.indexOf('async function openDetail(')
  const openDetailBody = js.slice(start, js.indexOf('\n}\n', start))
  const leave = openDetailBody.indexOf('Actions.onDrawerClosed()')
  assert.ok(leave > openDetailBody.indexOf("drawerMode = 'node'"), 'openDetail deveria chamar Actions.onDrawerClosed() depois de entrar no modo nó')
  assert.ok(leave < openDetailBody.indexOf('await loadDetail('), 'e antes de carregar o detalhe')
  assert.match(actionsMod, /export function onDrawerClosed\(\) \{\s*artifactsState = null/)
})

test('actions.mjs reaproveita .node-actions do mesmo nó em vez de recriar o bloco a cada renderNodeActions', () => {
  assert.match(actionsMod, /node-actions-slot/)
  assert.match(actionsMod, /const sameNode = current && current\.id === id/)
  assert.match(actionsMod, /let block = slot\.querySelector\('\.node-actions'\)/)
})

test('gaveta de artefatos guarda o arquivo escolhido e não volta pro REPORT.md nem para "Carregando…" no refresh', () => {
  assert.match(actionsMod, /artifactsState\.current/)
  assert.match(actionsMod, /export function refreshArtifacts\s*\(\)\s*\{\s*\n\s*if \(artifactsState && artifactsState\.wf\) loadArtifacts\(artifactsState\.wf, false\)/)
  assert.match(actionsMod, /function loadArtifacts\(wf, reset\)/)
  // reset=false não pode substituir o corpo por "Carregando…"
  const loadArtifactsBody = actionsMod.slice(actionsMod.indexOf('async function loadArtifacts'), actionsMod.indexOf('function renderArtifactsBody'))
  assert.doesNotMatch(loadArtifactsBody, /if \(!reset\)[\s\S]{0,80}Carregando/)
})

test('#req-status não mistura o pedido de uma run com o de outra (lastRequest preso ao runKey)', () => {
  assert.match(actionsMod, /lastRequest\.runKey !== runKey/)
})

test('E2: histórico dos 5 últimos pedidos na gaveta em modo run', () => {
  assert.match(actionsMod, /function renderRequestsSection\(model\)/)
  assert.match(actionsMod, /\.slice\(0, 5\)/)
  assert.match(actionsMod, /artifact-requests/)
  assert.match(actionsMod, /renderRequestsSection\(model\)/) // render() chama a cada refresh
  assert.match(actionsMod, /renderRequestsSection\(lastModel\)/) // renderArtifactsBody também chama, na abertura
})
