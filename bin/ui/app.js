// Painel web ao vivo do graph-watch. Node puro, sem libs. Consome o contrato documentado no topo
// de bin/ui-server.mjs. Todo texto vindo do journal entra via textContent/createElement.
//
// ── Contrato com o CSS (o visual é trocável; a lógica não depende dele) ──
// O JS só posiciona e marca estado. Tudo que é visual fica no style.css, pendurado nestes ganchos:
//   #graph                     quadro do grafo; width/height em px vêm do layout. data-status = status da run
//                              (rodando|parada?|terminado): nó "rodando" de run parada não deve pulsar.
//   .node                      button do nó. left/top = CENTRO da bolinha. data-kind (plan|node|critic|synth),
//                              data-variant (empty|running|done|fail|skipped), data-state (estado cru),
//                              data-round, data-selected. Contém .dot e .node-label.
//   .edge                      segmento de reta. left/top = ponto de saída, width = comprimento, rotação em
//                              transform (origem no meio da borda esquerda). data-from, data-to, data-active
//                              (true quando a origem já rodou).
//   .run-btn                   run na lateral; aria-current, data-status (rodando|parada?|terminado).
//                              Contém .run-name e .run-strip (uma .dot por nó, com data-variant).
//   #conn                      aviso de conexão (vazio quando conectado). #empty-msg: estado vazio.
// A geometria vem de graph-layout.mjs (LAYOUT); o CSS deve manter a .dot com diâmetro LAYOUT.DOT.

import { STATE_TEXT, variantOf, hasRun, buildGraph, layoutGraph } from './graph-layout.mjs'

// ── DOM ──
const $ = (id) => document.getElementById(id)
const els = {
  sidebar: $('sidebar'),
  sidebarToggle: $('sidebar-toggle'),
  header: $('run-header'),
  emptyMsg: $('empty-msg'),
  conn: $('conn'),
  graph: $('graph'),
  edges: $('edges'),
  nodes: $('nodes'),
  drawer: $('drawer'),
  drawerBody: $('drawer-body'),
  drawerClose: $('drawer-close'),
}

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

const nodeEls = new Map()
const edgeEls = new Map()

function renderGraph(model) {
  const graph = buildGraph(model)
  const { pos, segments, width, height } = layoutGraph(graph)
  els.graph.style.width = `${width}px`
  els.graph.style.height = `${height}px`
  setData(els.graph, { status: model.status || '' }) // run parada/terminada: o CSS para o pulso
  const stateById = new Map(graph.V.map((v) => [v.id, v.state]))

  reconcile(
    els.edges,
    edgeEls,
    segments,
    (s) => s.key,
    () => el('div', 'edge'),
    (e, s) => {
      e.style.left = `${s.x}px`
      e.style.top = `${s.y}px`
      e.style.width = `${s.len}px`
      e.style.transform = `rotate(${s.angle}deg)`
      setData(e, { from: s.from, to: s.to, active: hasRun(stateById.get(s.from)) })
    },
  )

  reconcile(
    els.nodes,
    nodeEls,
    graph.V,
    (v) => v.id,
    (v) => {
      const b = el('button', 'node')
      b.type = 'button'
      b.append(el('span', 'dot'), el('span', 'node-label'))
      b.addEventListener('click', () => openDetail(b.dataset.id))
      return b
    },
    (b, v) => {
      const p = pos.get(v.id)
      b.style.left = `${p.x}px`
      b.style.top = `${p.y}px`
      const label = v.kind === 'node' ? `${v.id} · ${v.title}` : v.title
      setText(b.lastChild, label)
      b.title = label
      b.setAttribute('aria-label', `${label}, ${STATE_TEXT[v.state] || v.state}`)
      setData(b, { id: v.id, kind: v.kind, variant: variantOf(v.state), state: v.state, round: v.round, selected: v.id === openNodeId })
    },
  )
}

// ── Estado da página ──
let runs = []
let selectedWf = new URLSearchParams(location.search).get('run') || null
let currentModel = null
let openNodeId = null

els.sidebarToggle.addEventListener('click', () => {
  const open = els.sidebar.classList.toggle('open')
  els.sidebarToggle.setAttribute('aria-expanded', String(open))
})
els.drawerClose.addEventListener('click', closeDrawer)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer()
})
window.addEventListener('popstate', () => {
  const wf = new URLSearchParams(location.search).get('run')
  if (wf && wf !== selectedWf) selectRun(wf, { fromHistory: true })
})

function closeDrawer() {
  els.drawer.hidden = true
  openNodeId = null
  for (const b of nodeEls.values()) setData(b, { selected: false })
}

// ── Lateral ──
const groupEls = new Map()
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
  const projects = [...new Set(runs.map((r) => r.project))]
  reconcile(
    els.sidebar,
    groupEls,
    projects,
    (p) => p,
    (p) => {
      const g = el('div', 'project-group')
      g.append(el('h2', null, p), el('div', 'project-runs'))
      return g
    },
    () => {},
  )
  const list = new Map([...groupEls].map(([p, g]) => [p, g.lastChild]))
  for (const [wf, b] of runEls) {
    const r = runs.find((x) => x.wf === wf)
    if (!r || list.get(r.project) !== b.parentNode) {
      b.remove()
      runEls.delete(wf)
    }
  }
  for (const p of projects) {
    const container = list.get(p)
    const inProject = runs.filter((r) => r.project === p)
    const cache = new Map(inProject.filter((r) => runEls.has(r.wf)).map((r) => [r.wf, runEls.get(r.wf)]))
    reconcile(container, cache, inProject, (r) => r.wf, createRunButton, updateRunButton)
    for (const [wf, b] of cache) runEls.set(wf, b)
    keepOrder(container, inProject.map((r) => runEls.get(r.wf)))
  }
  keepOrder(els.sidebar, projects.map((p) => groupEls.get(p)))

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

function createRunButton(r) {
  const b = el('button', 'run-btn')
  b.type = 'button'
  b.append(el('span', 'run-name'), el('span', 'run-strip'))
  b.addEventListener('click', () => selectRun(b.dataset.wf))
  return b
}

function updateRunButton(b, r) {
  setData(b, { wf: r.wf, status: r.status })
  b.setAttribute('aria-current', String(r.wf === selectedWf))
  setText(b.firstChild, r.wf.replace(/^wf_/, ''))
  b.title = r.goal || r.wf
  const strip = b.lastChild
  const dots = r.nodes || []
  while (strip.children.length > dots.length) strip.lastChild.remove()
  while (strip.children.length < dots.length) strip.append(el('span', 'dot'))
  dots.forEach((n, i) => setData(strip.children[i], { variant: variantOf(n.state), round: n.round || 1 }))
}

function selectRun(wf, opts = {}) {
  if (wf !== selectedWf) {
    closeDrawer()
    currentModel = null
    for (const e of [...nodeEls.values(), ...edgeEls.values()]) e.remove()
    nodeEls.clear()
    edgeEls.clear()
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
    els.header.append(el('h1'), el('span', 'meta meta-status'), el('span', 'meta meta-round'), el('span', 'meta meta-agents'), el('span', 'meta meta-goal'), el('span', 'warns'))
  }
  const [h1, status, round, agents, goal, warns] = els.header.children
  setText(h1, model.project ? `${model.project} — ${model.wf.replace(/^wf_/, '')}` : model.wf)
  setText(status, model.status || '')
  setData(els.header, { status: model.status || '' })
  setText(round, `round ${model.round}`)
  const est = model.estimate != null ? ` de ~${model.estimate}${model.ceiling != null ? ` (teto ${model.ceiling})` : ''}` : ''
  setText(agents, model.spent != null ? `${model.spent} agentes${est}` : '')
  setText(goal, model.goal || '')
  setText(warns, (model.warns || []).join('; '))
}

// ── Detalhe ──
async function openDetail(id) {
  if (!selectedWf) return
  openNodeId = id
  els.drawer.hidden = false
  for (const b of nodeEls.values()) setData(b, { selected: b.dataset.id === id })
  els.drawerBody.replaceChildren(el('p', 'drawer-loading', 'Carregando…'))
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
    renderDetail(detail, id)
    els.drawerBody.scrollTop = scroll
  } catch {
    /* mantém o que já estava desenhado */
  }
}

function localTimeOf(iso) {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString(undefined, { hour12: false }) : ''
}

function renderDetail(detail, id) {
  const body = els.drawerBody
  body.replaceChildren()
  const v = (buildGraph(currentModel || { nodes: [] }).V.find((x) => x.id === id) || {})
  const state = v.state || detail.state
  body.append(el('p', 'drawer-title', detail.pseudo ? v.title || detail.id : `${detail.title || detail.id} (${detail.id})`))
  const st = el('p', 'drawer-state', STATE_TEXT[state] || state || '')
  st.dataset.variant = variantOf(state)
  body.append(st)

  if (!detail.agents || !detail.agents.length) return body.append(el('p', null, 'Esse nó ainda não começou.'))

  for (const agent of [...detail.agents].reverse()) {
    const block = el('section', 'agent-block')
    block.dataset.status = agent.status
    block.append(el('h3', null, `${agent.label} — ${agent.status}`))
    if (agent.toolCalls && agent.toolCalls.length) {
      const ul = el('ul', 'tool-calls')
      for (const tc of [...agent.toolCalls].reverse()) {
        const li = el('li')
        li.append(el('time', null, localTimeOf(tc.ts) || tc.time || ''), document.createTextNode(` ${tc.name}${tc.desc ? ` — ${tc.desc}` : ''}`))
        ul.append(li)
      }
      block.append(ul)
    }
    if (agent.verdict) {
      const n = (agent.verdict.blocking || []).length
      block.append(el('p', 'verdict', `veredito: ${agent.verdict.pass ? 'passou' : 'não passou'}${n ? ` (${n} bloqueio${n > 1 ? 's' : ''})` : ''}`))
      if (n) {
        const ul = el('ul', 'blocking')
        for (const b of agent.verdict.blocking) ul.append(el('li', null, b.issue + (b.where ? ` — ${b.where}` : '')))
        block.append(ul)
      }
    }
    if (agent.result && agent.result.summary) block.append(el('p', 'summary', agent.result.summary))
    if (agent.checks && agent.checks.length) {
      const ul = el('ul', 'checks-list')
      for (const c of agent.checks) {
        const li = el('li', null, `${c.ok ? '✓' : '✗'} ${c.cmd}`)
        li.dataset.ok = String(!!c.ok)
        ul.append(li)
      }
      block.append(ul)
    }
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
function connect() {
  const es = new EventSource('/api/events')
  es.addEventListener('open', () => {
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
  es.addEventListener('error', () => setText(els.conn, 'Perdi a conexão com o graph-watch. Tentando de novo…'))
}

connect()
