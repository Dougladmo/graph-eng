import { createHash } from 'node:crypto'
import { validRelativePath } from './node-check-policy.mjs'

export const BUDGET_POLICY_ID = 'graph-eng-budget-v2'
export const BUDGET_POLICY_VERSION = 1
export const BUDGET_ROLES = Object.freeze(['planner', 'planReviewer', 'designReviewer', 'critic', 'synth', 'executor', 'verifier'])
export const FIXED_BUDGET_LIMITS = Object.freeze({ planner: 5, planReviewer: 5, designReviewer: 5, critic: 5, synth: 3, executor: 0, verifier: 0 })
export const EFFORT_NODE_CAP = Object.freeze({ low: 3, medium: 6, max: 10 })

export function resolveBudgetMode(requestedMode, plan) {
  if (['research', 'architecture', 'implement', 'review'].includes(requestedMode)) return requestedMode
  if (['research', 'architecture', 'implement', 'review'].includes(plan?.mode)) return plan.mode
  if ((plan?.nodes || []).some(node => node.kind === 'implement')) return 'implement'
  if ((plan?.nodes || []).some(node => node.kind === 'design')) return 'architecture'
  return 'research'
}

const RESERVED_IDS = new Set(['research-base', 'design-base'])
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}` : JSON.stringify(value)
const stableHash = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
const normPath = value => String(value).replace(/^\.\//, '').trim()
const stem = value => String(value).split('*')[0].replace(/\/+$/, '')
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/')

function ancestorsOf(node, byId) {
  const seen = new Set()
  const stack = [...node.deps]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const parent = byId.get(id)
    if (parent) stack.push(...parent.deps)
  }
  return seen
}

// tier fast/standard (fluxo adaptativo): sem pesquisa nem design injetados; quem lê o repo é o planner e o decomposer.
function applyRails(nodes, mode, researchImported = false, tier = 'full') {
  const changes = []
  const note = (rule, node, action, detail) => changes.push({ rule, node, action, detail })
  const byId = new Map(nodes.map(node => [node.id, node]))
  const round = nodes.length ? nodes[0].round : 1
  const lean = tier === 'fast' || tier === 'standard'
  if (!researchImported && !lean && !nodes.some(node => node.kind === 'research')) {
    let base = byId.get('research-base')
    if (!base) {
      base = { id: 'research-base', kind: 'research', round, title: 'Pesquisa de base', brief: 'Levantar código, docs do repo e docs externas das bibliotecas envolvidas, na versão instalada, para a tarefa.', deps: [], files: [], risk: 'medium', acceptance: ['achados com evidência (file:line ou URL + versão)'], explore: false, injected: true, reason: 'plano sem pesquisa', inputs: [], outputs: [], inputsDeclared: true, outputsDeclared: true }
      nodes.push(base); byId.set(base.id, base)
      note('R1', base.id, 'inject', 'research-base injetado na raiz (plano sem pesquisa)')
    }
  }
  if ((mode === 'implement' || mode === 'architecture') && !lean && !nodes.some(node => node.kind === 'design')) {
    const researchIds = nodes.filter(node => node.kind === 'research').map(node => node.id)
    let base = byId.get('design-base')
    if (!base) {
      base = { id: 'design-base', kind: 'design', round, title: 'Design de base', brief: 'Registrar as decisões e contratos mínimos para a implementação, a partir da pesquisa.', deps: [...researchIds], files: [], risk: 'medium', acceptance: ['decisão + contratos + como verificar'], explore: false, injected: true, reason: 'plano sem design', inputs: [], outputs: [], inputsDeclared: true, outputsDeclared: true }
      nodes.push(base); byId.set(base.id, base)
      note('R3', base.id, 'inject', `design-base injetado, depende de ${researchIds.join(', ') || '(nada)'} (plano sem design)`)
    } else {
      const add = researchIds.filter(id => !base.deps.includes(id))
      if (add.length) { base.deps.push(...add); note('R3', base.id, 'add-dep', `design-base passou a depender de ${add.join(', ')}`) }
    }
  }
  for (const node of nodes) {
    if (node.kind !== 'research') continue
    const bad = node.deps.filter(id => { const parent = byId.get(id); return parent && parent.kind !== 'research' })
    if (bad.length) { node.deps = node.deps.filter(id => !bad.includes(id)); note('R5', node.id, 'drop-dep', `${node.id} deixou de depender de ${bad.join(', ')} (pesquisa não depende de design/implementação)`) }
  }
  for (const node of nodes) {
    if (node.kind !== 'design') continue
    const bad = node.deps.filter(id => byId.get(id)?.kind === 'implement')
    if (bad.length) { node.deps = node.deps.filter(id => !bad.includes(id)); note('R6', node.id, 'drop-dep', `${node.id} deixou de depender de ${bad.join(', ')} (design roda antes da implementação)`) }
  }
  const researchIds = nodes.filter(node => node.kind === 'research').map(node => node.id)
  for (const node of nodes) {
    if (node.kind !== 'design') continue
    if (researchIds.some(id => ancestorsOf(node, byId).has(id))) continue
    const add = researchIds.filter(id => id !== node.id && !node.deps.includes(id))
    if (add.length) { node.deps.push(...add); note('R2', node.id, 'add-dep', `${node.id} passou a depender de ${add.join(', ')} (design sem pesquisa entre os ancestrais)`) }
  }
  const designIds = nodes.filter(node => node.kind === 'design').map(node => node.id)
  for (const node of nodes) {
    if (node.kind !== 'implement') continue
    if (designIds.some(id => ancestorsOf(node, byId).has(id))) continue
    const add = designIds.filter(id => id !== node.id && !node.deps.includes(id))
    if (add.length) { node.deps.push(...add); note('R4', node.id, 'add-dep', `${node.id} passou a depender de ${add.join(', ')} (implementação sem design entre os ancestrais)`) }
  }
  return changes
}

export function normalizeBudgetNodes({ list, prefix = '', round = 1, rails = false, fresh = false, mode, existingIds = [], researchImported = false, tier = 'full' } = {}) {
  if (!Array.isArray(list) || !['research', 'architecture', 'implement', 'review'].includes(mode) || !Number.isSafeInteger(round) || round < 1 || typeof prefix !== 'string' || !Array.isArray(existingIds) || existingIds.some(id => typeof id !== 'string')) throw new TypeError('budget_policy_plan_input_invalid')
  const idMap = new Map()
  const existing = new Set(existingIds)
  const taken = fresh ? new Set() : new Set(existing)
  const nodes = []
  const notes = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('budget_policy_node_invalid')
    const rawId = String(raw.id || '')
    let id = prefix + (rawId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || `n${nodes.length + 1}`)
    if (prefix === '' && RESERVED_IDS.has(id) && raw.injected !== true) { id += '_'; notes.push(`${id}: id reservado usado pelo planner, renomeado`) }
    while (taken.has(id)) id += '_'
    taken.add(id)
    idMap.set(rawId, id)
    let kind = ['research', 'design', 'implement'].includes(raw.kind) ? raw.kind : 'research'
    const readOnly = mode === 'research' || mode === 'review'
    if (kind === 'implement' && readOnly) { kind = 'design'; notes.push(`${id}: modo read-only, implement virou design (proposta sem edição)`) }
    else if (kind === 'implement' && mode !== 'implement') { kind = 'design'; notes.push(`${id}: modo ${mode} sem implementação, implement virou design`) }
    nodes.push(Object.assign({
      id, kind, round, title: String(raw.title || id).slice(0, 80), brief: String(raw.brief || raw.title || ''),
      rawDeps: (raw.deps || []).map(String), files: (Array.isArray(raw.files) ? raw.files : []).map(normPath).filter(Boolean),
      inputs: (Array.isArray(raw.inputs) ? raw.inputs : []).map(normPath).filter(Boolean), outputs: (Array.isArray(raw.outputs) ? raw.outputs : []).map(normPath).filter(Boolean),
      inputsDeclared: Array.isArray(raw.inputs), outputsDeclared: Array.isArray(raw.outputs), interface: raw.interface ?? null,
      risk: ['low', 'medium', 'high'].includes(raw.risk) ? raw.risk : 'medium', acceptance: (raw.acceptance || []).map(String), explore: !!raw.explore && kind === 'design',
    }, raw.injected === true ? { injected: true, reason: String(raw.reason || '') } : {}))
  }
  for (const node of nodes) {
    node.deps = []
    for (const dep of node.rawDeps) {
      const mapped = idMap.get(dep) || (!fresh && existing.has(dep) ? dep : null)
      if (mapped && mapped !== node.id) node.deps.push(mapped)
      else notes.push(`${node.id}: dep desconhecida "${dep}" ignorada`)
    }
    delete node.rawDeps
  }
  const railChanges = rails ? applyRails(nodes, mode, researchImported === true, tier) : []
  for (const node of nodes) {
    node.files ??= []
    node.inputs ??= []
    node.outputs ??= []
    node.inputsDeclared ??= false
    node.outputsDeclared ??= false
  }
  return { nodes, railChanges, notes }
}

export function validateBudgetDag(nodes) {
  const problems = []
  if (!Array.isArray(nodes)) return ['nodes precisa ser uma lista']
  const ids = new Set()
  const normalizedIds = new Map()
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) { problems.push('nó inválido'); continue }
    if (typeof node.id !== 'string' || !node.id.trim()) { problems.push('id vazio ou inválido'); continue }
    if (ids.has(node.id)) problems.push(`id duplicado: ${node.id}`)
    ids.add(node.id)
    const normalized = node.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'n'
    if (normalizedIds.has(normalized)) problems.push(`ids colidem após normalização: ${normalizedIds.get(normalized)} e ${node.id}`)
    else normalizedIds.set(normalized, node.id)
  }
  // Manifestos são máquina: cada item é UM caminho relativo canônico. Prosa, faixa de linha
  // (":12"), vírgula, espaço, absoluto e ".." são rejeitados aqui, nunca normalizados.
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string') continue
    for (const field of ['files', 'inputs', 'outputs']) {
      if (!Array.isArray(node[field])) continue
      for (const value of node[field]) {
        if (!validRelativePath(value) || /[\s,]/.test(value) || /:\d/.test(value)) problems.push(`manifesto inválido em ${node.id}.${field}: "${String(value)}"`)
      }
    }
  }
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string') continue
    const deps = node.deps === undefined ? [] : node.deps
    if (!Array.isArray(deps)) { problems.push(`deps inválidas em ${node.id}`); continue }
    for (const dep of deps) {
      if (typeof dep !== 'string' || !ids.has(dep)) problems.push(`dependência desconhecida em ${node.id}: ${String(dep)}`)
      else if (dep === node.id) problems.push(`autorreferência: ${node.id}`)
    }
  }
  const byId = new Map(nodes.filter(node => node && typeof node.id === 'string').map(node => [node.id, node]))
  const state = new Map()
  function visit(id, trail) {
    if (state.get(id) === 2) return
    if (state.get(id) === 1) { problems.push(`ciclo: ${[...trail, id].join(' -> ')}`); return }
    state.set(id, 1)
    for (const dep of byId.get(id)?.deps || []) if (byId.has(dep)) visit(dep, [...trail, id])
    state.set(id, 2)
  }
  for (const id of byId.keys()) visit(id, [])
  return problems
}

export function areasForImplementIds(nodes, implementIds) {
  const fileSets = new Map()
  for (const id of implementIds) {
    const node = nodes.find(item => item.id === id)
    fileSets.set(id, new Set((node?.files || []).map(normPath)))
  }
  const parent = new Map(implementIds.map(id => [id, id]))
  const find = value => { while (parent.get(value) !== value) value = parent.get(value); return value }
  const union = (left, right) => { const a = find(left); const b = find(right); if (a !== b) parent.set(a, b) }
  for (let i = 0; i < implementIds.length; i++) for (let j = i + 1; j < implementIds.length; j++) {
    let overlapsFiles = false
    for (const a of fileSets.get(implementIds[i])) { for (const b of fileSets.get(implementIds[j])) { if (overlaps(stem(a), stem(b))) { overlapsFiles = true; break } } if (overlapsFiles) break }
    if (overlapsFiles) union(implementIds[i], implementIds[j])
  }
  const groups = new Map()
  for (const id of implementIds) { const root = find(id); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(id) }
  const groupList = [...groups.values()].map(ids => ({ ids, files: [...new Set(ids.flatMap(id => [...fileSets.get(id)]))] }))
  groupList.sort((a, b) => b.files.length - a.files.length || (a.ids[0] < b.ids[0] ? -1 : 1))
  let k = Math.max(1, Math.ceil((2 * implementIds.length) / 3))
  if (k > groupList.length) k = groupList.length
  const buckets = Array.from({ length: k }, () => ({ ids: [], files: [] }))
  for (const group of groupList) {
    buckets.sort((a, b) => a.files.length - b.files.length)
    buckets[0].ids.push(...group.ids); buckets[0].files.push(...group.files)
  }
  return buckets.filter(bucket => bucket.files.length)
}

export function polishAffectedClosure(nodes, area) {
  const affected = new Set(nodes.filter(node => [...(node.inputs || []), ...(node.outputs || [])].some(spec =>
    area.files.some(file => overlaps(stem(normPath(spec)), stem(normPath(file)))))).map(node => node.id))
  const stack = [...affected]
  while (stack.length) {
    const id = stack.pop()
    for (const child of nodes.filter(node => (node.deps || []).includes(id))) if (!affected.has(child.id)) { affected.add(child.id); stack.push(child.id) }
  }
  return nodes.filter(node => affected.has(node.id))
}

export function polishRevalidationBudget(nodes) {
  const implementIds = nodes.filter(node => node.kind === 'implement').map(node => node.id)
  const areas = areasForImplementIds(nodes, implementIds)
  return areas.reduce((total, area) => total + polishAffectedClosure(nodes, area).filter(node => node.kind === 'implement').length * 2, 0)
}

export function allocateBudget({ planVersion, reason, mode, effort, nodes, pendingNodeIds, localRepairsUsed, structuralReplansUsed, usedByRole, baseLimitsByRole, baseReservedByRole } = {}) {
  if (!Number.isSafeInteger(planVersion) || planVersion < 1 || !['initial', 'approved-replan'].includes(reason) || !['research', 'architecture', 'implement', 'review'].includes(mode) || !Object.hasOwn(EFFORT_NODE_CAP, effort) || !Array.isArray(nodes) || !Array.isArray(pendingNodeIds) || !Number.isSafeInteger(localRepairsUsed) || localRepairsUsed < 0 || localRepairsUsed > 2 || !Number.isSafeInteger(structuralReplansUsed) || structuralReplansUsed < 0 || structuralReplansUsed > 2) throw new TypeError('budget_allocation_input_invalid')
  const exactRoles = value => value && typeof value === 'object' && !Array.isArray(value) && canonicalJson(Object.keys(value).sort()) === canonicalJson([...BUDGET_ROLES].sort()) && BUDGET_ROLES.every(role => Number.isSafeInteger(value[role]) && value[role] >= 0)
  if (!exactRoles(usedByRole) || !exactRoles(baseLimitsByRole) || !exactRoles(baseReservedByRole)) throw new TypeError('budget_allocation_ledger_invalid')
  const nodeIds = nodes.map(node => node.id)
  const expectedPending = nodeIds.filter(id => pendingNodeIds.includes(id))
  if (canonicalJson(pendingNodeIds) !== canonicalJson(expectedPending) || new Set(nodeIds).size !== nodeIds.length || new Set(pendingNodeIds).size !== pendingNodeIds.length) throw new TypeError('budget_allocation_pending_nodes_invalid')
  if (baseLimitsByRole.planner !== 5 || baseLimitsByRole.planReviewer !== 5 || baseLimitsByRole.designReviewer !== 5 || baseLimitsByRole.critic !== 5 || baseLimitsByRole.synth !== 3) throw new TypeError('budget_allocation_fixed_limits_invalid')
  const impl = nodes.filter(node => node.kind === 'implement')
  const pending = nodes.filter(node => pendingNodeIds.includes(node.id))
  const pendingImpl = pending.filter(node => node.kind === 'implement')
  const polishCalls = mode === 'implement' && pendingImpl.length ? Math.max(1, Math.ceil((2 * pendingImpl.length) / 3)) : 0
  const executorBase = pending.reduce((sum, node) => sum + (node.explore ? 3 : 1), 0) + polishCalls
  // Pool da run (plano, pesquisa, design) + um reparo próprio por nó de código pendente.
  const repairAllowance = 2 - localRepairsUsed + pendingImpl.length
  const executorRequired = executorBase + repairAllowance
  const deferVerify = node => node.kind !== 'implement' && node.round === 1 && (effort === 'low' || effort === 'medium')
  const verifiedNodes = pending.filter(node => !deferVerify(node))
  const verifierBase = verifiedNodes.length * 2 + (mode === 'implement' ? polishRevalidationBudget(nodes) : 0)
  const verifierRequired = verifierBase + repairAllowance * 2
  const limitsByRole = { ...baseLimitsByRole,
    executor: Math.max(baseLimitsByRole.executor, usedByRole.executor + executorRequired),
    verifier: Math.max(baseLimitsByRole.verifier, usedByRole.verifier + verifierRequired),
  }
  const reservedByRole = { ...baseReservedByRole,
    executor: Math.min(executorRequired, Math.max(0, limitsByRole.executor - usedByRole.executor)),
    verifier: Math.min(verifierRequired, Math.max(0, limitsByRole.verifier - usedByRole.verifier)),
  }
  if (reason === 'initial' && mode !== 'implement' && mode !== 'architecture') reservedByRole.designReviewer = 0
  for (const role of BUDGET_ROLES) if (usedByRole[role] > limitsByRole[role] || reservedByRole[role] > limitsByRole[role] - usedByRole[role]) throw new TypeError(`budget_allocation_balance_invalid:${role}`)
  const effectivePlanHash = stableHash(nodes)
  const allocation = {
    schemaVersion: BUDGET_POLICY_VERSION, policyId: BUDGET_POLICY_ID, planVersion, reason, mode, effort,
    pendingNodeIds: [...pendingNodeIds], counters: { localRepairsUsed, structuralReplansUsed },
    baseUsedByRole: { ...usedByRole }, baseLimitsByRole: { ...baseLimitsByRole }, baseReservedByRole: { ...baseReservedByRole },
    effectivePlanHash,
    demand: { executor: executorRequired, verifier: verifierRequired },
    limitsByRole: { ...limitsByRole }, reservedByRole: { ...reservedByRole },
  }
  return { allocation, limitsByRole, reservedByRole }
}

export function sameBudgetValue(a, b) { return canonicalJson(a) === canonicalJson(b) }
