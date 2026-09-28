// CLI de retomada: monta os args de retomada do motor (workflows/graph-eng.js, args.resume) a partir do
// run dir e do journal do último Workflow que rodou nela. Contrato: docs/specs/2026-09-28-acoes-no-painel.md
// C8, D2 §5.3, §9.2 e §9.3. Node puro, sem dependências.
//
// Princípio (correção do verificador do D2): os args base e o estado herdado saem da MESMA execução, o
// último wf da run (W). Nunca se pega "o resume/*.json mais recente" por conta própria: numa run disparada
// de novo do zero depois de uma retomada, isso juntaria o plano velho com o estado novo.
//
// Quem usa: a skill (SKILL.md, "Ações sobre uma run"), rodando este CLI antes de cada Workflow(...) de
// retomada ou refazer; e o texto colado pelo painel (bin/ui/commands.mjs), que roda o mesmo comando.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { defaultStateDir } from './config.mjs'
import { resolveRunDir } from './organize.mjs'
import { readJournalTolerant } from './graph-watch.mjs'
import { NODE_RE, readListeners, ownerPresence, ownerPathInfo, writeJsonAtomic } from './requests.mjs'

export const RESUME_ID_RE = /^rs-\d{8}-\d{6}(-\d+)?$/
export const ACTIVE_GUARD_MS = 60000 // C8: um agent-*.jsonl ou journal.jsonl escrito há menos disso ainda pode estar vivo

function extractText(msg) {
  if (!msg) return ''
  const c = msg.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
  return ''
}

// Primeira linha de um agent-*.jsonl: texto do prompt (pro cabeçalho) e timestamp, se houver.
function readFirstLine(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const nl = raw.indexOf('\n')
  const line = nl === -1 ? raw : raw.slice(0, nl)
  if (!line.trim()) return null
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  const text = extractText(obj.message) || extractText(obj)
  const t = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN
  return { text, timestamp: Number.isNaN(t) ? null : t }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return []
  }
}

// Todo wf cujo 1º agent-*.jsonl traz `Run dir (paper trail): <runDir>` no fim da linha (D2 §5.3.2). Wfs só
// planOnly (journal com só o rótulo `plan`) ficam de fora. Devolve { wf, dir, t0, rs } por execução, da
// mais velha para a mais nova.
const RUN_DIR_LINE_RE = /(?:^|\n)[ \t]*Run dir \(paper trail\): ([^\n]+)/

function findWfsOfRun(projectsDir, runDir) {
  // Casa a linha inteira (não um prefixo): uma run cujo runId é prefixo de outra (ex.: "...-acoes" e
  // "...-acoes-no-painel") não pode pegar o wf da outra por `includes`.
  const wantedRunDir = path.resolve(runDir)
  const out = []
  for (const slug of listDirs(projectsDir)) {
    const slugDir = path.join(projectsDir, slug.name)
    for (const sess of listDirs(slugDir)) {
      const wfRoot = path.join(slugDir, sess.name, 'subagents', 'workflows')
      for (const wfEnt of listDirs(wfRoot)) {
        if (!wfEnt.name.startsWith('wf_')) continue
        const dir = path.join(wfRoot, wfEnt.name)
        let agentFiles
        try {
          agentFiles = fs.readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
        } catch {
          continue
        }
        if (!agentFiles.length) continue
        let found = false
        let t0 = Infinity
        let rs = null
        for (const f of agentFiles) {
          const first = readFirstLine(path.join(dir, f))
          if (!first) continue
          const runDirMatch = first.text.match(RUN_DIR_LINE_RE)
          if (runDirMatch && path.resolve(runDirMatch[1].trim()) === wantedRunDir) {
            found = true
            const m = first.text.match(/(?:^|\n)[ \t]*Resume: (rs-\d{8}-\d{6}(?:-\d+)?)/)
            if (m) rs = m[1]
          }
          if (first.timestamp !== null && first.timestamp < t0) t0 = first.timestamp
        }
        if (!found) continue
        if (t0 === Infinity) {
          try {
            t0 = fs.statSync(path.join(dir, 'journal.jsonl')).mtimeMs
          } catch {
            t0 = 0
          }
        }
        const { events } = readJournalTolerant(path.join(dir, 'journal.jsonl'))
        const labels = events.filter((e) => e.type === 'started').map((e) => e.label)
        const planOnly = labels.length > 0 && labels.every((l) => l === 'plan')
        if (planOnly) continue
        out.push({ wf: wfEnt.name, dir, t0, rs })
      }
    }
  }
  out.sort((a, b) => a.t0 - b.t0)
  return out
}

// Último resultado por rótulo, no formato que o motor entende (§5.3.5): work/repair/design-repair/judge
// dão o `work`; verify/escalate dão o veredito.
function stateFromJournal(events) {
  const work = new Map() // id -> { status, summary, artifact, filesChanged }
  const verify = new Map() // id -> { pass, blocking }
  const designReview = new Map() // r<n> -> result
  const startedByKey = new Map()
  for (const e of events) {
    if (e.type === 'started') startedByKey.set(e.key, e.label)
    if (e.type !== 'result' && e.type !== 'failed') continue
    const label = startedByKey.get(e.key)
    if (!label) continue
    const [k, id] = label.split(':')
    if (!id) continue
    if (k === 'work' || k === 'repair' || k === 'design-repair' || k === 'judge') {
      if (e.type === 'failed') continue
      const r = e.result || {}
      work.set(id, { status: r.status, summary: r.summary, artifact: r.artifact, filesChanged: r.filesChanged || [], attempts: (work.get(id)?.attempts || 0) + 1 })
    } else if (k === 'verify' || k === 'escalate') {
      const r = e.type === 'failed' ? { pass: false, blocking: [{ issue: String(e.error || 'falhou') }] } : e.result || {}
      verify.set(id, { pass: !!r.pass, blocking: r.blocking || [], attempts: (verify.get(id)?.attempts || 0) + 1 })
    } else if (k === 'design-review') {
      designReview.set(id, e.type === 'failed' ? { pass: false } : e.result || {})
    }
  }
  return { work, verify, designReview }
}

function lastDesignReview(designReview) {
  let best = null
  let bestN = -1
  for (const [id, r] of designReview) {
    const n = Number(String(id).replace(/^r/, '')) || 0
    if (n > bestN) {
      bestN = n
      best = r
    }
  }
  return best
}

function planIds(plan) {
  return new Set((plan.nodes || []).map((n) => n.id))
}

// Fecho de descendentes (deps normalizadas: qualquer nó que dependa, direta ou indiretamente, de um id do
// conjunto inicial), §5.3 / spec "refazer: fecho de RERUN".
function dependentsClosure(plan, seedIds) {
  const nodes = plan.nodes || []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const closure = new Set(seedIds.filter((id) => byId.has(id)))
  let grew = true
  while (grew) {
    grew = false
    for (const n of nodes) {
      if (closure.has(n.id)) continue
      if ((n.deps || []).some((d) => closure.has(d))) {
        closure.add(n.id)
        grew = true
      }
    }
  }
  return closure
}

function findRepoRoot(runDir) {
  // .graph-runs/<run> -> o pai de .graph-runs é a raiz do repo/plugin
  const graphRuns = path.dirname(runDir)
  if (path.basename(graphRuns) === '.graph-runs') return path.dirname(graphRuns)
  return null
}

function fail(reason, code = 1) {
  return { ok: false, code, reason }
}

// buildResumeArgs({ runDir, projectsDir, rerun, dependents, now, cwd, stateDir, ownerOk })
// -> { ok:true, resumeId, argsFile, args, summary, warnings } | { ok:false, code, reason }
export function buildResumeArgs({
  runDir: rawRunDir,
  projectsDir = path.join(os.homedir(), '.claude', 'projects'),
  graphRunsHome = path.join(os.homedir(), '.claude', 'graph-runs'),
  home = os.homedir(),
  rerun = [],
  dependents = false,
  now = Date.now(),
  cwd = process.cwd(),
  stateDir = defaultStateDir(),
  ownerOk = false,
} = {}) {
  if (typeof rawRunDir !== 'string' || !rawRunDir) return fail('faltou --run-dir')
  const runDir = rawRunDir.startsWith('~') ? path.join(os.homedir(), rawRunDir.slice(1)) : rawRunDir
  if (!path.isAbsolute(runDir)) return fail('--run-dir precisa ser um caminho absoluto (ou começar com ~/)')
  const runId = path.basename(path.resolve(runDir))
  const resolved = resolveRunDir(path.resolve(runDir), runId, { projectsDir, graphRunsHome, home })
  if (!resolved.ok) return fail(`runDir inválido: ${resolved.why}`)
  const real = resolved.real
  const rerunIn = Array.isArray(rerun) ? rerun : rerun ? [rerun] : []
  for (const id of rerunIn) {
    if (!NODE_RE.test(String(id))) return fail(`--rerun com nó inválido: ${id}`)
  }

  const warnings = []
  const wfs = findWfsOfRun(projectsDir, real)
  const W = wfs.length ? wfs[wfs.length - 1] : null

  // ── Trava contra dois Workflows (C8) ──
  if (W && !ownerOk) {
    const { events: wEvents } = readJournalTolerant(path.join(W.dir, 'journal.jsonl'))
    // W terminou quando o `synth` (rótulo sem `:`) tem resultado (D2 §8: sinônimo de "wf terminado").
    const startedByKey = new Map()
    let terminated = false
    for (const e of wEvents) {
      if (e.type === 'started') startedByKey.set(e.key, e.label)
      if ((e.type === 'result' || e.type === 'failed') && startedByKey.get(e.key) === 'synth') terminated = true
    }
    if (!terminated) {
      const owner = ownerPathInfo(W.dir)
      let recentWrite = false
      try {
        const files = fs.readdirSync(W.dir)
        for (const f of files) {
          if (f !== 'journal.jsonl' && !(f.startsWith('agent-') && f.endsWith('.jsonl'))) continue
          const st = fs.statSync(path.join(W.dir, f))
          if (now - st.mtimeMs < ACTIVE_GUARD_MS) {
            recentWrite = true
            break
          }
        }
      } catch {
        /* sem arquivos: não conta como escrita recente */
      }
      let presence = 'nunca'
      if (owner) {
        try {
          presence = ownerPresence(readListeners(stateDir, now), owner.session, now)
        } catch {
          presence = 'nunca'
        }
      }
      if (presence === 'ouvindo' || presence === 'rearmando' || recentWrite) {
        return fail(`a execução ${W.wf} ainda pode estar viva na sessão dona ${owner ? owner.session.slice(0, 8) : '?'}; pare a run nela (Copiar para parar) e retome de novo`, 4)
      }
    }
  }

  // ── Args base (§5.3.3) ──
  let base = null
  let sourceArgs = null
  if (W) {
    if (W.rs) {
      const rsFile = path.join(real, 'resume', `${W.rs}.json`)
      const rsData = readJsonSafe(rsFile)
      if (rsData && rsData.resume && rsData.resume.id === W.rs && rsData.runDir === real) {
        base = rsData
        sourceArgs = `resume/${W.rs}.json`
      } else {
        warnings.push(`resume/${W.rs} não encontrado: nós prontos antes de ${W.wf} rodam de novo`)
      }
    }
    if (!base) {
      const wfJsonCandidates = listWfJsonCandidates(projectsDir, W.wf)
      let wfJson = null
      for (const f of wfJsonCandidates) {
        const data = readJsonSafe(f)
        if (data) {
          wfJson = data
          break
        }
      }
      if (wfJson && wfJson.args) {
        base = wfJson.args
        sourceArgs = 'wf.json'
      } else {
        const argsFile = path.join(real, 'args.json')
        const argsData = readJsonSafe(argsFile)
        if (argsData) {
          let argsMtime = 0
          try {
            argsMtime = fs.statSync(argsFile).mtimeMs
          } catch {
            /* segue com 0 */
          }
          if (argsMtime > W.t0 + 5000) {
            return fail('args.json é de um disparo que não rodou; dispare a run de novo')
          }
          base = argsData
          sourceArgs = 'args.json'
        }
      }
    }
  } else {
    const argsData = readJsonSafe(path.join(real, 'args.json'))
    if (argsData) {
      base = argsData
      sourceArgs = 'args.json'
      warnings.push('nenhuma execução encontrada para esta run: estado vazio')
    }
  }

  let plan = base && base.plan
  let planSource = plan ? 'args' : 'journal'
  if ((!plan || !Array.isArray(plan.nodes)) && W) {
    // Sem plano na base: run sem gate, disparo do zero — vale o resultado do rótulo `plan` no journal de W.
    const { events } = readJournalTolerant(path.join(W.dir, 'journal.jsonl'))
    const startedByKey = new Map()
    for (const e of events) {
      if (e.type === 'started') startedByKey.set(e.key, e.label)
      if (e.type === 'result' && startedByKey.get(e.key) === 'plan' && e.result && Array.isArray(e.result.nodes)) plan = e.result
    }
    planSource = 'journal'
  }
  if (!plan || !Array.isArray(plan.nodes)) return fail('a run parou antes do plano; dispare de novo')
  base = base || {}

  const idsInPlan = planIds(plan)
  for (const id of rerunIn) {
    if (!idsInPlan.has(id)) return fail(`--rerun com nó fora do plano: ${id}`)
  }

  // ── Estado herdado + o que W rodou por cima (§5.3.5) ──
  // §5.3.4 (correção do D2): o ponto de partida é resume.done da base MENOS o fecho de refazer de W —
  // já é o `resume.rerun` gravado nesse mesmo arquivo (ele já é o fecho, não os ids crus do pedido). Um
  // nó do fecho que W não terminou nunca volta como pronto.
  const isResumeBase = base.resume && base.resume.done && sourceArgs === `resume/${W ? W.rs : ''}.json`
  const doneStart = isResumeBase ? { ...base.resume.done } : {}
  if (isResumeBase) {
    for (const id of Array.isArray(base.resume.rerun) ? base.resume.rerun : []) delete doneStart[id]
  }
  const done = { ...doneStart }
  let designReviewOut = base.resume && base.resume.designReview ? base.resume.designReview : null

  if (W) {
    const { events } = readJournalTolerant(path.join(W.dir, 'journal.jsonl'))
    const { work, verify, designReview } = stateFromJournal(events)
    for (const id of idsInPlan) {
      const w = work.get(id)
      const v = verify.get(id)
      const node = (plan.nodes || []).find((n) => n.id === id)
      if (!w && !v) continue // nada rodou em W para este nó: mantém o herdado (ou nada)
      const isImplement = node && node.kind === 'implement'
      if (v) {
        if (v.pass && !(v.blocking && v.blocking.length)) {
          done[id] = { summary: (w && w.summary) || done[id]?.summary || '', artifact: (w && w.artifact) || done[id]?.artifact || '', verified: true, attempts: v.attempts || 1, filesChanged: (w && w.filesChanged) || [] }
        } else {
          delete done[id]
        }
      } else if (w) {
        if (isImplement || w.status !== 'done') {
          // implementação sem veredito não está pronta; research/design com status blocked/failed/partial
          // também não — sem isso, o nó que travou nunca roda de novo e os dependentes herdam o bloqueio.
          delete done[id]
        } else {
          done[id] = { summary: w.summary || '', artifact: w.artifact || '', verified: true, attempts: w.attempts || 1, filesChanged: w.filesChanged || [] }
        }
      }
    }
    const dr = lastDesignReview(designReview)
    if (dr) {
      designReviewOut = { pass: !!dr.pass, attempts: 1, blocking: dr.blocking || [] }
    } else {
      const startedNonImpl = events.some((e) => {
        if (e.type !== 'started' || !e.label) return false
        const [k, id] = e.label.split(':')
        if (k !== 'work') return false
        const node = (plan.nodes || []).find((n) => n.id === id)
        return node && node.kind !== 'implement'
      })
      if (startedNonImpl) designReviewOut = null
    }
  }

  // ── artefato precisa existir, dentro do runDir e não vazio (§5.3.6) ──
  for (const id of Object.keys(done)) {
    const art = done[id] && done[id].artifact
    if (!art || !isInside(real, art) || !fileNonEmpty(art)) {
      warnings.push(`${id}: artefato ausente ou vazio (${art || '(nenhum)'}), nó não está pronto`)
      delete done[id]
    }
  }

  // ── nada de journal: pesquisa/design ficam prontos com verified:false, toda implementação roda ──
  if (!W) {
    for (const node of plan.nodes || []) {
      if (node.kind === 'implement') continue
      const art = path.join(real, `${node.id}.md`)
      if (fileNonEmpty(art)) {
        done[node.id] = { summary: '(sem journal)', artifact: art, verified: false, attempts: 1 }
      }
    }
    warnings.push('sem journal nenhum: pesquisa e design ficam prontas com verified:false, e toda implementação roda')
  }

  // ── refazer + dependentes ──
  const rerunClosure = dependents ? [...dependentsClosure(plan, rerunIn)] : rerunIn.filter((id) => idsInPlan.has(id))
  const readyIds = [...idsInPlan].filter((id) => Object.hasOwn(done, id) && !rerunClosure.includes(id))
  const pendingIds = [...idsInPlan].filter((id) => !readyIds.includes(id))

  // ── cwd fora da raiz do projeto ──
  const root = findRepoRoot(real)
  let cwdNote = null
  let checksPrefix = ''
  try {
    const realCwd = fs.realpathSync(cwd)
    if (root && realCwd !== fs.realpathSync(root)) {
      checksPrefix = `cd "${root}" && `
      cwdNote = `Retomada disparada de outra pasta: o repo é ${root}; use caminhos absolutos.`
    }
  } catch {
    /* cwd ilegível: sem prefixo */
  }

  const resumeId = genResumeId(now, real)
  const outArgs = {
    ...stripResume(base),
    plan,
    runDir: real,
    resume: {
      id: resumeId,
      from: W ? [W.wf] : [],
      done,
      rerun: rerunClosure,
      dependents: !!dependents,
      designReview: designReviewOut,
    },
  }
  if (checksPrefix && Array.isArray(outArgs.checks)) outArgs.checks = outArgs.checks.map((c) => `${checksPrefix}${c}`)
  if (cwdNote) outArgs.context = outArgs.context ? `${outArgs.context}\n\n${cwdNote}` : cwdNote

  const argsFile = path.join(real, 'resume', `${resumeId}.json`)
  writeJsonAtomic(argsFile, outArgs)

  const summary = {
    ready: readyIds,
    rerun: rerunClosure,
    pending: pendingIds,
    designReview: designReviewOut && designReviewOut.pass ? 'pula' : 'roda',
    sources: { args: sourceArgs || 'nenhum', plan: planSource, journals: W ? [W.wf] : [] },
  }

  return { ok: true, resumeId, argsFile, args: outArgs, summary, warnings }
}

function stripResume(base) {
  const out = { ...base }
  delete out.resume
  return out
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function isInside(parent, child) {
  const rel = path.relative(parent, path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function fileNonEmpty(file) {
  try {
    return fs.statSync(file).size > 0
  } catch {
    return false
  }
}

// `<sessão>/workflows/<W>.json`, gravado pelo host no fim do wf. Como não sabemos de antemão qual sessão,
// procuramos em toda sessão sob projectsDir (é raro ter mais de uma correspondência; a primeira que existir vale).
function listWfJsonCandidates(projectsDir, wf) {
  const out = []
  for (const slug of listDirs(projectsDir)) {
    for (const sess of listDirs(path.join(projectsDir, slug.name))) {
      out.push(path.join(projectsDir, slug.name, sess.name, 'workflows', `${wf}.json`))
    }
  }
  return out
}

function genResumeId(now, real) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  let id = `rs-${stamp}`
  let n = 0
  while (fs.existsSync(path.join(real, 'resume', `${id}.json`))) {
    n++
    id = `rs-${stamp}-${n}`
  }
  return id
}

// ── CLI ──
function parseCliArgs(argv) {
  const opts = {}
  const rerun = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--rerun') rerun.push(argv[++i])
    else if (a === '--dependents') opts.dependents = true
    else if (a === '--owner-ok') opts.ownerOk = true
    else if (a === '--run-dir') opts.runDir = argv[++i]
    else if (a === '--state-dir') opts.stateDir = argv[++i]
    else if (a === '--projects-dir') opts.projectsDir = argv[++i]
    else if (a === '--graph-runs-home') opts.graphRunsHome = argv[++i]
  }
  opts.rerun = rerun
  return opts
}

async function cliMain() {
  const argv = process.argv.slice(2)
  const opts = parseCliArgs(argv)
  const r = buildResumeArgs({
    runDir: opts.runDir,
    projectsDir: opts.projectsDir,
    graphRunsHome: opts.graphRunsHome,
    stateDir: opts.stateDir,
    rerun: opts.rerun,
    dependents: !!opts.dependents,
    ownerOk: !!opts.ownerOk,
  })
  if (!r.ok) {
    console.error(`graph-eng: ${r.reason}`)
    process.exit(r.code || 1)
  }
  console.log(JSON.stringify({ ok: true, resumeId: r.resumeId, argsFile: r.argsFile, args: r.args, summary: r.summary, warnings: r.warnings }))
  process.exit(0)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
  cliMain().catch((e) => {
    console.error(`graph-eng: erro inesperado: ${(e && e.stack) || e}`)
    process.exit(1)
  })
}
