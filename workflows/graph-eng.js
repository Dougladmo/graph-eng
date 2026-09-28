export const meta = {
  name: 'graph-eng',
  description: 'Lean graph engineering: mode-shaped skeleton of phases -> effort x ceiling sizes the graph -> DAG scheduler -> design review with repair -> cross-checked verify + critic loop -> polish + consolidate. Agent count derives from effort (manual/auto/low/medium/high/max) and a ceiling (default 24/auto).',
  whenToUse: 'Complex multi-step work (feature, refactor, system architecture, deep investigation, audit) that benefits from separating workers from checkers and iterating until done-criteria hold, at low agent count. Prefer invoking through the graph-eng skill, which scouts context and passes args {task, mode, effort, ceiling, runDir, runId, context, checks, economy}. There is no trivial 1-node shortcut: every mode runs its full skeleton of phases.',
  phases: [
    { title: 'Plan', detail: '1 planner: smallest DAG for the target, done-criteria, risk per node, effort/mode chosen and justified' },
    { title: 'Research/Design', detail: 'DAG scheduler runs research and design nodes; width and node cap derive from the agent target' },
    { title: 'Design review', detail: 'independent reviewer checks assumptions, acceptance, stories and best practices; repairs the design or blocks implementation' },
    { title: 'Execute', detail: 'implement nodes run in parallel when their files are disjoint; single-lane when they overlap' },
    { title: 'Verify/Critic', detail: 'cross-checked verify per risky node (adaptive 2nd vote), then integration critic against done-criteria' },
    { title: 'Synthesize', detail: 'polishers (ceil(2/3 x implement nodes)) + 1 consolidator write REPORT.md, memory index, human-gate list' },
  ],
}

// graph-eng: Plan -> skeleton por modo -> [Research/Design -> Design review -> Execute] -> critic loop -> Synthesize
//
// Por que custa pouco (fundamentação em skills/graph-eng/DESIGN.md):
// - alvo de agentes = esforço × teto (agent-target.mjs, espelhado abaixo): menos esforço, menos agentes, sem tocar código
// - largura capada + scheduler DAG dinâmico: o nó começa quando as deps terminam, sem barreira por onda
// - verificação adaptativa: 1 verificador barato por nó arriscado; sobe para o modelo da sessão só se ele duvidar
// - revisão do design antes de implementar: reprovada = a implementação não começa
// - reparo <= maxRepairs, guiado por feedback externo (verificador, checks) e interrompido sem progresso
// - implementação paralela quando os arquivos são disjuntos, raia única quando se sobrepõem
// - estado em disco (paper trail) e só resumos curtos entre nós; prefixo de prompt idêntico em todos (cache)

// ── Entrada ──
const A = typeof args === 'string' ? { task: args } : (args || {})
const TASK = String(A.task || '').trim()
if (!TASK) {
  return { error: "Sem tarefa. Use Workflow({name: 'graph-eng:graph-eng', args: {task: '...', runDir: '...'}}), de preferência pela skill graph-eng." }
}

// ── agent-target (espelho de bin/ui/agent-target.mjs) ──
// O script do Workflow não importa nada (sem import/require/Node API), então esta cópia é inline.
// test/target.test.mjs extrai este bloco por regex e compara com bin/ui/agent-target.mjs para todo
// ceiling 4..100 x nível x modo: as duas tabelas têm que ser idênticas.
const EFFORT_PCT = { low: 20, medium: 40, high: 70, max: 100 }
const MODE_FLOOR = { implement: 8, architecture: 6, research: 4, review: 4 }
const MODE_FIXED = { implement: 4, architecture: 4, research: 3, review: 3 }
const MODE_MINNODES = { implement: 3, architecture: 2, research: 1, review: 1 }
const CEILING_MAX = 100
const DEFAULTS_TARGET = { effort: 'auto', ceiling: 24, economy: 'balanced', maxRounds: 3, maxRepairs: 2, planGate: false }
const EFFORTS_GRAPH = ['manual', 'auto', 'low', 'medium', 'high', 'max']
function floorOf(mode) { return MODE_FLOOR[mode] || 8 }
function clampInt(n, lo, hi) { return Math.max(lo, Math.min(hi, n)) }
function targetFor(level, ceiling, mode) {
  const pct = EFFORT_PCT[level] || EFFORT_PCT.medium
  const raw = Math.floor((pct * ceiling + 50) / 100)
  return Math.min(ceiling, Math.max(floorOf(mode), raw))
}
function targetTable(ceiling, mode) {
  return { low: targetFor('low', ceiling, mode), medium: targetFor('medium', ceiling, mode), high: targetFor('high', ceiling, mode), max: targetFor('max', ceiling, mode) }
}
function targetRange(ceiling, mode) {
  return { min: targetFor('low', ceiling, mode), max: targetFor('max', ceiling, mode) }
}
function sizing(target, mode) {
  const fixed = MODE_FIXED[mode] || MODE_FIXED.implement
  const minNodes = MODE_MINNODES[mode] || MODE_MINNODES.implement
  return { width: clampInt(Math.ceil(target / 6), 2, 8), maxNodes: clampInt(Math.floor((target - fixed) / 2), minNodes, 24) }
}
function validateCeiling(ceiling, mode) {
  const min = floorOf(mode)
  const max = CEILING_MAX
  if (!Number.isInteger(Number(ceiling)) || typeof ceiling === 'boolean' || String(ceiling).trim() === '') {
    return { ok: false, min, max, error: 'use um número inteiro' }
  }
  const c = Number(ceiling)
  if (c < min) return { ok: false, min, max, error: `mínimo ${min}` }
  if (c > max) return { ok: false, min, max, error: 'máximo 100' }
  return { ok: true, min, max }
}
function estimateAgents(nodes, opts) {
  const o = opts || {}
  const list = nodes || []
  const implementCount = list.filter((n) => n.kind === 'implement').length
  let total = 1 // plano
  for (const n of list) total += (n.explore ? 3 : 1) + ((n.kind === 'implement' || o.level === 'high' || o.level === 'max') ? 1 : 0)
  if (o.mode === 'implement' || o.mode === 'architecture') total += 1 // revisão do design
  total += 1 // crítica r1
  if (o.mode === 'implement' && implementCount > 0) total += Math.max(1, Math.ceil((2 * implementCount) / 3)) // polidores
  total += 1 // consolidador
  return total
}
// ── fim agent-target ──

// Executor barato, revisor forte: worker/designer/synth podem ser um modelo menor (null = modelo da sessão), mas
// planner, verificador, revisor do design, critic e juiz rodam sempre no modelo da sessão. O revisor precisa ser
// >= o gerador (Xiang 2026) e o executor barato com advisor forte custa menos e acerta mais (Anthropic, advisor
// strategy). Nó de risco alto usa o modelo da sessão em tudo.
const MODELS = {
  lean: { effort: 'low', worker: 'sonnet', designer: 'sonnet', synth: 'sonnet' },
  balanced: { effort: 'medium', worker: 'sonnet', designer: null, synth: 'sonnet' },
  max: { effort: 'high', worker: null, designer: null, synth: null },
}
const ECONOMY = MODELS[A.economy] ? A.economy : 'balanced'
const MDL = Object.assign({}, MODELS[ECONOMY])
if ('workerModel' in A) MDL.worker = A.workerModel || null
const REASON_EFFORT = MDL.effort

const MODE = ['research', 'architecture', 'implement', 'review'].includes(A.mode) ? A.mode : 'auto'
const RUN_DIR = String(A.runDir || '.graph-runs/adhoc').replace(/\/+$/, '')
const RUNS_ROOT = String(A.runsRoot || RUN_DIR.replace(/\/[^/]+$/, '') || '.graph-runs')
const RUN_ID = String(A.runId || RUN_DIR.split('/').pop())
const CHECKS = Array.isArray(A.checks) ? A.checks.map(String).filter(Boolean) : []
const CONTEXT = String(A.context || '').trim()
const SPEC = String(A.spec || '').trim() // caminho da spec: o humano é dono do "o quê"
const FIXED_DONE = Array.isArray(A.doneWhen) ? A.doneWhen.map(String).filter(Boolean) : [] // critérios travados
const MAX_GAPS = 3

// ── Esforço (tamanho do grafo) e teto ──
const REQUESTED_EFFORT = A.effort || 'auto'
let EFFORT_SOURCE = A.effortSource || (A.effort ? 'flag' : 'default')
let effortArg = A.effort
if (effortArg === 'manual') {
  log('esforço: manual chegou ao workflow, tratado como auto (a skill resolve antes de disparar)')
  effortArg = 'auto'
  EFFORT_SOURCE = 'manual-fallback'
}
const LEVEL0 = ['low', 'medium', 'high', 'max'].includes(effortArg) ? effortArg : null // null = auto

let CEILING = DEFAULTS_TARGET.ceiling
if (Number.isFinite(A.ceiling)) CEILING = Math.floor(A.ceiling)
else if (Number.isFinite(A.maxAgents)) CEILING = Math.floor(A.maxAgents)
if (Number.isFinite(A.ceiling) && Number.isFinite(A.maxAgents) && Math.floor(A.ceiling) !== Math.floor(A.maxAgents)) {
  log(`ceiling (${Math.floor(A.ceiling)}) e maxAgents (${Math.floor(A.maxAgents)}) divergem; ceiling vence`)
}

const preCheck = validateCeiling(CEILING, MODE)
if (!preCheck.ok) return { error: `ceiling ${CEILING} fora de [${preCheck.min}..100] para o modo ${MODE}: ${preCheck.error}`, runDir: RUN_DIR }

const MAXROUNDS = Number.isFinite(A.maxRounds) && A.maxRounds > 0 ? Math.floor(A.maxRounds) : DEFAULTS_TARGET.maxRounds
const MAXREPAIRS = Number.isFinite(A.maxRepairs) && A.maxRepairs > 0 ? Math.floor(A.maxRepairs) : DEFAULTS_TARGET.maxRepairs

// Sizing pré-planner: o schema do plano usa o pior caso (nível mais alto possível) para não cortar nós à toa.
const T0 = LEVEL0 ? targetFor(LEVEL0, CEILING, MODE) : targetFor('max', CEILING, MODE)
const SIZE0 = sizing(T0, MODE)
const TARGET_RANGE = targetRange(CEILING, MODE)

const C = { maxAgents: T0, width: SIZE0.width, maxNodes: SIZE0.maxNodes, maxRounds: MAXROUNDS, maxRepairs: MAXREPAIRS }

// ── Utilitários ──
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] // esforço de raciocínio do agent(), eixo separado do effort de tamanho do grafo
const atLeast = (a, b) => EFFORTS[Math.max(EFFORTS.indexOf(a), EFFORTS.indexOf(b))]
const bullets = (xs) => (xs && xs.length ? xs.map((x) => '- ' + x).join('\n') : '- (none given)')
const normPath = (p) => String(p).replace(/^\.\//, '').trim()
const gapKey = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const artifactOf = (id, r) => (r && r.work && r.work.artifact) || `${RUN_DIR}/${id}.md`

// ── Orçamento: todo agent() passa por aqui ──
// As fases obrigatórias do esqueleto (revisão do design, crítica, síntese) reservam vaga até rodarem
// uma vez; os reparos, verificações e polidores disputam o que sobra.
let spent = 0
const stats = {}
const dropped = []
let MANDATORY = { designReview: true, critic: true, synth: true } // conservador até o modo resolver
// Todo nó de implementação reserva 1 vaga de verify (work+verify) desde antes de rodar o work,
// até a verificação de fato acontecer (ou o worker falhar) — sem isso, um work concorrente de
// outro nó podia gastar a vaga que garantiria a verificação deste (§6: toda implementação é
// verificada por outro agente).
const pendingVerify = new Set()
const reservedLeft = () => (MANDATORY.designReview ? 1 : 0) + (MANDATORY.critic ? 1 : 0) + (MANDATORY.synth ? 1 : 0) + pendingVerify.size
function canSpend(n) {
  if (spent + n > C.maxAgents - reservedLeft()) return false
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
  required: ['goal', 'complexity', 'doneWhen', 'nodes', 'effort'],
  properties: {
    goal: { type: 'string' },
    complexity: { enum: ['trivial', 'moderate', 'complex'] },
    mode: { enum: ['implement', 'architecture', 'research', 'review'] },
    effort: {
      type: 'object',
      required: ['level', 'why'],
      properties: { level: { enum: ['low', 'medium', 'high', 'max'] }, why: { type: 'string' } },
    },
    doneWhen: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', maxItems: 3, items: { type: 'string' } },
    nodes: { type: 'array', minItems: 1, maxItems: SIZE0.maxNodes, items: NODE_ITEM },
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
const DESIGN_REVIEW = {
  type: 'object',
  required: ['pass', 'confidence', 'blocking', 'checked'],
  properties: {
    pass: { type: 'boolean' },
    confidence: { enum: ['high', 'medium', 'low'] },
    blocking: {
      type: 'array',
      items: {
        type: 'object',
        required: ['issue', 'where', 'fix', 'node'],
        properties: { issue: { type: 'string' }, where: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' }, node: { type: 'string' } },
      },
    },
    nits: { type: 'array', items: { type: 'string' } },
    checked: {
      type: 'object',
      properties: { assumptions: { type: 'boolean' }, acceptance: { type: 'boolean' }, stories: { type: 'boolean' }, bestPractices: { type: 'boolean' } },
    },
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
// SHARED abre todo prompt, idêntico em todos os agentes: o prefixo comum vira cache hit. Effort/Ceiling/Target
// vêm dos args de entrada e não mudam durante a run (o valor resolvido pelo planner vai no PLAN_BLOCK, à parte,
// para não invalidar o cache de quem já rodou antes do plano).
// RESUME_LINE fica vazia até o bloco de retomada (perto do normalize de `first`) calcular o fecho de
// refazer; buildShared() é reinvocada depois disso para que a linha "Resume:" apareça já no prefixo
// que os nós de pesquisa/design/implementação recebem (workPrompt etc. leem SHARED por closure, e só
// rodam depois dessa reatribuição).
let RESUME_LINE = ''
function buildShared() {
  return [
    `# Graph run ${RUN_ID}`,
    `Task: ${TASK}`,
    `Mode: ${MODE}`,
    `Economy: ${ECONOMY}`,
    `Effort: ${LEVEL0 || 'auto'}`,
    `Ceiling: ${CEILING}`,
    LEVEL0 ? `Target: ${targetFor(LEVEL0, CEILING, MODE)}` : `Target: auto ${TARGET_RANGE.min}-${TARGET_RANGE.max}`,
    `Run dir (paper trail): ${RUN_DIR}`,
    RESUME_LINE || false,
    SPEC && `Spec (source of truth for WHAT; the graph owns HOW): ${SPEC}. Read the parts your node needs.`,
    CONTEXT && `Scouted context:\n${CONTEXT}`,
    'Rules for every node:',
    '- You are ONE node of a graph. Do only your job; other nodes cover the rest. Do not spawn subagents.',
    '- Never commit, push, deploy, open PRs, touch remote databases or send messages. Code edits only in implement nodes.',
    '- Every claim needs evidence (file:line, URL, or command + result). Without evidence, label it "unverified".',
    '- Be terse. Full output goes to files; the structured return is a short summary.',
  ].filter(Boolean).join('\n') + '\n'
}
let SHARED = buildShared()
let PLAN_BLOCK = ''

const MODE_HINT = {
  auto: 'Resolve mode: implement if the task changes code, else architecture (a pivotal decision, no code) or research (investigation only). Set plan.mode.',
  research: 'Investigation only: research nodes, optionally one design node that concludes. No implement nodes.',
  architecture: 'Understand the current system (research), then decide (design). Set explore=true on the single pivotal decision when there are genuinely different viable options. No implement nodes.',
  implement: 'Code change: at least one research node first, then design, then implement nodes with exact files and acceptance the checks can prove. A graph is only as good as its oracle: when no existing check proves a node, its acceptance includes writing that test first (red before, green after).',
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
const BEST_PRACTICES = 'best practices: repo patterns and conventions (CLAUDE.md, docs, neighbouring code), suspicious code, defects, security (injection, secrets, authz, unsafe input, path traversal)'

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
You did not write this. Try to refute it. An acceptance item without evidence is not met. Always apply also: ${BEST_PRACTICES}.${n.kind === 'implement' ? ' A violation of these in an implement node is blocking.' : ''}
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
Judge the WHOLE result against the done criteria. Workers want to be finished; you check with evidence. Apply ${BEST_PRACTICES} to the whole change; a violation in code is an unmet criterion. Do not invent work either: a reviewer asked for gaps always finds some, so only unmet criteria and real defects count, never nice-to-haves.
Done when:
${bullets(DONE_WHEN)}
## Node results
${nodeTable()}
${unverified.length ? `Not individually verified, spot-check their key claims: ${unverified.join(', ')}\n` : ''}${hasImpl && CHECKS.length ? `Run every check once: ${CHECKS.join(' | ')}\n` : ''}${seen.size ? `Gaps already attempted (do not re-propose unless you have a clearly different fix): ${[...seen].join('; ')}\n` : ''}
For each criterion: met true/false + evidence. Also look for contradictions between nodes and broken seams.
done=true when every criterion is met. Otherwise return at most ${MAX_GAPS} gap nodes (same shape as plan nodes; deps may reference existing node ids): small, concrete, no redo of finished work.`
}

function designReviewPrompt(attempt) {
  const designNodes = [...NODES.values()].filter((n) => n.round === 1 && n.kind !== 'implement')
  const implNodes = [...NODES.values()].filter((n) => n.round === 1 && n.kind === 'implement')
  const table = designNodes.map((n) => {
    const r = RESULTS.get(n.id)
    return `- [${n.id}] ${n.kind} ${n.title}: ${r && r.work ? r.work.summary : '(sem saída)'} -> ${r ? artifactOf(n.id, r) : ''}`
  }).join('\n') || '(nenhum)'
  const implTable = implNodes.map((n) => `- [${n.id}] ${n.title}:\n${bullets(n.acceptance)}`).join('\n') || '(nenhum)'
  return SHARED + PLAN_BLOCK + `
## Role: design reviewer (attempt r${attempt})
Check the design against: (1) the plan's assumptions vs the research evidence; (2) the done criteria and every implement node's acceptance below; (3) user stories in the spec, when there is one; (4) ${BEST_PRACTICES}.
Done when:
${bullets(DONE_WHEN)}
## Research and design nodes
${table}
## Implement nodes waiting on this design
${implTable}
Each blocking item must name the design node to fix (node = its id; pick one of the research/design ids above). pass=true only when nothing blocks. Set checked.assumptions/acceptance/stories/bestPractices to whether you actually verified each (false when there was nothing to check, e.g. no spec for stories).`
}

// ── Grafo ──
const NODES = new Map() // id -> nó (todos os rounds)
const RESULTS = new Map() // id -> { status, work, verdict, verified, attempts, note }
const BLOCKED = new Set() // nós sem saída utilizável: os dependentes são pulados
const RAILS = [] // trilhos aplicados no round 1: { rule, node, action, detail }
const RESERVED_IDS = new Set(['research-base', 'design-base'])

let RMODE = MODE === 'auto' ? 'implement' : MODE // atualizado antes do 1º normalize (§3.2)
let READ_ONLY = RMODE === 'research' || RMODE === 'review'

function ancestorsOf(n, byId) {
  const seen = new Set()
  const stack = [...n.deps]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const m = byId.get(id)
    if (m) stack.push(...m.deps)
  }
  return seen
}

function railLog(rule, node, action, detail) {
  RAILS.push({ rule, node, action, detail })
  log(`trilho ${rule}: ${detail}`)
}

// Trilhos deterministas do esqueleto: garantem pesquisa na raiz, design antes de implementar (em
// implement/architecture) e a ordem pesquisa -> design -> implementação nas deps, sem depender do
// planner lembrar. Idempotentes: reenviar o mesmo plano não muda nada (§5, DR-6).
function applyRails(out) {
  const byId = new Map(out.map((n) => [n.id, n]))
  const round = out.length ? out[0].round : 1

  // R1: nenhum nó research -> injeta research-base na raiz
  if (!out.some((n) => n.kind === 'research')) {
    let base = byId.get('research-base')
    if (!base) {
      base = {
        id: 'research-base', kind: 'research', round,
        title: 'Pesquisa de base',
        brief: 'Levantar código, docs do repo e docs externas das bibliotecas envolvidas, na versão instalada, para a tarefa.',
        deps: [], files: [], risk: 'medium',
        acceptance: ['achados com evidência (file:line ou URL + versão)'],
        explore: false, injected: true, reason: 'plano sem pesquisa',
      }
      out.push(base)
      byId.set(base.id, base)
      railLog('R1', base.id, 'inject', 'research-base injetado na raiz (plano sem pesquisa)')
    }
  }

  // R3: implement/architecture sem nó design -> injeta design-base, depende de toda pesquisa
  if ((RMODE === 'implement' || RMODE === 'architecture') && !out.some((n) => n.kind === 'design')) {
    const researchIds = out.filter((n) => n.kind === 'research').map((n) => n.id)
    let base = byId.get('design-base')
    if (!base) {
      base = {
        id: 'design-base', kind: 'design', round,
        title: 'Design de base',
        brief: 'Registrar as decisões e contratos mínimos para a implementação, a partir da pesquisa.',
        deps: [...researchIds], files: [], risk: 'medium',
        acceptance: ['decisão + contratos + como verificar'],
        explore: false, injected: true, reason: 'plano sem design',
      }
      out.push(base)
      byId.set(base.id, base)
      railLog('R3', base.id, 'inject', `design-base injetado, depende de ${researchIds.join(', ') || '(nada)'} (plano sem design)`)
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
      const anc = ancestorsOf(n, byId)
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
      const anc = ancestorsOf(n, byId)
      if (designIds.some((d) => anc.has(d))) continue
      const add = designIds.filter((d) => d !== n.id && !n.deps.includes(d))
      if (add.length) {
        n.deps.push(...add)
        railLog('R4', n.id, 'add-dep', `${n.id} passou a depender de ${add.join(', ')} (implementação sem design entre os ancestrais)`)
      }
    }
  }
}

function normalize(list, prefix, round, opts) {
  const railsOn = !!(opts && opts.rails)
  const idMap = new Map()
  const taken = new Set(NODES.keys())
  const out = []
  for (const raw of list || []) {
    const rawId = String(raw.id || '')
    let id = prefix + (rawId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'n' + (out.length + 1))
    if (prefix === '' && RESERVED_IDS.has(id) && raw.injected !== true) {
      id += '_'
      log(`${id}: id reservado usado pelo planner, renomeado`)
    }
    while (taken.has(id)) id += '_'
    taken.add(id)
    idMap.set(rawId, id)
    let kind = ['research', 'design', 'implement'].includes(raw.kind) ? raw.kind : 'research'
    if (kind === 'implement' && READ_ONLY) {
      kind = 'design'
      log(`${id}: modo read-only, implement virou design (proposta sem edição)`)
    } else if (kind === 'implement' && RMODE !== 'implement') {
      kind = 'design'
      log(`${id}: modo ${RMODE} sem implementação, implement virou design`)
    }
    out.push(Object.assign({
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
    }, raw.injected === true ? { injected: true, reason: String(raw.reason || '') } : {}))
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
  if (railsOn) applyRails(out)
  return out
}

// Kinds que o esqueleto do modo exige com pelo menos 1 nó (§ esqueleto obrigatório por modo):
// pesquisa sempre; design em implement/architecture; implementação só em implement.
function requiredKinds(mode) {
  const req = ['research']
  if (mode === 'implement' || mode === 'architecture') req.push('design')
  if (mode === 'implement') req.push('implement')
  return req
}

// C.maxNodes só existe de fato depois do planner (resolveMode + LEVEL): SIZE0 usado no schema do
// plano é o pior caso (nível mais alto), então o plano normalizado pode vir maior que o teto real
// do nível resolvido. Corta os nós excedentes, nunca esvaziando um kind obrigatório do esqueleto
// do modo (research sempre; design em implement/architecture; implement em implement): o corte sai
// do kind com mais nós, começando pelos que não têm dependentes. Se o piso por kind (1 por kind
// obrigatório) exceder maxNodes, mantém 1 nó por kind mesmo acima do teto e registra no log. Limpa
// deps para os IDs cortados — quem chama reaplica applyRails para recuperar pesquisa/design entre
// os ancestrais. Nunca passa um plano acima do teto adiante sem essa proteção.
//
// C7 (trilho maxNodes na retomada): protectedIds (os nós READY de uma retomada) nunca é cortado e
// não conta para o teto — o teto vale só para quem ainda vai rodar (pending). Sem retomada,
// protectedIds vem vazio e o comportamento é idêntico ao de antes.
function applyMaxNodes(nodes, maxNodes, mode, protectedIds) {
  const protectedSet = protectedIds instanceof Set ? protectedIds : new Set(protectedIds || [])
  const protectedNodes = nodes.filter((n) => protectedSet.has(n.id))
  const pending = nodes.filter((n) => !protectedSet.has(n.id))
  if (pending.length <= maxNodes) return { nodes, cut: [], floorNote: null }
  const byId = new Map(pending.map((n) => [n.id, n]))
  const required = requiredKinds(mode)
  const protectedNote = protectedNodes.length ? ` (+ ${protectedNodes.length} nó(s) pronto(s) da retomada, fora do teto)` : ''

  if (required.length > maxNodes) {
    const kept = []
    for (const k of required) {
      const found = pending.find((n) => n.kind === k)
      if (found) kept.push(found)
    }
    const keptIds = new Set([...protectedNodes, ...kept].map((n) => n.id))
    const finalNodes = nodes.filter((n) => keptIds.has(n.id))
    for (const n of finalNodes) n.deps = n.deps.filter((d) => keptIds.has(d))
    const cut = pending.filter((n) => !keptIds.has(n.id)).map((n) => n.id)
    const floorNote = `piso de 1 nó por kind obrigatório (${required.join(', ')} = ${required.length}) excede maxNodes (${maxNodes}); mantendo ${kept.length} nó(s) pendente(s), 1 por kind${protectedNote}`
    return { nodes: finalNodes, cut, floorNote }
  }

  const floorFor = (kind) => (required.includes(kind) ? 1 : 0)
  const keepIds = new Set(pending.map((n) => n.id))
  const cut = []
  while (keepIds.size > maxNodes) {
    const depended = new Set()
    for (const id of keepIds) {
      for (const d of byId.get(id).deps) if (keepIds.has(d)) depended.add(d)
    }
    const countByKind = {}
    for (const id of keepIds) {
      const k = byId.get(id).kind
      countByKind[k] = (countByKind[k] || 0) + 1
    }
    const eligibleKinds = Object.keys(countByKind).filter((k) => countByKind[k] > floorFor(k))
    if (!eligibleKinds.length) break // não dá para cortar mais sem furar o piso de algum kind
    eligibleKinds.sort((a, b) => countByKind[b] - countByKind[a])
    const targetKind = eligibleKinds[0]
    const candidates = [...keepIds].filter((id) => byId.get(id).kind === targetKind)
    candidates.sort((a, b) => (depended.has(a) ? 1 : 0) - (depended.has(b) ? 1 : 0))
    const victim = candidates[0]
    keepIds.delete(victim)
    cut.push(victim)
  }
  const finalIds = new Set([...protectedNodes.map((n) => n.id), ...keepIds])
  const finalNodes = nodes.filter((n) => finalIds.has(n.id))
  for (const n of finalNodes) n.deps = n.deps.filter((d) => finalIds.has(d))
  return { nodes: finalNodes, cut, floorNote: protectedNodes.length ? `${protectedNodes.length} nó(s) pronto(s) da retomada, fora do teto` : null }
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

// Forma compacta (§6.4) direto de NODES/RESULTS/BLOCKED: a verdade do motor, sem dedução de
// journal. Estados que só existem em progresso (trabalhando/verificando/reparando/erro) não dão
// pra saber daqui, então um nó ainda sem resultado sai como "aguardando".
function graphText() {
  const depth = new Map()
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id)
    depth.set(id, 0)
    const n = NODES.get(id)
    const deps = (n && n.deps) || []
    const v = deps.length ? Math.max(0, ...deps.map((p) => (NODES.has(p) ? depthOf(p) + 1 : 0))) : 0
    depth.set(id, v)
    return v
  }
  const lines = []
  for (const n of NODES.values()) {
    const r = RESULTS.get(n.id)
    let marker = ' '
    let label = 'aguardando'
    if (!r) {
      // segue aguardando
    } else if (r.status === 'skipped') {
      marker = '-'
      label = 'pulado'
    } else if (r.status === 'blocked') {
      marker = 'x'
      label = 'bloqueado'
    } else if (r.status === 'failed') {
      const isCheck = ((r.verdict && r.verdict.blocking) || []).some((b) => String((b && b.issue) || '').startsWith('check failing:'))
      marker = 'x'
      label = isCheck ? 'falhou (check)' : 'falhou'
    } else if (r.status === 'done') {
      if (r.verified) {
        marker = '+'
        label = 'pronto'
      } else if (r.attempts > 1) {
        marker = 'r'
        label = 'sem reverificação'
      } else {
        marker = 'o'
        label = 'pronto s/ verif.'
      }
    }
    const k = depthOf(n.id)
    const deps = n.deps.length ? n.deps.join(' ') : 'plan'
    lines.push(`${'  '.repeat(k)}${k ? '└▶ ' : ''}[${marker}] ${n.id} ${label}  ← ${deps}`)
  }
  return lines.join('\n')
}

// Leitura paraleliza, escrita não entre implementações que tocam o mesmo arquivo (Cognition 2026,
// Google/DeepMind 2026). Arquivos disjuntos (declarados em n.files) rodam juntos; sem arquivo
// declarado, ou com sobreposição, cai na raia única.
function stem(p) { return String(p).split('*')[0].replace(/\/+$/, '') }
function overlaps(a, b) { return a === b || a.startsWith(b + '/') || b.startsWith(a + '/') }
function writeBusy(n, running) {
  if (n.kind !== 'implement') return false
  return [...running.values()].some((m) => {
    if (m.kind !== 'implement') return false
    if (!n.files.length || !m.files.length) return true
    const over = n.files.some((f) => m.files.some((g) => overlaps(stem(f), stem(g))))
    if (!over) log(`paralelo: ${n.id} roda junto de ${m.id} (arquivos disjuntos)`)
    return over
  })
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
    log(graphText())
  }
}

// Só o executor desce de modelo; quem julga (planner, verify, revisor do design, critic, juiz) fica no modelo da sessão.
function workerModel(n) {
  if (n.risk === 'high' || plan.complexity === 'trivial') return undefined // tarefa pequena: o modelo forte direto sai mais barato que errar
  return (n.kind === 'design' ? MDL.designer : MDL.worker) || undefined
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

function doWork(n, deps, verdict, escalate, label) {
  return run(workPrompt(n, deps, verdict, null), {
    label: label || (verdict ? 'repair:' : 'work:') + n.id,
    phase: RMODE === 'implement' || RMODE === 'architecture' ? (n.kind === 'implement' ? 'Execute' : 'Research') : 'Research',
    schema: WORK,
    model: escalate ? undefined : workerModel(n),
    effort: escalate || n.risk === 'high' ? 'high' : n.kind === 'research' ? REASON_EFFORT : atLeast(REASON_EFFORT, 'medium'),
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
    { label: `draft-${'ab'[i]}:${n.id}`, phase: 'Research', schema: WORK, model: workerModel(n), effort: atLeast(REASON_EFFORT, 'medium') },
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
  { label: 'judge:' + n.id, phase: 'Research', schema: WORK, effort: 'high' })
}

async function runNode(n) {
  const deps = depBlock(n)
  const isImpl = n.kind === 'implement'
  // Implementação exige orçamento para work+verify ANTES de rodar o work: sem as 2 vagas, o nó
  // fica sem rodar (skipped) em vez de sair "done" sem verificação (§6, piso do implement).
  if (isImpl) {
    if (!canSpend(2)) { log(`orçamento: ${n.id} sem vaga para work+verify, pulado`); return { status: 'skipped', attempts: 0, note: 'sem orçamento (work+verify)' } }
    pendingVerify.add(n.id)
  }
  const release = () => pendingVerify.delete(n.id)
  let work
  try {
    work = n.explore ? await explore(n, deps) : await doWork(n, deps, null, false)
  } catch (e) {
    if (isImpl) release()
    throw e
  }
  if (!work) { if (isImpl) release(); return { status: 'blocked', attempts: 1, note: 'worker sem retorno (orçamento ou erro)' } }
  if (work.status === 'blocked') { if (isImpl) release(); return { status: 'blocked', work, attempts: 1, note: 'worker bloqueado: ' + work.summary } }
  // Verificação cruzada é a regra; adia só pesquisa/design do round 1, em low/medium, para a fase que
  // olha todos juntos (revisão do design em implement/architecture, senão a crítica). Implementação
  // nunca adia, gap (round > 1) nunca adia (§7).
  const defer = n.kind !== 'implement' && n.round === 1 && (LEVEL === 'low' || LEVEL === 'medium')
  if (defer) {
    const to = (RMODE === 'implement' || RMODE === 'architecture') ? 'a revisão do design' : 'o critic'
    return { status: 'done', work, verified: false, attempts: 1, note: 'verificação adiada para ' + to }
  }
  // A vaga reservada para o verify já garantiu orçamento para o work acima; libera antes de gastá-la
  // de fato (a aritmética de canSpend(2) já contou as duas, sem risco de outro nó furar na frente:
  // nada assíncrono corre entre o release e o canSpend síncrono de dentro de run()).
  if (isImpl) release()
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
  if (!verdict) return { status: isImpl ? 'partial' : 'done', work, verified: false, attempts, note: 'sem verificação (orçamento)' }
  return { status: verdict.pass ? 'done' : 'failed', work, verdict, verified: true, attempts }
}

async function repairDesign(id, verdictSubset) {
  const n = NODES.get(id)
  if (!n) return null
  const deps = depBlock(n)
  const fixed = await doWork(n, deps, verdictSubset, false, 'design-repair:' + id)
  if (!fixed) return null
  const prev = RESULTS.get(id) || { attempts: 1 }
  RESULTS.set(id, Object.assign({}, prev, { work: fixed, attempts: (prev.attempts || 1) + 1 }))
  return fixed
}

// Revisão do design (§6): fase do motor, não nó do planner, para que nada a esqueça e para que ela
// veja todos os designs de uma vez. Reprovada ao fim = a implementação não começa.
async function runDesignReview() {
  let pass = false
  let attempt = 0
  let prevCount = Infinity
  let lastVerdict = { blocking: [] }
  while (true) {
    attempt++
    const v = await run(designReviewPrompt(attempt), { label: 'design-review:r' + attempt, phase: 'Design review', schema: DESIGN_REVIEW, effort: 'high' }, attempt === 1)
    if (attempt === 1) MANDATORY.designReview = false
    if (!v) {
      log('revisão do design sem retorno: tratada como reprovada')
      lastVerdict = { blocking: [] }
      break
    }
    const norm = Object.assign({}, v, { blocking: v.blocking || [], pass: !!v.pass && !(v.blocking || []).length })
    lastVerdict = norm
    if (norm.pass) { pass = true; break }
    if (attempt > C.maxRepairs) break
    if (norm.blocking.length >= prevCount) { log('revisão do design: reparo sem progresso, parou'); break }
    prevCount = norm.blocking.length
    const targets = [...new Set(norm.blocking.map((b) => b.node))].filter((id) => { const nd = NODES.get(id); return nd && nd.kind === 'design' })
    if (!targets.length) { log('revisão do design: bloqueio sem nó de design apontado'); break }
    if (!canSpend(targets.length + 1)) { log('revisão do design: sem orçamento para reparo + nova revisão'); break }
    await parallel(targets.map((id) => () => repairDesign(id, { blocking: norm.blocking.filter((b) => b.node === id) })))
  }
  if (pass) log(`revisão do design aprovada (r${attempt})`)
  else log(`revisão do design reprovada após ${Math.max(0, attempt - 1)} reparo(s): implementação não começa`)
  return { pass, attempts: attempt, blocking: lastVerdict.blocking }
}

function areasForPolish() {
  if (RMODE !== 'implement') return []
  // Numa retomada, o nó pronto (resumed:true) não rodou nesta execução: os polidores olham só as
  // áreas de quem de fato rodou agora (C7, "Os polidores só olham as áreas das implementações que
  // rodaram nesta execução").
  const implDone = first.filter((n) => n.kind === 'implement' && (RESULTS.get(n.id) || {}).status === 'done' && !(RESULTS.get(n.id) || {}).resumed).map((n) => n.id)
  if (!implDone.length) return []
  const fileSets = new Map()
  for (const id of implDone) {
    const n = NODES.get(id)
    const r = RESULTS.get(id)
    fileSets.set(id, new Set([...(n.files || []), ...((r.work && r.work.filesChanged) || [])].map(normPath)))
  }
  const parent = new Map(implDone.map((id) => [id, id]))
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x }
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  for (let i = 0; i < implDone.length; i++) {
    for (let j = i + 1; j < implDone.length; j++) {
      const a = implDone[i]; const b = implDone[j]
      let over = false
      for (const x of fileSets.get(a)) { for (const y of fileSets.get(b)) { if (overlaps(stem(x), stem(y))) { over = true; break } } if (over) break }
      if (over) union(a, b)
    }
  }
  const groups = new Map()
  for (const id of implDone) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(id)
  }
  const groupList = [...groups.values()].map((ids) => ({ ids, files: [...new Set(ids.flatMap((id) => [...fileSets.get(id)]))] }))
  groupList.sort((a, b) => b.files.length - a.files.length || (a.ids[0] < b.ids[0] ? -1 : 1))
  let k = Math.max(1, Math.ceil((2 * implDone.length) / 3))
  if (k > groupList.length) {
    log(`síntese: k reduzido a ${groupList.length} (áreas disjuntas)`)
    k = groupList.length
  }
  const buckets = Array.from({ length: k }, () => ({ ids: [], files: [] }))
  for (const g of groupList) {
    buckets.sort((a, b) => a.files.length - b.files.length)
    buckets[0].ids.push(...g.ids)
    buckets[0].files.push(...g.files)
  }
  return buckets.filter((b) => b.files.length)
}

async function runPolish() {
  const areas = areasForPolish()
  if (!areas.length) return []
  const results = await parallel(areas.map((area, i) => () => run(SHARED + PLAN_BLOCK + `
## Role: polisher (area ${i + 1}/${areas.length})
Area (only these files): ${area.files.join(', ')}. Before editing, copy each of these files as-is into ${RUN_DIR}/polish-${i + 1}/ (same relative path), as your backup. Fix small quality problems (naming, dead code, comments, duplication, conventions) WITHOUT changing behavior or public contracts. ${CHECKS.length ? `Run: ${CHECKS.join(' | ')}. ` : ''}If any check fails after your edit, restore each file from your backup in ${RUN_DIR}/polish-${i + 1}/ and report it. Nothing in this run is committed, so the files in your area also hold the uncommitted work of the implement nodes: never undo via git (its checkout, restore, stash or reset commands), which would discard that work along with your edit. Do not touch files outside the area. Do not commit.
Return status, summary, filesChanged, checks, confidence.`,
    { label: 'polish:' + (i + 1), phase: 'Synthesize', schema: WORK, model: MDL.worker || undefined, effort: REASON_EFFORT })))
  return results.filter(Boolean).map((w, i) => ({ k: i + 1, files: w.filesChanged || [], status: w.status, summary: w.summary }))
}

// ── Resume (validação sem gastar agente, C7) ──
// A retomada exige o plano pronto (senão o planner rodaria de novo, gastando um agente à toa) e não
// combina com planOnly (que só devolve o plano, sem executar nada). O id vem pronto do CLI (o motor
// não tem Date.now), então só confere a forma.
const RESUME = A.resume && typeof A.resume === 'object' ? A.resume : null
const RESUME_ID_RE = /^rs-\d{8}-\d{6}(-\d+)?$/
if (RESUME) {
  if (!(A.plan && Array.isArray(A.plan.nodes))) return { error: 'resume exige args.plan (o motor não replaneja numa retomada)', runDir: RUN_DIR }
  if (A.planOnly) return { error: 'resume não combina com planOnly', runDir: RUN_DIR }
  if (!RESUME_ID_RE.test(String(RESUME.id || ''))) return { error: `resume.id inválido: ${RESUME.id}`, runDir: RUN_DIR }
}

// ── Plan ──
phase('Plan')
let plan = A.plan && Array.isArray(A.plan.nodes) ? A.plan : null
if (!plan) {
  const T = LEVEL0 ? targetFor(LEVEL0, CEILING, MODE) : null
  const table = targetTable(CEILING, MODE)
  plan = await run(SHARED + `
## Role: planner (graph designer)
Design the graph of jobs for the agent target below. Every extra node costs tokens and adds noise; add one only for independent work that can run in parallel, or for a genuinely different skill.
1. Read just enough (repo files, docs) to understand the task.
2. Memory: if ${RUNS_ROOT}/INDEX.md exists, skim it and open at most 2 relevant past REPORT.md files; reuse their decisions.
3. goal = the final deliverable in one sentence. ${FIXED_DONE.length
    ? `doneWhen is fixed by the user; return it verbatim:\n${bullets(FIXED_DONE)}`
    : `doneWhen = 2-5 checkable criteria for the whole task${CHECKS.length ? ` (checks available: ${CHECKS.join(' | ')})` : ''}.`}
4. Ambiguity about BEHAVIOR or OUTCOME (never about code details you can read): record the most reasonable choice in assumptions${A.planOnly ? ', and put up to 3 questions whose answer would change the result in questions' : ''}.
5. Size to the agent target. Ceiling ${CEILING}. ${LEVEL0
    ? `Effort is fixed: ${LEVEL0} -> target ${T}, width ${sizing(T, MODE).width}, max ${sizing(T, MODE).maxNodes} nodes.`
    : `Effort is auto: pick low|medium|high|max by the task's complexity and say why in effort.why. Targets: low ${table.low} (≤${sizing(table.low, MODE).maxNodes} nodes), medium ${table.medium} (≤${sizing(table.medium, MODE).maxNodes}), high ${table.high} (≤${sizing(table.high, MODE).maxNodes}), max ${table.max} (≤${sizing(table.max, MODE).maxNodes}).`}
   Cost per node on the happy path: implement 2 (work+verify) + ~0.7 polish; research/design 1 (2 at high/max).
   Fixed: plan, design review (implement/architecture), critic, synth. Complex task (feature, multi-part bug): 3-5 research and 3-5 design nodes in parallel when the target allows. Simple task: stay near the floor. max: use the ceiling.
6. Skeleton (the engine enforces it with deterministic rails; do not add a design-review, critic or synth node yourself):
   ${MODE_HINT[MODE]} Research comes first: code, repo docs and the external docs of the libraries involved, at the installed version.
   - kind research|design|implement.
   - brief = the end state + expected output + where to look + what not to touch. Describe the outcome, not the steps: the node owns the how.
   - deps only where a node truly consumes another's output (no fake waiting). Inherently sequential work is a short chain, not a fan-out.
   - Reads parallelize, writes do not: implement nodes run one at a time unless their files are disjoint. List their exact files, and when several must agree on a contract (types, API, schema), make them depend on one design node that fixes it.
   - External knowledge: when the task integrates or upgrades an external API, SDK, library or service the repo does not already use the same way, add one research node for its current docs (installed version, auth, limits, errors, breaking changes), risk medium, and make every node that uses it depend on it. Memory of an API is not evidence.
   - risk: high = security, auth, money, data/migrations, public API, prod config; low = read-only work with little downside; else medium.
   - acceptance = concrete, verifiable checks for that node.
7. effort.level/why: with effort fixed, repeat the given level and why:"fixed by user". With mode auto, also set plan.mode.
8. Write ${RUN_DIR}/plan.md: goal, doneWhen, assumptions, node table and a mermaid graph.
Return structured output only.`, { label: 'plan', phase: 'Plan', schema: PLAN, effort: 'high' }, true)
  if (!plan) return { error: 'o planner falhou', runDir: RUN_DIR, stats }
}

const DONE_WHEN = FIXED_DONE.length ? FIXED_DONE : (plan.doneWhen || []).map(String)
const ASSUMPTIONS = (plan.assumptions || []).map(String)

// Resolução do modo e do esforço (§3.2): RMODE sobre o plano CRU, antes do normalize, porque o
// normalize converte implement->design de acordo com RMODE.
function resolveMode(rawPlan) {
  if (MODE !== 'auto') return MODE
  if (['implement', 'architecture', 'research', 'review'].includes(rawPlan.mode)) return rawPlan.mode
  const nodes = rawPlan.nodes || []
  if (nodes.some((n) => n.kind === 'implement')) return 'implement'
  if (nodes.some((n) => n.kind === 'design')) return 'architecture'
  return 'research'
}
RMODE = resolveMode(plan)
READ_ONLY = RMODE === 'research' || RMODE === 'review'
log(`modo: ${MODE} -> ${RMODE}` + (MODE === 'auto' ? ' (planner)' : ''))

const ceilCheck2 = validateCeiling(CEILING, RMODE)
if (!ceilCheck2.ok) return { error: `ceiling ${CEILING} fora de [${ceilCheck2.min}..100] para o modo ${RMODE}: ${ceilCheck2.error}`, runDir: RUN_DIR }

const EFFORTS_LEVEL = ['low', 'medium', 'high', 'max']
let LEVEL = LEVEL0 || (plan.effort && EFFORTS_LEVEL.includes(plan.effort.level) ? plan.effort.level : 'medium')
let LEVEL_WHY = (plan.effort && String(plan.effort.why || '')) || (LEVEL0 ? 'fixed by user' : 'fallback: plano sem effort')
let TARGET = 0
function applyLevel(level) {
  LEVEL = level
  TARGET = targetFor(LEVEL, CEILING, RMODE)
  const size = sizing(TARGET, RMODE)
  C.maxAgents = TARGET
  C.width = size.width
  C.maxNodes = size.maxNodes
}
applyLevel(LEVEL)
MANDATORY = { designReview: RMODE === 'implement' || RMODE === 'architecture', critic: true, synth: true }

let first = normalize(plan.nodes, '', 1, { rails: true })
// ── Resume: classifica pronto/refazer sobre o plano cru, ANTES do bump e do corte do maxNodes (C7) ──
// READY = done ∩ plano − RERUN (RERUN já é o fecho de descendentes, pelas deps NORMALIZADAS, quando
// dependents=true — os trilhos já rodaram em normalize() acima). Classifica primeiro para que o bump
// de esforço e o corte do maxNodes, logo abaixo, saibam quais nós já estão prontos: pronto nunca é
// cortado e não entra na conta do teto, que vale só para quem ainda vai rodar (C7 §"Trilho maxNodes
// na retomada").
const resumeReadyIds = new Set()
const resumeReadyData = new Map()
let resumeRerunIds = []
if (RESUME) {
  const idsAll = new Set(first.map((n) => n.id))
  const rerunRaw = Array.isArray(RESUME.rerun) ? [...new Set(RESUME.rerun.map(String))] : []
  const unknownRerun = rerunRaw.filter((id) => !idsAll.has(id))
  if (unknownRerun.length) return { error: `resume.rerun com nó desconhecido: ${unknownRerun.join(', ')}`, runDir: RUN_DIR }
  const childrenOf = new Map()
  for (const n of first) for (const d of n.deps) {
    if (!childrenOf.has(d)) childrenOf.set(d, [])
    childrenOf.get(d).push(n.id)
  }
  const rerunSet = new Set(rerunRaw)
  if (RESUME.dependents) {
    const stack = [...rerunRaw]
    while (stack.length) {
      const id = stack.pop()
      for (const c of (childrenOf.get(id) || [])) if (!rerunSet.has(c)) { rerunSet.add(c); stack.push(c) }
    }
  }
  resumeRerunIds = [...rerunSet]
  const doneMap = (RESUME.done && typeof RESUME.done === 'object') ? RESUME.done : {}
  for (const rawId of Object.keys(doneMap)) {
    const id = String(rawId)
    const d = doneMap[rawId] || {}
    if (!idsAll.has(id)) { log(`resume: done.${id} desconhecido, nó não existe no plano, ignorado`); continue }
    if (rerunSet.has(id)) continue // no fecho de refazer: roda de novo
    const art = d.artifact ? normPath(String(d.artifact)) : ''
    if (art && (art.includes('..') || !(art === RUN_DIR || art.startsWith(RUN_DIR + '/')))) {
      log(`resume: done.${id} com artifact fora do run dir (${d.artifact}), ignorado; nó roda`)
      continue
    }
    resumeReadyIds.add(id)
    resumeReadyData.set(id, d)
  }
}

// No automático, o tamanho do grafo é decisão do planner: se o plano não cabe no nível que ele
// mesmo escolheu, o nível sobe até caber (nunca acima do teto), em vez de cortar entrega. O corte
// abaixo fica para o nível fixado pelo usuário, ou para quando nem o max comporta o plano. Na
// retomada, conta só quem vai rodar, pela mesma razão do corte.
const toRun = first.length - resumeReadyIds.size
if (!LEVEL0 && toRun > C.maxNodes) {
  const from = LEVEL
  const fromMax = C.maxNodes
  const higher = EFFORTS_LEVEL.slice(EFFORTS_LEVEL.indexOf(from) + 1)
  const to = higher.find((l) => sizing(targetFor(l, CEILING, RMODE), RMODE).maxNodes >= toRun) || 'max'
  if (to !== from) {
    applyLevel(to)
    const readyNote = resumeReadyIds.size ? ` para rodar (+ ${resumeReadyIds.size} pronto(s) da retomada)` : ''
    const detail = `esforço subiu de ${from} para ${to}: o plano tem ${toRun} nó(s)${readyNote} e ${from} comporta ${fromMax}`
    LEVEL_WHY += ` (${detail})`
    railLog('effort', 'plan', 'bump', detail)
  }
}

{
  const capped = applyMaxNodes(first, C.maxNodes, RMODE, resumeReadyIds)
  if (capped.cut.length) {
    railLog('maxNodes', capped.cut.join(','), 'cut', `plano tinha ${first.length} nó(s), cortado(s) ${capped.cut.join(', ')} para caber no teto de ${C.maxNodes} nós do nível ${LEVEL}` + (capped.floorNote ? ` (${capped.floorNote})` : ''))
    first = capped.nodes
    applyRails(first) // design sem pesquisa e implementação sem design recuperam as deps após o corte
  }
}
first.forEach((n) => NODES.set(n.id, n))
// Um refazer cortado pelo teto não roda, então não aparece na linha Resume: nem no resumeInfo.
resumeRerunIds = resumeRerunIds.filter((id) => NODES.has(id))

// ── Resume: aplica a classificação acima (C7) ──
// Cada pronto vai direto para RESULTS com resumed:true, sem gastar agente; nenhum nó fora da lista é
// tocado aqui. resumeReadyIds nunca foi cortado pelo maxNodes (protegido acima), então todo id aqui
// ainda existe em NODES.
let resumeInfo = null
if (RESUME) {
  for (const id of resumeReadyIds) {
    const d = resumeReadyData.get(id) || {}
    const art = d.artifact ? normPath(String(d.artifact)) : ''
    RESULTS.set(id, {
      status: 'done',
      work: {
        status: 'done',
        summary: String(d.summary || ''),
        artifact: art || undefined,
        filesChanged: Array.isArray(d.filesChanged) ? d.filesChanged.map(String) : undefined,
        confidence: 'high',
      },
      verified: !!d.verified,
      attempts: Number.isFinite(d.attempts) && d.attempts > 0 ? Math.floor(d.attempts) : 1,
      resumed: true,
    })
  }
  const readyIds = [...resumeReadyIds]
  RESUME_LINE = `Resume: ${RESUME.id}` + (resumeRerunIds.length ? ` · refazer: ${resumeRerunIds.join(',')}` : '')
  SHARED = buildShared()
  resumeInfo = { id: RESUME.id, ready: readyIds, rerun: resumeRerunIds, ran: [], designReviewSkipped: false }
  log(`resume ${RESUME.id}: ${readyIds.length} nó(s) pronto(s) (${readyIds.join(', ') || '(nenhum)'}), refazer ${resumeRerunIds.length ? resumeRerunIds.join(', ') : '(nenhum)'}`)
}

PLAN_BLOCK = `Goal: ${plan.goal}\n` +
  (ASSUMPTIONS.length ? `Assumptions (treat as decided): ${ASSUMPTIONS.join(' | ')}\n` : '') +
  `Sizing: effort ${LEVEL} (${EFFORT_SOURCE}) -> target ${TARGET} of ceiling ${CEILING}, width ${C.width}, max nodes ${C.maxNodes}; mode ${RMODE}\n` +
  `Graph: ${first.map((n) => `${n.id} "${n.title}" (${n.kind})${n.deps.length ? ' <- ' + n.deps.join(',') : ''}`).join(' | ')}\n`

// C7: a estimativa do log conta só quem vai rodar nesta execução — pronto da retomada não gasta
// agente, então não entra no "~N agentes no caminho feliz".
const estimateNodes = resumeReadyIds.size ? first.filter((n) => !resumeReadyIds.has(n.id)) : first
const estimate = estimateAgents(estimateNodes, { mode: RMODE, level: LEVEL })

// Gate humano opcional antes de gastar: devolve plano, perguntas e estimativa; reinvoque com args.plan.
if (A.planOnly) {
  return {
    planOnly: true,
    runDir: RUN_DIR,
    mode: RMODE,
    plan: { goal: plan.goal, complexity: plan.complexity, mode: RMODE, effort: { level: LEVEL, why: LEVEL_WHY }, doneWhen: DONE_WHEN, assumptions: ASSUMPTIONS, nodes: first },
    questions: (plan.questions || []).map(String),
    effort: { requested: REQUESTED_EFFORT, source: EFFORT_SOURCE, level: LEVEL, why: LEVEL_WHY, ceiling: CEILING, target: TARGET, width: C.width, maxNodes: C.maxNodes, table: targetTable(CEILING, RMODE) },
    rails: RAILS,
    estimate: { happyPath: estimate, target: TARGET, ceiling: CEILING },
    graph: mermaid(),
    stats,
  }
}

log(`plano: ${first.length} nó(s), modo ${RMODE}, esforço ${LEVEL} (${EFFORT_SOURCE}), alvo ${TARGET}/${CEILING}: ~${estimate} agentes no caminho feliz (largura ${C.width}, máx. nós ${C.maxNodes})`)
log(graphText())

// ── Esqueleto: Research/Design -> Design review -> Execute -> Verify/Critic -> Synthesize ──
// Sem atalho trivial: todo modo roda as fases obrigatórias do seu esqueleto (D1 §4).
phase('Research')
const nonImpl1 = first.filter((n) => n.kind !== 'implement' && !RESULTS.has(n.id))
const impl1 = first.filter((n) => n.kind === 'implement' && !RESULTS.has(n.id))
await executeGraph(nonImpl1)

let designReview = null
// Retomada com revisão já aprovada, e nenhum nó de pesquisa/design do round 1 rodando agora: o
// veredito herdado vale, sem gastar agente de novo (C7, "Revisão do design").
const resumeReviewInherited = !!(RESUME && RESUME.designReview && RESUME.designReview.pass === true && nonImpl1.length === 0)
if (resumeReviewInherited) {
  designReview = { pass: true, attempts: Number.isFinite(RESUME.designReview.attempts) ? RESUME.designReview.attempts : 1, blocking: [] }
  MANDATORY.designReview = false
  if (resumeInfo) resumeInfo.designReviewSkipped = true
  log(`resume ${RESUME.id}: revisão do design herdada (aprovada), não roda de novo`)
} else if (MANDATORY.designReview || RMODE === 'implement' || RMODE === 'architecture') {
  phase('Design review')
  designReview = await runDesignReview()
  if (designReview.pass) {
    for (const n of NODES.values()) {
      if (n.round !== 1 || n.kind === 'implement') continue
      const r = RESULTS.get(n.id)
      if (r && r.status === 'done' && !r.verified) RESULTS.set(n.id, Object.assign({}, r, { verified: true, note: 'revisado na revisão do design' }))
    }
  } else {
    for (const n of impl1) {
      RESULTS.set(n.id, { status: 'skipped', note: 'revisão do design reprovada' })
      BLOCKED.add(n.id)
    }
    MANDATORY.critic = false
  }
}
const skipCritic = !!(designReview && !designReview.pass)

if (!skipCritic) {
  phase('Execute')
  await executeGraph(impl1)
}

// ── Loop: a crítica julga o todo; os gaps viram o próximo round ──
let batch = []
let lastCritic = null
let leftover = []
const seenGaps = new Set()
if (!skipCritic) {
  for (let round = 1; round <= C.maxRounds; round++) {
    if (round > 1) {
      phase('Execute')
      await executeGraph(batch)
    }
    if (!MANDATORY.critic && !canSpend(1)) {
      log('orçamento acabou antes do critic')
      break
    }
    phase('Critic')
    const reservedCritic = round === 1 && MANDATORY.critic
    lastCritic = await run(criticPrompt(round, seenGaps), { label: 'critic:r' + round, phase: 'Critic', schema: CRITIC, effort: 'high' }, reservedCritic)
    if (round === 1) MANDATORY.critic = false
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
    batch = normalize(fresh, `r${round + 1}-`, round + 1, { rails: false })
    batch.forEach((n) => NODES.set(n.id, n))
    log(`round ${round + 1}: ${batch.map((n) => n.id).join(', ')}`)
    log(graphText())
  }
} else {
  log('revisão do design reprovada: crítica e polidores não rodam')
}

const nodesOut = () => [...NODES.values()].map((n) => {
  const r = RESULTS.get(n.id) || {}
  return Object.assign({
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
    resumed: !!r.resumed,
  }, n.injected === true ? { injected: true, reason: n.reason } : {})
})

// ── Synthesize ──
phase('Synthesize')
const polish = skipCritic ? [] : await runPolish()
const graph = mermaid()
const statLine = () => Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(', ')
const polishSummary = polish.length ? polish.map((p) => `- polish:${p.k} (${p.status}): ${p.summary} [${(p.files || []).join(', ')}]`).join('\n') : '(nenhum)'
const railsSummary = RAILS.length ? RAILS.map((r) => `- ${r.rule} ${r.node}: ${r.detail}`).join('\n') : '(nenhum)'
const manualNote = EFFORT_SOURCE === 'manual-fallback' ? '\nEsforço manual sem humano para responder: o Claude decidiu sozinho.\n' : ''
const reviewBlockSection = skipCritic
  ? `## Bloqueio da revisão do design\n${(designReview.blocking || []).map((b) => `- [${b.node}] ${b.issue} -> ${b.fix}`).join('\n') || '(sem detalhe)'}\n`
  : ''
const synth = await run(SHARED + PLAN_BLOCK + `
## Role: synthesizer
Done when:
${bullets(DONE_WHEN)}
## Node results
${nodeTable()}
${reviewBlockSection}## Polish
${polishSummary}
## Rails
${railsSummary}
## Sizing
effort ${LEVEL} (source ${EFFORT_SOURCE}): ${LEVEL_WHY} · target ${TARGET} / ceiling ${CEILING}
${manualNote}## Final critic
${lastCritic ? (lastCritic.done ? 'DONE: ' : 'NOT DONE: ') + lastCritic.assessment : (skipCritic ? 'crítica não rodou (revisão do design reprovada)' : 'critic did not run')}
${leftover.length ? 'Open gaps left for the human:\n' + bullets(leftover.map((g) => `${g.title}: ${g.brief}`)) + '\n' : ''}${dropped.length ? `Skipped for budget: ${dropped.join(', ')}\n` : ''}
1. Write ${RUN_DIR}/REPORT.md in Portuguese (pt-BR), opening node artifacts only as needed. Sections: Resultado (status + 3-5 lines) | O que mudou / achados (file:line) | Decisões e trade-offs | Premissas assumidas (the plan's assumptions and the Rails above, for the user to confirm) | Riscos e pendências | Gate humano (what needs the user's approval before commit, deploy, migration or publishing, including any assumption that changes behavior) | Próximos passos | Grafo executado (paste this block verbatim):
\`\`\`mermaid
${graph}
\`\`\`
   | Custo: ${spent + 1} agentes (${statLine()}, synth 1).
2. Append one row to ${RUNS_ROOT}/INDEX.md (create it with the header "| run | tarefa | status | relatório |" if missing): | ${RUN_ID} | <task in <=12 words> | <status> | ${RUN_DIR}/REPORT.md |
Return structured output in pt-BR.`, { label: 'synth', phase: 'Synthesize', schema: SYNTH, model: MDL.synth || undefined, effort: 'medium' }, true)

const finalNodes = nodesOut()
// Nó implement 'partial' (done sem verify por falta de orçamento) rebaixa o status final: a run
// não pode fechar 'done' com uma implementação sem verificação cruzada (§6).
const hasUnverifiedImpl = finalNodes.some((n) => n.kind === 'implement' && n.status === 'partial')
if (resumeInfo) resumeInfo.ran = finalNodes.filter((n) => !n.resumed && n.status !== 'not run').map((n) => n.id)

return {
  task: TASK,
  mode: RMODE,
  economy: ECONOMY,
  runDir: RUN_DIR,
  report: `${RUN_DIR}/REPORT.md`,
  status: skipCritic ? 'blocked' : (hasUnverifiedImpl ? 'partial' : (synth ? synth.status : 'partial')),
  summary: synth ? synth.summary : null,
  humanGate: synth ? synth.humanGate : [],
  decisions: synth ? synth.decisions : [],
  changes: synth ? synth.changes : [],
  risks: synth ? synth.risks : [],
  nextSteps: synth ? synth.nextSteps : [],
  assumptions: ASSUMPTIONS,
  openGaps: leftover.map((g) => g.title),
  critic: lastCritic ? { done: lastCritic.done, assessment: lastCritic.assessment, criteria: lastCritic.criteria } : null,
  effort: { requested: REQUESTED_EFFORT, source: EFFORT_SOURCE, level: LEVEL, why: LEVEL_WHY, target: TARGET, ceiling: CEILING },
  rails: RAILS,
  designReview: designReview ? { pass: designReview.pass, attempts: designReview.attempts, blocking: designReview.blocking } : null,
  polish,
  nodes: finalNodes,
  graph,
  resume: resumeInfo,
  stats: Object.assign({ agents: spent, dropped }, stats),
}
