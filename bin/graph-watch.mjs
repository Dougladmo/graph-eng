#!/usr/bin/env node
// graph-watch: visualizador só-leitura do journal do workflow graph-eng.
// Node puro, sem dependências. Contrato completo em test/model.test.mjs (topo do arquivo) e
// docs/specs/2026-09-27-visualizacao-design.md. Modos: `snapshot`, `agent`, `events`, `live` e `ui`
// (painel web ao vivo, servido por bin/ui-server.mjs — docs/specs/2026-09-27-painel-web.md). O núcleo
// (buildModel/normalizeNodes/estimateAgents/findRun) é usado por todos os modos.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

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

const LABEL_RE = /^(plan|work|verify|escalate|repair|draft-[ab]|judge|critic|synth)(:|$)/

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

// ── normalize() (graph-eng.js:314-349), como função pura e testável ──
export function normalizeNodes(list, opts = {}) {
  const { prefix = '', round = 1, existingIds = new Set(), readOnly = false } = opts
  const idMap = new Map()
  const taken = new Set(existingIds)
  const out = []
  for (const raw of list || []) {
    const rawId = String(raw.id || '')
    let id = prefix + (rawId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'n' + (out.length + 1))
    while (taken.has(id)) id += '_'
    taken.add(id)
    idMap.set(rawId, id)
    const rawKind = ['research', 'design', 'implement'].includes(raw.kind) ? raw.kind : 'research'
    let kind = rawKind
    if (kind === 'implement' && readOnly) kind = 'design'
    out.push({
      id,
      kind,
      rawKind,
      round,
      title: String(raw.title || id).slice(0, 80),
      rawDeps: (raw.deps || []).map(String),
      risk: ['low', 'medium', 'high'].includes(raw.risk) ? raw.risk : 'medium',
      explore: !!raw.explore && kind === 'design',
    })
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
  const { runDir, siblingPlanOnlyDir, economy, mode, cutLine } = opts
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

  const NODES = new Map()
  function doNormalize(list, o) {
    const out = normalizeNodes(list, { ...o, existingIds: new Set(NODES.keys()), readOnly: READ_ONLY })
    out.forEach((n) => NODES.set(n.id, n))
    return out
  }

  const planStarted = events.some((e) => e.type === 'started' && e.label === 'plan')
  let planRes = null
  const orphans = []

  if (!planStarted) {
    const sibDir = siblingPlanOnlyDir || findSiblingPlanOnly(runDir)
    if (sibDir) {
      const { events: sibEvents } = readJournalTolerant(path.join(sibDir, 'journal.jsonl'))
      const st = sibEvents.find((e) => e.type === 'started' && e.label === 'plan')
      const res = st && sibEvents.find((e) => e.key === st.key && e.type === 'result')
      const hasWork = sibEvents.some((e) => e.type === 'started' && e.label && e.label.startsWith('work:'))
      if (res && !hasWork) {
        planRes = res.result
        doNormalize(planRes.nodes, { round: 1 })
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
  let spent = events.slice(0, cut).filter((e) => e.type === 'started').length
  let critic = null
  let synth = null
  let round = 1

  for (const e of events.slice(cut)) {
    if (e.type === 'started') {
      spent++
      const s = { label: e.label, done: false, seq: spent, agentId: e.agentId }
      byKey.set(e.key, s)
      const label = e.label || ''
      const [k, id] = label.split(':')
      if (!planStarted && !planRes && id && /^(work|draft-a)$/.test(k) && !NODES.has(id)) {
        NODES.set(id, { id, kind: '?', rawKind: '?', risk: 'medium', round: 1, title: '(sem plano no journal)', deps: [], explore: false, orphan: true })
        orphans.push(id)
      }
      if (id && k !== 'critic') {
        if (!per.has(id)) per.set(id, [])
        per.get(id).push(s)
      }
      if (k === 'critic') critic = { r: Number(id.slice(1)), running: true }
      if (k === 'synth') synth = 'rodando'
    } else if (e.type === 'result' || e.type === 'failed') {
      const s = byKey.get(e.key)
      if (!s) continue
      s.done = true
      s.failed = e.type === 'failed'
      s.result = e.result
      if (s.label === 'plan' && e.result && Array.isArray(e.result.nodes)) {
        planRes = e.result
        doNormalize(e.result.nodes, { round: 1 })
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
    }
  }

  if (orphans.length) warns.push(`${orphans.length} nó(s) sem plano (${orphans.join(', ')}): desenhados sem deps, em modo compacto`)
  if (!planStarted && !planRes && NODES.size === 0) warns.push('sem plano no journal nem run planOnly irmã')

  const ended = synth !== null
  const START = new Map()
  for (const [id, xs] of per) START.set(id, xs[0].seq)

  function closed(id) {
    if (ended) return true
    for (const n of NODES.values()) if (n.deps && n.deps.includes(id) && START.has(n.id)) return true
    const n = NODES.get(id)
    return !!(critic && n && critic.r >= (n.round || 1))
  }

  const DEAD = new Set(['bloqueado', 'pulado'])
  const kindOf = (l) => l.split(':')[0]
  const isDraft = (k) => k === 'draft-a' || k === 'draft-b'
  const MEMO = new Map()
  function state(id) {
    if (!MEMO.has(id)) MEMO.set(id, computeState(id))
    return MEMO.get(id)
  }

  function computeState(id) {
    const xs = per.get(id) || []
    const n = NODES.get(id)
    if (!xs.length) {
      const dead = n && n.deps && n.deps.some((d) => DEAD.has(state(d)))
      if (dead || ended) return 'pulado'
      return 'aguardando'
    }
    const open = xs.filter((x) => !x.done)
    if (open.length) {
      const k = kindOf(open[open.length - 1].label)
      if (k === 'verify' || k === 'escalate') return 'verificando'
      if (k === 'repair') return 'reparando'
      return 'trabalhando'
    }
    const last = xs[xs.length - 1]
    const lk = kindOf(last.label)
    const drafts = xs.filter((x) => isDraft(kindOf(x.label)))
    if (last.failed) {
      if (lk === 'work' || lk === 'judge' || (drafts.length === 2 && drafts.every((x) => x.failed))) return 'bloqueado'
      return 'erro'
    }
    const deferred = !!(P && n && n.kind !== 'implement' && P.defer.includes(n.risk))
    let verdict = null
    let pendingAfter = null
    let verifiedEver = false
    for (const x of xs) {
      if (x.failed) continue
      const k = kindOf(x.label)
      const r = x.result || {}
      if (k === 'verify' || k === 'escalate') {
        verdict = { pass: !!r.pass && !(r.blocking || []).length, via: 'verify' }
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
      if (!asWork && k !== 'repair') continue
      if (asWork && r.status === 'blocked') return 'bloqueado'
      const red = (r.checks || []).some((c) => c && c.ok === false)
      const gated = k === 'repair' || (P ? !deferred : x !== last)
      if (red && gated) {
        verdict = { pass: false, via: 'check' }
        pendingAfter = null
        verifiedEver = true
        continue
      }
      pendingAfter = k === 'repair' ? 'repair' : 'work'
      verdict = null
    }
    if (pendingAfter === 'draft') return closed(id) ? 'bloqueado' : 'trabalhando'
    if (verdict) return verdict.pass ? 'pronto' : verdict.via === 'check' ? 'falhou-check' : 'falhou'
    if (pendingAfter === 'repair') return closed(id) ? 'sem-reverificacao' : 'reparando'
    if (!verifiedEver && (deferred || closed(id) || !P)) {
      const flagsUnknown = !P || (mode === undefined && n && n.rawKind === 'implement')
      if (flagsUnknown) {
        warns.push(`${id}: deferido ou reprovado? passe --economy e --mode`)
        return 'pronto-sem-verif?'
      }
      return 'pronto-sem-verif'
    }
    return 'verificando'
  }

  const nodes = [...NODES.values()].map((n) => {
    const st = state(n.id)
    const xs = per.get(n.id) || []
    const reps = xs.filter((x) => kindOf(x.label) === 'repair').length
    const out = { id: n.id, kind: n.kind, risk: n.risk, round: n.round || 1, title: n.title, deps: n.deps || [], explore: !!n.explore, state: st, reps, closed: closed(n.id) }
    if (n.orphan) out.orphan = true
    if (ACTIVE_STATES.has(st)) {
      const open = xs.filter((x) => !x.done)
      const last = open[open.length - 1]
      if (last && last.agentId) out.running = { label: last.label, agentId: last.agentId }
    }
    return out
  })

  const idleSec = Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000))
  const status = synth === 'pronto' ? 'terminado' : idleSec > 600 ? 'parada?' : 'rodando'

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
  }

  if (P) {
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
      const line = `${indent}${arrow}[${marker}] ${n.id} ${label}  ← ${deps}`
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
  if (model.estimate != null) header += ` (estimativa ~${model.estimate}, teto ${model.ceiling})`
  if (model.status === 'parada?') header += ` · parada? (último evento há ${Math.max(1, Math.round(model.idleSec / 60))} min)`
  out.push(cutCols(header, cols))
  for (const w of model.warns) out.push(cutCols('aviso: ' + w, cols))
  out.push('')

  const layers = layoutLayers(model.nodes)
  const hasOrphan = model.nodes.some((n) => n.orphan)
  const full = !hasOrphan && layers.every((L) => L.length * (BOX_W + 2) + Math.max(0, L.length - 1) * GAP <= cols)
  if (full && layers.length) {
    out.push(...renderBoxLayers(model, layers, color))
  } else {
    out.push(...renderCompact(model, layers, color, rows, cols))
  }
  out.push('')
  const criticLine = model.critic
    ? model.critic.running
      ? `critic r${model.critic.r} rodando`
      : `critic r${model.critic.r}: ${model.critic.done ? 'critérios atendidos' : model.critic.gaps + ' gap(s) → round ' + (model.critic.r + 1)}`
    : 'critic: aguardando'
  out.push(cutCols(`${criticLine} · synth: ${model.synth}`, cols))
  out.push(cutCols('legenda: [~] trabalhando  [?] verificando  [R] reparando N  [r] reparado, sem reverificação  [+] pronto', cols))
  out.push(cutCols('         [o] pronto s/ verif.  [x] falhou / falhou (check) / bloqueado  [!] erro  [ ] aguardando  [-] pulado', cols))
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
  const active = model.nodes.filter((n) => n.running)
  if (active.length) {
    return active
      .map((n) => {
        const shortId = String(n.running.agentId).slice(0, 8) + '…'
        const call = lastToolUse(runDir, n.running.agentId)
        if (call && call.ts) {
          const ageSec = Math.max(0, Math.round((now - Date.parse(call.ts)) / 1000))
          return `agora: ${n.running.label} · agente ${shortId} · última tool call ${call.name} há ${ageSec}s`
        }
        return `agora: ${n.running.label} · agente ${shortId} · sem tool call ainda`
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

const PSEUDO_KINDS = new Set(['plan', 'critic', 'synth'])

// Todos os agentes de um nó, na ordem do journal. `id` é o id do nó (`I2`, `r2-G1`) ou um pseudo-nó
// (`plan`, `critic` — todas as rodadas —, `synth`).
export function agentsOfNode(runDir, id, n = 20) {
  const { events } = readJournalTolerant(path.join(runDir, 'journal.jsonl'))
  const started = events.filter((e) => e.type === 'started' && e.label)
  const mine = started.filter((e) => {
    const [k, rest] = e.label.split(':')
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
  const { economy, modeFlag, explicitRun } = opts
  const journalPath = path.join(runDir, 'journal.jsonl')
  const emittedFinal = new Map()
  let planEmitted = false
  let paradaEmitted = false
  let synthEmitted = false

  const snap = (cutLine) => buildModel({ runDir, economy, mode: modeFlag, cutLine })

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
      if (curModel.estimate != null) text += `, estimativa ~${curModel.estimate}, teto ${curModel.ceiling}`
      console.log(eventLine(curModel, text))
    }
    const prevById = new Map((prevModel ? prevModel.nodes : []).map((n) => [n.id, n]))
    for (const n of curModel.nodes) {
      const pn = prevById.get(n.id)
      const prevReps = pn ? pn.reps : 0
      if (n.reps > prevReps) console.log(eventLine(curModel, `${n.id} reparo ${n.reps}`))
      const isFinal = FINAL_ALWAYS.has(n.state) || (FINAL_CLOSED.has(n.state) && n.closed)
      if (isFinal && emittedFinal.get(n.id) !== n.state) {
        emittedFinal.set(n.id, n.state)
        console.log(eventLine(curModel, `${n.id} ${stateLabel(n)[0]}`))
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

  let total = countReadyEvents(journalPath)
  const retomandoModel = await snap(total)
  console.log(eventLine(retomandoModel, `retomando: ${summarizeActive(retomandoModel)}`))

  let previous = retomandoModel
  if (explicitRun) {
    // `--run` explícito: a história antes deste arme já foi notificada por um watch anterior
    // (§5.2). Não repete marco nenhum: só confere se a run já terminou.
    if (retomandoModel.synth === 'pronto') {
      synthEmitted = true
      console.log(eventLine(retomandoModel, 'TERMINADO'))
      return 0
    }
    checkParada(retomandoModel)
  } else {
    previous = null
    for (let i = 1; i <= total; i++) {
      const cur = await snap(i)
      emitDiff(previous, cur)
      previous = cur
    }
    if (synthEmitted) return 0
    if (!previous) previous = retomandoModel
    checkParada(previous)
  }

  for (;;) {
    await sleep(150)
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
      if (synthEmitted) return 0
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
  const { economy, modeFlag, stdout = process.stdout, stdin = process.stdin, intervalMs = 500, maxTicks, signal, colsFixed, rowsFixed, onModel, footer } = opts
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
        const model = await buildModel({ runDir, economy, mode: modeFlag })
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
const FLAGS_WITH_VALUE = new Set(['--run-dir', '--projects-dir', '--wait-ms', '--economy', '--mode', '--run', '--run-id', '--cols', '--rows', '-n', '--port'])

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
    const model = await buildModel({ runDir, economy, mode: modeFlag })
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
    const code = await runEventsMode(runDir, { economy, modeFlag, explicitRun: !!opts['--run'] })
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
