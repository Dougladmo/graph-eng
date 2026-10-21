// Artefatos da run e saída de cada nó: só leitura (GET /api/runs/:wf/artifacts[/:name]). Este módulo não
// faz nenhuma escrita. Sem inner/outerHTML: todo texto entra por textContent ou por nós criados com
// createElement, como o resto de bin/ui/.
//
// Módulo com estado próprio (padrão de config-modal.mjs): initArtifacts() é chamado uma vez por app.js;
// renderRunTools(model) a cada renderHeader(); renderNodeOutput(model, id) a cada detalhe de nó aberto.

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

// ── Estado do módulo ──
let refs = null // { runActions, drawerTitle, drawerState, drawerReason, drawerBody }
let hooks = null // { openArtifactsDrawer, selectRun }
let lastModel = null
let artifactsState = null // { wf, files, current } enquanto a gaveta está em modo run

export function initArtifacts(o) {
  hooks = o
  refs = {
    runActions: $('run-actions'),
    drawerTitle: $('drawer-title'),
    drawerState: $('drawer-state'),
    drawerReason: $('drawer-reason'),
    drawerBody: $('drawer-body'),
  }
}

// ── Barra da run: o botão Artefatos e, numa execução já retomada em outra, a nota com o atalho ──
export function renderRunTools(model) {
  lastModel = model
  const bar = refs.runActions
  if (!bar) return
  if (!model) {
    bar.hidden = true
    bar.replaceChildren()
    return
  }
  bar.hidden = false
  if (!bar.querySelector('#act-artifacts')) {
    const btn = el('button', 'btn-ghost', 'Artefatos')
    btn.type = 'button'
    btn.id = 'act-artifacts'
    btn.addEventListener('click', onArtifactsClick)
    bar.prepend(btn)
  }
  const btn = bar.querySelector('#act-artifacts')
  btn.disabled = !model.runDir
  btn.title = model.runDir ? '' : 'Essa run não tem pasta em .graph-runs.'

  let note = bar.querySelector('.run-note')
  if (model.supersededBy) {
    if (!note) {
      note = el('span', 'run-note')
      const go = el('button', 'btn-link', 'Abrir a execução mais nova')
      go.type = 'button'
      go.id = 'go-current'
      go.addEventListener('click', () => {
        if (lastModel && lastModel.supersededBy && hooks.selectRun) hooks.selectRun(lastModel.supersededBy)
      })
      note.append(el('span', null, ''), go)
      bar.append(note)
    }
    setText(note.firstChild, `Essa execução foi retomada em ${model.supersededBy}; use a mais nova.`)
  } else if (note) {
    note.remove()
  }
}

function onArtifactsClick() {
  if (!lastModel || !hooks.openArtifactsDrawer) return
  hooks.openArtifactsDrawer()
  openArtifacts(lastModel.current || lastModel.wf)
}

// ── Gaveta, modo run: artefatos da run ──
// `artifactsState.current` guarda o arquivo escolhido pelo usuário; o refresh de ~1 s (refreshArtifacts,
// chamado por app.js a cada evento 'run') reabre esse mesmo arquivo, não o REPORT.md, e não passa pela
// tela "Carregando…" — senão a gaveta ficaria inutilizável com a run rodando.
const GROUP_LABEL = { report: 'Relatório', plan: 'Plano', pedido: 'Pedido', node: 'Nós', outro: 'Outros' }
const GROUP_ORDER = ['report', 'plan', 'pedido', 'node', 'outro']

async function openArtifacts(wf) {
  setText(refs.drawerTitle, '')
  refs.drawerTitle.append(document.createTextNode('Artefatos '), el('span', 'mono', (lastModel && lastModel.runId) || wf))
  setText(refs.drawerState, 'Carregando…')
  // O motivo é do nó (renderDetailHead, app.js): vindo da gaveta de um nó falho sem fechar, ele seguia
  // à mostra no topo dos artefatos da run.
  refs.drawerReason.hidden = true
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

export function onDrawerClosed() {
  artifactsState = null
}

// ── Gaveta, modo nó: <details> "Saída do nó" com os arquivos gravados pelo nó (só leitura) ──
// O bloco é reaproveitado entre refreshes do mesmo nó (o poll de ~1 s não pode fechar o <details> nem
// perder o arquivo carregado): só recriamos o DOM quando o nó muda. O slot fica antes dos agentes, irmão
// de .agent-content (que renderDetail substitui sem tocar nele).
export function renderNodeOutput(model, id) {
  const body = refs.drawerBody
  if (!body) return
  let slot = body.querySelector('.node-output-slot')
  if (!slot) {
    slot = el('div', 'node-output-slot')
    body.prepend(slot)
  }
  const node = model && model.nodes ? model.nodes.find((n) => n.id === id) : null
  if (!node) {
    slot.dataset.node = ''
    slot.replaceChildren()
    return
  }
  if (slot.dataset.node === id && slot.firstChild) return
  slot.dataset.node = id
  slot.replaceChildren()
  const details = el('details', 'node-output')
  details.append(el('summary', null, 'Saída do nó'), el('div', 'node-output-files'))
  slot.append(details)
  loadNodeArtifacts(model, id, details.querySelector('.node-output-files'))
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
