// Fórmula de esforço × teto → alvo de agentes. ESM puro, sem Node API, porque o painel serve este
// arquivo direto ao navegador (bin/ui-server.mjs) e o graph-watch e a config o importam. O motor do
// workflow (workflows/graph-eng.js) não pode importar nada, então mantém uma cópia inline idêntica,
// entre os marcadores "agent-target (espelho de bin/ui/agent-target.mjs)"; test/target.test.mjs prova
// que as duas tabelas são iguais. Ver .graph-runs/20260928-0213-fases-esforco-teto/D1.md §2.

export const EFFORT_PCT = { low: 20, medium: 40, high: 70, max: 100 }
export const MODE_FLOOR = { implement: 8, architecture: 6, research: 4, review: 4 }
export const MODE_FIXED = { implement: 4, architecture: 4, research: 3, review: 3 }
export const MODE_MINNODES = { implement: 3, architecture: 2, research: 1, review: 1 }
export const CEILING_MAX = 100
export const DEFAULTS = { effort: 'auto', ceiling: 24, economy: 'balanced', maxRounds: 3, maxRepairs: 2, planGate: false }
export const EFFORTS_GRAPH = ['manual', 'auto', 'low', 'medium', 'high', 'max']

// Maior piso dos modos conhecidos: conservador para 'auto' ou modo desconhecido (a config vale para
// todo modo, sem saber qual vai rodar).
export function floorOf(mode) {
  return MODE_FLOOR[mode] || 8
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

export function targetFor(level, ceiling, mode) {
  const pct = EFFORT_PCT[level] || EFFORT_PCT.medium
  const raw = Math.floor((pct * ceiling + 50) / 100) // arredondamento inteiro (evita 0.7*24 = 16.79999...)
  return Math.min(ceiling, Math.max(floorOf(mode), raw))
}

export function targetTable(ceiling, mode) {
  return {
    low: targetFor('low', ceiling, mode),
    medium: targetFor('medium', ceiling, mode),
    high: targetFor('high', ceiling, mode),
    max: targetFor('max', ceiling, mode),
  }
}

export function targetRange(ceiling, mode) {
  return { min: targetFor('low', ceiling, mode), max: targetFor('max', ceiling, mode) }
}

export function sizing(target, mode) {
  const fixed = MODE_FIXED[mode] || MODE_FIXED.implement
  const minNodes = MODE_MINNODES[mode] || MODE_MINNODES.implement
  return {
    width: clamp(Math.ceil(target / 6), 2, 8),
    maxNodes: clamp(Math.floor((target - fixed) / 2), minNodes, 24),
  }
}

export function validateCeiling(ceiling, mode) {
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

// Caminho feliz (sem reparo nem round extra), duplicada em workflows/graph-eng.js (D1 §9.1).
export function estimateAgents(nodes, { mode, level } = {}) {
  const list = nodes || []
  const implementCount = list.filter((n) => n.kind === 'implement').length
  let total = 1 // plano
  for (const n of list) {
    total += (n.explore ? 3 : 1) + ((n.kind === 'implement' || level === 'high' || level === 'max') ? 1 : 0)
  }
  if (mode === 'implement' || mode === 'architecture') total += 1 // revisão do design
  total += 1 // crítica r1
  if (mode === 'implement' && implementCount > 0) total += Math.max(1, Math.ceil((2 * implementCount) / 3)) // polidores
  total += 1 // consolidador
  return total
}
