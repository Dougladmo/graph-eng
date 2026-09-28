// Painel web ao vivo do graph-watch. Node puro, sem libs. Consome o contrato documentado no topo
// de bin/ui-server.mjs. Todo texto vindo do journal entra via textContent/createElement.
//
// ── Contrato com o CSS (o visual é trocável; a lógica não depende dele) ──
// O JS só posiciona e marca estado. Tudo que é visual fica no style.css, pendurado nestes ganchos:
//   <html data-rail>           open|closed — lateral de runs (card flutuante à esquerda), aplicada por theme.js.
//   #app[data-drawer]          open|closed — gaveta de detalhe (card flutuante à direita). O grafo centra no
//                              espaço entre os cards abertos; abrir e fechar é só CSS (transição).
//   #graph                     quadro do grafo; width/height em px vêm de placeGraph. data-status = status da
//                              run (rodando|parada?|terminado): nó "rodando" de run parada fica congelado.
//   .lane                      coluna de fase (Plano, Pesquisa, Implementação…); passos em sequência da mesma fase
//                              dividem uma coluna larga. left/top/width/height em px. data-kind (plan|node|critic|synth),
//                              data-active (tem nó rodando numa run viva), data-mood (running|fail|frozen|'').
//                              Contém .lane-title e .lane-sub.
//   .node                      button do nó. left/top = CENTRO da bolinha. data-kind, data-variant
//                              (empty|running|done|fail|skipped), data-state (estado cru), data-round,
//                              data-tone (1..3, cor do round), data-selected. Contém .dot e .node-label.
//                              --i (em .lane, .node e .edge) = índice do passo, para escalonar a entrada.
//   .edge                      segmento de reta de centro a centro. left/top = ponto de saída, width =
//                              comprimento, rotação em transform (origem no meio da borda esquerda).
//                              data-from, data-to, data-active (true quando a origem já rodou).
//   .run-btn                   run na lateral; aria-current, data-status (rodando|parada?|terminado).
//                              Contém .run-top (.run-name, .run-badge) e .run-bottom (.run-project, .run-strip
//                              com uma .dot por nó, data-variant/data-tone).
//   #live                      data-state connecting|on|off. #conn: aviso de conexão (vazio quando conectado).
//   #empty-msg                 estado vazio.
//   #settings[data-state]      closed|open|closing — modal de engrenagem (card flutuante central). Lógica em
//                              config-modal.mjs (initSettings), chamada uma vez abaixo; o switch de tema mora lá.
// A geometria vem de graph-layout.mjs (LAYOUT, placeGraph).

import { STATE_TEXT, variantOf, hasRun, buildGraph, layoutGraph, placeGraph, laneTitle, nodeLabel, LAYOUT } from './graph-layout.mjs'
import { initSettings } from './config-modal.mjs'
import { PAGE, STEP, sectionOf, titleOf, metaOf, stripOf, buildSections } from './sidebar.mjs'
import { openConfirm } from './confirm.mjs'
import * as Actions from './actions.mjs'

// ── DOM ──
const $ = (id) => document.getElementById(id)
const els = {
  app: $('app'),
  live: $('live'),
  railOpen: $('rail-open'),
  railClose: $('rail-close'),
  sidebar: $('sidebar'),
  sidebarToggle: $('sidebar-toggle'),
  runLists: $('run-lists'),
  orgMsg: $('org-msg'),
  searchBtn: $('runs-search-btn'),
  searchRow: $('runs-search-row'),
  runsQ: $('runs-q'),
  filterBtn: $('runs-filter-btn'),
  filterMenu: $('runs-filter-menu'),
  filterDot: $('filter-dot'),
  filterArchived: $('filter-archived'),
  filterArchivedN: $('filter-archived-n'),
  newGroupBtn: $('runs-new-group-btn'),
  rowMenu: $('row-menu'),
  header: $('run-header'),
  emptyMsg: $('empty-msg'),
  conn: $('conn'),
  mapScroll: $('map-scroll'),
  graph: $('graph'),
  lanes: $('lanes'),
  edges: $('edges'),
  nodes: $('nodes'),
  drawer: $('drawer'),
  drawerTitle: $('drawer-title'),
  drawerState: $('drawer-state'),
  drawerBody: $('drawer-body'),
  drawerClose: $('drawer-close'),
}
const mobile = window.matchMedia('(max-width: 720px)')
const MOBILE_GRAPH_H = 300 // altura do quadro do grafo no celular (o resto da tela é da folha de detalhe)
const DRAWER_RESERVE = 372 // largura que a gaveta cobre no desktop (360 + 12 de margem)
const RAIL_RESERVE = 288 // largura que a lateral cobre no desktop (12 + 264 + 12)

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function setData(e, obj) {
  for (const [k, v] of Object.entries(obj)) {
    const s = String(v)
    if (e.dataset[k] !== s) e.dataset[k] = s
  }
}

function setText(e, text) {
  if (e.textContent !== text) e.textContent = text
}

function setStyle(e, obj) {
  for (const [k, v] of Object.entries(obj)) if (e.style[k] !== v) e.style[k] = v
}

const shortWf = (wf) => wf.replace(/^wf_/, '')
const toneOf = (round) => (((round || 1) - 1) % 3) + 1

// Reconciliação por chave: cria o que falta, atualiza o que existe, remove o que sumiu. Elemento que já
// existe nunca é recriado (a animação da bolinha e o foco do teclado sobrevivem às atualizações).
function reconcile(container, cache, items, keyOf, create, update) {
  const seen = new Set()
  for (const item of items) {
    const k = keyOf(item)
    seen.add(k)
    let e = cache.get(k)
    if (!e) {
      e = create(item)
      cache.set(k, e)
      container.append(e)
    }
    update(e, item)
  }
  for (const [k, e] of cache) {
    if (!seen.has(k)) {
      e.remove()
      cache.delete(k)
    }
  }
}

// ── Grafo ──
const laneEls = new Map()
const nodeEls = new Map()
const edgeEls = new Map()
let scrolledTo = null // `${wf}#${coluna}` da última rolagem automática (só rola de novo quando a etapa muda)

function renderGraph(model) {
  const graph = buildGraph(model)
  const layout = layoutGraph(graph)
  const small = mobile.matches
  const place = placeGraph(layout, {
    width: els.mapScroll.clientWidth,
    height: small ? MOBILE_GRAPH_H : els.mapScroll.clientHeight,
    reserveLeft: railIsOpen() && !small ? RAIL_RESERVE : 0,
    reserveRight: openNodeId && !small ? DRAWER_RESERVE : 0,
    mobile: small,
  })
  setStyle(els.graph, { width: `${place.width}px`, height: `${place.height}px` })
  els.graph.style.setProperty('--label-w', `${place.labelW}px`) // rótulo do nó com respiro dentro da coluna
  const live = model.status === 'rodando'
  setData(els.graph, { status: model.status || '' })

  const byId = new Map(graph.V.map((v) => [v.id, v]))
  const maxRound = Math.max(1, ...graph.V.map((v) => v.round || 1))
  // o contorno tracejado do nó injetado pelos trilhos só entra na legenda quando a run tem um
  const legendInjected = document.getElementById('legend-injected')
  if (legendInjected) legendInjected.hidden = !graph.V.some((v) => v.injected)
  const lanes = place.lanes.map((lane) => {
    const vs = lane.ids.map((id) => byId.get(id))
    const running = vs.some((v) => variantOf(v.state) === 'running')
    const failed = vs.some((v) => variantOf(v.state) === 'fail')
    const kinds = vs.filter((v) => v.node).map((v) => v.node.kind)
    const round = maxRound > 1 && lane.kind === 'node' ? `round ${lane.round} · ` : ''
    let sub = lane.kind === 'node' ? `${round}${laneSize(lane)}` : ''
    let mood = ''
    if (running) [sub, mood] = live ? ['rodando', 'running'] : ['parada', 'frozen']
    else if (failed) [sub, mood] = ['falhou', 'fail']
    return { ...lane, title: laneTitle(lane, kinds, maxRound), sub, mood, active: running && live }
  })

  reconcile(
    els.lanes,
    laneEls,
    lanes,
    (l) => l.index,
    () => {
      const d = el('div', 'lane')
      d.append(el('span', 'lane-title'), el('span', 'lane-sub'))
      return d
    },
    (d, l) => {
      setStyle(d, { left: `${l.left}px`, top: `${l.top}px`, width: `${l.width}px`, height: `${l.height}px` })
      d.style.setProperty('--i', l.first)
      setText(d.firstChild, l.title)
      setText(d.lastChild, l.sub)
      setData(d, { kind: l.kind, active: l.active, mood: l.mood })
    },
  )

  reconcile(
    els.edges,
    edgeEls,
    place.segments,
    (s) => s.key,
    () => el('div', 'edge'),
    (e, s) => {
      setStyle(e, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.len}px`, transform: `rotate(${s.angle}deg)` })
      e.style.setProperty('--i', s.col)
      setData(e, { from: s.from, to: s.to, active: hasRun(byId.get(s.from).state) })
    },
  )

  reconcile(
    els.nodes,
    nodeEls,
    graph.V,
    (v) => v.id,
    () => {
      const b = el('button', 'node')
      b.type = 'button'
      b.append(el('span', 'dot'), el('span', 'node-label'))
      b.addEventListener('click', () => openDetail(b.dataset.id))
      return b
    },
    (b, v) => {
      const p = place.pos.get(v.id)
      setStyle(b, { left: `${p.x}px`, top: `${p.y}px` })
      b.style.setProperty('--i', p.col)
      const full = v.kind === 'node' ? `${v.id} · ${v.title}` : v.title
      setText(b.lastChild, nodeLabel(v))
      b.title = full
      b.setAttribute('aria-label', `${full}, ${STATE_TEXT[v.state] || v.state}`)
      setData(b, { id: v.id, kind: v.kind, variant: variantOf(v.state), state: v.state, round: v.round, tone: toneOf(v.round), selected: v.id === openNodeId, injected: v.injected ? '1' : '' })
    },
  )

  followRunning(model.wf, lanes)
}

// Tamanho da fase: "1 nó", "3 em paralelo" ou, com passos em sequência, "5 nós · até 2 em paralelo".
function laneSize(lane) {
  if (lane.steps === 1) return lane.count === 1 ? '1 nó' : `${lane.count} em paralelo`
  return `${lane.count} nós · ${lane.maxParallel > 1 ? `até ${lane.maxParallel} em paralelo` : 'em sequência'}`
}

// Grafo mais largo que a tela (celular, ou run grande): rola até a etapa que está rodando, deixando a
// anterior à vista. Só quando a etapa muda — rolagem manual do usuário não é desfeita a cada tick.
function followRunning(wf, lanes) {
  const i = lanes.findIndex((l) => l.mood === 'running')
  if (i < 0) return
  const key = `${wf}#${i}`
  if (key === scrolledTo) return
  const first = scrolledTo === null || !scrolledTo.startsWith(`${wf}#`)
  scrolledTo = key
  const scroller = els.mapScroll
  if (scroller.scrollWidth <= scroller.clientWidth) return
  const pad = mobile.matches ? LAYOUT.mobile.PAD_X : LAYOUT.desktop.PAD_X
  const target = Math.max(0, lanes[Math.max(0, i - 1)].left - pad)
  scroller.scrollTo({ left: target, behavior: first ? 'auto' : 'smooth' })
}

// o quadro mudou de tamanho (janela, gaveta, rotação): reposiciona, no máximo uma vez por quadro
let resizeQueued = false
new ResizeObserver(() => {
  if (resizeQueued || !currentModel) return
  resizeQueued = true
  requestAnimationFrame(() => {
    resizeQueued = false
    if (currentModel) renderGraph(currentModel)
  })
}).observe(els.mapScroll)

// ── Estado da página ──
let runs = []
let selectedWf = new URLSearchParams(location.search).get('run') || null
let currentModel = null
let openNodeId = null
let drawerMode = null // null | 'node' | 'run' (artefatos, Actions.openArtifactsDrawer)

els.sidebarToggle.addEventListener('click', () => setSidebarOpen(!els.sidebar.classList.contains('open')))
els.drawerClose.addEventListener('click', closeDrawer)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (els.sidebar.classList.contains('open')) setSidebarOpen(false)
  else closeDrawer()
})
window.addEventListener('popstate', () => {
  const wf = new URLSearchParams(location.search).get('run')
  if (wf && wf !== selectedWf) selectRun(wf, { fromHistory: true })
})

function setSidebarOpen(open) {
  els.sidebar.classList.toggle('open', open)
  els.sidebarToggle.setAttribute('aria-expanded', String(open))
}

function closeDrawer() {
  if (!openNodeId && !drawerMode) return
  openNodeId = null
  drawerMode = null
  setData(els.app, { drawer: 'closed' })
  for (const b of nodeEls.values()) setData(b, { selected: false })
  if (currentModel) renderGraph(currentModel)
  Actions.onDrawerClosed()
}

// ── Lateral de runs (card flutuante; recolhe e expande) ──
const railIsOpen = () => !window.graphEngRail || window.graphEngRail.get() !== 'closed'

function setRailOpen(open) {
  if (window.graphEngRail) window.graphEngRail.set(open ? 'open' : 'closed')
  syncRailButtons()
  // o foco segue o controle visível, para o teclado não ficar num botão que sumiu
  ;(open ? els.railClose : els.railOpen).focus({ preventScroll: true })
  if (currentModel) renderGraph(currentModel) // o grafo recentra no espaço livre (a transição anima)
}
function syncRailButtons() {
  const open = railIsOpen()
  els.railOpen.setAttribute('aria-expanded', String(open))
  els.railClose.setAttribute('aria-expanded', String(open))
}
els.railClose.addEventListener('click', () => setRailOpen(false))
els.railOpen.addEventListener('click', () => setRailOpen(true))
syncRailButtons()

// ── Configurações (modal de engrenagem, com o switch de tema dentro) ──
initSettings()

// ── Ações da run (retomar, parar, refazer nó, artefatos; bin/ui/actions.mjs, C14) ──
Actions.initActions({
  openArtifactsDrawer() {
    openNodeId = null
    drawerMode = 'run'
    setData(els.app, { drawer: 'open', drawerMode: 'run' })
    els.drawer.setAttribute('aria-label', 'artefatos da run')
    for (const b of nodeEls.values()) setData(b, { selected: false })
    if (currentModel) renderGraph(currentModel)
  },
  selectRun(wf) {
    selectRun(wf)
  },
})

// ── Lateral (bin/ui/sidebar.mjs monta as seções; app.js só desenha) ──
// O ícone da lixeira (Apagar finalizadas…) vive como <template> estático em index.html; app.js só clona,
// nunca monta SVG na mão (mesma regra do resto da página: nada de HTML bruto nem SVG programático aqui).
function trashIcon() {
  const t = document.getElementById('icon-trash')
  return t ? t.content.firstElementChild.cloneNode(true) : el('span')
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* navegação privada, storage bloqueado: a preferência não persiste, sem quebrar a página */
  }
}
const SECTIONS_KEY = 'graph-eng-sections'
const ARCHIVED_KEY = 'graph-eng-show-archived'

let org = { groups: [], pinned: [], warnings: [] }
let showArchived = !!loadJSON(ARCHIVED_KEY, false)
let query = ''
const sectionOpen = loadJSON(SECTIONS_KEY, {})
const sectionShown = {} // { [secId]: número mostrado }; não persiste
const firstSeen = new Map() // key → ordem de 1ª aparição (D4 §4.12)
const sectionEls = new Map() // secId → { root, head, toggle, name, count, list, emptyEl, more, actions, cache }
let lastSections = []

function renderSidebar() {
  setText(els.emptyMsg, runs.length ? '' : 'Nenhuma run do graph-eng por aqui. Dispare /graph-eng numa sessão do Claude Code e ela aparece sozinha.')
  syncFilterUI()
  lastSections = buildSections(runs, org, { showArchived, query, open: sectionOpen, shown: sectionShown, selectedWf, firstSeen, now: Date.now() })
  renderSections(lastSections)
  autoSelect()
}

function renderSections(sections) {
  const container = els.runLists
  const seen = new Set()
  for (const sec of sections) {
    seen.add(sec.id)
    let s = sectionEls.get(sec.id)
    if (!s) {
      s = createSectionEl()
      sectionEls.set(sec.id, s)
      container.append(s.root)
    }
    updateSectionEl(s, sec)
  }
  for (const [id, s] of sectionEls) {
    if (!seen.has(id)) {
      s.root.remove()
      sectionEls.delete(id)
    }
  }
  keepOrder(
    container,
    sections.map((sec) => sectionEls.get(sec.id).root),
  )
}

// Só move elemento quando a ordem mudou de fato (mover reinicia animação CSS).
function keepOrder(container, wanted) {
  const current = [...container.children]
  if (current.length === wanted.length && current.every((c, i) => c === wanted[i])) return
  for (const w of wanted) container.append(w)
}

function createSectionEl() {
  const root = el('section', 'sec')
  const head = el('div', 'sec-head')
  const toggle = el('button', 'sec-toggle')
  toggle.type = 'button'
  const name = el('span', 'sec-name')
  const count = el('span', 'sec-count')
  const chev = el('span', 'chev')
  chev.setAttribute('aria-hidden', 'true')
  toggle.append(name, count, chev)
  const actions = el('div', 'sec-actions')
  head.append(toggle, actions)
  const list = el('div', 'run-list')
  list.setAttribute('role', 'list')
  const emptyEl = el('p', 'sec-empty')
  const more = el('button', 'show-more')
  more.type = 'button'
  root.append(head, list, emptyEl, more)
  const s = { root, head, toggle, name, count, chev, list, emptyEl, more, actions, cache: new Map(), id: null }
  toggle.addEventListener('click', () => toggleSection(s.id))
  root.addEventListener('dragover', (e) => onSectionDragOver(e, s))
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget)) clearDropState(s)
  })
  root.addEventListener('drop', (e) => onSectionDrop(e, s))
  return s
}

function updateSectionEl(s, sec) {
  s.id = sec.id
  // onSectionDrop (drag para grupo) lê s.kind: sem isso, toda seção parecia "estado" e soltar numa
  // seção de grupo desagrupava e desfixava a run em vez de movê-la para o grupo.
  s.kind = sec.kind
  const toggleId = `sec-${sec.id}-t`
  const listId = `sec-${sec.id}-l`
  s.toggle.id = toggleId
  s.toggle.setAttribute('aria-controls', listId)
  s.toggle.setAttribute('aria-expanded', String(sec.open))
  s.list.id = listId
  s.list.setAttribute('aria-labelledby', toggleId)
  setData(s.root, { sec: sec.id, kind: sec.kind })
  setText(s.name, sec.label)
  setText(s.count, sec.open ? '' : String(sec.count))
  s.list.hidden = !sec.open
  renderSectionActions(s, sec)
  reconcile(
    s.list,
    s.cache,
    sec.rows,
    (r) => r.key,
    createRunRow,
    (row, r) => updateRunRow(row, r),
  )
  keepOrder(
    s.list,
    sec.rows.map((r) => s.cache.get(r.key)),
  )
  const showEmpty = sec.open && sec.rows.length === 0 && sec.empty
  s.emptyEl.hidden = !showEmpty
  setText(s.emptyEl, sec.empty || '')
  s.more.hidden = sec.more === 0
  setText(s.more, `Mostrar mais ${sec.more}`)
  s.more.onclick = () => {
    sectionShown[sec.id] = (Object.hasOwn(sectionShown, sec.id) ? sectionShown[sec.id] : PAGE) + STEP
    renderSidebar()
  }
}

function renderSectionActions(s, sec) {
  s.actions.replaceChildren()
  if (sec.id === 'done' && sec.count > 0) {
    const btn = el('button', 'icon-btn sec-action')
    btn.type = 'button'
    btn.title = 'Apagar finalizadas…'
    btn.setAttribute('aria-label', 'Apagar finalizadas…')
    btn.append(trashIcon())
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      openDeleteFinished(sec)
    })
    s.actions.append(btn)
  } else if (sec.kind === 'group') {
    const btn = el('button', 'icon-btn sec-action')
    btn.type = 'button'
    btn.title = 'Mais ações do grupo'
    btn.setAttribute('aria-label', `Mais ações do grupo ${sec.label}`)
    btn.setAttribute('aria-haspopup', 'menu')
    btn.textContent = '⋯'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      openGroupMenu(btn, sec)
    })
    s.actions.append(btn)
  }
}

function toggleSection(id) {
  const cur = lastSections.find((x) => x.id === id)
  sectionOpen[id] = cur ? !cur.open : true
  saveJSON(SECTIONS_KEY, sectionOpen)
  renderSidebar()
}

function createRunRow() {
  const row = el('div', 'run-row')
  row.setAttribute('role', 'listitem')
  row.draggable = true
  const btn = el('button', 'run-btn')
  btn.type = 'button'
  const dot = el('span', 'row-dot')
  const title = el('span', 'run-title')
  const right = el('span', 'run-right')
  btn.append(dot, title, right)
  btn.addEventListener('click', () => {
    selectRun(row.dataset.wf)
    setSidebarOpen(false)
  })
  const more = el('button', 'run-more', '⋯')
  more.type = 'button'
  more.setAttribute('aria-haspopup', 'menu')
  more.addEventListener('click', (e) => {
    e.stopPropagation()
    const r = row.getBoundingClientRect()
    openRunMenu(row.dataset.key, r.right, r.bottom, more)
  })
  row.append(btn, more)
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    openRunMenu(row.dataset.key, e.clientX, e.clientY, more)
  })
  row.addEventListener('keydown', (e) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      const r = row.getBoundingClientRect()
      openRunMenu(row.dataset.key, r.right, r.bottom, more)
    }
  })
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-graph-eng-run', row.dataset.wf)
    e.dataTransfer.setData('text/plain', title.textContent)
    e.dataTransfer.effectAllowed = 'move'
    els.runLists.classList.add('dragging')
  })
  row.addEventListener('dragend', () => {
    els.runLists.classList.remove('dragging')
    for (const s of sectionEls.values()) clearDropState(s)
  })
  return row
}

function updateRunRow(row, r) {
  setData(row, { key: r.key, wf: r.wf })
  const [btn, more] = row.children
  const sec = sectionOf(r)
  setData(btn, { status: r.status, stopped: sec === 'stopped' ? '1' : '0', archived: r.archived ? '1' : '0' })
  const selected = r.wf === selectedWf || (Array.isArray(r.wfs) && r.wfs.includes(selectedWf))
  btn.setAttribute('aria-current', String(selected))
  const [dot, titleEl, right] = btn.children
  const state = r.status === 'rodando' ? 'running' : sec === 'stopped' ? 'stopped' : r.planOnly ? 'planonly' : 'done'
  setData(dot, { state })
  setText(titleEl, titleOf(r))
  const meta = metaOf(r)
  btn.title = [r.goal, r.project, r.runId || r.wf].filter(Boolean).join(' · ') + (meta ? ` · ${meta}` : '')
  updateRunRight(right, r)
  more.setAttribute('aria-label', `Mais ações para ${titleOf(r)}`)
}

function updateRunRight(container, r) {
  if (r.planOnly && r.status !== 'rodando') {
    if (container.dataset.built !== 'plan') {
      container.replaceChildren(el('span', 'run-plan', 'só plano'))
      container.dataset.built = 'plan'
    }
    return
  }
  const s = stripOf(r.nodes || [])
  if (s.mode === 'dots') {
    if (container.dataset.built !== 'dots') {
      container.replaceChildren(el('span', 'run-strip'))
      container.dataset.built = 'dots'
    }
    const strip = container.firstChild
    strip.setAttribute('role', 'img')
    strip.setAttribute('aria-label', s.label)
    strip.title = s.label
    while (strip.children.length > s.dots.length) strip.lastChild.remove()
    while (strip.children.length < s.dots.length) strip.append(el('span', 'dot'))
    s.dots.forEach((d, i) => setData(strip.children[i], { variant: d.variant, tone: d.tone }))
  } else {
    if (container.dataset.built !== 'sum') {
      container.replaceChildren(el('span', 'run-sum'))
      container.dataset.built = 'sum'
    }
    const sum = container.firstChild
    sum.setAttribute('role', 'img')
    sum.setAttribute('aria-label', s.label)
    sum.title = s.label
    while (sum.children.length > s.items.length) sum.lastChild.remove()
    while (sum.children.length < s.items.length) {
      const item = el('span', 'sum-item')
      item.append(el('span', 'dot'), el('span', 'sum-n'))
      sum.append(item)
    }
    s.items.forEach((it, i) => {
      const item = sum.children[i]
      setData(item.firstChild, { variant: it.variant })
      setText(item.lastChild, String(it.n))
    })
  }
}

function autoSelect() {
  if (selectedWf) {
    if (!currentModel && runs.some((r) => r.wf === selectedWf || (r.wfs || []).includes(selectedWf))) refresh()
    return
  }
  if (!runs.length) return
  const running = runs.find((r) => r.status === 'rodando' && !r.archived)
  if (running) return selectRun(running.wf, { replace: true })
  for (const sec of lastSections) {
    if (sec.rows.length) return selectRun(sec.rows[0].wf, { replace: true })
  }
}

function selectRun(wf, opts = {}) {
  if (wf !== selectedWf) {
    closeDrawer()
    currentModel = null
    for (const e of [...laneEls.values(), ...nodeEls.values(), ...edgeEls.values()]) e.remove()
    laneEls.clear()
    nodeEls.clear()
    edgeEls.clear()
    els.mapScroll.scrollTo({ left: 0, top: 0 })
  }
  selectedWf = wf
  if (!opts.fromHistory) {
    const url = new URL(location.href)
    url.searchParams.set('run', wf)
    if (opts.replace) history.replaceState(null, '', url)
    else history.pushState(null, '', url)
  }
  renderSections(lastSections) // atualiza aria-current sem reconstruir tudo
  refresh()
}

// ── Busca e filtro do cabeçalho da lista ──
function syncFilterUI() {
  els.filterDot.hidden = !showArchived
  els.filterArchived.setAttribute('aria-checked', String(showArchived))
  const n = runs.filter((r) => r.archived).length
  setText(els.filterArchivedN, ` (${n})`)
}

els.searchBtn.addEventListener('click', () => {
  const opening = els.searchRow.hidden
  els.searchRow.hidden = !opening
  els.searchBtn.setAttribute('aria-pressed', String(opening))
  if (opening) els.runsQ.focus({ preventScroll: true })
  else closeSearch()
})
function closeSearch() {
  query = ''
  els.runsQ.value = ''
  els.searchRow.hidden = true
  els.searchBtn.setAttribute('aria-pressed', 'false')
  renderSidebar()
}
els.runsQ.addEventListener('input', () => {
  query = els.runsQ.value
  renderSidebar()
})
els.runsQ.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeSearch()
  }
})

function onFilterOutside(e) {
  if (els.filterMenu.hidden) return
  if (!els.filterMenu.contains(e.target) && !els.filterBtn.contains(e.target)) closeFilterMenu()
}
function closeFilterMenu() {
  els.filterMenu.hidden = true
  els.filterBtn.setAttribute('aria-expanded', 'false')
  document.removeEventListener('click', onFilterOutside)
}
els.filterBtn.addEventListener('click', () => {
  const willOpen = els.filterMenu.hidden
  if (willOpen) {
    els.filterMenu.hidden = false
    els.filterBtn.setAttribute('aria-expanded', 'true')
    document.addEventListener('click', onFilterOutside)
    els.filterArchived.focus({ preventScroll: true })
  } else {
    closeFilterMenu()
  }
})
els.filterArchived.addEventListener('click', () => {
  showArchived = !showArchived
  saveJSON(ARCHIVED_KEY, showArchived)
  closeFilterMenu()
  renderSidebar()
})
els.newGroupBtn.addEventListener('click', () => startGroupEdit())

// ── Menu ⋯ (run e grupo): um único #row-menu flutuante, reaproveitado (D4 §4.5) ──
let menuOpener = null
function closeMenu() {
  const m = els.rowMenu
  if (m.hidden) return
  m.hidden = true
  m.replaceChildren()
  document.removeEventListener('click', onMenuOutside)
  document.removeEventListener('keydown', onMenuKeydown)
}
function onMenuOutside(e) {
  if (!els.rowMenu.contains(e.target)) {
    closeMenu()
  }
}
function onMenuKeydown(e) {
  const m = els.rowMenu
  if (m.hidden) return
  const items = [...m.querySelectorAll('[role^="menuitem"]')]
  const i = items.indexOf(document.activeElement)
  if (e.key === 'Escape') {
    e.preventDefault()
    closeMenu()
    if (menuOpener) menuOpener.focus({ preventScroll: true })
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    items[(i + 1 + items.length) % items.length]?.focus()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    items[(i - 1 + items.length) % items.length]?.focus()
  } else if (e.key === 'Home') {
    e.preventDefault()
    items[0]?.focus()
  } else if (e.key === 'End') {
    e.preventDefault()
    items[items.length - 1]?.focus()
  } else if (e.key === 'Tab') {
    closeMenu()
  }
}
function menuItem(text, { onClick, danger, role = 'menuitem', checked } = {}) {
  const b = el('button', danger ? 'menu-item danger' : 'menu-item', text)
  b.type = 'button'
  b.setAttribute('role', role)
  b.tabIndex = -1
  if (checked !== undefined) b.setAttribute('aria-checked', String(checked))
  b.addEventListener('click', () => {
    closeMenu()
    onClick()
  })
  return b
}
function menuSep(label) {
  const s = el('div', 'menu-sep')
  s.setAttribute('role', 'presentation')
  if (label) s.append(el('span', 'menu-sep-label', label))
  return s
}
function openMenuAt(x, y, build, opener) {
  const m = els.rowMenu
  m.replaceChildren()
  build(m)
  m.hidden = false
  m.style.left = '0px'
  m.style.top = '0px'
  const rect = m.getBoundingClientRect()
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
  const top = y + rect.height > window.innerHeight - 8 ? Math.max(8, y - rect.height) : y
  m.style.left = `${left}px`
  m.style.top = `${top}px`
  const first = m.querySelector('[role^="menuitem"]')
  if (first) first.focus({ preventScroll: true })
  menuOpener = opener
  setTimeout(() => document.addEventListener('click', onMenuOutside))
  document.addEventListener('keydown', onMenuKeydown)
}
function openRunMenu(key, x, y, opener) {
  const r = runs.find((x2) => x2.key === key)
  if (!r) return
  openMenuAt(x, y, (m) => {
    m.append(menuItem(r.pinned ? 'Desafixar' : 'Fixar', { onClick: () => orgCall('pin', { wf: r.wf, pinned: !r.pinned }) }))
    m.append(menuSep('Mover para'))
    for (const g of org.groups) m.append(menuItem(g.name, { role: 'menuitemradio', checked: r.group === g.id, onClick: () => orgCall('move', { wf: r.wf, group: g.id }) }))
    m.append(menuItem('Sem grupo', { role: 'menuitemradio', checked: !r.group, onClick: () => orgCall('move', { wf: r.wf, group: null }) }))
    m.append(menuItem('Novo grupo…', { onClick: () => startGroupEdit({ wf: r.wf }) }))
    m.append(menuSep())
    m.append(menuItem(r.archived ? 'Desarquivar' : 'Arquivar', { onClick: () => orgCall('archive', { wf: r.wf, archived: !r.archived }) }))
    m.append(menuItem('Apagar…', { danger: true, onClick: () => openDeleteRun(r) }))
  }, opener)
}
function openGroupMenu(anchor, sec) {
  const idx = org.groups.findIndex((g) => g.id === sec.id)
  const rect = anchor.getBoundingClientRect()
  openMenuAt(rect.left, rect.bottom + 4, (m) => {
    m.append(menuItem('Renomear', { onClick: () => startGroupRename(sec.id) }))
    m.append(menuItem('Mover para cima', { onClick: () => orgCall('group-move', { gid: sec.id, index: Math.max(0, idx - 1) }) }))
    m.append(menuItem('Mover para baixo', { onClick: () => orgCall('group-move', { gid: sec.id, index: Math.min(org.groups.length - 1, idx + 1) }) }))
    m.append(menuSep())
    m.append(menuItem('Apagar grupo…', { danger: true, onClick: () => openDeleteGroup(sec) }))
  }, anchor)
}

// ── Criar / renomear grupo (edição inline, D4 §4.3) ──
function startGroupEdit(opts = {}) {
  const prev = els.runLists.querySelector('.group-edit')
  if (prev) prev.remove()
  const row = el('div', 'group-edit')
  const input = el('input')
  input.type = 'text'
  input.placeholder = 'Nome do grupo'
  input.maxLength = 40
  input.autocomplete = 'off'
  input.spellcheck = false
  const err = el('p', 'field-err')
  err.hidden = true
  row.append(input, err)
  els.runLists.prepend(row)
  input.focus()
  let done = false
  const finish = async (commit) => {
    if (done) return
    if (commit && input.value.trim()) {
      done = true
      const res = await orgCall('group-create', { name: input.value.trim(), wf: opts.wf })
      if (res && res.error) {
        done = false
        err.textContent = (res.fields && res.fields.name) || res.error
        err.hidden = false
        input.focus()
        return
      }
    } else {
      done = true
    }
    row.remove()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      done = true
      row.remove()
    }
  })
  input.addEventListener('blur', () => finish(!!input.value.trim()))
}

function startGroupRename(gid) {
  const s = sectionEls.get(gid)
  if (!s) return
  const g = org.groups.find((x) => x.id === gid)
  const input = el('input', 'group-rename-input')
  input.type = 'text'
  input.value = g ? g.name : ''
  input.maxLength = 40
  input.autocomplete = 'off'
  input.spellcheck = false
  const name = s.name
  name.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const finish = async (commit) => {
    if (done) return
    done = true
    if (commit && input.value.trim() && input.value.trim() !== (g && g.name)) {
      const res = await orgCall('group-rename', { gid, name: input.value.trim() })
      if (res && res.error) {
        done = false
        return
      }
    }
    if (input.parentNode) input.replaceWith(name)
    toggleSectionFocus(gid)
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    }
  })
  input.addEventListener('blur', () => finish(true))
}
function toggleSectionFocus(id) {
  const s = sectionEls.get(id)
  if (s) s.toggle.focus({ preventScroll: true })
}

// ── Arrastar (D4 §4.6): HTML5 nativo, dataTransfer `application/x-graph-eng-run` = wf ──
let hoverTimer = null
let hoverSec = null
function clearDropState(s) {
  s.head.removeAttribute('data-drop')
}
function onSectionDragOver(e, s) {
  if (s.id === 'archived') return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  s.head.setAttribute('data-drop', 'over')
  if (hoverSec !== s.id) {
    clearTimeout(hoverTimer)
    hoverSec = s.id
    hoverTimer = setTimeout(() => {
      if (!sectionOpen[s.id]) {
        sectionOpen[s.id] = true
        saveJSON(SECTIONS_KEY, sectionOpen)
        renderSidebar()
      }
    }, 600)
  }
}
async function onSectionDrop(e, s) {
  if (s.id === 'archived') return
  e.preventDefault()
  clearTimeout(hoverTimer)
  hoverTimer = null
  hoverSec = null
  clearDropState(s)
  const wf = e.dataTransfer.getData('application/x-graph-eng-run')
  if (!wf) return
  if (s.id === 'pinned') await orgCall('pin', { wf, pinned: true })
  else if (s.kind === 'group') await orgCall('move', { wf, group: s.id })
  else {
    await orgCall('move', { wf, group: null })
    await orgCall('pin', { wf, pinned: false })
  }
}

// ── Chamadas de organização (POST /api/org/*, C10 O1-O9) ──
const ORG_PATHS = {
  pin: () => '/api/org/pin',
  'group-create': () => '/api/org/groups',
  'group-rename': (a) => `/api/org/groups/${encodeURIComponent(a.gid)}/rename`,
  'group-move': (a) => `/api/org/groups/${encodeURIComponent(a.gid)}/move`,
  'group-delete': (a) => `/api/org/groups/${encodeURIComponent(a.gid)}/delete`,
  move: () => '/api/org/move',
  archive: () => '/api/org/archive',
  delete: () => '/api/org/delete',
  'delete-finished': () => '/api/org/delete-finished',
}
let orgMsgTimer = null
function showOrgMsg(text) {
  setText(els.orgMsg, text)
  clearTimeout(orgMsgTimer)
  orgMsgTimer = setTimeout(() => setText(els.orgMsg, ''), 4000)
}
async function orgCall(op, body) {
  const path = ORG_PATHS[op](body)
  const payload = { ...body }
  delete payload.gid
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const msg = data.error || `não consegui salvar (${res.status})`
      showOrgMsg(`Não consegui salvar: ${msg}`)
      return { error: msg, fields: data.fields }
    }
    if (data.org) org = data.org
    renderSidebar()
    return data
  } catch {
    showOrgMsg('Não consegui salvar: sem conexão com o painel.')
    return { error: 'sem conexão com o painel' }
  }
}

// ── Dialogs de apagar (bin/ui/confirm.mjs, D4 §4.8) ──
function openDeleteRun(r) {
  openConfirm({
    title: 'Apagar a run?',
    body: r.runDir ? `Remove a pasta ${r.runDir}. Os históricos em ~/.claude/projects ficam. Não dá para desfazer.` : 'Essa run não tem pasta em .graph-runs; ela só sai da lista.',
    typed: r.name,
    confirmText: 'Apagar',
    danger: true,
    focus: 'typed',
    onConfirm: async (typed) => {
      const res = await orgCall('delete', { wf: r.wf, confirm: typed })
      return res && res.error ? { error: res.error } : {}
    },
  })
}
function openDeleteGroup(sec) {
  openConfirm({
    title: `Apagar o grupo ${sec.label}?`,
    body: `As ${sec.count} run${sec.count === 1 ? '' : 's'} dele voltam para Em andamento, Paradas ou Finalizadas. Nenhuma run é apagada.`,
    confirmText: 'Apagar grupo',
    danger: true,
    onConfirm: async () => {
      const res = await orgCall('group-delete', { gid: sec.id })
      if (res && res.error) return { error: res.error }
      delete sectionOpen[sec.id] // grupo some: sua chave de aberto/fechado não fica lixo no localStorage
      saveJSON(SECTIONS_KEY, sectionOpen)
      return {}
    },
  })
}
function openDeleteFinished(sec) {
  const full = buildSections(runs, org, { showArchived, open: { done: true }, shown: { done: sec.count }, firstSeen, now: Date.now() }).find((s) => s.id === 'done')
  const rows = full ? full.rows : []
  const wrap = el('div')
  const list = el('div', 'confirm-list')
  for (const r of rows) list.append(el('p', 'confirm-list-item', `${titleOf(r)} — ${r.runDir || 'sem pasta; só sai da lista'}`))
  wrap.append(list, el('p', 'hint', 'Fixadas, runs em grupo e arquivadas ficam de fora. Os históricos em ~/.claude/projects ficam. Não dá para desfazer.'))
  openConfirm({
    title: `Apagar ${rows.length} runs finalizadas?`,
    body: wrap,
    typed: `apagar ${rows.length}`,
    confirmText: `Apagar ${rows.length} runs`,
    danger: true,
    focus: 'typed',
    onConfirm: async (typed) => {
      const res = await orgCall('delete-finished', { wfs: rows.map((r) => r.wf), confirm: typed })
      if (res && res.error) return { error: res.error }
      if (res && res.failed && res.failed.length) {
        const doneN = rows.length - res.failed.length
        return { error: `${doneN} apagadas; ${res.failed.length} falharam: ${res.failed.map((f) => `${f.wf}: ${f.reason}`).join('; ')}` }
      }
      return {}
    },
  })
}

// ── Busca do modelo, sem corrida ──
// Várias notificações seguidas viram no máximo uma busca em voo + uma pendente; resposta de outra run
// (o usuário trocou no meio) é descartada.
let inflight = false
let pending = false

async function refresh() {
  if (!selectedWf) return
  if (inflight) {
    pending = true
    return
  }
  inflight = true
  const wf = selectedWf
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(wf)}`)
    if (wf !== selectedWf) return
    if (!res.ok) {
      currentModel = null
      setText(els.emptyMsg, 'Essa run não está mais disponível.')
      renderHeader(null)
      return
    }
    currentModel = await res.json()
    if (wf !== selectedWf) return
    if (runs.length) setText(els.emptyMsg, '')
    renderHeader(currentModel)
    renderGraph(currentModel)
    if (openNodeId) await loadDetail(wf, openNodeId)
    else if (drawerMode === 'run') Actions.refreshArtifacts()
  } catch {
    /* sem rede: o #conn já avisa; o próximo evento tenta de novo */
  } finally {
    inflight = false
    if (pending) {
      pending = false
      refresh()
    }
  }
}

function renderHeader(model) {
  if (!model) {
    els.header.replaceChildren()
    Actions.render(null)
    return
  }
  if (!els.header.firstChild) {
    const h1 = el('h1')
    h1.append(document.createTextNode(''), el('span', 'mono'))
    const chips = el('div', 'chips')
    const reason = el('span', 'chip chip-reason')
    reason.id = 'chip-reason'
    const listen = el('span', 'chip-listen')
    listen.id = 'chip-listen'
    chips.append(el('span', 'chip chip-status'), el('span', 'chip'), el('span', 'chip'), reason, listen, el('span', 'warns'))
    els.header.append(h1, chips, el('p', 'goal'))
  }
  const [h1, chips, goal] = els.header.children
  const id = shortWf(model.wf)
  if (h1.firstChild.data !== (model.project ? `${model.project} — ` : '')) h1.firstChild.data = model.project ? `${model.project} — ` : ''
  setText(h1.lastChild, id)
  const [status, round, agents, , , warns] = chips.children
  setText(status, model.status || '')
  setData(status, { status: model.status || '' })
  setText(round, `round ${model.round}`)
  const est = model.estimate != null ? ` de ~${model.estimate}${model.ceiling != null ? ` (teto ${model.ceiling})` : ''}` : ''
  setText(agents, model.spent != null ? `${model.spent} agente${model.spent === 1 ? '' : 's'}${est}` : '')
  // avisos viram chips laranja (o wrapper .warns é display: contents, os chips ficam na mesma linha)
  const list = model.warns || []
  while (warns.children.length > list.length) warns.lastChild.remove()
  while (warns.children.length < list.length) warns.append(el('span', 'chip chip-warn'))
  list.forEach((w, i) => setText(warns.children[i], w))
  setText(goal, model.goal || '')
  Actions.render(model)
}

// ── Detalhe ──
async function openDetail(id) {
  if (!selectedWf) return
  const wasOpen = !!openNodeId
  openNodeId = id
  drawerMode = 'node'
  // Sai do modo run: vindo dos Artefatos sem fechar a gaveta, o artifactsState seguia preenchido, e
  // cada refresh anexava a lista "Pedidos" na gaveta do nó. Zerar também faz desistir um
  // loadArtifacts ainda em voo.
  Actions.onDrawerClosed()
  setData(els.app, { drawer: 'open', drawerMode: 'node' })
  els.drawer.setAttribute('aria-label', 'detalhe do nó')
  for (const b of nodeEls.values()) setData(b, { selected: b.dataset.id === id })
  if (!wasOpen && currentModel) renderGraph(currentModel)
  renderDetailHead(null, id)
  // Limpa a gaveta (pode vir dos Artefatos ou de outro nó) e põe o aviso DENTRO de .agent-content, que
  // renderDetail substitui; solto em #drawer-body ele ficaria para sempre entre as ações e os agentes.
  els.drawerBody.replaceChildren()
  agentContentEl().replaceChildren(el('p', 'drawer-note', 'Carregando…'))
  await loadDetail(selectedWf, id)
}

async function loadDetail(wf, id) {
  // pseudo-nó critic:rN usa o endpoint `critic` (todas as rodadas); polish:<k> usa `polish-<k>`
  // (a URL não aceita ':')
  const apiId = id.startsWith('critic:') ? 'critic' : id.startsWith('polish:') ? `polish-${id.slice('polish:'.length)}` : id
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(wf)}/nodes/${encodeURIComponent(apiId)}`)
    if (!res.ok || openNodeId !== id || wf !== selectedWf) return
    const detail = await res.json()
    if (openNodeId !== id || wf !== selectedWf) return
    const scroll = els.drawerBody.scrollTop
    renderDetailHead(detail, id)
    renderDetail(detail)
    const v = buildGraph(currentModel || { nodes: [] }).V.find((x) => x.id === id) || {}
    const pseudo = v.kind ? v.kind !== 'node' : !!detail.pseudo
    Actions.renderNodeActions(pseudo ? null : currentModel, id)
    els.drawerBody.scrollTop = scroll
  } catch {
    /* mantém o que já estava desenhado */
  }
}

function localTimeOf(iso) {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString(undefined, { hour12: false }) : ''
}

function renderDetailHead(detail, id) {
  const v = buildGraph(currentModel || { nodes: [] }).V.find((x) => x.id === id) || {}
  const state = v.state || (detail && detail.state) || ''
  const pseudo = v.kind ? v.kind !== 'node' : !!(detail && detail.pseudo)
  const title = pseudo ? v.title || id : (detail && detail.title) || v.title || id
  els.drawerTitle.replaceChildren(document.createTextNode(title))
  if (!pseudo && title !== id) els.drawerTitle.append(' ', el('span', 'mono', `(${id})`))
  setText(els.drawerState, STATE_TEXT[state] || state)
  setData(els.drawerState, { variant: variantOf(state) })
}

// Só o conteúdo dos agentes fica aqui dentro; `.node-actions-slot` (Actions.renderNodeActions) é irmão
// dele em #drawer-body e nunca é tocado por esta função — senão o refresh de ~1 s fecharia o <details>
// "Saída do nó" e descartaria o arquivo aberto a cada poll (ver I7.md, pendência do REPAIR).
function agentContentEl() {
  let c = els.drawerBody.querySelector('.agent-content')
  if (!c) {
    c = el('div', 'agent-content')
    els.drawerBody.append(c)
  }
  return c
}

function renderDetail(detail) {
  const body = agentContentEl()
  body.replaceChildren()
  if (detail.injected) body.append(el('p', 'drawer-note', `injetado pelo motor: ${detail.reason || ''}`))
  if (!detail.agents || !detail.agents.length) return body.append(el('p', 'drawer-note', 'Esse nó ainda não começou.'))

  for (const agent of [...detail.agents].reverse()) {
    const block = el('section', 'agent-block')
    block.dataset.status = agent.status
    const h3 = el('h3', null, agent.label)
    h3.append(el('span', 'agent-status', ` — ${agent.status}`))
    block.append(h3)
    if (agent.verdict) {
      const n = (agent.verdict.blocking || []).length
      const p = el('p', 'verdict', `veredito: ${agent.verdict.pass ? 'passou' : 'não passou'}${n ? ` (${n} bloqueio${n > 1 ? 's' : ''})` : ''}`)
      p.dataset.pass = String(!!agent.verdict.pass)
      block.append(p)
      if (n) {
        const ul = el('ul', 'blocking')
        for (const b of agent.verdict.blocking) ul.append(el('li', null, b.issue + (b.where ? ` — ${b.where}` : '')))
        block.append(ul)
      }
    }
    if (agent.checks && agent.checks.length) {
      const ul = el('ul', 'checks-list')
      for (const c of agent.checks) {
        const li = el('li')
        li.dataset.ok = String(!!c.ok)
        li.append(el('span', 'mark', c.ok ? '✓ ' : '✗ '), el('span', null, c.cmd))
        ul.append(li)
      }
      block.append(ul)
    }
    if (agent.toolCalls && agent.toolCalls.length) {
      const ul = el('ul', 'tool-calls')
      for (const tc of [...agent.toolCalls].reverse()) {
        const li = el('li')
        const call = el('span', 'call', `${tc.name}${tc.desc ? ` — ${tc.desc}` : ''}`)
        call.title = call.textContent // a linha é cortada em duas; o texto inteiro fica no tooltip
        li.append(el('time', null, localTimeOf(tc.ts) || tc.time || ''), call)
        ul.append(li)
      }
      block.append(ul)
    }
    if (agent.result && agent.result.summary) block.append(el('p', 'summary', agent.result.summary))
    if (agent.lastText) block.append(el('p', 'last-text', agent.lastText))
    if (agent.prompt) {
      const d = el('details', 'prompt')
      d.append(el('summary', null, 'prompt'), el('p', null, agent.prompt))
      block.append(d)
    }
    body.append(block)
  }
}

// ── SSE ──
function setLive(state) {
  setData(els.live, { state })
  setText(els.live, state === 'on' ? 'ao vivo' : state === 'off' ? 'sem conexão' : 'conectando')
}

function connect() {
  const es = new EventSource('/api/events')
  es.addEventListener('open', () => {
    setLive('on')
    setText(els.conn, '')
    refresh() // pode ter perdido eventos enquanto estava fora
  })
  es.addEventListener('runs', (e) => {
    let data
    try {
      data = JSON.parse(e.data)
    } catch {
      return
    }
    runs = data.runs || []
    org = data.org || { groups: [], pinned: [], warnings: [] }
    renderSidebar()
  })
  es.addEventListener('run', (e) => {
    let data
    try {
      data = JSON.parse(e.data)
    } catch {
      return
    }
    if (data.wf === selectedWf) refresh()
  })
  es.addEventListener('error', () => {
    setLive('off')
    setText(els.conn, 'Perdi a conexão com o graph-watch. Tentando de novo…')
  })
}

connect()
