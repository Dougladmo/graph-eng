import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ENGINE_PATH = path.join(here, '..', 'workflows', 'graph-eng.js')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

export async function loadWorkflowSource(sourcePath = ENGINE_PATH) {
  const raw = await readFile(sourcePath, 'utf8')
  const prefix = 'export const meta ='
  if (!raw.startsWith(prefix)) return raw
  let i = prefix.length
  while (/\s/.test(raw[i] || '')) i++
  if (raw[i] !== '{') throw new SyntaxError('export const meta precisa iniciar com objeto literal')
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (; i < raw.length; i++) {
    const char = raw[i]
    const next = raw[i + 1]
    if (lineComment) { if (char === '\n') lineComment = false; continue }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; i++ } continue }
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') { lineComment = true; i++; continue }
    if (char === '/' && next === '*') { blockComment = true; i++; continue }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue }
    if (char === '{') depth++
    else if (char === '}' && --depth === 0) {
      let end = i + 1
      while (raw[end] === ' ' || raw[end] === '\t') end++
      if (raw[end] === ';') end++
      if (raw[end] === '\r') end++
      if (raw[end] === '\n') end++
      return raw.slice(end)
    }
  }
  throw new SyntaxError('export const meta não terminou com um objeto balanceado')
}

export async function compileWorkflow(sourcePath = ENGINE_PATH) {
  return new AsyncFunction('args', 'agent', 'log', 'phase', 'parallel', 'budget', 'runtime', await loadWorkflowSource(sourcePath))
}
