// Ações sobre a run: retomar, parar, refazer nó, copiar comando, artefatos e o selo "retomado"
// (spec docs/specs/2026-09-28-acoes-no-painel.md, item 1 e itens 4-9, contrato C14). Sem inner/outerHTML:
// todo texto entra por textContent ou nós criados com createElement, como o resto de bin/ui/.
//
// Módulo com estado próprio (padrão de config-modal.mjs): initActions() é chamado uma vez por app.js, que
// também chama render(model) a cada renderHeader() e renderNodeActions(model, id) a cada detalhe de nó
// aberto. As chamadas de escrita (POST /api/requests[/…]) e de leitura (GET /api/runs/:wf/artifacts[…])
// ficam só aqui: app.js não sabe nada da fila de pedidos.

import { openConfirm } from './confirm.mjs'
import { commandText } from './commands.mjs'
import { variantOf } from './graph-layout.mjs'

const $ = (id) => document.getElementById(id)

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
function setText(e, text) {
  if (e && e.textContent !== text) e.textContent = text
}
function setData(e, obj) {
  if (!e) return
  for (const [k, v] of Object.entries(obj)) {
    const s = String(v)
    if (e.dataset[k] !== s) e.dataset[k] = s
  }
}

const REQ_LABEL = {
  resume: 'Pedido de retomada',
  stop: 'Pedido de parada',
}
function reqSubject(req) {
  if (!req) return ''
  if (req.type === 'rerun-node') {
    const n = (req.dependentsList || []).length
    return `Pedido para refazer ${req.node}${n ? ` e ${n} dependente${n > 1 ? 's' : ''}` : ''}`
  }
  return REQ_LABEL[req.type] || 'Pedido'
}
function reqStateText(req) {
  const subj = reqSubject(req)
  if (req.state === 'pendente') return `${subj}: pendente — esperando uma sessão aceitar.`
  if (req.state === 'aceito') return `${subj}: aceito pela sessão ${(req.acceptedBy || '').slice(0, 8)} — executando.`
  if (req.state === 'feito') return `${subj}: feito às ${localTime(req.finishedAt || req.updatedAt)}.`
  if (req.state === 'falhou') return `${subj}: falhou — ${req.reason || 'sem motivo registrado'}.`
  return subj
}
function reqVariant(req) {
  if (!req) return 'empty'
  if (req.state === 'pendente') return 'empty'
  if (req.state === 'aceito') return 'running'
  if (req.state === 'feito') return 'done'
  if (req.state === 'falhou') return 'fail'
  return 'empty'
}
function localTime(iso) {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString(undefined, { hour12: false }) : ''
}

// ── Clipboard (item 4): writeText → textarea+execCommand → dialog de fallback ──
let copyResetTimer = null
async function copyText(text, btn) {
  let ok = false
  try {
    await navigator.clipboard.writeText(text)
    ok = true
  } catch {
    ok = false
  }
  if (!ok) {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.append(ta)
      ta.focus()
      ta.select()
      ok = document.execCommand('copy')
      ta.remove()
    } catch {
      ok = false
    }
  }
  if (ok && btn) {
    const original = btn.dataset.label || btn.textContent
    btn.dataset.label = original
    setText(btn, 'Copiado')
    clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(() => setText(btn, original), 1500)
    return
  }
  if (!ok) openCopyFallback(text)
}
function openCopyFallback(text) {
  const box = el('div')
  const ta = document.createElement('textarea')
  ta.readOnly = true
  ta.value = text
  ta.rows = 3
  ta.style.width = '100%'
  box.append(ta)
  openConfirm({
    title: 'Copie o comando',
    body: box,
    confirmText: 'Fechar',
    focus: 'ok',
    onConfirm: async () => {
      ta.select()
    },
  })
  queueMicrotask(() => {
    ta.select()
  })
}

// ── POSTs da fila (A1/A3) ──
async function postRequest(body) {
  const res = await fetch('/api/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { error: data.error || 'não consegui enviar o pedido' }
  lastRequest = data.request
  renderReqStatus()
  return {}
}
async function cancelRequest(id) {
  const res = await fetch(`/api/requests/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { error: data.error || 'não consegui cancelar' }
  lastRequest = data.request
  renderReqStatus()
  return {}
}

// ── Estado do módulo ──
let refs = null // { app, drawerTitle, drawerState, drawerBody, els: { runActions, actWhy, reqStatus } }
let hooks = null // { getModel, getWf, openArtifactsDrawer, deselectNodes }
let lastModel = null
let lastRequest = null // o pedido mostrado em #req-status: actions.open, senão requests[0]
let artifactsState = null // { files, current, text } enquanto a gaveta está em modo run

export function initActions(o) {
  hooks = o
  refs = {
    runActions: $('run-actions'),
    actWhy: $('act-why'),
    reqStatus: $('req-status'),
    drawerTitle: $('drawer-title'),
    drawerState: $('drawer-state'),
    drawerBody: $('drawer-body'),
    app: $('app'),
  }
}

// ── Cabeçalho: chips + barra de ações + estado do pedido (chamado por renderHeader) ──
export function render(model) {
  lastModel = model
  renderChips(model)
  renderActionsBar(model)
  renderReqStatus(model)
  renderRequestsSection(model)
}

function renderChips(model) {
  const reason = $('chip-reason')
  const listen = $('chip-listen')
  if (!reason || !listen) return
  if (!model) {
    setText(reason, '')
    listen.replaceChildren()
    return
  }
  setText(reason, model.stop && model.stop.text ? model.stop.text : '')
  setData(reason, { reason: (model.stop && model.stop.reason) || '' })
  const listening = (model.actions && model.actions.listening) || { project: false, owner: false, ownerPresence: 'nunca' }
  const on = !!listening.project
  setData(listen, { on: on ? '1' : '0' })
  if (!listen.firstChild) listen.append(el('span', 'dot'), el('span', 'chip-listen-text'))
  const [dot, text] = listen.children
  setData(dot, { variant: on ? 'done' : 'empty' })
  setText(text, !on ? 'nenhuma sessão ouvindo' : listening.owner ? 'sessão ouvindo' : 'sessão ouvindo · não é a dona')
  listen.title = on ? '' : 'Nenhum graph-watch deste projeto deu sinal nos últimos 30 s. Os botões voltam quando uma sessão do Claude Code estiver ouvindo; enquanto isso, use Copiar.'
}

// ── Barra #run-actions ──
function actionButton(id, cls, label) {
  const b = el('button', cls, label)
  b.type = 'button'
  b.id = id
  return b
}
function ensureBar() {
  const bar = refs.runActions
  if (!bar || bar.firstChild) return bar
  bar.append(
    actionButton('act-resume', 'btn-primary', 'Retomar'),
    actionButton('act-stop', 'btn-ghost danger', 'Parar…'),
    actionButton('act-artifacts', 'btn-ghost', 'Artefatos'),
    actionButton('go-current', 'btn-link', 'Abrir a execução mais nova'),
    actionButton('copy-resume', 'btn-link', 'Copiar para retomar'),
    actionButton('copy-stop', 'btn-link', 'Copiar para parar'),
  )
  bar.querySelector('#act-resume').addEventListener('click', onResumeClick)
  bar.querySelector('#act-stop').addEventListener('click', onStopClick)
  bar.querySelector('#act-artifacts').addEventListener('click', onArtifactsClick)
  bar.querySelector('#go-current').addEventListener('click', onGoCurrentClick)
  bar.querySelector('#copy-resume').addEventListener('click', (e) => onCopyClick(e, 'resume'))
  bar.querySelector('#copy-stop').addEventListener('click', (e) => onCopyClick(e, 'stop'))
  return bar
}

function setDisabled(btn, ok, why) {
  btn.disabled = !ok
  btn.title = ok ? '' : why || ''
  if (ok) btn.removeAttribute('aria-describedby')
  else btn.setAttribute('aria-describedby', 'act-why')
}

function renderActionsBar(model) {
  const bar = ensureBar()
  if (!bar) return
  const actWhy = refs.actWhy
  if (!model || !model.actions) {
    bar.hidden = true
    setText(actWhy, '')
    return
  }
  bar.hidden = false
  const a = model.actions
  const superseded = model.supersededBy != null
  const stopped = model.status !== 'rodando' && model.status !== 'terminado'
  const [resumeBtn, stopBtn, artifactsBtn, goCurrentBtn, copyResumeBtn, copyStopBtn] = bar.children

  resumeBtn.hidden = !stopped
  stopBtn.hidden = model.status === 'terminado'
  copyResumeBtn.hidden = resumeBtn.hidden
  copyStopBtn.hidden = stopBtn.hidden
  goCurrentBtn.hidden = !superseded
  artifactsBtn.disabled = !model.runDir
  artifactsBtn.title = model.runDir ? '' : 'Essa run não tem pasta em .graph-runs.'
  copyStopBtn.title = 'Cole na sessão que está rodando a run; outra sessão não consegue parar o workflow.'

  setDisabled(resumeBtn, !!(a.resume && a.resume.ok), a.resume && a.resume.why)
  setDisabled(stopBtn, !!(a.stop && a.stop.ok), a.stop && a.stop.why)
  setDisabled(copyResumeBtn, !!(a.copy && a.copy.resume && a.copy.resume.ok), a.copy && a.copy.resume && a.copy.resume.why)
  setDisabled(copyStopBtn, !!(a.copy && a.copy.stop && a.copy.stop.ok), a.copy && a.copy.stop && a.copy.stop.why)

  if (superseded) {
    for (const b of [resumeBtn, stopBtn, copyResumeBtn, copyStopBtn]) setDisabled(b, false, a.resume ? a.resume.why : '')
    setText(actWhy, `Essa execução foi retomada em ${model.supersededBy}; use a mais nova.`)
    return
  }
  const routeNote = (a.resume && a.resume.route === 'owner') || (a.rerun && a.rerun.route === 'owner')
  const firstWhy = [resumeBtn, stopBtn].find((b) => !b.hidden && b.disabled)
  setText(actWhy, routeNote ? 'Quem atende é a sessão dona: ela para a execução antiga e retoma.' : firstWhy ? firstWhy.title : '')
}

async function onResumeClick() {
  if (!lastModel) return
  const res = await postRequest({ type: 'resume', wf: lastModel.current || lastModel.wf })
  if (res.error) setText(refs.actWhy, res.error)
}
function onStopClick() {
  if (!lastModel) return
  openConfirm({
    title: 'Parar a run?',
    body: `A sessão que rodou ${lastModel.goal || lastModel.wf} interrompe o workflow agora. Agentes em andamento se perdem; os nós prontos ficam em .graph-runs e dá para retomar depois.`,
    confirmText: 'Parar run',
    danger: true,
    onConfirm: async () => {
      const res = await postRequest({ type: 'stop', wf: lastModel.current || lastModel.wf })
      if (res.error) return { error: res.error }
      return {}
    },
  })
}
function onGoCurrentClick() {
  if (lastModel && lastModel.supersededBy && hooks.selectRun) hooks.selectRun(lastModel.supersededBy)
}
function onCopyClick(e, type) {
  if (!lastModel) return
  const text = commandText({ type, runDir: lastModel.runDir, wf: lastModel.current || lastModel.wf })
  if (text) copyText(text, e.currentTarget)
}
function onArtifactsClick() {
  if (!lastModel || !hooks.openArtifactsDrawer) return
  hooks.openArtifactsDrawer()
  openArtifacts(lastModel.current || lastModel.wf)
}

// ── #req-status ──
function renderReqStatus(model = lastModel) {
  const p = refs.reqStatus
  if (!p) return
  // lastRequest só vale para a run cujo runKey ele mesmo carrega — sem isso, trocar de run mostra o
  // "Pedido de retomada…" da run anterior (com o Cancelar apontando para o id errado).
  const runKey = model && model.runKey
  if (lastRequest && lastRequest.runKey !== runKey) lastRequest = null
  const req = (model && model.actions && model.actions.open) || (model && model.requests && model.requests[0]) || lastRequest
  if (!req) {
    p.hidden = true
    p.replaceChildren()
    return
  }
  lastRequest = req
  p.hidden = false
  setData(p, { state: req.state })
  if (!p.firstChild) p.append(el('span', 'row-dot'), el('span', 'req-text'), actionButton('req-cancel', 'btn-link', 'Cancelar pedido'))
  const [dot, text, cancelBtn] = p.children
  setData(dot, { state: reqVariant(req) === 'running' ? 'running' : '' })
  let msg = reqStateText(req)
  if (req.state === 'pendente' && model && model.actions && model.actions.listening && !model.actions.listening.project) {
    msg += ' Nenhuma sessão ouvindo: ele espera até uma abrir.'
  }
  setText(text, msg)
  const cancelable = req.state === 'pendente' || (req.state === 'aceito' && Date.now() - Date.parse(req.acceptedAt || req.createdAt || 0) >= 2 * 60 * 1000)
  cancelBtn.hidden = !cancelable
  setText(cancelBtn, req.state === 'aceito' ? 'Descartar pedido' : 'Cancelar pedido')
  cancelBtn.onclick = () => cancelRequest(req.id)
}

// ── Gaveta, modo nó (C14): botão Refazer nó…, copiar, <details> Saída do nó, selo "retomado" ──
// O bloco é reaproveitado entre chamadas do mesmo nó (o refresh de ~1 s não pode fechar o <details> nem
// perder o arquivo carregado): só recriamos o DOM quando o nó muda; caso contrário mudamos só os estados
// disabled/hidden e os textos. `current` guarda o que os handlers de clique precisam, sempre a versão mais
// nova (os handlers são criados uma vez, mas leem `current` a cada clique).
let current = null // { model, node, id }
export function renderNodeActions(model, id) {
  const body = refs.drawerBody
  if (!body) return
  let slot = body.querySelector('.node-actions-slot')
  if (!slot) {
    slot = el('div', 'node-actions-slot')
    body.prepend(slot)
  }
  const sameNode = current && current.id === id && slot.firstChild
  if (!sameNode) slot.replaceChildren()

  if (!model) {
    current = null
    if (!slot.firstChild) slot.append(el('p', 'drawer-note node-actions', 'Plano, revisão, crítica, polimento e síntese não se refazem sozinhos.'))
    return
  }
  const node = model.nodes ? model.nodes.find((n) => n.id === id) : null
  if (!node) {
    current = null
    slot.replaceChildren()
    return
  }
  current = { model, node, id }

  let block = slot.querySelector('.node-actions')
  if (!block) {
    block = el('div', 'node-actions')
    const row = el('div', 'row')
    const rerunBtn = actionButton(null, 'btn-ghost', 'Refazer nó…')
    const copyBtn = actionButton(null, 'btn-link', '')
    row.append(rerunBtn, copyBtn)
    block.append(row)
    rerunBtn.addEventListener('click', () => {
      if (current) openRerunDialog(current.model, current.node, current.id)
    })
    copyBtn.addEventListener('click', (e) => {
      if (!current) return
      const text = commandText({ type: 'rerun-node', runDir: current.model.runDir, node: current.id, dependents: false })
      if (text) copyText(text, e.currentTarget)
    })
    const details = el('details', 'node-output')
    details.append(el('summary', null, 'Saída do nó'), el('div', 'node-output-files'))
    block.append(details)
    slot.append(block)
    loadNodeArtifacts(model, id, details.querySelector('.node-output-files'))
  }

  const row = block.querySelector('.row')
  const [rerunBtn, copyBtn] = row.children
  setText(copyBtn, `Copiar para refazer ${id}`)

  let chip = row.querySelector('.chip-resumed')
  if (node.resumed === true) {
    if (!chip) {
      chip = el('span', 'chip-resumed', 'retomado')
      chip.title = 'Resultado herdado de uma execução anterior; nenhum agente rodou este nó nesta execução.'
      row.append(chip)
    }
  } else if (chip) chip.remove()

  const runOk = model.actions && model.actions.rerun && model.actions.rerun.ok
  const runCopyOk = model.actions && model.actions.copy && model.actions.copy.rerun && model.actions.copy.rerun.ok
  const nodeOk = node.rerun && node.rerun.ok
  rerunBtn.disabled = !(runOk && nodeOk)
  copyBtn.hidden = !(runCopyOk && nodeOk)
  const why = !nodeOk ? node.rerun && node.rerun.why : !runOk ? model.actions.rerun.why : ''
  let whyP = block.querySelector('.why')
  if (why) {
    if (!whyP) {
      whyP = el('p', 'why')
      block.insertBefore(whyP, block.querySelector('.node-output'))
    }
    setText(whyP, why)
  } else if (whyP) whyP.remove()

  let depsCopyBtn = row.querySelector('.deps-copy')
  const deps = node.dependents || []
  if (deps.length) {
    if (!depsCopyBtn) {
      depsCopyBtn = actionButton(null, 'btn-link deps-copy', 'Copiar com dependentes')
      depsCopyBtn.addEventListener('click', (e) => {
        if (!current) return
        const text = commandText({ type: 'rerun-node', runDir: current.model.runDir, node: current.id, dependents: true })
        if (text) copyText(text, e.currentTarget)
      })
      row.append(depsCopyBtn)
    }
    depsCopyBtn.hidden = !(runCopyOk && nodeOk)
  } else if (depsCopyBtn) {
    depsCopyBtn.hidden = true
  }
}

function openRerunDialog(model, node, id) {
  const deps = node.dependents || []
  const box = el('div')
  const label = document.createElement('label')
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  label.append(cb, document.createTextNode(' Refazer também os dependentes'))
  box.append(el('p', null, `O nó roda de novo, aproveitando os resultados dos nós prontos. Nó pronto fora da lista não gera agente.`))
  box.append(label)
  const note = el('p', 'hint', deps.length ? `Também refaz: ${deps.join(', ')}` : 'Nenhum nó depende deste.')
  box.append(note)
  if (!deps.length) cb.disabled = true
  openConfirm({
    title: `Refazer ${id}?`,
    body: box,
    confirmText: 'Refazer',
    onConfirm: async () => {
      const dependents = cb.checked
      const res = await postRequest({ type: 'rerun-node', wf: model.current || model.wf, node: id, dependents })
      if (res.error) return { error: res.error }
      return {}
    },
  })
  cb.addEventListener('change', () => {
    const okBtn = document.getElementById('confirm-ok')
    if (okBtn) okBtn.textContent = cb.checked && deps.length ? `Refazer ${deps.length + 1} nós` : 'Refazer'
  })
  cb.focus()
}

async function loadNodeArtifacts(model, id, container) {
  if (!model.runDir) {
    container.append(el('p', 'drawer-note', 'Esse nó ainda não gravou saída em .graph-runs.'))
    return
  }
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(model.current || model.wf)}/artifacts`)
    if (!res.ok) return
    const data = await res.json()
    const files = (data.files || []).filter((f) => f.kind === 'node' && f.node === id)
    if (!files.length) {
      container.append(el('p', 'drawer-note', 'Esse nó ainda não gravou saída em .graph-runs.'))
      return
    }
    for (const f of files) {
      const btn = el('button', null, f.name)
      btn.type = 'button'
      btn.addEventListener('click', () => openArtifactInline(model, f, container))
      container.append(btn)
    }
  } catch {
    /* mantém a lista vazia */
  }
}
async function openArtifactInline(model, file, container) {
  let pre = container.querySelector('pre.artifact')
  if (!pre) {
    pre = el('pre', 'artifact')
    container.append(pre)
  }
  setText(pre, 'Carregando…')
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(model.current || model.wf)}/artifacts/${encodeURIComponent(file.name)}`)
    if (!res.ok) return setText(pre, `Não consegui ler ${file.name}.`)
    const data = await res.json()
    setText(pre, data.truncated ? `Mostrando os primeiros 256 KB de ${data.size}.\n\n${data.text}` : data.text)
  } catch {
    setText(pre, `Não consegui ler ${file.name}.`)
  }
}

// ── Gaveta, modo run (item 5): artefatos da run ──
// `artifactsState.current` guarda o arquivo escolhido pelo usuário; o refresh de ~1 s (refreshArtifacts,
// chamado por app.js a cada evento 'run') reabre esse mesmo arquivo, não o REPORT.md, e não passa pela
// tela "Carregando…" — senão a gaveta ficaria inutilizável com a run rodando (ver I7.md, pendência do
// REPAIR).
const GROUP_LABEL = { report: 'Relatório', plan: 'Plano', pedido: 'Pedido', node: 'Nós', outro: 'Outros' }
const GROUP_ORDER = ['report', 'plan', 'pedido', 'node', 'outro']

async function openArtifacts(wf) {
  setText(refs.drawerTitle, '')
  refs.drawerTitle.append(document.createTextNode('Artefatos '), el('span', 'mono', (lastModel && lastModel.runId) || wf))
  setText(refs.drawerState, 'Carregando…')
  refs.drawerBody.replaceChildren(el('p', 'drawer-note', 'Carregando…'))
  artifactsState = { wf, current: null }
  await loadArtifacts(wf, true)
}

// Chamado pelo poll (app.js refresh()) quando a gaveta já está em modo run: atualiza a lista e o arquivo
// selecionado no lugar, sem resetar a tela nem trocar de arquivo.
export function refreshArtifacts() {
  if (artifactsState && artifactsState.wf) loadArtifacts(artifactsState.wf, false)
}

async function loadArtifacts(wf, reset) {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(wf)}/artifacts`)
    if (!res.ok) {
      if (!reset) return // refresh silencioso: mantém o que já está na tela em vez de trocar por um erro
      const data = await res.json().catch(() => ({}))
      setText(refs.drawerState, '')
      refs.drawerBody.replaceChildren(el('p', 'drawer-note', data.error === 'essa run não tem pasta de artefatos' ? 'Essa run não tem pasta em .graph-runs.' : 'Não consegui ler os artefatos.'))
      return
    }
    const data = await res.json()
    if (!artifactsState || artifactsState.wf !== wf) return // a gaveta fechou ou trocou de run enquanto isso
    artifactsState.files = data.files || []
    renderArtifactsBody(wf, data.files || [], reset)
  } catch {
    if (reset) {
      setText(refs.drawerState, '')
      refs.drawerBody.replaceChildren(el('p', 'drawer-note', 'Não consegui ler os artefatos.'))
    }
  }
}

function renderArtifactsBody(wf, files, reset) {
  setText(refs.drawerState, `${files.length} arquivo${files.length === 1 ? '' : 's'}`)
  const body = refs.drawerBody
  let list = body.querySelector('.artifact-list')
  let pre = body.querySelector('pre.artifact')
  if (reset || !list || !pre) {
    body.replaceChildren()
    list = el('div', 'artifact-list')
    pre = el('pre', 'artifact')
    body.append(list, pre)
  } else {
    list.replaceChildren()
  }
  const byGroup = new Map()
  for (const g of GROUP_ORDER) byGroup.set(g, [])
  for (const f of files) (byGroup.get(f.kind) || byGroup.get('outro')).push(f)
  const select = (f) => {
    artifactsState.current = f.name
    for (const b of list.querySelectorAll('.artifact-item')) b.removeAttribute('aria-current')
    const btn = list.querySelector(`[data-name="${cssEscape(f.name)}"]`)
    if (btn) btn.setAttribute('aria-current', 'true')
    openArtifactFile(wf, f, pre)
  }
  const wanted = artifactsState && artifactsState.current
  let chosen = wanted ? files.find((f) => f.name === wanted) : null
  if (!chosen) chosen = files.find((f) => f.name === 'REPORT.md') || files.find((f) => f.name === 'plan.md') || files[0] || null
  for (const g of GROUP_ORDER) {
    const items = byGroup.get(g)
    if (!items.length) continue
    list.append(el('p', 'artifact-group-label', GROUP_LABEL[g] || g))
    for (const f of items) {
      const btn = el('button', 'artifact-item', f.name)
      btn.type = 'button'
      btn.dataset.name = f.name
      if (chosen && f.name === chosen.name) btn.setAttribute('aria-current', 'true')
      btn.addEventListener('click', () => select(f))
      list.append(btn)
    }
  }
  if (!files.length) {
    if (!body.querySelector('.drawer-note')) body.append(el('p', 'drawer-note', 'O relatório sai no fim da run.'))
  } else {
    const stale = body.querySelector('.drawer-note')
    if (stale) stale.remove()
  }
  if (chosen) {
    const changedSelection = artifactsState.current !== chosen.name || reset
    artifactsState.current = chosen.name
    // No refresh silencioso (changedSelection === false), reabre o mesmo arquivo sem passar por
    // "Carregando…": a saída pode estar mudando (nó em execução) e o texto só troca quando o conteúdo
    // muda de fato (setText compara antes de escrever).
    openArtifactFile(wf, chosen, pre, { silent: !changedSelection })
  }
  renderRequestsSection(lastModel)
}
function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}
async function openArtifactFile(wf, file, pre, opts = {}) {
  if (!opts.silent) setText(pre, 'Carregando…')
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(wf)}/artifacts/${encodeURIComponent(file.name)}`)
    if (!res.ok) return setText(pre, `Não consegui ler ${file.name}.`)
    const data = await res.json()
    setText(pre, data.truncated ? `Mostrando os primeiros 256 KB de ${data.size}.\n\n${data.text}` : data.text)
  } catch {
    if (!opts.silent) setText(pre, `Não consegui ler ${file.name}.`)
  }
}

// E2: histórico dos 5 últimos pedidos, na gaveta em modo run (spec docs/specs/2026-09-28-acoes-no-painel.md
// item 5 + tabela de extras). Sem isso o `feito`/`falhou` de um pedido some assim que o seguinte é aberto.
// Só desenha quando a gaveta está em modo run (artifactsState presente); render(model) chama isto a cada
// refresh, então o histórico também acompanha um pedido que muda de estado sem os arquivos mudarem.
function renderRequestsSection(model) {
  if (!refs.drawerBody || !artifactsState) return
  const reqs = ((model && model.requests) || []).slice(0, 5)
  let box = refs.drawerBody.querySelector('.artifact-requests')
  if (!reqs.length) {
    if (box) box.remove()
    return
  }
  if (!box) {
    box = el('div', 'artifact-requests')
    box.append(el('p', 'artifact-group-label', 'Pedidos'))
    box.append(el('ul'))
    refs.drawerBody.append(box)
  }
  const ul = box.querySelector('ul')
  while (ul.children.length > reqs.length) ul.lastChild.remove()
  while (ul.children.length < reqs.length) ul.append(el('li'))
  reqs.forEach((req, i) => setText(ul.children[i], reqStateText(req)))
}

export function onDrawerClosed() {
  artifactsState = null
}
