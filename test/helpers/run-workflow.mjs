// Harness de teste do workflow (D1 §12): o arquivo inteiro, sem `export const meta`, roda como
// AsyncFunction, com os globais que o host do Workflow injeta (args, agent, log, phase, parallel,
// budget). Exportado para test/target.test.mjs, test/workflow-rails.test.mjs e para o teste de
// paridade de I3 (graph-watch).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ENGINE_PATH = path.join(__dirname, '..', '..', 'workflows', 'graph-eng.js')

function loadSource() {
  const raw = fs.readFileSync(ENGINE_PATH, 'utf8')
  return raw.replace(/^export const meta = \{[\s\S]*?\n\}\n/, '')
}

// script(label, prompt, opts) => resultado estruturado (ou null, como agent() pode devolver).
export async function runWorkflow(args, script) {
  const src = loadSource()
  const calls = []
  const logs = []
  let live = 0
  let maxLive = 0
  const agent = async (prompt, opts) => {
    live++
    maxLive = Math.max(maxLive, live)
    calls.push(opts.label)
    try {
      await Promise.resolve()
      return await script(opts.label, prompt, opts)
    } finally {
      live--
    }
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const fn = new AsyncFunction('args', 'agent', 'log', 'phase', 'parallel', 'budget', src)
  const result = await fn(
    args,
    agent,
    (m) => logs.push(String(m)),
    (p) => calls.push('#' + p),
    (fns) => Promise.all(fns.map((f) => f())),
    { total: 0, remaining: () => Infinity },
  )
  return { result, calls, logs, maxLive }
}

// Stub padrão: responde por prefixo do rótulo, do jeito que a maioria dos testes precisa.
// `routes` pode sobrescrever por prefixo exato (ex.: 'design-review') com uma função (label, prompt) => valor,
// ou um valor fixo.
export function defaultScript(routes) {
  const R = routes || {}
  return async (label, prompt, opts) => {
    const prefix = label.split(':')[0]
    if (R[prefix]) {
      const v = typeof R[prefix] === 'function' ? R[prefix](label, prompt, opts) : R[prefix]
      return v
    }
    if (R[label]) return typeof R[label] === 'function' ? R[label](label, prompt, opts) : R[label]
    if (prefix === 'plan') return R.plan || { goal: 'g', complexity: 'moderate', doneWhen: ['ok'], nodes: [], effort: { level: 'medium', why: 'default' } }
    if (prefix === 'work' || prefix === 'repair' || prefix === 'design-repair' || prefix === 'polish' || prefix === 'draft-a' || prefix === 'draft-b' || prefix === 'judge') {
      return { status: 'done', summary: label + ' ok', confidence: 'high', checks: [] }
    }
    if (prefix === 'verify' || prefix === 'escalate') return { pass: true, confidence: 'high', blocking: [] }
    if (prefix === 'design-review') return { pass: true, confidence: 'high', blocking: [], checked: { assumptions: true, acceptance: true, stories: false, bestPractices: true } }
    if (prefix === 'critic') return { done: true, assessment: 'ok', gaps: [] }
    if (prefix === 'synth') return { status: 'done', summary: 'ok', humanGate: [] }
    return null
  }
}
