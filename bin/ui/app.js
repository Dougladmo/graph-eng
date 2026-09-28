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
// A geometria vem de graph-layout.mjs (LAYOUT, placeGraph).

import { STATE_TEXT, variantOf, hasRun, buildGraph, layoutGraph, placeGraph, laneTitle, LAYOUT } from './graph-layout.mjs'

// ── DOM ──
const $ = (id) => document.getElementById(id)
const els = {
  app: $('app'),
  live: $('live'),
  railOpen: $('rail-open'),
  railClose: $('rail-close'),
  sidebar: $('sidebar'),
  sidebarToggle: $('sidebar-toggle'),
  groupActive: $('group-active'),
  groupDone: $('group-done'),
  themeSwitch: $('theme-switch'),
  themeLabel: $('theme-label'),
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
      const label = v.kind === 'node' ? `${v.id} · ${v.title}` : v.title
      setText(b.lastChild, label)
      b.title = label
      b.setAttribute('aria-label', `${label}, ${STATE_TEXT[v.state] || v.state}`)
      setData(b, { id: v.id, kind: v.kind, variant: variantOf(v.state), state: v.state, round: v.round, tone: toneOf(v.round), selected: v.id === openNodeId })
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
  if (!openNodeId) return
  openNodeId = null
  setData(els.app, { drawer: 'closed' })
  for (const b of nodeEls.values()) setData(b, { selected: false })
  if (currentModel) renderGraph(currentModel)
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

// ── Tema ──
function syncThemeSwitch() {
  const dark = window.graphEngTheme ? window.graphEngTheme.get() === 'dark' : false
  els.themeSwitch.setAttribute('aria-checked', String(dark))
}
els.themeSwitch.addEventListener('click', () => {
  if (!window.graphEngTheme) return
  window.graphEngTheme.set(window.graphEngTheme.get() === 'dark' ? 'light' : 'dark')
  syncThemeSwitch()
})
// o tema pode mudar sozinho (sistema mudou e não há escolha salva)
new MutationObserver(syncThemeSwitch).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
syncThemeSwitch()

// ── Lateral ──
const runEls = new Map()

// Ordem estável na lateral: em andamento primeiro e, dentro de cada grupo, a ordem em que a run apareceu
// pela primeira vez (o servidor ordena por última atividade, o que faria a lista pular a cada tick).
const firstSeen = new Map()
function stableRuns(list) {
  for (const r of list) if (!firstSeen.has(r.wf)) firstSeen.set(r.wf, firstSeen.size)
  const rank = (r) => (r.status === 'terminado' ? 1 : 0)
  return [...list].sort((a, b) => rank(a) - rank(b) || firstSeen.get(a.wf) - firstSeen.get(b.wf))
}

function renderSidebar() {
  setText(els.emptyMsg, runs.length ? '' : 'Nenhuma run do graph-eng por aqui. Dispare /graph-eng numa sessão do Claude Code e ela aparece sozinha.')
  const groups = [
    [els.groupActive, runs.filter((r) => r.status !== 'terminado')],
    [els.groupDone, runs.filter((r) => r.status === 'terminado')],
  ]
  // run que mudou de grupo (terminou) sai da lista antiga antes de entrar na nova
  for (const [wf, b] of runEls) {
    const r = runs.find((x) => x.wf === wf)
    const home = r && (r.status === 'terminado' ? els.groupDone : els.groupActive).lastElementChild
    if (!r || b.parentNode !== home) {
      b.remove()
      runEls.delete(wf)
    }
  }
  for (const [section, list] of groups) {
    section.hidden = list.length === 0
    const container = section.lastElementChild
    const cache = new Map(list.filter((r) => runEls.has(r.wf)).map((r) => [r.wf, runEls.get(r.wf)]))
    reconcile(container, cache, list, (r) => r.wf, createRunButton, updateRunButton)
    for (const [wf, b] of cache) runEls.set(wf, b)
    keepOrder(container, list.map((r) => runEls.get(r.wf)))
  }

  if (!selectedWf && runs.length) {
    const running = runs.find((r) => r.status === 'rodando')
    selectRun((running || runs[0]).wf, { replace: true })
  } else if (selectedWf && !currentModel && runs.some((r) => r.wf === selectedWf)) {
    refresh() // ?run= apontava para uma run que só agora apareceu na lista
  }
}

// Só move elemento quando a ordem mudou de fato (mover reinicia animação CSS).
function keepOrder(container, wanted) {
  const current = [...container.children]
  if (current.length === wanted.length && current.every((c, i) => c === wanted[i])) return
  for (const w of wanted) container.append(w)
}

function createRunButton() {
  const b = el('button', 'run-btn')
  b.type = 'button'
  const top = el('span', 'run-top')
  top.append(el('span', 'run-name'), el('span', 'run-badge'))
  const bottom = el('span', 'run-bottom')
  bottom.append(el('span', 'run-project'), el('span', 'run-strip'))
  b.append(top, bottom)
  b.addEventListener('click', () => {
    selectRun(b.dataset.wf)
    setSidebarOpen(false)
  })
  return b
}

function updateRunButton(b, r) {
  setData(b, { wf: r.wf, status: r.status })
  b.setAttribute('aria-current', String(r.wf === selectedWf))
  const [top, bottom] = b.children
  setText(top.firstChild, shortWf(r.wf))
  setText(top.lastChild, r.status === 'parada?' ? 'parada?' : r.status === 'rodando' ? 'rodando' : '')
  setText(bottom.firstChild, r.project || '')
  b.title = r.goal || r.wf
  const strip = bottom.lastChild
  const dots = r.nodes || []
  while (strip.children.length > dots.length) strip.lastChild.remove()
  while (strip.children.length < dots.length) strip.append(el('span', 'dot'))
  dots.forEach((n, i) => setData(strip.children[i], { variant: variantOf(n.state), tone: toneOf(n.round) }))
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
  for (const [k, b] of runEls) b.setAttribute('aria-current', String(k === selectedWf))
  refresh()
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
  if (!model) return els.header.replaceChildren()
  if (!els.header.firstChild) {
    const h1 = el('h1')
    h1.append(document.createTextNode(''), el('span', 'mono'))
    const chips = el('div', 'chips')
    chips.append(el('span', 'chip chip-status'), el('span', 'chip'), el('span', 'chip'), el('span', 'warns'))
    els.header.append(h1, chips, el('p', 'goal'))
  }
  const [h1, chips, goal] = els.header.children
  const id = shortWf(model.wf)
  if (h1.firstChild.data !== (model.project ? `${model.project} — ` : '')) h1.firstChild.data = model.project ? `${model.project} — ` : ''
  setText(h1.lastChild, id)
  const [status, round, agents, warns] = chips.children
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
}

// ── Detalhe ──
async function openDetail(id) {
  if (!selectedWf) return
  const wasOpen = !!openNodeId
  openNodeId = id
  setData(els.app, { drawer: 'open' })
  for (const b of nodeEls.values()) setData(b, { selected: b.dataset.id === id })
  if (!wasOpen && currentModel) renderGraph(currentModel)
  renderDetailHead(null, id)
  els.drawerBody.replaceChildren(el('p', 'drawer-note', 'Carregando…'))
  await loadDetail(selectedWf, id)
}

async function loadDetail(wf, id) {
  // pseudo-nó critic:rN usa o endpoint `critic` (todas as rodadas)
  const apiId = id.startsWith('critic:') ? 'critic' : id
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(wf)}/nodes/${encodeURIComponent(apiId)}`)
    if (!res.ok || openNodeId !== id || wf !== selectedWf) return
    const detail = await res.json()
    if (openNodeId !== id || wf !== selectedWf) return
    const scroll = els.drawerBody.scrollTop
    renderDetailHead(detail, id)
    renderDetail(detail)
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

function renderDetail(detail) {
  const body = els.drawerBody
  body.replaceChildren()
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
    try {
      runs = stableRuns(JSON.parse(e.data).runs || [])
    } catch {
      return
    }
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
