// Lógica pura da lista lateral (Fixadas, grupos, Em andamento, Paradas, Finalizadas e Arquivadas). Sem
// DOM: importável pelo Node, testado em test/ui-sidebar.test.mjs. bin/ui/app.js só desenha o que
// buildSections devolve. Contrato: docs/specs/2026-09-28-acoes-no-painel.md C13, detalhe em
// .graph-runs/20260928-1146-acoes-no-painel/D4.md §4.

import { variantOf } from './graph-layout.mjs'

export const PAGE = 10
export const STEP = 20
export const STRIP_MAX = 10 // X da fileira de bolinhas (D4 §4.4.1)
export const DEFAULT_OPEN = { pinned: true, active: true, stopped: true, done: false, archived: true }

const toneOf = (round) => (((round || 1) - 1) % 3) + 1
const RUN_ID_PREFIX_RE = /^\d{8}-\d{4}-/

// ── Seção de uma run (D4 §3.4 / C13): arquivada → fixada → grupo → rodando (vence planOnly) →
// terminado ou planOnly → o resto vai para Paradas. Espelha isInFinishedSection de bin/organize.mjs
// (paridade testada em test/ui-sidebar.test.mjs).
export function sectionOf(run) {
  if (run.archived) return 'archived'
  if (run.pinned) return 'pinned'
  if (run.group) return run.group
  if (run.status === 'rodando') return 'active'
  if (run.status === 'terminado' || run.planOnly) return 'done'
  return 'stopped'
}

// Título legível: runId sem o prefixo `AAAAMMDD-HHMM-`; sem runId, o goal cortado em 80; sem os dois, o wf
// curto (D4 §4.4).
export function titleOf(run) {
  if (typeof run.runId === 'string' && run.runId) {
    const stripped = run.runId.replace(RUN_ID_PREFIX_RE, '')
    return stripped || run.runId
  }
  if (typeof run.goal === 'string' && run.goal.trim()) {
    const g = run.goal.trim()
    return g.length > 80 ? `${g.slice(0, 80)}…` : g
  }
  return (run.wf || '').replace(/^wf_/, '')
}

function relTime(ms, now) {
  const diff = Math.max(0, now - (ms || now))
  const min = Math.round(diff / 60000)
  if (min < 1) return 'agora mesmo'
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.round(h / 24)
  return `há ${d} d`
}

// Texto do tooltip/meta (D4 §4.4): o motivo da parada, "terminada há X" ou "só plano". As três opções se
// excluem: uma run planOnly termina sempre como `terminado` (bin/ui-server.mjs), então ela nunca chega ao
// caso `stop`.
export function metaOf(run, now = Date.now()) {
  if (run.planOnly && run.status !== 'rodando') return 'só plano'
  if (run.status === 'terminado') return `terminada ${relTime(run.mtime, now)}`
  if (run.status !== 'rodando' && run.stop && run.stop.text) return run.stop.text
  return ''
}

function wordFor(variant, n) {
  switch (variant) {
    case 'fail':
      return 'com erro'
    case 'running':
      return 'rodando'
    case 'done':
      return n === 1 ? 'concluído' : 'concluídos'
    case 'empty':
      return 'na fila'
    case 'skipped':
      return n === 1 ? 'pulado' : 'pulados'
    default:
      return variant
  }
}

const STRIP_ORDER = ['fail', 'running', 'done', 'empty', 'skipped']

// stripOf(nodes, max) (D4 §4.4.1): até `max` nós, uma bolinha por nó (`mode: 'dots'`); acima, um resumo por
// estado com até 3 itens não zerados, na ordem com erro, rodando, concluído(s), na fila, pulado(s)
// (`mode: 'sum'`). `label` é sempre o texto por extenso de TODOS os estados não zerados, singular/plural.
export function stripOf(nodes = [], max = STRIP_MAX) {
  const counts = { fail: 0, running: 0, done: 0, empty: 0, skipped: 0 }
  const dots = nodes.map((n) => {
    const variant = variantOf(n.state)
    counts[variant] = (counts[variant] || 0) + 1
    return { variant, tone: toneOf(n.round) }
  })
  const nonZero = STRIP_ORDER.filter((v) => counts[v] > 0)
  const label = nonZero.map((v) => `${counts[v]} ${wordFor(v, counts[v])}`).join(', ')
  if (nodes.length <= max) return { mode: 'dots', dots, label }
  const items = nonZero.slice(0, 3).map((v) => ({ variant: v, n: counts[v] }))
  return { mode: 'sum', items, label }
}

function norm(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

function matches(run, title, nq) {
  if (!nq) return true
  return norm(title).includes(nq) || norm(run.project).includes(nq) || norm(run.goal).includes(nq) || norm(run.runId).includes(nq)
}

// Monta as seções prontas para desenhar (D4 §4.2, §4.12). `runs`: RunResumo[] (GET /api/runs). `org`:
// OrgPublica ({ groups, pinned }). `open`/`shown`: { [id]: bool|number } vindos do localStorage/estado da
// página. `firstSeen`: Map por `key`, mutado aqui (ordem estável, D4 §4.12).
export function buildSections(runs, org, { showArchived = false, query = '', open = {}, shown = {}, selectedWf = null, firstSeen = new Map(), now = Date.now() } = {}) {
  for (const r of runs) if (!firstSeen.has(r.key)) firstSeen.set(r.key, firstSeen.size)
  const nq = norm((query || '').trim())
  const isSelected = (r) => r.wf === selectedWf || (Array.isArray(r.wfs) && r.wfs.includes(selectedWf))

  const validGroupIds = new Set((org.groups || []).map((g) => g.id))
  const bySec = new Map()
  for (const r of runs) {
    const title = titleOf(r)
    if (!matches(r, title, nq)) continue
    // Grupo apagado por outra aba/painel pode deixar `group` apontando para um id que já não existe
    // (o servidor não limpa placement em group-delete). Sem isso, a run some da lista em silêncio.
    let sec = sectionOf(r)
    if (r.group && !validGroupIds.has(r.group)) sec = sectionOf({ ...r, group: null })
    if (sec === 'archived' && !showArchived) continue
    if (!bySec.has(sec)) bySec.set(sec, [])
    bySec.get(sec).push(r)
  }

  const defs = [{ id: 'pinned', label: 'Fixadas', kind: 'pinned' }]
  for (const g of org.groups || []) defs.push({ id: g.id, label: g.name, kind: 'group' })
  defs.push({ id: 'active', label: 'Em andamento', kind: 'state' })
  defs.push({ id: 'stopped', label: 'Paradas', kind: 'state' })
  defs.push({ id: 'done', label: 'Finalizadas', kind: 'state' })
  if (showArchived) defs.push({ id: 'archived', label: 'Arquivadas', kind: 'archived' })

  const pinnedOrder = new Map((org.pinned || []).map((k, i) => [k, i]))
  const sections = []
  for (const def of defs) {
    let rows = bySec.get(def.id) || []
    if (rows.length === 0 && def.kind !== 'group') continue // seção vazia some, menos os grupos
    rows =
      def.id === 'pinned'
        ? [...rows].sort((a, b) => (pinnedOrder.get(a.key) ?? 0) - (pinnedOrder.get(b.key) ?? 0))
        : [...rows].sort((a, b) => firstSeen.get(a.key) - firstSeen.get(b.key))

    const forcedOpen = rows.some(isSelected) || (nq !== '' && rows.length > 0)
    // Escolha explícita do usuário (clique no cabeçalho) manda: mesmo com a selecionada dentro,
    // fechar por clique fecha de verdade. Sem escolha salva, a seleção/busca ainda força aberto.
    const hasSaved = Object.hasOwn(open, def.id)
    const defaultOpen = hasSaved ? !!open[def.id] : def.kind === 'group' ? true : !!DEFAULT_OPEN[def.id]
    const isOpen = hasSaved ? defaultOpen : defaultOpen || forcedOpen

    let limit = Object.hasOwn(shown, def.id) ? shown[def.id] : PAGE
    const selIdx = rows.findIndex(isSelected)
    if (selIdx >= limit) limit = selIdx + 1 // a selecionada nunca fica escondida
    const visible = isOpen ? rows.slice(0, Math.max(limit, 0)) : []
    const remaining = rows.length - visible.length
    const more = isOpen && remaining > 0 ? Math.min(STEP, remaining) : 0
    const empty = rows.length === 0 && def.kind === 'group' ? 'Arraste uma run para cá' : null

    sections.push({ id: def.id, label: def.label, kind: def.kind, open: isOpen, forcedOpen, count: rows.length, rows: visible, more, empty })
  }
  return sections
}
