#!/usr/bin/env node
// graph-watch: visualizador só-leitura do journal do workflow graph-eng.
// Node puro, sem dependências. Contrato completo em test/model.test.mjs (topo do arquivo) e
// docs/specs/2026-09-27-visualizacao-design.md. Modos: `snapshot`, `agent`, `events`, `live` e `ui`
// (painel web ao vivo, servido por bin/ui-server.mjs — docs/specs/2026-09-27-painel-web.md). O núcleo
// (buildModel/normalizeNodes/estimateAgents/findRun) é usado por todos os modos.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { estimateAgents as estimateTarget, targetFor } from './ui/agent-target.mjs'
import { defaultStateDir, ownerPathInfo, listRequests, isEligible, isPendingExpired, markSeen, requestEventLine, writeHeartbeat, readListeners, ownerPresence, HEARTBEAT_MS, hasTerminatedMarker, markTerminated } from './requests.mjs'

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
function pluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || null
  } catch {
    return null
  }
}

// ── Erros ──
export class GraphWatchError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GraphWatchError'
    this.code = code
  }
}

// ── Presets (graph-eng.js:35-37) ──
const PRESETS = {
  lean: { maxAgents: 12, defer: ['low', 'medium'] },
  balanced: { maxAgents: 24, defer: ['low'] },
  max: { maxAgents: 48, defer: [] },
}

const LABEL_RE = /^(plan|work|verify|escalate|repair|draft-[ab]|judge|critic|synth|design-review|design-repair|polish)(:|$)/
// `id` depois de ':' não é nó real para estes rótulos: fica fora de `per` (D3 §3.1).
const PSEUDO_LABELS = new Set(['critic', 'design-review', 'polish'])

// ── Detecção de parada (spec docs/specs/2026-09-28-acoes-no-painel.md C6, D1 §3.3) ──
// Rótulos pseudo-agente que a linha "agora" (buildNowBlock) e `model.activePseudo` também contam,
// além de plan e synth (o pedido cita só critic e synth; os outros têm o mesmo defeito e custam zero).
const STOP_PSEUDO_KINDS = new Set(['plan', 'critic', 'synth', 'design-review', 'polish'])

const STOP_REASON_TEXT = {
  orcamento: 'orçamento esgotado',
  interrompida: 'interrompida',
  'sessao-encerrada': 'sessão encerrada',
}

function stopReasonText(reason, idleSec) {
  return STOP_REASON_TEXT[reason] || `sem atividade há ${Math.max(1, Math.floor(idleSec / 60))} min`
}

// ── Motivo do nó (spec C.., 7º pedido do PEDIDO.md: "motivo de cada nó") ──
// Só os 5 estados abaixo — "não terminou verificado" — ganham `n.reason`, calculado em buildModel a
// partir do journal (nunca inventado). Os demais (pronto, pronto-sem-verif[?], trabalhando,
// verificando, reparando, aguardando, erro) ficam sem motivo: são estados saudáveis/esperados, ou
// (erro) fora do pedido literal.
const REASON_STATES = new Set(['pulado', 'falhou', 'falhou-check', 'bloqueado', 'sem-reverificacao'])

// Primeira linha de um texto livre, achatado e cortado em `max` chars (usada no title da bolinha e
// como resumo; a gaveta e as linhas do events/snapshot mostram o `reason` inteiro, com quebras).
function firstLine(s, max = 160) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

// Última linha JSON válida de um texto com uma tentativa por linha (linhas truncadas ou vazias no
// meio da cauda lida são ignoradas: a última válida é a que importa).
function lastValidJsonLine(text) {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l) continue
    try {
      return JSON.parse(l)
    } catch {
      continue
    }
  }
  return null
}

// Lê só os últimos 64 KB de `agent-<id>.jsonl` (D1 §3.3 passo 3, §4 "custo de leitura"): a run some
// tem só agentes já terminados quando `openAgentIds` está vazio.
function readAgentTail(runDir, agentId, maxBytes = 65536) {
  const file = path.join(runDir, `agent-${agentId}.jsonl`)
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return { mtimeMs: null, tail: null }
  }
  const start = Math.max(0, st.size - maxBytes)
  const len = st.size - start
  let text = ''
  if (len > 0) {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, start)
      text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  }
  return { mtimeMs: st.mtimeMs, tail: lastValidJsonLine(text) }
}

function newestAgentFile(runDir) {
  let files
  try {
    files = fs.readdirSync(runDir)
  } catch {
    return null
  }
  let best = null
  for (const f of files) {
    const m = /^agent-(.+)\.jsonl$/.exec(f)
    if (!m) continue
    let st
    try {
      st = fs.statSync(path.join(runDir, f))
    } catch {
      continue
    }
    if (!best || st.mtimeMs > best.mtimeMs) best = { agentId: m[1], mtimeMs: st.mtimeMs }
  }
  return best
}

// `orcamento` (cota/gasto esgotado) e `interrompida` ([Request interrupted by user…], Esc ou Parar)
// valem na hora, sem esperar o limiar de silêncio; qualquer outra última linha é `vivo`.
export function classifyTail(tail) {
  if (!tail) return 'vivo'
  if (tail.isApiErrorMessage === true) {
    const q = tail.quotaLimits
    if (tail.error === 'rate_limit' || tail.apiErrorStatus === 429 || (q && q.status === 'rejected')) return 'orcamento'
  }
  if (tail.type === 'user') {
    const content = tail.message && tail.message.content
    const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []
    if (blocks.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('[Request interrupted by user'))) {
      return 'interrompida'
    }
  }
  return 'vivo'
}

// Avalia um agente aberto (started sem result/failed): parado?, motivo, idleSec. Sem `agent-<id>.jsonl`
// (agente ainda não escreveu nada), usa o mtime do journal como aproximação (D1 §3.3 passo 3).
function evalOpenAgent(runDir, agentId, journalMtimeMs, now, L, ownerGone, ownerListening) {
  const { mtimeMs, tail } = readAgentTail(runDir, agentId)
  const effectiveMtime = mtimeMs === null ? journalMtimeMs : mtimeMs
  const kind = classifyTail(tail)
  const idleSec = Math.max(0, Math.round((now - effectiveMtime) / 1000))
  const stopped = kind !== 'vivo' || idleSec > L
  if (!stopped) return { stopped, idleSec }
  const reason = kind === 'orcamento' || kind === 'interrompida' ? kind : !ownerListening && ownerGone ? 'sessao-encerrada' : 'sem-atividade'
  return { stopped, idleSec, reason }
}

// Regra única de parada (D1 §3.3, spec C6), usada por `buildModel` e pela lista de runs do servidor
// (`bin/ui-server.mjs`): nenhum dos dois calcula isso à parte mais.
export function computeStop({
  runDir,
  openAgentIds = [],
  terminated = false,
  planOnly = false,
  now = Date.now(),
  stallMinutes = 5,
  ownerListening = false,
  ownerGone = false,
} = {}) {
  if (terminated || planOnly) return null
  const L = stallMinutes * 60 * (ownerListening ? 3 : 1)
  let journalMtimeMs = now
  try {
    journalMtimeMs = fs.statSync(path.join(runDir, 'journal.jsonl')).mtimeMs
  } catch {
    /* sem journal legível: now é o melhor palpite */
  }

  if (openAgentIds.length) {
    const evals = openAgentIds.map((id) => evalOpenAgent(runDir, id, journalMtimeMs, now, L, ownerGone, ownerListening))
    // Numa fase paralela, um agente ainda vivo basta para a run seguir viva (D1 §3.3 passo 5).
    if (evals.some((e) => !e.stopped)) return null
    const idleSec = Math.max(...evals.map((e) => e.idleSec))
    const priority = ['orcamento', 'interrompida', 'sessao-encerrada', 'sem-atividade']
    const reason = priority.find((r) => evals.some((e) => e.reason === r)) || 'sem-atividade'
    return { reason, text: stopReasonText(reason, idleSec), idleSec }
  }

  // Sem agente aberto: entre agentes, ou o workflow morreu entre um e outro (D1 §3.3 passo 6).
  const newest = newestAgentFile(runDir)
  const mtime = newest ? newest.mtimeMs : journalMtimeMs
  const idleSec = Math.max(0, Math.round((now - mtime) / 1000))
  const tail = newest ? readAgentTail(runDir, newest.agentId).tail : null
  const kind = classifyTail(tail)
  const stopped = (kind !== 'vivo' && idleSec > 60) || idleSec > L
  if (!stopped) return null
  const reason = kind === 'orcamento' || kind === 'interrompida' ? kind : !ownerListening && ownerGone ? 'sessao-encerrada' : 'sem-atividade'
  return { reason, text: stopReasonText(reason, idleSec), idleSec }
}

// Ids reservados pelo motor para os nós injetados pelos trilhos (D1 §5, D3 §3.3).
const RESERVED_NODE_IDS = ['research-base', 'design-base']

// ── Leitura tolerante do journal (§7: linha parcial fica guardada até completar) ──
export function readJournalTolerant(journalPath) {
  let raw
  try {
    raw = fs.readFileSync(journalPath, 'utf8')
  } catch {
    return { events: [], illegible: 0, missing: true }
  }
  const rawLines = raw.split('\n')
  while (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop()
  const events = []
  let illegible = 0
  rawLines.forEach((line, i) => {
    if (!line.trim()) return
    try {
      events.push(JSON.parse(line))
    } catch {
      // a última linha pode ser uma escrita em andamento: ignorada sem contar como ilegível
      if (i !== rawLines.length - 1) illegible++
    }
  })
  return { events, illegible, missing: false }
}

// ── Retomada (I8, spec C8/D2 §5.3.9 "loadResume"): leitura tolerante de <runDir>/resume/<rs>.json,
// gravado por bin/graph-resume.mjs de forma atômica (tmp wx 0600 + rename). Usada pelo CLI e pelo
// fallback de buildModel abaixo (`readWfPrefixInfo`), para não criar ciclo de import com graph-resume.mjs.
export function loadResume(runDir, rs) {
  if (typeof runDir !== 'string' || !runDir || typeof rs !== 'string' || !/^rs-\d{8}-\d{6}(-\d+)?$/.test(rs)) return null
  try {
    const text = fs.readFileSync(path.join(runDir, 'resume', `${rs}.json`), 'utf8')
    const data = JSON.parse(text)
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

// Lê só `Run dir (paper trail): <dir>` e `Resume: <rs>` do início do prompt do próprio wf (mesmas linhas
// do SHARED de workflows/graph-eng.js), sem repetir o `inferHeader` inteiro de bin/ui-server.mjs (que fica
// do lado do servidor, e importaria este módulo, criando ciclo).
function readWfPrefixInfo(dir) {
  let files
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
      .sort()
  } catch {
    return {}
  }
  for (const f of files.slice(0, 3)) {
    let fd
    try {
      fd = fs.openSync(path.join(dir, f), 'r')
      const buf = Buffer.alloc(65536)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      const text = buf.toString('utf8', 0, n)
      const d = text.match(/(?:^|\\n|\n)[ \t]*Run dir \(paper trail\): ([^\\"\n]{1,1024})/)
      const rs = text.match(/(?:^|\\n|\n)[ \t]*Resume: (rs-\d{8}-\d{6}(?:-\d+)?)/)
      if (d || rs) return { runDirRaw: d ? d[1].trim() || undefined : undefined, resumeId: rs ? rs[1] : undefined }
    } catch {
      /* transcrição ausente ou ilegível: tenta a próxima */
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  return {}
}

// ── normalize() (graph-eng.js:314-349), como função pura e testável ──
export function normalizeNodes(list, opts = {}) {
  const { prefix = '', round = 1, existingIds = new Set(), readOnly = false, reserved = [] } = opts
  const idMap = new Map()
  const taken = new Set(existingIds)
  const out = []
  for (const raw of list || []) {
    const rawId = String(raw.id || '')
    let id = prefix + (rawId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'n' + (out.length + 1))
    // [DR-6] reserva condicional: só renomeia quando o planner (não o motor) usou o id (D1 §5 regra 2).
    if (prefix === '' && reserved.includes(id) && raw.injected !== true) id += '_'
    while (taken.has(id)) id += '_'
    taken.add(id)
    idMap.set(rawId, id)
    const rawKind = ['research', 'design', 'implement'].includes(raw.kind) ? raw.kind : 'research'
    let kind = rawKind
    if (kind === 'implement' && readOnly) kind = 'design'
    out.push(Object.assign({
      id,
      kind,
      rawKind,
      round,
      title: String(raw.title || id).slice(0, 80),
      rawDeps: (raw.deps || []).map(String),
      risk: ['low', 'medium', 'high'].includes(raw.risk) ? raw.risk : 'medium',
      explore: !!raw.explore && kind === 'design',
    }, raw.injected === true ? { injected: true, reason: String(raw.reason || '') } : {}))
  }
  for (const n of out) {
    n.deps = []
    for (const d of n.rawDeps) {
      const m = idMap.get(d) || (existingIds.has(d) ? d : null)
      if (m && m !== n.id) n.deps.push(m)
    }
    delete n.rawDeps
  }
  return out
}

// ── estimativa (graph-eng.js:557-558) sobre nós já normalizados ──
export function estimateAgents(nodes, preset, opts = {}) {
  const P = PRESETS[preset] || PRESETS.balanced
  const { spent = 1, trivial = false } = opts
  let estimate = spent + (trivial ? 0 : 2)
  for (const n of nodes) {
    estimate += (n.explore ? 3 : 1) + (n.kind === 'implement' || !P.defer.includes(n.risk) ? 1 : 0)
  }
  return estimate
}

function ancestorsOfNode(n, byId) {
  const seen = new Set()
  const stack = [...((n && n.deps) || [])]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const m = byId.get(id)
    if (m) stack.push(...(m.deps || []))
  }
  return seen
}

// Espelha workflows/graph-eng.js `applyRails` (D1 §5), como função pura sobre uma lista de nós já
// normalizados do round 1. Só o motor decide de fato (esta cópia serve para desenhar o grafo antes
// de o nó injetado rodar); test/model.test.mjs prova a paridade contra o harness do motor (D3 §10.7).
export function applyRails(nodes, mode) {
  const out = nodes.map((n) => ({ ...n, deps: [...(n.deps || [])] }))
  const byId = new Map(out.map((n) => [n.id, n]))
  const round = out.length ? out[0].round : 1
  const rails = []
  const railLog = (rule, node, action, detail) => rails.push({ rule, node, action, detail })

  // R1: nenhum nó research -> injeta research-base na raiz
  if (!out.some((n) => n.kind === 'research')) {
    let base = byId.get('research-base')
    if (!base) {
      const reason = 'research-base injetado na raiz (plano sem pesquisa)'
      base = { id: 'research-base', kind: 'research', rawKind: 'research', round, title: 'pesquisa de base (injetada)', deps: [], risk: 'medium', explore: false, injected: true, reason }
      out.push(base)
      byId.set(base.id, base)
      railLog('R1', base.id, 'inject', reason)
    }
  }

  // R3: implement/architecture sem nó design -> injeta design-base, depende de toda pesquisa
  if ((mode === 'implement' || mode === 'architecture') && !out.some((n) => n.kind === 'design')) {
    const researchIds = out.filter((n) => n.kind === 'research').map((n) => n.id)
    let base = byId.get('design-base')
    if (!base) {
      const reason = `design-base injetado, depende de ${researchIds.join(', ') || '(nada)'} (plano sem design)`
      base = { id: 'design-base', kind: 'design', rawKind: 'design', round, title: 'design de base (injetado)', deps: [...researchIds], risk: 'medium', explore: false, injected: true, reason }
      out.push(base)
      byId.set(base.id, base)
      railLog('R3', base.id, 'inject', reason)
    } else {
      const add = researchIds.filter((id) => !base.deps.includes(id))
      if (add.length) base.deps.push(...add)
    }
  }

  // R5: nó research dependendo de design/implement -> a dep cai
  for (const n of out) {
    if (n.kind !== 'research') continue
    const bad = n.deps.filter((d) => { const m = byId.get(d); return m && m.kind !== 'research' })
    if (bad.length) {
      n.deps = n.deps.filter((d) => !bad.includes(d))
      railLog('R5', n.id, 'drop-dep', `${n.id} deixou de depender de ${bad.join(', ')} (pesquisa não depende de design/implementação)`)
    }
  }

  // R6: nó design dependendo de implement -> a dep cai (evita deadlock do estágio 1)
  for (const n of out) {
    if (n.kind !== 'design') continue
    const bad = n.deps.filter((d) => { const m = byId.get(d); return m && m.kind === 'implement' })
    if (bad.length) {
      n.deps = n.deps.filter((d) => !bad.includes(d))
      railLog('R6', n.id, 'drop-dep', `${n.id} deixou de depender de ${bad.join(', ')} (design roda antes da implementação)`)
    }
  }

  // R2: nó design sem research entre os ancestrais -> ganha dep em toda pesquisa do round
  const researchIds2 = out.filter((n) => n.kind === 'research').map((n) => n.id)
  if (researchIds2.length) {
    for (const n of out) {
      if (n.kind !== 'design') continue
      const anc = ancestorsOfNode(n, byId)
      if (researchIds2.some((r) => anc.has(r))) continue
      const add = researchIds2.filter((r) => r !== n.id && !n.deps.includes(r))
      if (add.length) {
        n.deps.push(...add)
        railLog('R2', n.id, 'add-dep', `${n.id} passou a depender de ${add.join(', ')} (design sem pesquisa entre os ancestrais)`)
      }
    }
  }

  // R4: nó implement sem design entre os ancestrais -> ganha dep em todo design do round
  const designIds = out.filter((n) => n.kind === 'design').map((n) => n.id)
  if (designIds.length) {
    for (const n of out) {
      if (n.kind !== 'implement') continue
      const anc = ancestorsOfNode(n, byId)
      if (designIds.some((d) => anc.has(d))) continue
      const add = designIds.filter((d) => d !== n.id && !n.deps.includes(d))
      if (add.length) {
        n.deps.push(...add)
        railLog('R4', n.id, 'add-dep', `${n.id} passou a depender de ${add.join(', ')} (implementação sem design entre os ancestrais)`)
      }
    }
  }

  return { nodes: out, rails }
}

function findSiblingPlanOnly(runDir) {
  const parent = path.dirname(runDir)
  let entries
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return null
  }
  const me = path.basename(runDir)
  let meMtime = Infinity
  try {
    meMtime = fs.statSync(path.join(runDir, 'journal.jsonl')).mtimeMs
  } catch {
    /* sem journal próprio ainda: aceita qualquer candidato */
  }
  const candidates = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name === me) continue
    const dir = path.join(parent, e.name)
    let st
    try {
      st = fs.statSync(path.join(dir, 'journal.jsonl'))
    } catch {
      continue
    }
    candidates.push({ dir, mtime: st.mtimeMs })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  for (const c of candidates) {
    if (c.mtime > meMtime) continue
    const { events } = readJournalTolerant(path.join(c.dir, 'journal.jsonl'))
    const st = events.find((e) => e.type === 'started' && e.label === 'plan')
    if (!st) continue
    const res = events.find((e) => e.key === st.key && e.type === 'result')
    const hasWork = events.some((e) => e.type === 'started' && e.label && e.label.startsWith('work:'))
    if (res && !hasWork) return c.dir
  }
  return null
}

// ── Modelo (§6.1) a partir de um journal já achado ──
export async function buildModel(opts = {}) {
  const {
    runDir,
    siblingPlanOnlyDir,
    economy,
    mode,
    cutLine,
    effort,
    ceiling,
    now = Date.now(),
    stallMinutes = 5,
    ownerListening = false,
    ownerGone = false,
  } = opts
  const journalPath = path.join(runDir, 'journal.jsonl')
  let stat
  try {
    stat = fs.statSync(journalPath)
  } catch {
    throw new GraphWatchError(3, `nenhuma run do graph-eng em ${runDir}`)
  }
  const { events: allEvents, illegible } = readJournalTolerant(journalPath)
  const events = typeof cutLine === 'number' ? allEvents.slice(0, cutLine) : allEvents

  const startedEvents = events.filter((e) => e.type === 'started')
  const hasLabeled = startedEvents.some((e) => e.label)
  if (startedEvents.length && !hasLabeled) {
    throw new GraphWatchError(2, 'formato de journal não reconhecido (sem label); use /workflows')
  }
  const labels = startedEvents.filter((e) => e.label).map((e) => e.label)
  if (labels.length && !labels.some((l) => LABEL_RE.test(l))) {
    throw new GraphWatchError(2, `${path.basename(runDir)} não é run do graph-eng`)
  }

  const warns = []
  if (illegible) warns.push(`${illegible} linha(s) ilegível(is)`)

  const P = PRESETS[economy] || null
  const READ_ONLY = mode === 'research' || mode === 'review'

  // ── Formato novo (D3 §2): esqueleto de fases, effort/ceiling, revisão do design, polidores.
  // `NEW` só liga quando o journal já usa o schema novo (rótulos novos, ou `effort` no plano cru,
  // ou a flag/opt `effort`). Sem nenhum dos três, o caminho inteiro segue byte a byte o de hoje.
  const NEW_LABEL_RE = /^(design-review|design-repair|polish)(:|$)/
  let NEW = labels.some((l) => NEW_LABEL_RE.test(l)) || effort != null
  const LEVELS = ['low', 'medium', 'high', 'max']
  const RMODES = ['implement', 'architecture', 'research', 'review']
  let LEVEL = null
  let RMODE = null
  let HAS_DR = false
  function resolveModeFallback(rawNodes) {
    const list = rawNodes || []
    if (list.some((n) => n.kind === 'implement')) return 'implement'
    if (list.some((n) => n.kind === 'design')) return 'architecture'
    return 'research'
  }
  // Precedência D1 §3.2/"plan gate": o valor fixado nos args/flags vence o do plano cru.
  function applyPlanEffortAndMode(res) {
    if (res && res.effort && typeof res.effort.level === 'string') NEW = true
    if (!NEW) return
    LEVEL = LEVELS.includes(effort) ? effort : LEVELS.includes(res && res.effort && res.effort.level) ? res.effort.level : null
    RMODE = RMODES.includes(mode) ? mode : RMODES.includes(res && res.mode) ? res.mode : resolveModeFallback(res && res.nodes)
    HAS_DR = RMODE === 'implement' || RMODE === 'architecture'
  }
  const RAILS_OUT = []
  function applyRoundOneRails(list) {
    if (!NEW) return list
    const { nodes: withRails, rails: rr } = applyRails(list, RMODE)
    for (const n of withRails) NODES.set(n.id, n)
    RAILS_OUT.push(...rr)
    return withRails
  }

  const NODES = new Map()
  function doNormalize(list, o) {
    const ro = NEW ? RMODE !== 'implement' : READ_ONLY
    const out = normalizeNodes(list, { ...o, existingIds: new Set(NODES.keys()), readOnly: ro, reserved: NEW ? RESERVED_NODE_IDS : undefined })
    out.forEach((n) => NODES.set(n.id, n))
    return out
  }

  const planStarted = events.some((e) => e.type === 'started' && e.label === 'plan')
  let planRes = null
  const orphans = []
  let resumeMeta = null // { id, from } (C11/I8): wf retomado sem `plan` no journal
  const resumeSynthEvents = [] // eventos sintéticos p/ desenhar resume.done como pronto (I8, D2 §8)

  // Run retomada (I8, D2 §8): o wf retomado não chama o planner de novo (o motor recebe args.plan). O
  // prefixo do próprio wf traz `Resume: <rs>`, e o plano e o estado prontos saem de
  // `<runDir do header>/resume/<rs>.json`. Vem antes da irmã planOnly: numa run com plan gate, a irmã
  // tem o plano de antes da aprovação e não sabe quais nós já estavam prontos — com ela na frente, todo
  // nó pronto da retomada saía como pulado.
  if (!planStarted) {
    const { runDirRaw, resumeId } = readWfPrefixInfo(runDir)
    if (runDirRaw && resumeId) {
      const rd = loadResume(runDirRaw, resumeId)
      if (rd && rd.plan && Array.isArray(rd.plan.nodes)) {
        planRes = rd.plan
        applyPlanEffortAndMode(planRes)
        const first = doNormalize(planRes.nodes, { round: 1 })
        applyRoundOneRails(first)
        const doneMap = (rd.resume && rd.resume.done) || {}
        const rerunSet = new Set((rd.resume && rd.resume.rerun) || [])
        resumeMeta = { id: resumeId, from: Array.isArray(rd.resume && rd.resume.from) ? rd.resume.from : [] }
        let n = 0
        for (const id of Object.keys(doneMap)) {
          if (rerunSet.has(id)) continue
          const node = NODES.get(id)
          if (!node) continue
          node.resumed = true
          const entry = doneMap[id] || {}
          const key = `resume:${++n}:${id}`
          resumeSynthEvents.push({ type: 'started', key, agentId: null, label: `work:${id}`, phase: 'Execute', synthetic: true })
          resumeSynthEvents.push({ type: 'result', key, result: { status: 'done', summary: entry.summary || '', artifact: entry.artifact || '', filesChanged: entry.filesChanged || [] } })
          if (node.kind === 'implement' || entry.verified === true) {
            const vkey = `resume:${++n}:v:${id}`
            resumeSynthEvents.push({ type: 'started', key: vkey, agentId: null, label: `verify:${id}`, phase: 'Verify', synthetic: true })
            resumeSynthEvents.push({ type: 'result', key: vkey, result: { pass: true, confidence: 'high', blocking: [] } })
          }
        }
        // Revisão do design herdada: o motor não roda outra quando a da execução anterior passou. Sem ela,
        // a coluna ficava "aguardando" e os nós de design, "pronto s/ verif.".
        const dr = rd.resume && rd.resume.designReview
        const drInJournal = events.some((e) => e.type === 'started' && /^design-review:/.test(e.label || ''))
        if (dr && dr.pass === true && !drInJournal) {
          const att = Number.isInteger(dr.attempts) && dr.attempts > 0 ? dr.attempts : 1
          const dkey = `resume:${++n}:dr`
          resumeSynthEvents.push({ type: 'started', key: dkey, agentId: null, label: `design-review:r${att}`, phase: 'Design review', synthetic: true })
          resumeSynthEvents.push({ type: 'result', key: dkey, result: { pass: true, confidence: 'high', blocking: [] } })
        }
        warns.push(`plano e estado prontos lidos de resume/${resumeId} (sem plan neste journal)`)
      } else {
        warns.push(`Resume: ${resumeId} sem resume/${resumeId}.json legível`)
      }
    }
  }

  if (!planStarted && !planRes) {
    const sibDir = siblingPlanOnlyDir || findSiblingPlanOnly(runDir)
    if (sibDir) {
      const { events: sibEvents } = readJournalTolerant(path.join(sibDir, 'journal.jsonl'))
      const st = sibEvents.find((e) => e.type === 'started' && e.label === 'plan')
      const res = st && sibEvents.find((e) => e.key === st.key && e.type === 'result')
      const hasWork = sibEvents.some((e) => e.type === 'started' && e.label && e.label.startsWith('work:'))
      if (res && !hasWork) {
        planRes = res.result
        applyPlanEffortAndMode(planRes)
        const first = doNormalize(planRes.nodes, { round: 1 })
        applyRoundOneRails(first)
        warns.push(`plano lido da run planOnly ${path.basename(sibDir)}`)
      }
    }
  }

  // Run retomada (resumeFromRunId) não grava novo `launched`, só um segundo `started plan`. O estado vem da
  // última tentativa (senão os nós duplicam e o agente abandonado fica "rodando" para sempre); o custo soma todas.
  const planIdx = events.reduce((a, e, i) => (e.type === 'started' && e.label === 'plan' ? [...a, i] : a), [])
  const cut = planIdx.length > 1 ? planIdx[planIdx.length - 1] : 0
  if (cut) warns.push(`run retomada: ${planIdx.length} tentativas, desenhando a última`)

  const byKey = new Map()
  const per = new Map()
  const openByLabel = new Map() // rótulo → tentativa ainda sem resultado
  let abandoned = 0
  let spent = events.slice(0, cut).filter((e) => e.type === 'started').length
  let critic = null
  let synth = null
  let round = 1

  // ── Revisão do design e polidores (§3.2, §4.1, §4.3) ──
  let drStarted = false
  let drOpenCount = 0
  let designRepairOpenCount = 0
  let drAttempts = 0
  let drLastPass = null
  let drLastBlocking = []
  let drLastBlockingRaw = [] // itens crus (com .issue), p/ motivo por nó — drLastBlocking fica só com ids
  let drLastFailed = false
  const polishState = new Map() // k -> { state }

  for (const e of [...events.slice(cut), ...resumeSynthEvents]) {
    if (e.type === 'started') {
      if (!e.synthetic) spent++
      const s = { label: e.label, done: false, seq: spent, agentId: e.agentId }
      byKey.set(e.key, s)
      const label = e.label || ''
      const [k, id] = label.split(':')
      // Resume sem novo `started plan` (plano passado por args): o runtime roda de novo, com o mesmo rótulo,
      // toda chamada que não terminou. A tentativa anterior, sem resultado, foi abandonada: sai do estado do
      // nó (senão ele fica "trabalhando" para sempre), mas segue no custo.
      const prev = label && openByLabel.get(label)
      if (prev) {
        abandoned++
        const xs = id ? per.get(id) : null
        const i = xs ? xs.indexOf(prev) : -1
        if (i >= 0) xs.splice(i, 1)
      }
      if (label) openByLabel.set(label, s)
      if (!planStarted && !planRes && id && /^(work|draft-a)$/.test(k) && !NODES.has(id)) {
        NODES.set(id, { id, kind: '?', rawKind: '?', risk: 'medium', round: 1, title: '(sem plano no journal)', deps: [], explore: false, orphan: true })
        orphans.push(id)
      }
      if (id && !PSEUDO_LABELS.has(k)) {
        if (!per.has(id)) per.set(id, [])
        per.get(id).push(s)
      }
      if (k === 'critic') critic = { r: Number(id.slice(1)), running: true }
      if (k === 'synth') synth = 'rodando'
      if (k === 'design-review') {
        drStarted = true
        drOpenCount++
        const attempt = Number(String(id).replace(/^r/, '')) || 1
        drAttempts = Math.max(drAttempts, attempt)
      }
      if (k === 'design-repair') designRepairOpenCount++
      if (k === 'polish') {
        const kk = Number(id)
        if (Number.isFinite(kk)) polishState.set(kk, { state: 'trabalhando' })
      }
    } else if (e.type === 'result' || e.type === 'failed') {
      const s = byKey.get(e.key)
      if (!s) continue
      if (openByLabel.get(s.label) === s) openByLabel.delete(s.label)
      s.done = true
      s.failed = e.type === 'failed'
      s.result = e.result
      if (s.label === 'plan' && e.result && Array.isArray(e.result.nodes)) {
        planRes = e.result
        applyPlanEffortAndMode(planRes)
        const first = doNormalize(e.result.nodes, { round: 1 })
        applyRoundOneRails(first)
      }
      if (s.label && s.label.startsWith('critic:')) {
        const r = Number(s.label.split(':')[1].slice(1))
        const gaps = (e.result && e.result.gaps) || []
        critic = { r, running: false, gaps: gaps.length, done: !!(e.result && e.result.done) }
        if (gaps.length) {
          round = r + 1
          doNormalize(gaps, { prefix: `r${r + 1}-`, round: r + 1 })
        }
      }
      if (s.label === 'synth') synth = 'pronto'
      if (s.label && s.label.startsWith('design-review:')) {
        drOpenCount--
        const attempt = Number(s.label.split(':')[1].replace(/^r/, '')) || 1
        drAttempts = Math.max(drAttempts, attempt)
        const r = e.result || {}
        drLastFailed = e.type === 'failed'
        drLastPass = drLastFailed ? false : !!r.pass
        drLastBlocking = (r.blocking || []).map((b) => String((b && b.node) || b))
        drLastBlockingRaw = r.blocking || []
      }
      if (s.label && s.label.startsWith('design-repair:')) designRepairOpenCount--
      if (s.label && s.label.startsWith('polish:')) {
        const kk = Number(s.label.split(':')[1])
        if (Number.isFinite(kk)) polishState.set(kk, { state: e.type === 'failed' ? 'erro' : 'pronto' })
      }
    }
  }

  if (abandoned) warns.push(`run retomada: ${abandoned} agente(s) interrompido(s) antes do resume, desenhando a nova tentativa`)
  if (orphans.length) warns.push(`${orphans.length} nó(s) sem plano (${orphans.join(', ')}): desenhados sem deps, em modo compacto`)
  if (!planStarted && !planRes && NODES.size === 0) warns.push('sem plano no journal nem run planOnly irmã')

  const ended = synth !== null

  // Estado da revisão do design (§4.1): o primeiro caso que se aplicar, na ordem da lista.
  function computeDesignReviewState() {
    if (drOpenCount > 0) return { state: 'verificando', attempts: drAttempts, pass: drLastPass, blocking: drLastBlocking }
    if (designRepairOpenCount > 0) return { state: 'reparando', attempts: drAttempts, pass: drLastPass, blocking: drLastBlocking }
    if (!drStarted) return { state: 'aguardando', attempts: 0, pass: null, blocking: [] }
    if (drLastPass && !drLastFailed && !drLastBlocking.length) return { state: 'pronto', attempts: drAttempts, pass: true, blocking: [] }
    return { state: 'falhou', attempts: drAttempts, pass: drLastPass, blocking: drLastBlocking }
  }
  const designReviewModel = NEW ? computeDesignReviewState() : null

  const START = new Map()
  for (const [id, xs] of per) START.set(id, xs[0].seq)

  function closed(id) {
    if (ended) return true
    if (NEW && HAS_DR && designReviewModel && designReviewModel.state !== 'aguardando') {
      const n0 = NODES.get(id)
      if (n0 && n0.round === 1 && n0.kind !== 'implement') return true
    }
    for (const n of NODES.values()) if (n.deps && n.deps.includes(id) && START.has(n.id)) return true
    const n = NODES.get(id)
    return !!(critic && n && critic.r >= (n.round || 1))
  }

  // Por que `closed(id)` deu true, na mesma ordem que ela confere (usado só para o motivo de
  // sem-reverificacao: nunca muda o valor de `closed`, só explica em pt-BR qual dos ramos bateu).
  function closedCause(id) {
    if (ended) return 'a run terminou antes de reverificar'
    if (NEW && HAS_DR && designReviewModel && designReviewModel.state !== 'aguardando') {
      const n0 = NODES.get(id)
      if (n0 && n0.round === 1 && n0.kind !== 'implement') return 'a revisão do design já fechou este round'
    }
    for (const n of NODES.values()) {
      if (n.deps && n.deps.includes(id) && START.has(n.id)) return `o nó ${n.id} já começou antes da reverificação`
    }
    const n = NODES.get(id)
    if (critic && n && critic.r >= (n.round || 1)) return 'a crítica avançou para o próximo round'
    return 'motivo não determinado no journal'
  }

  const DEAD = new Set(['bloqueado', 'pulado'])
  const kindOf = (l) => l.split(':')[0]
  const isDraft = (k) => k === 'draft-a' || k === 'draft-b'
  const MEMO = new Map()
  // `full(id)` memoiza { state, reason }; `state(id)` (usada pelo resto do arquivo, inclusive
  // recursivamente aqui dentro para os deps) segue devolvendo só a string, como sempre devolveu.
  function full(id) {
    if (!MEMO.has(id)) MEMO.set(id, computeState(id))
    return MEMO.get(id)
  }
  function state(id) {
    return full(id).state
  }

  function computeState(id) {
    const xs = per.get(id) || []
    const n = NODES.get(id)
    if (!xs.length) {
      // `badDep` usa o mesmo DEAD (bloqueado/pulado) que decide `dead` — uma dependência que só
      // "falhou" não entra aqui (o motor não trata isso como cascata; ela conta como orçamento).
      const badDep = n && n.deps && n.deps.find((d) => DEAD.has(state(d)))
      const dead = !!badDep
      if (dead || ended) {
        let reason
        if (badDep) {
          const ds = state(badDep)
          reason = ds === 'pulado'
            ? `pulado: não rodou porque a dependência ${badDep} foi pulada`
            : `pulado: não rodou porque a dependência ${badDep} ficou bloqueada`
        } else if (typeof ceiling === 'number' && Number.isFinite(ceiling) && spent >= ceiling) {
          reason = `pulado: sem orçamento — o teto de ${ceiling} agentes acabou antes deste nó`
        } else {
          reason = 'pulado: não rodou: a run terminou antes'
        }
        return { state: 'pulado', reason }
      }
      return { state: 'aguardando', reason: null }
    }
    const open = xs.filter((x) => !x.done)
    if (open.length) {
      const k = kindOf(open[open.length - 1].label)
      if (k === 'verify' || k === 'escalate') return { state: 'verificando', reason: null }
      if (k === 'repair' || k === 'design-repair') return { state: 'reparando', reason: null }
      return { state: 'trabalhando', reason: null }
    }
    const last = xs[xs.length - 1]
    const lk = kindOf(last.label)
    const drafts = xs.filter((x) => isDraft(kindOf(x.label)))
    if (last.failed) {
      if (lk === 'work' || lk === 'judge' || (drafts.length === 2 && drafts.every((x) => x.failed))) {
        const r = last.result || {}
        const msg = firstLine(r.summary || r.assessment || r.error || '', 200)
        return { state: 'bloqueado', reason: `bloqueado: ${msg || 'o agente não voltou com resultado utilizável'}` }
      }
      return { state: 'erro', reason: null }
    }
    // Adiamento (§4.2): numa run nova, LEVEL substitui o preset --economy (P.defer).
    const deferred = NEW && LEVEL
      ? !!(n && n.kind !== 'implement' && n.round === 1 && (LEVEL === 'low' || LEVEL === 'medium'))
      : !!(P && n && n.kind !== 'implement' && P.defer.includes(n.risk))
    let verdict = null
    let pendingAfter = null
    let verifiedEver = false
    for (const x of xs) {
      if (x.failed) continue
      const k = kindOf(x.label)
      const r = x.result || {}
      if (k === 'verify' || k === 'escalate') {
        verdict = { pass: !!r.pass && !(r.blocking || []).length, via: 'verify', blocking: r.blocking || [] }
        pendingAfter = null
        verifiedEver = true
        continue
      }
      const draftFailed = drafts.some((dx) => dx.failed)
      const asWork = k === 'work' || k === 'judge' || (isDraft(k) && draftFailed)
      if (isDraft(k) && !asWork) {
        pendingAfter = 'draft'
        continue
      }
      if (!asWork && k !== 'repair' && k !== 'design-repair') continue
      if (asWork && r.status === 'blocked') {
        const msg = firstLine(r.summary || r.assessment || '', 200)
        return { state: 'bloqueado', reason: `bloqueado: ${msg || 'o worker sinalizou bloqueio, sem detalhe no resultado'}` }
      }
      const failedCheck = (r.checks || []).find((c) => c && c.ok === false)
      const red = !!failedCheck
      const gated = k === 'repair' || k === 'design-repair' || (NEW && LEVEL ? !deferred : P ? !deferred : x !== last)
      if (red && gated) {
        verdict = { pass: false, via: 'check', check: failedCheck }
        pendingAfter = null
        verifiedEver = true
        continue
      }
      pendingAfter = k === 'repair' || k === 'design-repair' ? 'repair' : 'work'
      verdict = null
    }
    if (pendingAfter === 'draft') {
      if (!closed(id)) return { state: 'trabalhando', reason: null }
      const bothFailed = drafts.length === 2 && drafts.every((x) => x.failed)
      const reason = bothFailed ? 'bloqueado: os dois rascunhos falharam' : 'bloqueado: os rascunhos não fecharam antes da run terminar'
      return { state: 'bloqueado', reason }
    }
    if (verdict) {
      if (verdict.pass) return { state: 'pronto', reason: null }
      if (verdict.via === 'check') {
        const c = verdict.check || {}
        const out = String(c.output || '').replace(/\s+/g, ' ').trim()
        const reason = `falhou (check): ${c.cmd || '(comando desconhecido)'}` + (out ? `\n${out.slice(0, 300)}` : '')
        return { state: 'falhou-check', reason }
      }
      const reps = xs.filter((x) => kindOf(x.label) === 'repair' || kindOf(x.label) === 'design-repair').length
      const items = (verdict.blocking || []).map((b) => firstLine(String((b && b.issue) || b), 220)).filter(Boolean)
      const first = items[0] || '(sem detalhe de bloqueio no resultado)'
      const lines = [`falhou: reprovado na verificação — ${first}`, ...items.slice(1).map((i) => `- ${i}`)]
      if (reps > 0) lines.push(ended ? 'reparo sem progresso' : 'reparo tentado, segue sem verificação aprovada')
      else if (ended) lines.push('sem orçamento para reparar')
      return { state: 'falhou', reason: lines.join('\n') }
    }
    if (pendingAfter === 'repair') {
      if (!closed(id)) return { state: 'reparando', reason: null }
      return { state: 'sem-reverificacao', reason: `sem-reverificacao: reparado, mas sem nova verificação — ${closedCause(id)}` }
    }
    if (!verifiedEver && (deferred || closed(id) || (NEW && LEVEL ? false : !P))) {
      const flagsUnknown = NEW && LEVEL ? false : !P || (mode === undefined && n && n.rawKind === 'implement')
      if (flagsUnknown) {
        warns.push(`${id}: deferido ou reprovado? passe --economy e --mode`)
        return { state: 'pronto-sem-verif?', reason: null }
      }
      return { state: 'pronto-sem-verif', reason: null }
    }
    return { state: 'verificando', reason: null }
  }

  const nodes = [...NODES.values()].map((n) => {
    const f0 = full(n.id)
    let st = f0.state
    let reason = f0.reason
    const xs = per.get(n.id) || []
    const reps = xs.filter((x) => kindOf(x.label) === 'repair' || kindOf(x.label) === 'design-repair').length
    // Revisão do design verificou o nó não-implement do round 1: sobrescreve o veredito do próprio
    // nó (§4.2). "falhou" vale mesmo sobre um verify próprio que passou; "pronto" só troca estados
    // sem verificação, porque um verify próprio que já reprovou continua valendo.
    if (NEW && HAS_DR && designReviewModel && n.round === 1 && n.kind !== 'implement') {
      if (designReviewModel.state === 'falhou' && ended && designReviewModel.blocking.includes(n.id)) {
        st = 'falhou'
        const item = drLastBlockingRaw.find((b) => b && (b.node === n.id || String(b.node || b) === n.id))
        const issue = item && item.issue ? firstLine(String(item.issue), 220) : ''
        reason = `falhou: reprovado na revisão do design${issue ? ' — ' + issue : ''}`
      } else if (designReviewModel.state === 'pronto' && ['pronto-sem-verif', 'pronto-sem-verif?', 'sem-reverificacao'].includes(st)) {
        st = 'pronto'
        reason = null
      }
    }
    const out = { id: n.id, kind: n.kind, risk: n.risk, round: n.round || 1, title: n.title, deps: n.deps || [], explore: !!n.explore, state: st, reps, closed: closed(n.id) }
    if (n.orphan) out.orphan = true
    if (n.resumed) out.resumed = true
    if (n.injected) {
      out.injected = true
      out.reason = n.reason || ''
    } else if (REASON_STATES.has(st) && reason) {
      out.reason = reason
    }
    if (ACTIVE_STATES.has(st)) {
      const open = xs.filter((x) => !x.done)
      const last = open[open.length - 1]
      if (last && last.agentId) out.running = { label: last.label, agentId: last.agentId }
    }
    return out
  })

  const idleSec = Math.max(0, Math.round((now - stat.mtimeMs) / 1000))
  const synthDone = synth === 'pronto'

  // `openAgentIds`: agentId de todo `started` ainda sem `result`/`failed`, nós e pseudo (C6/D1 §3.3).
  const openAgentIds = [...byKey.values()].filter((s) => !s.done && s.agentId).map((s) => s.agentId)
  // planOnly (D1 §3.5): só houve `plan`, com resultado, e nenhum agente segue aberto.
  const attemptLabels = [...byKey.values()].map((s) => s.label)
  const planOnly = attemptLabels.length > 0 && attemptLabels.every((l) => l === 'plan') && openAgentIds.length === 0

  const stop = computeStop({ runDir, openAgentIds, terminated: synthDone, planOnly, now, stallMinutes, ownerListening, ownerGone })
  const status = synthDone || planOnly ? 'terminado' : stop ? 'parada?' : 'rodando'

  // Nó parado (D1 §3.3 "Nó parado"): mesmo que a run siga viva por outro nó paralelo, o nó cujo
  // agente está parado ganha `n.stop`, com o mesmo motivo/idleSec do agente dele.
  if (!synthDone && !planOnly) {
    const L = stallMinutes * 60 * (ownerListening ? 3 : 1)
    for (const n of nodes) {
      if (!n.running || !n.running.agentId) continue
      const ev = evalOpenAgent(runDir, n.running.agentId, stat.mtimeMs, now, L, ownerGone, ownerListening)
      if (ev.stopped) n.stop = { reason: ev.reason, text: stopReasonText(ev.reason, ev.idleSec), idleSec: ev.idleSec }
    }
  }

  // Linha "agora" (D1 §3.8): pseudo-agentes ainda abertos (plan, critic, synth, design-review, polish).
  const activePseudo = [...byKey.values()]
    .filter((s) => !s.done && s.agentId && STOP_PSEUDO_KINDS.has((s.label || '').split(':')[0]))
    .map((s) => ({ label: s.label, agentId: s.agentId }))

  const model = {
    wf: path.basename(runDir),
    round,
    status,
    idleSec,
    warns,
    nodes,
    critic,
    synth: synth || 'aguardando',
    spent,
    stop,
    planOnly,
    activePseudo,
    openAgentIds,
    resume: resumeMeta,
  }

  if (NEW) {
    model.effort = { level: LEVEL, why: (planRes && planRes.effort && planRes.effort.why) || undefined, mode: RMODE }
    model.rails = RAILS_OUT
    model.designReview = HAS_DR ? designReviewModel : null
    model.polish = [...polishState.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ k, state: v.state }))
  }

  if (NEW && LEVEL) {
    const first = nodes.filter((n) => n.round === 1 && !n.orphan)
    model.estimate = estimateTarget(first, { mode: RMODE, level: LEVEL })
    if (typeof ceiling === 'number' && Number.isFinite(ceiling)) {
      model.ceiling = ceiling
      model.target = targetFor(LEVEL, ceiling, RMODE)
    }
  } else if (P) {
    const first = nodes.filter((n) => n.round === 1 && !n.orphan)
    const trivial = !!(planRes && planRes.complexity === 'trivial' && first.length === 1)
    model.estimate = estimateAgents(first, economy, { spent: 1, trivial })
    model.ceiling = P.maxAgents
  }

  return model
}

// ── Achar a run (§6.8) ──
function slugify(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-')
}

function listWfDirsUnderSlugDir(slugDir) {
  const out = []
  let sessions
  try {
    sessions = fs.readdirSync(slugDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const s of sessions) {
    if (!s.isDirectory()) continue
    const wfRoot = path.join(slugDir, s.name, 'subagents', 'workflows')
    let wfs
    try {
      wfs = fs.readdirSync(wfRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const w of wfs) {
      if (!w.isDirectory()) continue
      const dir = path.join(wfRoot, w.name)
      let st
      try {
        st = fs.statSync(path.join(dir, 'journal.jsonl'))
      } catch {
        continue
      }
      out.push({ dir, wf: w.name, mtime: st.mtimeMs })
    }
  }
  return out
}

export function listAllWfDirs(projectsDir) {
  const out = []
  let slugs
  try {
    slugs = fs.readdirSync(projectsDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const s of slugs) {
    if (!s.isDirectory()) continue
    out.push(...listWfDirsUnderSlugDir(path.join(projectsDir, s.name)))
  }
  return out
}

export function isGraphEngRun(dir) {
  const { events } = readJournalTolerant(path.join(dir, 'journal.jsonl'))
  const labels = events.filter((e) => e.type === 'started' && e.label).map((e) => e.label)
  return labels.length > 0 && labels.some((l) => LABEL_RE.test(l))
}

export function isTerminatedRun(dir) {
  const { events } = readJournalTolerant(path.join(dir, 'journal.jsonl'))
  const st = events.find((e) => e.type === 'started' && e.label === 'synth')
  if (!st) return false
  return events.some((e) => e.key === st.key && e.type === 'result')
}

function reservedByCwd(dir, cwd) {
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return false
  }
  const needle = `"cwd":"${cwd}"`
  for (const f of files) {
    if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue
    try {
      const content = fs.readFileSync(path.join(dir, f), 'utf8')
      if (content.includes(needle)) return true
    } catch {
      /* ignore */
    }
  }
  return false
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function findRun(opts = {}) {
  const {
    projectsDir = path.join(os.homedir(), '.claude', 'projects'),
    cwd = process.cwd(),
    run,
    runId,
    mode = 'default',
    waitMs = 60000,
  } = opts

  const slug = slugify(cwd)
  const slugDir = path.join(projectsDir, slug)

  if (run) {
    const own = listWfDirsUnderSlugDir(slugDir).filter((c) => isGraphEngRun(c.dir))
    let found = own.find((c) => c.wf === run)
    if (!found) {
      const all = listAllWfDirs(projectsDir).filter((c) => isGraphEngRun(c.dir))
      found = all.find((c) => c.wf === run)
      if (found) console.error('graph-eng: aviso: run de outro projeto')
    }
    if (!found) throw new GraphWatchError(3, `run ${run} não encontrada para ${cwd}`)
    return { runDir: found.dir, wf: found.wf, terminated: isTerminatedRun(found.dir) }
  }

  if (runId) {
    const all = listAllWfDirs(projectsDir).filter((c) => isGraphEngRun(c.dir))
    const matches = []
    for (const c of all) {
      let files
      try {
        files = fs.readdirSync(c.dir)
      } catch {
        continue
      }
      const planMetaFile = files.find((f) => {
        if (!f.endsWith('.meta.json')) return false
        try {
          return JSON.parse(fs.readFileSync(path.join(c.dir, f), 'utf8')).description === 'plan'
        } catch {
          return false
        }
      })
      if (!planMetaFile) continue
      const agentId = planMetaFile.replace(/^agent-/, '').replace(/\.meta\.json$/, '')
      let content
      try {
        content = fs.readFileSync(path.join(c.dir, `agent-${agentId}.jsonl`), 'utf8')
      } catch {
        continue
      }
      if (content.includes(`.graph-runs/${runId}`) || content.includes(`graph-runs/${runId}`)) matches.push(c)
    }
    if (!matches.length) throw new GraphWatchError(3, `nenhuma run com runId ${runId}`)
    const nonPlanOnly = matches.find((c) => {
      const { events } = readJournalTolerant(path.join(c.dir, 'journal.jsonl'))
      return events.some((e) => e.type === 'started' && e.label && e.label.startsWith('work:'))
    })
    const chosen = nonPlanOnly || matches[0]
    return { runDir: chosen.dir, wf: chosen.wf, terminated: isTerminatedRun(chosen.dir) }
  }

  const deadline = Date.now() + waitMs
  for (;;) {
    let candidates = listWfDirsUnderSlugDir(slugDir).filter((c) => isGraphEngRun(c.dir))
    if (!candidates.length) {
      const all = listAllWfDirs(projectsDir).filter((c) => isGraphEngRun(c.dir))
      candidates = all.filter((c) => reservedByCwd(c.dir, cwd))
    }
    if (mode === 'events') {
      const open = candidates.filter((c) => !isTerminatedRun(c.dir))
      if (open.length) {
        open.sort((a, b) => b.mtime - a.mtime)
        return { runDir: open[0].dir, wf: open[0].wf, terminated: false }
      }
    } else if (candidates.length) {
      candidates.sort((a, b) => b.mtime - a.mtime)
      const c = candidates[0]
      return { runDir: c.dir, wf: c.wf, terminated: isTerminatedRun(c.dir) }
    }
    if (Date.now() >= deadline) {
      throw new GraphWatchError(3, mode === 'events' ? `nenhuma run do graph-eng em andamento para ${cwd}` : `nenhuma run do graph-eng para ${cwd}`)
    }
    await sleep(Math.min(20, Math.max(1, deadline - Date.now())))
  }
}

// ── Renderer (§6.3, §6.4) ──
const BOX_W = 22
const GAP = 3
const COLOR_CODES = { dim: 2, red: 31, green: 32, yellow: 33, magenta: 35, cyan: 36 }
const STATE_INFO = {
  trabalhando: ['trabalhando', '~', 'cyan'],
  verificando: ['verificando', '?', 'yellow'],
  reparando: (reps) => [`reparando ${reps}`, 'R', 'magenta'],
  pronto: ['pronto', '+', 'green'],
  'pronto-sem-verif': ['pronto s/ verif.', 'o', 'green'],
  'pronto-sem-verif?': ['pronto s/ verif.?', 'o', 'green'],
  falhou: ['falhou', 'x', 'red'],
  'falhou-check': ['falhou (check)', 'x', 'red'],
  bloqueado: ['bloqueado', 'x', 'red'],
  'sem-reverificacao': ['sem reverificação', 'r', 'yellow'],
  erro: ['erro', '!', 'red'],
  aguardando: ['aguardando', ' ', 'dim'],
  pulado: ['pulado', '-', 'dim'],
}

function stateLabel(n) {
  const info = STATE_INFO[n.state]
  if (typeof info === 'function') return info(n.reps)
  return info || [n.state, '?', 'dim']
}

function codePointLength(s) {
  return [...s].length
}

function cutCols(s, cols) {
  const arr = [...s]
  if (arr.length <= cols) return s
  return arr.slice(0, Math.max(0, cols - 1)).join('') + '…'
}

function paint(s, c, color) {
  if (!color || !c || !COLOR_CODES[c]) return s
  return `\x1b[${COLOR_CODES[c]}m${s}\x1b[0m`
}

function fitCell(s, w) {
  const arr = [...s]
  if (arr.length > w) return arr.slice(0, w - 1).join('') + '…'
  return s + ' '.repeat(w - arr.length)
}

function layoutLayers(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const depth = new Map()
  function d(id) {
    if (depth.has(id)) return depth.get(id)
    depth.set(id, 0)
    const n = byId.get(id)
    const deps = (n && n.deps) || []
    const val = deps.length ? Math.max(0, ...deps.map((p) => (byId.has(p) ? d(p) + 1 : 0))) : 0
    depth.set(id, val)
    return val
  }
  for (const n of nodes) d(n.id)
  const layers = []
  for (const n of nodes) {
    const k = depth.get(n.id)
    if (!layers[k]) layers[k] = []
    layers[k].push(n.id)
  }
  return layers.filter(Boolean)
}

function box(n) {
  const [label, marker, c] = stateLabel(n)
  const body = [`${n.id} · ${n.kind}`, `[${marker}] ${label}`, n.title, n.deps.length ? '← ' + n.deps.join(' ') : n.orphan ? '← ?' : '← plan']
  return { c, rows: ['┌' + '─'.repeat(BOX_W) + '┐', ...body.map((t) => '│' + fitCell(' ' + t, BOX_W) + '│'), '└' + '─'.repeat(BOX_W) + '┘'] }
}

function renderBoxLayers(model, layers, color) {
  const out = []
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const G = { '0011': '─', '1000': '│', '0100': '│', '1100': '│', '1001': '└', '1010': '┘', '1011': '┴', '0101': '┌', '0110': '┐', '0111': '┬', '1101': '├', '1110': '┤', '1111': '┼' }
  layers.forEach((L, k) => {
    const boxes = L.map((id) => box(byId.get(id)))
    const cx = (i) => Math.floor(i * (BOX_W + 2 + GAP) + (BOX_W + 2) / 2)
    if (k > 0) {
      const prevIds = layers[k - 1]
      const prevC = new Map(prevIds.map((id, i) => [id, cx(i)]))
      const parentXs = [...new Set(L.flatMap((id) => (byId.get(id).deps || []).filter((p) => prevC.has(p))))].map((p) => prevC.get(p))
      const kidXs = L.map((id, i) => [id, i]).filter(([id]) => (byId.get(id).deps || []).some((p) => prevC.has(p))).map(([, i]) => cx(i))
      if (parentXs.length || kidXs.length) {
        const lo = Math.min(...parentXs, ...kidXs)
        const hi = Math.max(...parentXs, ...kidXs)
        const bus = Array(hi + 1)
          .fill(' ')
          .map((_, x) => (x < lo || x > hi ? ' ' : G[[parentXs.includes(x), kidXs.includes(x), x > lo, x < hi].map(Number).join('')] || '─'))
        const stem = (set, ch) => {
          const a = Array(hi + 1).fill(' ')
          for (const x of set) a[x] = ch
          return a.join('')
        }
        out.push(stem(parentXs, '│'))
        out.push(bus.join(''))
        out.push(stem(kidXs, '▼'))
      }
    }
    const rowsCount = boxes[0] ? boxes[0].rows.length : 0
    for (let r = 0; r < rowsCount; r++) out.push(boxes.map((b) => paint(b.rows[r], b.c, color)).join(' '.repeat(GAP)))
  })
  return out
}

const ACTIVE_STATES = new Set(['trabalhando', 'verificando', 'reparando'])

function renderCompact(model, layers, color, rows, cols) {
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const lines = []
  layers.forEach((L, k) => {
    for (const id of L) {
      const n = byId.get(id)
      const [label, marker, c] = stateLabel(n)
      const indent = '  '.repeat(k)
      const arrow = k ? '└▶ ' : ''
      const deps = n.deps && n.deps.length ? n.deps.join(' ') : n.orphan ? '?' : 'plan'
      const reasonSuffix = n.reason ? `  · ${firstLine(n.reason, 80)}` : ''
      const line = `${indent}${arrow}[${marker}] ${n.id} ${label}  ← ${deps}${reasonSuffix}`
      lines.push({ id, c, text: paint(cutCols(line, cols), c, color) })
    }
  })
  if (rows && lines.length > rows) {
    const order = lines.map((l, i) => ({ i, active: ACTIVE_STATES.has(byId.get(l.id).state) }))
    order.sort((a, b) => (a.active === b.active ? a.i - b.i : a.active ? -1 : 1))
    const keepIdx = new Set(order.slice(0, Math.max(0, rows - 1)).map((o) => o.i))
    const kept = lines.filter((_, i) => keepIdx.has(i)).map((l) => l.text)
    kept.push(`… +${lines.length - kept.length} nós (graph-watch snapshot)`)
    return kept
  }
  return lines.map((l) => l.text)
}

// Corpo do desenho (sem a linha "agora", que só o modo snapshot acrescenta — não faz parte do golden).
export function graphText(model, opts = {}) {
  const cols = opts.cols || 100
  const color = !!opts.color
  const rows = opts.rows || Infinity
  const out = []
  const doneCount = model.nodes.filter((n) => n.state.startsWith('pronto')).length
  let header = `graph-eng · ${model.wf} · round ${model.round} · ${doneCount}/${model.nodes.length} prontos · agentes ${model.spent}`
  if (model.estimate != null && model.ceiling != null) {
    header += model.target != null
      ? ` (estimativa ~${model.estimate}, alvo ${model.target}, teto ${model.ceiling})`
      : ` (estimativa ~${model.estimate}, teto ${model.ceiling})`
  }
  if (model.status === 'parada?') header += ` · parada? (último evento há ${Math.max(1, Math.round(model.idleSec / 60))} min)`
  out.push(cutCols(header, cols))
  for (const w of model.warns) out.push(cutCols('aviso: ' + w, cols))
  out.push('')

  const layers = layoutLayers(model.nodes)
  const hasOrphan = model.nodes.some((n) => n.orphan)
  const hasInjected = model.nodes.some((n) => n.injected)
  const full = !hasOrphan && layers.every((L) => L.length * (BOX_W + 2) + Math.max(0, L.length - 1) * GAP <= cols)
  if (full && layers.length) {
    out.push(...renderBoxLayers(model, layers, color))
    // O layout em caixas (diferente do compacto, que traz o motivo embutido na linha via
    // `reasonSuffix`) não tem espaço para o texto dentro da caixa — por isso ele sai aqui, num
    // bloco à parte, uma linha por nó com `n.reason` (REPAIR do I11: os dois layouts do snapshot
    // precisam trazer o motivo, não só o compacto).
    const withReason = model.nodes.filter((n) => n.reason)
    if (withReason.length) {
      out.push('')
      out.push(cutCols('motivos:', cols))
      for (const n of withReason) out.push(cutCols(`  ${n.id}: ${firstLine(n.reason, cols)}`, cols))
    }
  } else {
    out.push(...renderCompact(model, layers, color, rows, cols))
  }
  out.push('')
  if (model.designReview) {
    const dr = model.designReview
    let drLine = `revisão do design: ${dr.state}`
    if (dr.attempts) drLine += ` r${dr.attempts}`
    if (dr.state === 'falhou' && dr.blocking.length) drLine += ` · bloqueios: ${dr.blocking.join(', ')}`
    out.push(cutCols(drLine, cols))
  }
  const criticLine = model.critic
    ? model.critic.running
      ? `critic r${model.critic.r} rodando`
      : `critic r${model.critic.r}: ${model.critic.done ? 'critérios atendidos' : model.critic.gaps + ' gap(s) → round ' + (model.critic.r + 1)}`
    : 'critic: aguardando'
  let synthLine = `${criticLine} · synth: ${model.synth}`
  if (model.polish && model.polish.length) {
    const done = model.polish.filter((p) => p.state === 'pronto').length
    synthLine += ` · polimento ${done}/${model.polish.length}`
  }
  out.push(cutCols(synthLine, cols))
  out.push(cutCols('legenda: [~] trabalhando  [?] verificando  [R] reparando N  [r] reparado, sem reverificação  [+] pronto', cols))
  out.push(cutCols('         [o] pronto s/ verif.  [x] falhou / falhou (check) / bloqueado  [!] erro  [ ] aguardando  [-] pulado', cols))
  if (hasInjected) out.push(cutCols('         (injetado) = nó que o motor acrescentou ao plano (trilho)', cols))
  return out.join('\n')
}

const NEXT_READY_STATES = new Set(['pronto', 'pronto-sem-verif', 'pronto-sem-verif?', 'sem-reverificacao'])

function lastToolUse(runDir, agentId) {
  let raw
  try {
    raw = fs.readFileSync(path.join(runDir, `agent-${agentId}.jsonl`), 'utf8')
  } catch {
    return null
  }
  let found = null
  for (const l of raw.trim().split('\n')) {
    if (!l) continue
    let o
    try {
      o = JSON.parse(l)
    } catch {
      continue
    }
    const content = Array.isArray(o.message && o.message.content) ? o.message.content : []
    for (const b of content) {
      if (b.type === 'tool_use') found = { name: b.name, ts: o.timestamp }
    }
  }
  return found
}

// ── Bloco "agora" (§5 de render-design.md; só o `snapshot` acrescenta, não faz parte do golden) ──
export function buildNowBlock(model, runDir, opts = {}) {
  const now = opts.now || Date.now()
  // D1 §3.8: além dos nós rodando, conta todo pseudo-agente aberto (plan, critic, synth,
  // design-review, polish) — hoje o bloco só olhava `model.nodes`, e critic/synth ficavam de fora.
  const active = [...model.nodes.filter((n) => n.running).map((n) => n.running), ...(model.activePseudo || [])]
  if (active.length) {
    return active
      .map((r) => {
        const shortId = String(r.agentId).slice(0, 8) + '…'
        const call = lastToolUse(runDir, r.agentId)
        if (call && call.ts) {
          const ageSec = Math.max(0, Math.round((now - Date.parse(call.ts)) / 1000))
          return `agora: ${r.label} · agente ${shortId} · última tool call ${call.name} há ${ageSec}s`
        }
        return `agora: ${r.label} · agente ${shortId} · sem tool call ainda`
      })
      .join('\n')
  }
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const next = model.nodes.filter((n) => n.state === 'aguardando' && (n.deps || []).every((d) => NEXT_READY_STATES.has((byId.get(d) || {}).state)))
  return next.length ? `agora: nada rodando · próximos: ${next.map((n) => n.id).join(', ')}` : 'agora: nada rodando'
}

// ── Hora local (spec painel-web item 14): getters locais do Date, que respeitam TZ ──
export function localHMS(d) {
  if (d === undefined || d === null || d === '') return ''
  const dt = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(dt.getTime())) return ''
  const pad = (x) => String(x).padStart(2, '0')
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`
}

function readTranscript(runDir, agentId) {
  let raw
  try {
    raw = fs.readFileSync(path.join(runDir, `agent-${agentId}.jsonl`), 'utf8')
  } catch {
    return null
  }
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function promptOf(lines) {
  const first = lines.find((o) => o.type === 'user' || (o.message && o.message.role === 'user'))
  if (!first || !first.message) return ''
  const c = first.message.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n') : ''
  return text.trim().slice(0, 600)
}

// Dados estruturados de um agente (um evento `started` do journal): o que o modo `agent` imprime e o
// que o painel mostra no detalhe do nó. `toolCalls[].ts` é o timestamp ISO cru da transcrição (UTC);
// `toolCalls[].time` é a hora local (HH:MM:SS) de quem chamou.
function agentData(runDir, st, events, n) {
  const res = events.find((e) => e.key === st.key && e.type !== 'started')
  const lines = readTranscript(runDir, st.agentId)
  const calls = []
  const texts = []
  let think = 0
  let thinkEmpty = 0
  for (const o of lines || []) {
    const content = Array.isArray(o.message && o.message.content) ? o.message.content : []
    for (const b of content) {
      if (b.type === 'tool_use') {
        const desc = (b.input && (b.input.description || b.input.command || b.input.file_path)) || JSON.stringify(b.input || {})
        calls.push({ ts: o.timestamp || null, time: localHMS(o.timestamp), name: b.name, desc: String(desc).replace(/\s+/g, ' ').slice(0, 200) })
      }
      if (b.type === 'text' && b.text && b.text.trim()) texts.push(b.text.trim())
      if (b.type === 'thinking') {
        think++
        if (!b.thinking) thinkEmpty++
      }
    }
  }
  const r = (res && res.result) || null
  const verdict = r && typeof r.pass === 'boolean' ? { pass: r.pass, confidence: r.confidence, blocking: r.blocking || [] } : null
  return {
    label: st.label,
    agentId: st.agentId,
    status: res ? (res.type === 'failed' ? 'erro' : 'terminou') : 'rodando',
    transcript: lines !== null,
    prompt: lines ? promptOf(lines) : '',
    totalCalls: calls.length,
    toolCalls: calls.slice(-n),
    lastText: texts.length ? texts[texts.length - 1] : null,
    think,
    thinkEmpty,
    verdict,
    result: r,
    checks: (r && Array.isArray(r.checks) && r.checks) || [],
  }
}

const PSEUDO_KINDS = new Set(['plan', 'critic', 'synth', 'design-review', 'polish'])
// Aceita `polish:<k>` (rótulo do journal) e `polish-<k>` (id da URL do painel, D3 §7): a API do
// painel (I2) evita dois-pontos no id do pseudo-nó, e aqui as duas grafias caem no mesmo agente.
const POLISH_ID_RE = /^polish[-:](\d{1,3})$/

// Todos os agentes de um nó, na ordem do journal. `id` é o id do nó (`I2`, `r2-G1`) ou um pseudo-nó
// (`plan`, `critic` — todas as rodadas —, `synth`, `design-review` — todas as tentativas —, `polish:<k>`
// ou `polish-<k>` — só o próprio polidor).
export function agentsOfNode(runDir, id, n = 20) {
  const { events } = readJournalTolerant(path.join(runDir, 'journal.jsonl'))
  const started = events.filter((e) => e.type === 'started' && e.label)
  const pm = POLISH_ID_RE.exec(id)
  const want = pm ? 'polish:' + Number(pm[1]) : null
  const mine = started.filter((e) => {
    const [k, rest] = e.label.split(':')
    if (want) return e.label === want
    return PSEUDO_KINDS.has(id) ? k === id : rest === id
  })
  return mine.map((st) => agentData(runDir, st, events, n))
}

// ── Modo `agent <nó>` (§6.7) ──
export function buildAgentView(runDir, arg, n = 8) {
  const { events } = readJournalTolerant(path.join(runDir, 'journal.jsonl'))
  const started = events.filter((e) => e.type === 'started' && e.label)
  const st = [...started].reverse().find((e) => e.label === arg || e.label.endsWith(':' + arg))
  if (!st) return { text: `nó ${arg} ainda não começou`, notStarted: true }
  const d = agentData(runDir, st, events, n)
  if (!d.transcript) throw new GraphWatchError(4, `sem transcrição para ${st.label}`)
  const out = []
  out.push(`${d.label} · agente ${d.agentId} · ${d.status === 'erro' ? 'ERRO' : d.status} · ${d.totalCalls} tool calls`)
  out.push('')
  out.push(`últimas ${d.toolCalls.length} tool calls:`)
  for (const c of d.toolCalls) out.push(`  ${c.time} ${c.name}  ${c.desc.slice(0, 80)}`)
  out.push('')
  out.push('último texto: ' + (d.lastText ? d.lastText.replace(/\s+/g, ' ').slice(0, 160) : '(nenhum texto livre; saída só estruturada)'))
  const r = d.result
  if (d.verdict) {
    out.push(`veredito: ${d.verdict.pass ? 'PASSOU' : 'REPROVOU'} (confiança ${d.verdict.confidence}) · ${d.verdict.blocking.length} bloqueio(s)`)
    for (const b of d.verdict.blocking) out.push('  - ' + String(b.issue).slice(0, 110))
  } else if (r) {
    out.push(`resultado: ${r.status || ''} · ${String(r.summary || r.assessment || '').slice(0, 140)}`)
  }
  out.push('')
  out.push(`raciocínio: ${d.think} bloco(s) de thinking, ${d.thinkEmpty} gravado(s) vazio(s) — não há o que mostrar`)
  return { text: out.join('\n'), notStarted: false, data: d }
}

export { codePointLength }

// ── Modo `events` (§5.1, §8.2 item 7) ──
const FINAL_ALWAYS = new Set(['pronto', 'pronto-sem-verif', 'bloqueado', 'erro', 'pulado'])
const FINAL_CLOSED = new Set(['falhou', 'falhou-check', 'sem-reverificacao', 'pronto-sem-verif?'])

function countReadyEvents(journalPath) {
  return readJournalTolerant(journalPath).events.length
}

function eventLine(model, marco) {
  const doneCount = model.nodes.filter((n) => n.state.startsWith('pronto')).length
  return `graph-eng ${model.wf} · ${marco} · ${doneCount}/${model.nodes.length} prontos · agentes ${model.spent}`
}

function summarizeActive(model) {
  const active = model.nodes.filter((n) => ACTIVE_STATES.has(n.state))
  const parts = active.map((n) => `${n.id} ${stateLabel(n)[0]}`)
  return `round ${model.round}${parts.length ? ', ' + parts.join(', ') : ''}`
}

// Roda o loop de marcos do modo `events` sobre uma run já achada (runDir). Devolve o exit code
// quando deve sair sozinho (0, após TERMINADO); nunca resolve fora disso — a run interrompida
// (§7 "não sai sozinho") depende de o processo ser encerrado de fora (SIGINT/kill).
export async function runEventsMode(runDir, opts = {}) {
  const { economy, modeFlag, effort, ceiling, explicitRun } = opts
  const journalPath = path.join(runDir, 'journal.jsonl')
  const emittedFinal = new Map()
  const emittedDR = new Map()
  let planEmitted = false
  let paradaEmitted = false
  let synthEmitted = false

  // ── Sinal de vida e fila de pedidos (spec C1-C4). Só existem quando o caminho do wf tem a forma
  // <slug>/<sessão>/subagents/workflows/<wf> (ownerPathInfo): um watcher sobre um --run-dir solto,
  // como os testes de hoje, não grava listener nem entra em "listen" (C3).
  const clock = () => (opts.now ? opts.now() : Date.now())
  const stateDir = opts.stateDir || defaultStateDir()
  const owner = ownerPathInfo(runDir)
  const startedAtIso = new Date(clock()).toISOString()
  let exitedHeartbeat = false
  // 'run' até o TERMINADO; vira 'listen' só na fase de escuta pós-TERMINADO (P2, C3). --run
  // (explicitRun) só escolhe a run a acompanhar num rearme e não tem relação com esta fase.
  let heartbeatMode = 'run'
  let listenUntilIso = null

  function beat(exitedAt = null) {
    if (!owner) return
    try {
      writeHeartbeat(stateDir, {
        session: owner.session,
        project: owner.project,
        cwd: opts.cwd ?? process.cwd(),
        pid: process.pid,
        wf: owner.wf,
        runId: opts.runId ?? null,
        mode: heartbeatMode,
        startedAt: startedAtIso,
        beatAt: new Date(clock()).toISOString(),
        listenUntil: listenUntilIso,
        exitedAt,
        plugin: pluginVersion(),
      })
    } catch {
      /* sinal de vida é melhor esforço: nunca derruba o watcher */
    }
  }

  function beatExit() {
    if (exitedHeartbeat || !owner) return
    exitedHeartbeat = true
    beat(new Date(clock()).toISOString())
  }

  let heartbeatTimer = null
  if (owner) {
    beat()
    heartbeatTimer = setInterval(beat, opts.heartbeatMs || HEARTBEAT_MS)
    if (heartbeatTimer.unref) heartbeatTimer.unref()
  }

  const seenLocally = new Set()
  function checkRequests() {
    if (!owner) return
    const now = clock()
    for (const req of listRequests(stateDir)) {
      if (req.state !== 'pendente' || seenLocally.has(req.id)) continue
      if (isPendingExpired(req, now)) continue
      if (!isEligible(req, { session: owner.session, project: owner.project })) continue
      seenLocally.add(req.id)
      if (!markSeen(stateDir, req.id, owner.session)) continue
      console.log(requestEventLine(req, { root: PLUGIN_ROOT, session: owner.session }))
    }
  }

  const onSignal = () => {
    beatExit()
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    process.exit(0)
  }
  if (owner) {
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  }

  // Presença da dona (C3, "no I3 o events passa a ler os listeners"): o próprio watcher É a dona
  // ouvindo (ou rearmando), então sua janela de parada é 3·N (computeStop) em vez de N.
  function presenceFlags() {
    if (!owner) return { ownerListening: false, ownerGone: false }
    const now = clock()
    let presence
    try {
      presence = ownerPresence(readListeners(stateDir, now), owner.session, now)
    } catch {
      return { ownerListening: false, ownerGone: false }
    }
    return { ownerListening: presence === 'ouvindo', ownerGone: presence === 'encerrada' }
  }
  const snap = (cutLine) => buildModel({ runDir, economy, mode: modeFlag, effort, ceiling, cutLine, ...presenceFlags() })

  function checkParada(model) {
    if (paradaEmitted || model.status !== 'parada?') return
    paradaEmitted = true
    console.log(eventLine(model, `parada? último evento há ${Math.max(1, Math.round(model.idleSec / 60))} min`))
  }

  function emitDiff(prevModel, curModel) {
    const count = curModel.nodes.filter((n) => !n.orphan).length
    if (!planEmitted && count) {
      planEmitted = true
      let text = `plano: ${count} nó(s)`
      if (curModel.estimate != null && curModel.ceiling != null) {
        text += curModel.target != null
          ? `, estimativa ~${curModel.estimate}, alvo ${curModel.target}, teto ${curModel.ceiling}`
          : `, estimativa ~${curModel.estimate}, teto ${curModel.ceiling}`
      }
      console.log(eventLine(curModel, text))
      for (const r of curModel.rails || []) console.log(eventLine(curModel, `trilho ${r.rule}: ${r.detail}`))
    }
    const prevById = new Map((prevModel ? prevModel.nodes : []).map((n) => [n.id, n]))
    for (const n of curModel.nodes) {
      const pn = prevById.get(n.id)
      const prevReps = pn ? pn.reps : 0
      if (n.reps > prevReps) console.log(eventLine(curModel, `${n.id} reparo ${n.reps}`))
      const isFinal = FINAL_ALWAYS.has(n.state) || (FINAL_CLOSED.has(n.state) && n.closed)
      if (isFinal && emittedFinal.get(n.id) !== n.state) {
        emittedFinal.set(n.id, n.state)
        const text = `${n.id} ${stateLabel(n)[0]}` + (n.reason ? ` — ${firstLine(n.reason, 140)}` : '')
        console.log(eventLine(curModel, text))
      }
    }
    if (curModel.designReview) {
      const dr = curModel.designReview
      if (dr.attempts > 0 && dr.state !== 'verificando' && dr.state !== 'reparando') {
        const key = `design-review:r${dr.attempts}`
        if (!emittedDR.has(key)) {
          emittedDR.set(key, true)
          const text = dr.state === 'pronto'
            ? `revisão do design r${dr.attempts}: aprovada`
            : `revisão do design r${dr.attempts}: reprovada (${dr.blocking.length} bloqueio(s): ${dr.blocking.join(', ')}) → reparo`
          console.log(eventLine(curModel, text))
        }
      }
    }
    if (curModel.critic && !curModel.critic.running) {
      const key = `critic:r${curModel.critic.r}`
      if (!emittedFinal.has(key)) {
        emittedFinal.set(key, true)
        const newIds = curModel.nodes.filter((n) => n.round === curModel.critic.r + 1 && !prevById.has(n.id)).map((n) => n.id)
        const text = curModel.critic.done
          ? `critic r${curModel.critic.r}: critérios atendidos`
          : `critic r${curModel.critic.r}: ${curModel.critic.gaps} gap(s) → round ${curModel.critic.r + 1}${newIds.length ? ' (' + newIds.join(', ') + ')' : ''}`
        console.log(eventLine(curModel, text))
      }
    }
    if (!synthEmitted && curModel.synth === 'pronto') {
      synthEmitted = true
      console.log(eventLine(curModel, 'TERMINADO'))
    }
  }

  function finish(code) {
    beatExit()
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    return code
  }

  function hhmm(ms) {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  // P2 (spec C3/C4): depois do TERMINADO, com dona e --listen-min > 0 (padrão 120), o watcher
  // segue ouvindo o painel até terminadoEm + listenMin, em vez de sair na hora. --listen-min 0
  // (ou sem dona) mantém o comportamento de hoje: sai assim que emite o TERMINADO.
  //
  // `terminadoEm` vem de markTerminated (persistido em stateDir/terminated/<wf>.json), não de
  // `clock()` direto: cada rearme do Monitor (timeout de 30 min, doc da tool) é um *processo novo*
  // de `graph-watch events --run`, e sem essa persistência `terminatedAt` recomeçava a cada arme,
  // empurrando `listenUntil` + 2h a cada vez e sem nunca chegar em "escuta do painel encerrada"
  // (C4). `rearmContinuing` só controla a linha impressa (`ouvindo…` em vez de
  // `ouvindo o painel até HH:MM`, C4) — a janela em si já é a persistida, rearme ou não.
  const listenMin = opts.listenMin != null ? Number(opts.listenMin) : 120
  async function afterTerminated({ rearmContinuing = false } = {}) {
    if (!owner || !(listenMin > 0)) return finish(0)
    const terminatedAt = markTerminated(stateDir, owner.wf, clock())
    const until = terminatedAt + listenMin * 60000
    listenUntilIso = new Date(until).toISOString()
    heartbeatMode = 'listen'
    beat()
    if (clock() >= until) {
      // Rearme depois da janela já ter passado: nem entra em listen, só fecha o episódio (C4).
      console.log(`graph-eng ${owner.wf} · escuta do painel encerrada`)
      return finish(0)
    }
    console.log(rearmContinuing ? `graph-eng ${owner.wf} · ouvindo…` : `graph-eng ${owner.wf} · ouvindo o painel até ${hhmm(until)}`)
    while (clock() < until) {
      await sleep(150)
      try {
        checkRequests()
      } catch {
        /* leitura transitória: tenta de novo no próximo tick */
      }
    }
    console.log(`graph-eng ${owner.wf} · escuta do painel encerrada`)
    return finish(0)
  }

  let total = countReadyEvents(journalPath)
  const retomandoModel = await snap(total)
  console.log(eventLine(retomandoModel, `retomando: ${summarizeActive(retomandoModel)}`))
  checkRequests()

  let previous = retomandoModel
  if (explicitRun) {
    // `--run` explícito: a história antes deste arme já foi notificada por um watch anterior
    // (§5.2). Não repete marco nenhum: só confere se a run já terminou.
    if (retomandoModel.synth === 'pronto') {
      synthEmitted = true
      // Já tem marcador de término (C4): este `--run` é um rearme de um episódio que outro
      // processo já anunciou. Não repete o `TERMINADO` — só a linha `ouvindo…` (dentro de
      // afterTerminated).
      const rearmContinuing = !!owner && listenMin > 0 && hasTerminatedMarker(stateDir, owner.wf)
      if (!rearmContinuing) console.log(eventLine(retomandoModel, 'TERMINADO'))
      return afterTerminated({ rearmContinuing })
    }
    checkParada(retomandoModel)
  } else {
    previous = null
    for (let i = 1; i <= total; i++) {
      const cur = await snap(i)
      emitDiff(previous, cur)
      previous = cur
    }
    if (synthEmitted) return afterTerminated()
    if (!previous) previous = retomandoModel
    checkParada(previous)
  }

  let sinceReqCheck = 0
  for (;;) {
    await sleep(150)
    sinceReqCheck += 150
    if (sinceReqCheck >= 1000) {
      sinceReqCheck = 0
      try {
        checkRequests()
      } catch {
        /* leitura transitória: tenta de novo no próximo tick */
      }
    }
    let now
    try {
      now = countReadyEvents(journalPath)
    } catch {
      continue
    }
    if (now > total) {
      for (let i = total + 1; i <= now; i++) {
        const cur = await snap(i)
        emitDiff(previous, cur)
        previous = cur
      }
      total = now
      if (synthEmitted) return afterTerminated()
    } else {
      try {
        checkParada(await snap(total))
      } catch {
        /* leitura transitória: tenta de novo no próximo tick */
      }
    }
  }
}

// ── Modo `live` (§6.6) ──
export async function runLive(runDir, opts = {}) {
  const { economy, modeFlag, effort, ceiling, stdout = process.stdout, stdin = process.stdin, intervalMs = 500, maxTicks, signal, colsFixed, rowsFixed, onModel, footer } = opts
  const isTTY = !!stdout.isTTY
  let lastText = null
  let stopped = false
  const write = (s) => {
    try {
      stdout.write(s)
    } catch {
      /* stream fechada: ignora */
    }
  }
  const restore = () => {
    if (isTTY) write('\x1b[?25h\x1b[?1049l')
  }
  const onExit = () => restore()
  process.on('exit', onExit)
  if (isTTY) write('\x1b[?1049h\x1b[?25l')

  let keyListener
  const canReadKeys = isTTY && stdin && stdin.isTTY && typeof stdin.setRawMode === 'function'
  if (canReadKeys) {
    stdin.setRawMode(true)
    stdin.resume()
    keyListener = (data) => {
      const s = data.toString()
      if (s === 'q' || s === '\u0003') stop()
    }
    stdin.on('data', keyListener)
  }

  function stop() {
    if (stopped) return
    stopped = true
    process.removeListener('exit', onExit)
    restore()
    if (canReadKeys) {
      stdin.removeListener('data', keyListener)
      try {
        stdin.setRawMode(false)
      } catch {
        /* stdin já fechado */
      }
      stdin.pause()
    }
  }

  if (signal) {
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  }

  const cols = () => Number(colsFixed || stdout.columns || 100)
  const rows = () => Number(rowsFixed || stdout.rows || 40)
  const onResize = () => {
    lastText = null
  }
  if (stdout.on) stdout.on('resize', onResize)

  let ticks = 0
  try {
    while (!stopped) {
      let body
      let idleSec = 0
      try {
        const model = await buildModel({ runDir, economy, mode: modeFlag, effort, ceiling })
        idleSec = model.idleSec
        body = graphText(model, { cols: cols(), rows: rows(), color: isTTY }) + '\n' + buildNowBlock(model, runDir)
        if (onModel) onModel(model)
      } catch (e) {
        body = e instanceof GraphWatchError ? `graph-eng: erro: ${e.message}` : `graph-eng: erro inesperado: ${String((e && e.message) || e)}`
      }
      const statusLine = `atualizado ${localHMS(new Date())} · último evento há ${idleSec}s · q sai`
      const text = body + '\n' + statusLine + (footer ? '\n' + footer : '')
      if (text !== lastText) {
        lastText = text
        if (isTTY) {
          write('\x1b[?2026h\x1b[H' + text.split('\n').map((l) => l + '\x1b[K').join('\n') + '\x1b[J\x1b[?2026l')
        } else {
          write(text + '\n')
        }
      }
      ticks++
      if (maxTicks && ticks >= maxTicks) break
      if (stopped) break
      await sleep(intervalMs)
    }
  } finally {
    if (stdout.removeListener) stdout.removeListener('resize', onResize)
    stop()
  }
}

// ── CLI ──
const FLAGS_WITH_VALUE = new Set(['--run-dir', '--projects-dir', '--wait-ms', '--economy', '--mode', '--run', '--run-id', '--cols', '--rows', '-n', '--port', '--ceiling', '--effort', '--state-dir', '--listen-min'])

function parseArgs(rest) {
  const opts = {}
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('-')) {
      if (FLAGS_WITH_VALUE.has(a)) opts[a] = rest[++i]
      else opts[a] = true
    } else positional.push(a)
  }
  return { opts, positional }
}

// Precedência: --port > GRAPH_ENG_PORT > padrão (spec painel-web item 1b).
export function parsePort(v, fallback, env = process.env.GRAPH_ENG_PORT) {
  const [raw, from] = v !== undefined && v !== true ? [v, '--port'] : env !== undefined && env !== '' ? [env, 'GRAPH_ENG_PORT'] : [undefined]
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!/^\d+$/.test(String(raw)) || n > 65535) throw new GraphWatchError(1, `${from} inválida: ${raw} (use 0 a 65535; 0 = porta livre qualquer)`)
  return n
}

async function main() {
  const argv = process.argv.slice(2)
  const mode = argv[0]
  const { opts, positional } = parseArgs(argv.slice(1))
  const noColor = !!opts['--no-color'] || !!process.env.NO_COLOR || !process.stdout.isTTY
  const color = !noColor
  const projectsDir = opts['--projects-dir'] || path.join(os.homedir(), '.claude', 'projects')
  const waitMs = Number(opts['--wait-ms'] ?? (mode === 'events' ? 60000 : 5000))
  const economy = opts['--economy']
  const modeFlag = opts['--mode']
  const effortFlag = opts['--effort']
  const ceilingFlag = opts['--ceiling'] != null ? Number(opts['--ceiling']) : undefined
  const cols = Number(opts['--cols'] || process.stdout.columns || 100)
  const rows = Number(opts['--rows'] || process.stdout.rows || 40)

  if (mode === 'ui') {
    // Painel web (docs/specs/2026-09-27-painel-web.md): sobe ou reaproveita o servidor e fica de pé.
    const { ensurePanel, openBrowser, DEFAULT_PORT } = await import('./ui-server.mjs')
    const panel = await ensurePanel({ port: parsePort(opts['--port'], DEFAULT_PORT), projectsDir })
    console.log(`graph-eng: painel: ${panel.url}`)
    if (opts['--open'] || (process.stdout.isTTY && !opts['--no-open'])) openBrowser(panel.url)
    if (panel.reused) process.exit(0)
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, () => {
        panel.close().then(() => process.exit(0))
        setTimeout(() => process.exit(0), 1000).unref()
      })
    }
    return
  }

  let runDir
  let terminated = false
  if (opts['--run-dir']) {
    runDir = opts['--run-dir']
  } else {
    const found = await findRun({
      projectsDir,
      cwd: process.cwd(),
      run: opts['--run'],
      runId: opts['--run-id'],
      mode: mode === 'events' ? 'events' : 'default',
      waitMs,
    })
    runDir = found.runDir
    terminated = found.terminated
  }

  if (mode === 'snapshot') {
    const model = await buildModel({ runDir, economy, mode: modeFlag, effort: effortFlag, ceiling: ceilingFlag })
    const lines = [graphText(model, { cols, rows, color }), buildNowBlock(model, runDir)]
    if (terminated) lines.push(`aviso: sem --run, usando ${model.wf} (terminada)`)
    console.log(lines.join('\n'))
    process.exit(0)
  } else if (mode === 'agent') {
    const nodeArg = positional[0]
    if (!nodeArg) {
      console.error('graph-eng: uso: graph-watch agent <nó> [-n N]')
      process.exit(1)
    }
    const n = Number(opts['-n']) || 8
    const view = buildAgentView(runDir, nodeArg, n)
    console.log(view.text)
    process.exit(0)
  } else if (mode === 'events') {
    const stateDir = opts['--state-dir']
    const listenMin = opts['--listen-min'] != null ? Number(opts['--listen-min']) : undefined
    const code = await runEventsMode(runDir, { economy, modeFlag, effort: effortFlag, ceiling: ceilingFlag, explicitRun: !!opts['--run'], stateDir, listenMin })
    process.exit(code)
  } else if (mode === 'live') {
    // `--svg` virou alias do painel web: garante o painel (instância única) e segue como `live`.
    // O painel sobe neste processo se ainda não houver um; ele cai junto quando o `live` sai.
    let footer
    if (opts['--svg']) {
      try {
        const { ensurePanel, DEFAULT_PORT } = await import('./ui-server.mjs')
        const panel = await ensurePanel({ port: parsePort(opts['--port'], DEFAULT_PORT), projectsDir })
        const link = `${panel.url}/?run=${path.basename(runDir)}`
        console.error(`graph-eng: painel: ${link}`)
        footer = `painel: ${link}`
      } catch (e) {
        console.error(`graph-eng: aviso: painel indisponível (${(e && e.message) || e}), seguindo no terminal`)
      }
    }
    const controller = new AbortController()
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => controller.abort())
    await runLive(runDir, {
      economy,
      modeFlag,
      effort: effortFlag,
      ceiling: ceilingFlag,
      colsFixed: opts['--cols'] ? cols : undefined,
      rowsFixed: opts['--rows'] ? rows : undefined,
      signal: controller.signal,
      footer,
    })
    process.exit(0)
  } else {
    console.error(`graph-eng: modo desconhecido: ${mode || '(nenhum)'}`)
    process.exit(1)
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
  main().catch((e) => {
    if (e instanceof GraphWatchError) {
      console.error('graph-eng: erro: ' + e.message)
      process.exit(e.code)
    }
    console.error('graph-eng: erro inesperado: ' + ((e && e.stack) || e))
    process.exit(1)
  })
}
