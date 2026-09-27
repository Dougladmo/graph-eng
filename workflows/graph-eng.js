export const meta = {
  name: 'graph-eng',
  description: 'Lean graph engineering: smallest DAG plan -> cheap width-capped executors -> check gate + strong adaptive verify + repair -> integration critic loop -> report. ~6-15 agents instead of 100+.',
  whenToUse: 'Complex multi-step work (feature, refactor, system architecture, deep investigation, audit) that benefits from separating workers from checkers and iterating until done-criteria hold, at low agent count. Prefer invoking through the graph-eng skill, which scouts context and passes args {task, mode, runDir, runId, context, checks, economy}. Skip for one-step tasks.',
  phases: [
    { title: 'Plan', detail: '1 planner: smallest DAG, done-criteria, risk per node' },
    { title: 'Execute', detail: 'DAG scheduler: reads 2-3 in parallel, writes single-lane' },
    { title: 'Verify', detail: 'check gate first; 1 strong skeptic per risky node, 2nd vote only on doubt, <=2 repairs' },
    { title: 'Critic', detail: 'whole vs done-criteria; gaps become the next round' },
    { title: 'Synthesize', detail: 'REPORT.md, memory index, human-gate list' },
  ],
}

// graph-eng: Plan -> loop[ DAG(work -> verify <-> repair) -> critic ] -> synthesize
//
// Por que custa pouco (fundamentação em skills/graph-eng/DESIGN.md):
// - menor grafo: o planner dimensiona pela complexidade; tarefa trivial vira 1 nó, sem critic nem synth
// - largura capada + scheduler DAG dinâmico: o nó começa quando as deps terminam, sem barreira por onda
// - verificação adaptativa: 1 verificador barato por nó arriscado; sobe para o modelo da sessão só se ele duvidar
// - reparo <= maxRepairs, guiado por feedback externo (verificador, checks) e interrompido sem progresso
// - estado em disco (paper trail) e só resumos curtos entre nós; prefixo de prompt idêntico em todos (cache)

// ── Entrada ──
const A = typeof args === 'string' ? { task: args } : (args || {})
const TASK = String(A.task || '').trim()
if (!TASK) {
  return { error: "Sem tarefa. Use Workflow({name: 'graph-eng:graph-eng', args: {task: '...', runDir: '...'}}), de preferência pela skill graph-eng." }
}

// Executor barato, revisor forte: worker/designer/synth podem ser um modelo menor (null = modelo da sessão), mas
// planner, verificador, critic e juiz rodam sempre no modelo da sessão. O revisor precisa ser >= o gerador
// (Xiang 2026) e o executor barato com advisor forte custa menos e acerta mais (Anthropic, advisor strategy).
// Nó de risco alto usa o modelo da sessão em tudo.
const PRESETS = {
  lean:     { maxAgents: 12, width: 2, maxNodes: 4, maxRounds: 2, maxRepairs: 1, defer: ['low', 'medium'], effort: 'low',    worker: 'sonnet', designer: 'sonnet', synth: 'sonnet' },
  balanced: { maxAgents: 24, width: 3, maxNodes: 6, maxRounds: 3, maxRepairs: 2, defer: ['low'],           effort: 'medium', worker: 'sonnet', designer: null,     synth: 'sonnet' },
  max:      { maxAgents: 48, width: 5, maxNodes: 8, maxRounds: 4, maxRepairs: 3, defer: [],                effort: 'high',   worker: null,     designer: null,     synth: null },
}
const ECONOMY = PRESETS[A.economy] ? A.economy : 'balanced'
const C = Object.assign({}, PRESETS[ECONOMY])
for (const k of ['maxAgents', 'width', 'maxNodes', 'maxRounds', 'maxRepairs']) {
  if (Number.isFinite(A[k]) && A[k] > 0) C[k] = Math.floor(A[k])
}
if ('workerModel' in A) C.worker = A.workerModel || null

const MODE = ['research', 'architecture', 'implement', 'review'].includes(A.mode) ? A.mode : 'auto'
const READ_ONLY = MODE === 'research' || MODE === 'review'
const RUN_DIR = String(A.runDir || '.graph-runs/adhoc').replace(/\/+$/, '')
const RUNS_ROOT = String(A.runsRoot || RUN_DIR.replace(/\/[^/]+$/, '') || '.graph-runs')
const RUN_ID = String(A.runId || RUN_DIR.split('/').pop())
const CHECKS = Array.isArray(A.checks) ? A.checks.map(String).filter(Boolean) : []
const CONTEXT = String(A.context || '').trim()
const SPEC = String(A.spec || '').trim() // caminho da spec: o humano é dono do "o quê"
const FIXED_DONE = Array.isArray(A.doneWhen) ? A.doneWhen.map(String).filter(Boolean) : [] // critérios travados
const MAX_GAPS = 3

// ── Utilitários ──
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const atLeast = (a, b) => EFFORTS[Math.max(EFFORTS.indexOf(a), EFFORTS.indexOf(b))]
const bullets = (xs) => (xs && xs.length ? xs.map((x) => '- ' + x).join('\n') : '- (none given)')
const normPath = (p) => String(p).replace(/^\.\//, '').trim()
const gapKey = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const artifactOf = (id, r) => (r && r.work && r.work.artifact) || `${RUN_DIR}/${id}.md`

// ── Orçamento: todo agent() passa por aqui ──
let spent = 0
const stats = {}
const dropped = []
function canSpend(n) {
  if (spent + n > C.maxAgents - 1) return false // 1 vaga reservada para o synth
  if (budget.total && budget.remaining() < 40000) return false
  return true
}
async function run(prompt, o, reserved) {
  if (!reserved && !canSpend(1)) {
    dropped.push(o.label)
    log('orçamento: pulou ' + o.label)
    return null
  }
  spent++
  const kind = o.label.split(':')[0]
  stats[kind] = (stats[kind] || 0) + 1
  const opts = {}
  for (const k in o) if (o[k] != null) opts[k] = o[k]
  try {
    return await agent(prompt, opts)
  } catch (e) {
    log(`${o.label} falhou: ${(e && e.message) || e}`)
    return null
  }
}

// ── Schemas ──
const NODE_ITEM = {
  type: 'object',
  required: ['id', 'title', 'kind', 'brief', 'deps', 'risk', 'acceptance'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    kind: { enum: ['research', 'design', 'implement'] },
    brief: { type: 'string' },
    deps: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    risk: { enum: ['low', 'medium', 'high'] },
    acceptance: { type: 'array', items: { type: 'string' } },
    explore: { type: 'boolean' },
  },
}
const PLAN = {
  type: 'object',
  required: ['goal', 'complexity', 'doneWhen', 'nodes'],
  properties: {
    goal: { type: 'string' },
    complexity: { enum: ['trivial', 'moderate', 'complex'] },
    doneWhen: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', maxItems: 3, items: { type: 'string' } },
    nodes: { type: 'array', minItems: 1, maxItems: C.maxNodes, items: NODE_ITEM },
  },
}
const WORK = {
  type: 'object',
  required: ['status', 'summary', 'confidence'],
  properties: {
    status: { enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    artifact: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['cmd', 'ok'],
        properties: { cmd: { type: 'string' }, ok: { type: 'boolean' }, output: { type: 'string' } },
      },
    },
    confidence: { enum: ['high', 'medium', 'low'] },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}
const VERDICT = {
  type: 'object',
  required: ['pass', 'confidence', 'blocking'],
  properties: {
    pass: { type: 'boolean' },
    confidence: { enum: ['high', 'medium', 'low'] },
    blocking: {
      type: 'array',
      items: {
        type: 'object',
        required: ['issue', 'where', 'fix'],
        properties: { issue: { type: 'string' }, where: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } },
      },
    },
    nits: { type: 'array', items: { type: 'string' } },
  },
}
const CRITIC = {
  type: 'object',
  required: ['done', 'assessment', 'gaps'],
  properties: {
    done: { type: 'boolean' },
    assessment: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'met'],
        properties: { criterion: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } },
      },
    },
    gaps: { type: 'array', maxItems: MAX_GAPS, items: NODE_ITEM },
  },
}
const SYNTH = {
  type: 'object',
  required: ['status', 'summary', 'humanGate'],
  properties: {
    status: { enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    changes: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    humanGate: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
  },
}

// ── Prompts ──
// SHARED abre todo prompt, idêntico em todos os agentes: o prefixo comum vira cache hit.
const SHARED = [
  `# Graph run ${RUN_ID}`,
  `Task: ${TASK}`,
  `Mode: ${MODE}${READ_ONLY ? ' (read-only: no code edits)' : ''}`,
  `Run dir (paper trail): ${RUN_DIR}`,
  SPEC && `Spec (source of truth for WHAT; the graph owns HOW): ${SPEC}. Read the parts your node needs.`,
  CONTEXT && `Scouted context:\n${CONTEXT}`,
  'Rules for every node:',
  '- You are ONE node of a graph. Do only your job; other nodes cover the rest. Do not spawn subagents.',
  '- Never commit, push, deploy, open PRs, touch remote databases or send messages. Code edits only in implement nodes.',
  '- Every claim needs evidence (file:line, URL, or command + result). Without evidence, label it "unverified".',
  '- Be terse. Full output goes to files; the structured return is a short summary.',
].filter(Boolean).join('\n') + '\n'
let PLAN_BLOCK = ''

const MODE_HINT = {
  auto: 'Choose only the node kinds the task actually needs.',
  research: 'Investigation only: research nodes, optionally one design node that concludes. No implement nodes.',
  architecture: 'Understand the current system (research), then decide (design). Set explore=true on the single pivotal decision when there are genuinely different viable options. No implement nodes unless the task asks for code.',
  implement: 'Code change: research only what is unknown, then implement nodes with exact files and acceptance the checks can prove. A graph is only as good as its oracle: when no existing check proves a node, its acceptance includes writing that test first (red before, green after).',
  review: 'Review/audit: one research node per independent dimension (e.g. correctness, security, performance), findings with file:line. No implement nodes.',
}
const HOW = {
  research: 'Investigate the repo with Read/Grep/Glob. When the answer depends on something outside the repo (external API, SDK, library, framework, CLI, version upgrade), research its current docs instead of trusting memory, in this order: ' +
    '(1) a docs MCP if the session has one (find it with ToolSearch, e.g. "context7" or "docs"; Context7 = resolve-library-id, then query-docs); (2) the official docs/reference with WebFetch; (3) WebSearch for changelog, breaking changes and known issues. ' +
    'Match the docs to the version installed here (package.json, lockfile, requirements, go.mod...) and name that version. If none of these tools is available, say so and label external claims "unverified". ' +
    'Stop as soon as the acceptance is met. Each finding = claim + evidence (file:line, or URL + version).',
  design: 'Write a decision record: context -> options (>=2, one line each) -> decision -> contracts/interfaces -> trade-offs and risks -> how to verify. Prefer the simplest design that meets acceptance; ground it in the real code.',
  implement: 'Edit only the files in scope (a tiny unavoidable adjacent edit is fine; list it). Follow the repo conventions. Never delete or weaken a test to make it pass. Before returning, run the fastest relevant check' +
    (CHECKS.length ? ` (${CHECKS.join(' | ')})` : '') + ' and report each one in checks (ok=false only for failures your change caused or should fix; pre-existing failures go to evidence as "pre-existing", with the tail of the output). Do not commit.',
}
const LENSES = {
  research: [
    'evidence: open the cited files/URLs and confirm they say what is claimed; for external docs, confirm they match the installed version and that the cited API/option exists there; flag stale or unsupported claims',
    'coverage: which important angle or counter-evidence did it miss that would change the conclusion',
  ],
  design: [
    'feasibility: will this work against the real code and constraints? name concrete failure modes',
    'simplicity: what is speculative or over-engineered and can be cut without failing acceptance',
  ],
  implement: [
    'correctness: run the checks, read the diff, test each acceptance item and the edge cases; external API/library calls must match the upstream docs artifact, not memory',
    'integration: callers, types, conventions and tests around the change; anything half-done or regressed',
  ],
}
const STANCES = [
  'Stance A (SIMPLEST viable): fewest moving parts, reuse what exists, defer anything speculative.',
  'Stance B (ROBUST): design for the failure modes, scale and evolution that are realistic here; justify every extra part.',
]

function depBlock(n) {
  if (!n.deps.length) return ''
  return '## Upstream results (open an artifact only if you need the detail)\n' + n.deps.map((d) => {
    const r = RESULTS.get(d)
    if (!r || !r.work) return `- [${d}] no output`
    const warn = r.status === 'failed' ? ` (WARNING failed verification: ${r.verdict.blocking.map((b) => b.issue).join('; ')})` : ''
    return `- [${d}] ${r.work.summary}${warn} -> ${artifactOf(d, r)}`
  }).join('\n') + '\n'
}

function workPrompt(n, deps, verdict, x) {
  const out = (x && x.out) || `${RUN_DIR}/${n.id}.md`
  const repair = verdict
    ? `\n## REPAIR: an independent verifier rejected your previous output (${out}). Fix these and keep what already works. If an item falls outside this node's acceptance or scope, do not fix it; list it in openQuestions:\n` +
      verdict.blocking.map((b) => `- ${b.issue} @ ${b.where}${b.evidence ? ` [${b.evidence}]` : ''} -> ${b.fix}`).join('\n') + '\n'
    : ''
  return SHARED + PLAN_BLOCK + `
## Your node: ${n.id} - ${n.title} [${n.kind}, risk ${n.risk}]
${n.brief}
${n.files.length ? `Files in scope: ${n.files.join(', ')}\n` : ''}Acceptance:
${bullets(n.acceptance)}
${deps}${x && x.stance ? `\n${x.stance}\n` : ''}${repair}
## How
${HOW[n.kind]}
Write the full output to ${out} (overwrite). Return: status, summary (<=120 words: what downstream nodes need), artifact="${out}", filesChanged, evidence, ${n.kind === 'implement' ? 'checks, ' : ''}confidence, openQuestions.`
}

function verifyPrompt(n, work, lens) {
  return SHARED + PLAN_BLOCK + `
## Role: independent verifier (lens: ${LENSES[n.kind][lens]})
You did not write this. Try to refute it. An acceptance item without evidence is not met.
Node ${n.id} - ${n.title} [${n.kind}, risk ${n.risk}]
Acceptance:
${bullets(n.acceptance)}
Worker summary: ${work.summary}
Artifact: ${work.artifact || `${RUN_DIR}/${n.id}.md`}
${work.filesChanged && work.filesChanged.length ? `Files changed: ${work.filesChanged.join(', ')} (inspect with git diff)\n` : ''}${n.kind === 'implement' ? `${CHECKS.length ? `Run: ${CHECKS.join(' | ')}\n` : ''}Scope: edits outside ${n.files.length ? n.files.join(', ') : 'what the acceptance needs'} are blocking (scope creep) unless trivially required; so is a deleted or weakened test.\n` : ''}
blocking = only what breaks acceptance or correctness (bug, unsupported claim, regression, failing check), each with where (file:line / section / check name), evidence and the concrete fix. Style and nice-to-haves go to nits. confidence=low only when you could not check key items.`
}

function nodeTable() {
  return [...NODES.values()].map((n) => {
    const r = RESULTS.get(n.id)
    if (!r) return `- [${n.id}] ${n.title}: not run`
    const v = !r.verified ? 'unverified'
      : r.status === 'done' ? 'verified'
      : 'FAILED verification: ' + r.verdict.blocking.map((b) => b.issue).join('; ')
    const reps = r.attempts > 1 ? `, ${r.attempts - 1} repair(s)` : ''
    return `- [${n.id}] ${n.kind}/${n.risk} ${r.status}, ${v}${reps}: ${r.work ? r.work.summary : r.note || ''} (${artifactOf(n.id, r)})`
  }).join('\n')
}

function criticPrompt(round, seen) {
  const unverified = [...RESULTS.entries()].filter(([, r]) => r.work && !r.verified).map(([id]) => id)
  const hasImpl = [...NODES.values()].some((n) => n.kind === 'implement')
  return SHARED + PLAN_BLOCK + `
## Role: integration critic (round ${round}/${C.maxRounds})
Judge the WHOLE result against the done criteria. Workers want to be finished; you check with evidence. Do not invent work either: a reviewer asked for gaps always finds some, so only unmet criteria and real defects count, never nice-to-haves.
Done when:
${bullets(DONE_WHEN)}
## Node results
${nodeTable()}
${unverified.length ? `Not individually verified, spot-check their key claims: ${unverified.join(', ')}\n` : ''}${hasImpl && CHECKS.length ? `Run every check once: ${CHECKS.join(' | ')}\n` : ''}${seen.size ? `Gaps already attempted (do not re-propose unless you have a clearly different fix): ${[...seen].join('; ')}\n` : ''}
For each criterion: met true/false + evidence. Also look for contradictions between nodes and broken seams.
done=true when every criterion is met. Otherwise return at most ${MAX_GAPS} gap nodes (same shape as plan nodes; deps may reference existing node ids): small, concrete, no redo of finished work.`
}

// ── Grafo ──
const NODES = new Map() // id -> nó (todos os rounds)
const RESULTS = new Map() // id -> { status, work, verdict, verified, attempts, note }
const BLOCKED = new Set() // nós sem saída utilizável: os dependentes são pulados

function normalize(list, prefix, round) {
  const idMap = new Map()
  const taken = new Set(NODES.keys())
  const out = []
  for (const raw of list || []) {
    const rawId = String(raw.id || '')
    let id = prefix + (rawId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'n' + (out.length + 1))
    while (taken.has(id)) id += '_'
    taken.add(id)
    idMap.set(rawId, id)
    let kind = ['research', 'design', 'implement'].includes(raw.kind) ? raw.kind : 'research'
    if (kind === 'implement' && READ_ONLY) {
      kind = 'design'
      log(`${id}: modo read-only, implement virou design (proposta sem edição)`)
    }
    out.push({
      id,
      kind,
      round,
      title: String(raw.title || id).slice(0, 80),
      brief: String(raw.brief || raw.title || ''),
      rawDeps: (raw.deps || []).map(String),
      files: (raw.files || []).map(normPath).filter(Boolean),
      risk: ['low', 'medium', 'high'].includes(raw.risk) ? raw.risk : 'medium',
      acceptance: (raw.acceptance || []).map(String),
      explore: !!raw.explore && kind === 'design',
    })
  }
  for (const n of out) {
    n.deps = []
    for (const d of n.rawDeps) {
      const m = idMap.get(d) || (NODES.has(d) ? d : null)
      if (m && m !== n.id) n.deps.push(m)
      else log(`${n.id}: dep desconhecida "${d}" ignorada`)
    }
    delete n.rawDeps
  }
  return out
}

function mermaid() {
  const mid = (id) => 'N_' + id.replace(/[^A-Za-z0-9_]/g, '_')
  const hasChild = new Set()
  for (const n of NODES.values()) for (const d of n.deps) hasChild.add(d)
  const L = ['graph TD', '  PLAN([plan])']
  for (const n of NODES.values()) {
    const r = RESULTS.get(n.id)
    const st = r ? r.status + (r.verified ? ' ok' : '') : 'not run'
    L.push(`  ${mid(n.id)}["${n.id} · ${n.title.replace(/["[\]]/g, "'")} (${n.kind}) - ${st}"]`)
    if (!n.deps.length) L.push(n.round > 1 ? `  CRITIC -.-> ${mid(n.id)}` : `  PLAN --> ${mid(n.id)}`)
    for (const d of n.deps) L.push(`  ${mid(d)} --> ${mid(n.id)}`)
    if (!hasChild.has(n.id)) L.push(`  ${mid(n.id)} --> CRITIC`)
  }
  L.push('  CRITIC{{critic}} --> SYNTH([report])')
  return L.join('\n')
}

// Leitura paraleliza, escrita não: dois nós implement nunca rodam ao mesmo tempo (Cognition 2026, Google/DeepMind 2026).
function writeBusy(n, running) {
  return n.kind === 'implement' && [...running.values()].some((m) => m.kind === 'implement')
}

// Scheduler DAG dinâmico: dispara cada nó assim que as deps terminam, respeitando a largura e a raia única de escrita.
async function executeGraph(batch) {
  const pending = batch.slice()
  const running = new Map()
  const inflight = new Map()
  let slots = 0
  while (pending.length || inflight.size) {
    for (let i = 0; i < pending.length; i++) {
      const n = pending[i]
      const dead = n.deps.filter((d) => BLOCKED.has(d))
      if (dead.length) {
        pending.splice(i--, 1)
        BLOCKED.add(n.id)
        RESULTS.set(n.id, { status: 'skipped', note: 'dependência sem saída: ' + dead.join(', ') })
        log(`${n.id}: pulado (dependência sem saída)`)
        continue
      }
      if (!n.deps.every((d) => RESULTS.has(d))) continue
      const need = n.explore ? 2 : 1
      if (slots > 0 && slots + need > C.width) continue
      if (writeBusy(n, running)) continue
      pending.splice(i--, 1)
      slots += need
      running.set(n.id, n)
      inflight.set(n.id, runNode(n).then(
        (r) => [n, need, r],
        (e) => [n, need, { status: 'blocked', attempts: 1, note: String((e && e.message) || e) }],
      ))
    }
    if (!inflight.size) {
      for (const n of pending) {
        BLOCKED.add(n.id)
        RESULTS.set(n.id, { status: 'skipped', note: 'deps irresolvíveis (ciclo?)' })
      }
      if (pending.length) log(`${pending.length} nó(s) com deps irresolvíveis foram pulados`)
      break
    }
    const [n, need, r] = await Promise.race(inflight.values())
    inflight.delete(n.id)
    running.delete(n.id)
    slots -= need
    RESULTS.set(n.id, r)
    if (r.status === 'blocked' || r.status === 'skipped') BLOCKED.add(n.id)
    log(`${n.id} -> ${r.status}${r.verified ? ' (verificado)' : ''}${r.attempts > 1 ? `, ${r.attempts - 1} reparo(s)` : ''}`)
  }
}

// Só o executor desce de modelo; quem julga (planner, verify, critic, juiz) fica no modelo da sessão.
function workerModel(n) {
  if (n.risk === 'high' || trivial) return undefined // tarefa pequena: o modelo forte direto sai mais barato que errar
  return (n.kind === 'design' ? C.designer : C.worker) || undefined
}

// Gate determinístico antes do juiz LLM (Spotify, Stripe): check vermelho vira veredito sem gastar verificador.
function checkGate(work) {
  const failed = (work.checks || []).filter((c) => c && c.ok === false)
  if (!failed.length) return null
  return {
    pass: false,
    confidence: 'high',
    blocking: failed.map((c) => ({
      issue: `check failing: ${c.cmd}`,
      where: c.cmd,
      evidence: String(c.output || '').slice(-600),
      fix: 'make this check pass without deleting or weakening tests',
    })),
  }
}

function doWork(n, deps, verdict, escalate) {
  return run(workPrompt(n, deps, verdict, null), {
    label: (verdict ? 'repair:' : 'work:') + n.id,
    phase: 'Execute',
    schema: WORK,
    model: escalate ? undefined : workerModel(n),
    effort: escalate || n.risk === 'high' ? 'high' : n.kind === 'research' ? C.effort : atLeast(C.effort, 'medium'),
  })
}

async function verify(n, work) {
  const norm = (v) => v && Object.assign({}, v, {
    blocking: v.blocking || [],
    pass: !!v.pass && !(v.blocking || []).length,
  })
  const v = await run(verifyPrompt(n, work, 0), {
    label: 'verify:' + n.id,
    phase: 'Verify',
    schema: VERDICT,
    effort: n.risk === 'high' ? 'high' : 'medium',
  })
  if (!v || v.confidence !== 'low') return norm(v)
  // Parada adaptativa: 2º voto (outra lente, esforço alto) só quando o primeiro verificador ficou em dúvida.
  const v2 = await run(verifyPrompt(n, work, 1), { label: 'escalate:' + n.id, phase: 'Verify', schema: VERDICT, effort: 'high' })
  return norm(v2 || v)
}

// Judge panel mínimo para a decisão central: 2 rascunhos com posturas opostas e 1 juiz que escolhe e enxerta.
async function explore(n, deps) {
  const drafts = (await parallel(STANCES.map((s, i) => () => run(
    workPrompt(n, deps, null, { stance: s, out: `${RUN_DIR}/${n.id}.${'ab'[i]}.md` }),
    { label: `draft-${'ab'[i]}:${n.id}`, phase: 'Execute', schema: WORK, model: workerModel(n), effort: atLeast(C.effort, 'medium') },
  )))).filter(Boolean)
  if (drafts.length < 2) return drafts[0] || null
  return run(SHARED + PLAN_BLOCK + `
## Role: judge for node ${n.id} - ${n.title}
Two independent drafts answer the same design question:
- A (simplest): ${drafts[0].summary} -> ${drafts[0].artifact || `${RUN_DIR}/${n.id}.a.md`}
- B (robust): ${drafts[1].summary} -> ${drafts[1].artifact || `${RUN_DIR}/${n.id}.b.md`}
Acceptance:
${bullets(n.acceptance)}
Read both. Pick the one that meets the acceptance with the least complexity, graft only the parts of the other that fix a real weakness, and write the final decision record to ${RUN_DIR}/${n.id}.md (state what was chosen and why). Return structured output with artifact="${RUN_DIR}/${n.id}.md".`,
  { label: 'judge:' + n.id, phase: 'Execute', schema: WORK, effort: 'high' })
}

async function runNode(n) {
  const deps = depBlock(n)
  let work = n.explore ? await explore(n, deps) : await doWork(n, deps, null, false)
  if (!work) return { status: 'blocked', attempts: 1, note: 'worker sem retorno (orçamento ou erro)' }
  if (work.status === 'blocked') return { status: 'blocked', work, attempts: 1, note: 'worker bloqueado: ' + work.summary }
  if (n.kind !== 'implement' && C.defer.includes(n.risk)) {
    return { status: 'done', work, verified: false, attempts: 1, note: 'verificação adiada para o critic' }
  }
  let verdict = checkGate(work) || await verify(n, work)
  let attempts = 1
  while (verdict && !verdict.pass && attempts <= C.maxRepairs) {
    const before = verdict.blocking.length
    const fixed = await doWork(n, deps, verdict, attempts === C.maxRepairs) // o último reparo sobe de modelo
    if (!fixed) break
    work = fixed
    attempts++
    const next = checkGate(work) || await verify(n, work)
    if (!next) {
      verdict = null
      break
    }
    verdict = next
    if (!verdict.pass && verdict.blocking.length >= before) {
      log(`${n.id}: reparo sem progresso, parou`)
      break
    }
  }
  if (!verdict) return { status: 'done', work, verified: false, attempts, note: 'sem verificação (orçamento)' }
  return { status: verdict.pass ? 'done' : 'failed', work, verdict, verified: true, attempts }
}

// ── Plan ──
phase('Plan')
let plan = A.plan && Array.isArray(A.plan.nodes) ? A.plan : null
if (!plan) {
  plan = await run(SHARED + `
## Role: planner (graph designer)
Design the SMALLEST graph of jobs that yields a high-quality result. Every extra node costs tokens and adds noise; add one only for independent work that can run in parallel, or for a genuinely different skill.
1. Read just enough (repo files, docs) to understand the task.
2. Memory: if ${RUNS_ROOT}/INDEX.md exists, skim it and open at most 2 relevant past REPORT.md files; reuse their decisions.
3. goal = the final deliverable in one sentence. ${FIXED_DONE.length
    ? `doneWhen is fixed by the user; return it verbatim:\n${bullets(FIXED_DONE)}`
    : `doneWhen = 2-5 checkable criteria for the whole task${CHECKS.length ? ` (checks available: ${CHECKS.join(' | ')})` : ''}.`}
4. Ambiguity about BEHAVIOR or OUTCOME (never about code details you can read): record the most reasonable choice in assumptions${A.planOnly ? ', and put up to 3 questions whose answer would change the result in questions' : ''}.
5. Size by complexity: trivial -> exactly 1 node; moderate -> 2-3 nodes; complex -> up to ${C.maxNodes}.
6. Nodes: kind research|design|implement. ${MODE_HINT[MODE]}
   - brief = the end state + expected output + where to look + what not to touch. Describe the outcome, not the steps: the node owns the how.
   - deps only where a node truly consumes another's output (no fake waiting). Inherently sequential work is a short chain, not a fan-out.
   - Reads parallelize, writes do not: implement nodes run one at a time. List their exact files, and when several must agree on a contract (types, API, schema), make them depend on one design node that fixes it.
   - External knowledge: when the task integrates or upgrades an external API, SDK, library or service the repo does not already use the same way, add one research node for its current docs (installed version, auth, limits, errors, breaking changes), risk medium, and make every node that uses it depend on it. Memory of an API is not evidence.
   - risk: high = security, auth, money, data/migrations, public API, prod config; low = read-only work with little downside; else medium.
   - acceptance = concrete, verifiable checks for that node.
7. Write ${RUN_DIR}/plan.md: goal, doneWhen, assumptions, node table and a mermaid graph.
Return structured output only.`, { label: 'plan', phase: 'Plan', schema: PLAN, effort: 'high' })
  if (!plan) return { error: 'o planner falhou', runDir: RUN_DIR, stats }
}

const DONE_WHEN = FIXED_DONE.length ? FIXED_DONE : (plan.doneWhen || []).map(String)
const ASSUMPTIONS = (plan.assumptions || []).map(String)
const first = normalize(plan.nodes, '', 1)
first.forEach((n) => NODES.set(n.id, n))
PLAN_BLOCK = `Goal: ${plan.goal}\n` +
  (ASSUMPTIONS.length ? `Assumptions (treat as decided): ${ASSUMPTIONS.join(' | ')}\n` : '') +
  `Graph: ${first.map((n) => `${n.id} "${n.title}" (${n.kind})${n.deps.length ? ' <- ' + n.deps.join(',') : ''}`).join(' | ')}\n`

const trivial = plan.complexity === 'trivial' && first.length === 1
// Estimativa do caminho feliz (sem reparo nem round extra), mostrada antes do fan-out.
let estimate = spent + (trivial ? 0 : 2) // critic + synth
for (const n of first) estimate += (n.explore ? 3 : 1) + (n.kind === 'implement' || !C.defer.includes(n.risk) ? 1 : 0)

// Gate humano opcional antes de gastar: devolve plano, perguntas e estimativa; reinvoque com args.plan.
if (A.planOnly) {
  return {
    planOnly: true,
    runDir: RUN_DIR,
    plan: { goal: plan.goal, complexity: plan.complexity, doneWhen: DONE_WHEN, assumptions: ASSUMPTIONS, nodes: first },
    questions: (plan.questions || []).map(String),
    estimate: { happyPath: estimate, ceiling: C.maxAgents },
    graph: mermaid(),
    stats,
  }
}

log(`plano: ${first.length} nó(s), ${plan.complexity}, preset ${ECONOMY}: ~${estimate} agentes no caminho feliz (teto ${C.maxAgents}, largura ${C.width})`)

// ── Loop: executa o DAG, o critic julga o todo, os gaps viram o próximo round ──
let batch = first
let lastCritic = null
let leftover = []
const seenGaps = new Set()
for (let round = 1; round <= C.maxRounds; round++) {
  phase('Execute')
  await executeGraph(batch)
  if (trivial) break
  if (!canSpend(1)) {
    log('orçamento acabou antes do critic')
    break
  }
  phase('Critic')
  lastCritic = await run(criticPrompt(round, seenGaps), { label: 'critic:r' + round, phase: 'Critic', schema: CRITIC, effort: 'high' })
  if (!lastCritic) break
  if (lastCritic.done) {
    log(`critic r${round}: critérios atendidos`)
    break
  }
  const fresh = (lastCritic.gaps || []).filter((g) => !seenGaps.has(gapKey(g.title)))
  if (!fresh.length) {
    log(`critic r${round}: sem gap novo, convergiu`)
    break
  }
  if (round === C.maxRounds) {
    leftover = fresh
    log(`teto de ${C.maxRounds} rounds: ${fresh.length} gap(s) ficam para o humano`)
    break
  }
  fresh.forEach((g) => seenGaps.add(gapKey(g.title)))
  batch = normalize(fresh, `r${round + 1}-`, round + 1)
  batch.forEach((n) => NODES.set(n.id, n))
  log(`round ${round + 1}: ${batch.map((n) => n.id).join(', ')}`)
}

const nodesOut = () => [...NODES.values()].map((n) => {
  const r = RESULTS.get(n.id) || {}
  return {
    id: n.id,
    title: n.title,
    kind: n.kind,
    risk: n.risk,
    status: r.status || 'not run',
    verified: !!r.verified,
    attempts: r.attempts || 0,
    artifact: r.work ? artifactOf(n.id, r) : undefined,
    blocking: r.verdict && !r.verdict.pass ? r.verdict.blocking : undefined,
    note: r.note,
  }
})

if (trivial) {
  const r = RESULTS.get(first[0].id) || {}
  return {
    task: TASK,
    trivial: true,
    runDir: RUN_DIR,
    status: r.status === 'done' ? 'done' : 'partial',
    summary: r.work ? r.work.summary : r.note,
    nodes: nodesOut(),
    stats: Object.assign({ agents: spent, dropped }, stats),
  }
}

// ── Synthesize ──
phase('Synthesize')
const graph = mermaid()
const statLine = () => Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(', ')
const synth = await run(SHARED + PLAN_BLOCK + `
## Role: synthesizer
Done when:
${bullets(DONE_WHEN)}
## Node results
${nodeTable()}
## Final critic
${lastCritic ? (lastCritic.done ? 'DONE: ' : 'NOT DONE: ') + lastCritic.assessment : 'critic did not run'}
${leftover.length ? 'Open gaps left for the human:\n' + bullets(leftover.map((g) => `${g.title}: ${g.brief}`)) + '\n' : ''}${dropped.length ? `Skipped for budget: ${dropped.join(', ')}\n` : ''}
1. Write ${RUN_DIR}/REPORT.md in Portuguese (pt-BR), opening node artifacts only as needed. Sections: Resultado (status + 3-5 lines) | O que mudou / achados (file:line) | Decisões e trade-offs | Premissas assumidas (the plan's assumptions, for the user to confirm) | Riscos e pendências | Gate humano (what needs the user's approval before commit, deploy, migration or publishing, including any assumption that changes behavior) | Próximos passos | Grafo executado (paste this block verbatim):
\`\`\`mermaid
${graph}
\`\`\`
   | Custo: ${spent + 1} agentes (${statLine()}, synth 1).
2. Append one row to ${RUNS_ROOT}/INDEX.md (create it with the header "| run | tarefa | status | relatório |" if missing): | ${RUN_ID} | <task in <=12 words> | <status> | ${RUN_DIR}/REPORT.md |
Return structured output in pt-BR.`, { label: 'synth', phase: 'Synthesize', schema: SYNTH, model: C.synth || undefined, effort: 'medium' }, true)

return {
  task: TASK,
  mode: MODE,
  economy: ECONOMY,
  runDir: RUN_DIR,
  report: `${RUN_DIR}/REPORT.md`,
  status: synth ? synth.status : 'partial',
  summary: synth ? synth.summary : null,
  humanGate: synth ? synth.humanGate : [],
  decisions: synth ? synth.decisions : [],
  changes: synth ? synth.changes : [],
  risks: synth ? synth.risks : [],
  nextSteps: synth ? synth.nextSteps : [],
  assumptions: ASSUMPTIONS,
  openGaps: leftover.map((g) => g.title),
  critic: lastCritic ? { done: lastCritic.done, assessment: lastCritic.assessment, criteria: lastCritic.criteria } : null,
  nodes: nodesOut(),
  graph,
  stats: Object.assign({ agents: spent, dropped }, stats),
}
