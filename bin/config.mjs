// Config do graph-eng em ~/.claude/graph-eng/config.json: leitura tolerante, validação campo a campo,
// precedência flag > arquivo > padrão e gravação atômica (tmp + rename). Node puro, sem dependências.
// Quem usa: o CLI bin/graph-config.mjs (a skill o roda antes de disparar o Workflow, que não tem acesso a
// disco) e o painel (GET/PUT /api/config em bin/ui-server.mjs). A fórmula de alvos não é copiada aqui: vem
// de bin/ui/agent-target.mjs. Contrato: .graph-runs/20260928-0213-fases-esforco-teto/D2.md §2-§5.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULTS, EFFORTS_GRAPH, CEILING_MAX, floorOf, validateCeiling, targetTable, targetRange } from './ui/agent-target.mjs'

export const CONFIG_KEYS = ['effort', 'ceiling', 'economy', 'planGate', 'maxRounds', 'maxRepairs'] // ordem de gravação
export const ECONOMIES = ['lean', 'balanced', 'max']
export const MAX_BODY = 4096
export const LIMITS = {
  ceiling: { min: floorOf(), max: CEILING_MAX },
  maxRounds: { min: 1, max: 5 },
  maxRepairs: { min: 1, max: 3 },
  effort: EFFORTS_GRAPH,
  economy: ECONOMIES,
}

export function defaultConfigPath(env = process.env, home = os.homedir()) {
  return env.GRAPH_ENG_CONFIG || path.join(home, '.claude', 'graph-eng', 'config.json')
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function intIn(v, { min, max }) {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

// Uma mensagem por campo (pt-BR, mostrada como vem no modal e no CLI), ou null se o valor vale.
const CHECK = {
  effort: (v) => (EFFORTS_GRAPH.includes(v) ? null : 'use manual, auto, low, medium, high ou max'),
  ceiling: (v, mode) => {
    // sem coerção: "24" (string) e true não passam, ao contrário do validateCeiling, que aceita string
    if (typeof v !== 'number' || !Number.isInteger(v)) return 'use um número inteiro'
    const r = validateCeiling(v, mode)
    return r.ok ? null : r.error
  },
  economy: (v) => (ECONOMIES.includes(v) ? null : 'use lean, balanced ou max'),
  planGate: (v) => (typeof v === 'boolean' ? null : 'use true ou false'),
  maxRounds: (v) => (intIn(v, LIMITS.maxRounds) ? null : 'de 1 a 5'),
  maxRepairs: (v) => (intIn(v, LIMITS.maxRepairs) ? null : 'de 1 a 3'),
}

// Estrita. `mode` só muda o piso do teto (ausente ou 'auto' → 8, o maior; a config vale para todo modo).
// → { ok, value: { chaves válidas, na ordem de CONFIG_KEYS }, errors: { [campo]: mensagem } }
export function validateConfig(obj, { mode } = {}) {
  if (!isPlainObject(obj)) return { ok: false, value: {}, errors: { config: 'o corpo deve ser um objeto' } }
  // pares [campo, mensagem] + Object.fromEntries: uma chave "__proto__" vinda do JSON vira propriedade
  // própria do objeto de erros, em vez de trocar o protótipo dele
  const errs = []
  for (const k of Object.keys(obj)) {
    if (!Object.hasOwn(CHECK, k)) errs.push([k, 'campo desconhecido'])
  }
  const value = {}
  for (const k of CONFIG_KEYS) {
    if (!Object.hasOwn(obj, k) || obj[k] === undefined) continue
    const e = CHECK[k](obj[k], mode)
    if (e) errs.push([k, e])
    else value[k] = obj[k]
  }
  return { ok: errs.length === 0, value, errors: Object.fromEntries(errs) }
}

// Nunca lança por conteúdo (arquivo editado à mão não derruba a skill nem o painel): o campo inválido fica
// fora de `stored` e vira aviso. Só erro de E/S que não seja ENOENT sobe.
export function readConfig(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { stored: {}, warnings: [] }
    throw e
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { stored: {}, warnings: [`config.json ilegível: ${e.message}; usando padrões`] }
  }
  if (!isPlainObject(parsed)) return { stored: {}, warnings: ['config.json ilegível: não é um objeto JSON; usando padrões'] }
  const { value, errors } = validateConfig(parsed)
  return { stored: value, warnings: Object.entries(errors).map(([k, msg]) => `${k}: ${msg} (ignorado)`) }
}

let seq = 0

// `value` já validado. Grava num tmp do mesmo diretório e renomeia por cima: quem lê vê o arquivo antigo
// ou o novo, nunca um pela metade; dois PUTs simultâneos → vence o último rename.
export function writeConfig(file, value) {
  const ordered = {}
  for (const k of CONFIG_KEYS) if (value[k] !== undefined) ordered[k] = value[k]
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${++seq}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(ordered, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* tmp nem chegou a existir */
    }
    throw e
  }
  return ordered
}

// Campo a campo: flag > arquivo > padrão. `flags` já validadas (o CLI chama validateConfig antes).
export function resolveConfig({ flags = {}, stored = {} } = {}) {
  const config = {}
  const source = {}
  for (const k of CONFIG_KEYS) {
    if (flags[k] !== undefined) [config[k], source[k]] = [flags[k], 'flag']
    else if (stored[k] !== undefined) [config[k], source[k]] = [stored[k], 'config']
    else [config[k], source[k]] = [DEFAULTS[k], 'default']
  }
  return { config, source, warnings: [] }
}

export function describeTargets(config, mode) {
  return {
    mode: mode || null,
    floor: floorOf(mode),
    targets: targetTable(config.ceiling, mode),
    range: targetRange(config.ceiling, mode),
    ask: config.effort === 'manual',
  }
}

// Caminho para mostrar ao usuário, com o home trocado por ~ (não expõe o nome do usuário no painel).
export function displayPath(file, home = os.homedir()) {
  const rel = path.relative(home, file)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join('~', rel) : file
}

// Corpo do GET /api/config e do PUT 200 (D2 §4.3). A tabela de alvos não vem daqui: o modal a calcula.
export function publicConfig(file, { home = os.homedir() } = {}) {
  const { stored, warnings } = readConfig(file)
  const { config, source } = resolveConfig({ stored })
  const defaults = {}
  for (const k of CONFIG_KEYS) defaults[k] = DEFAULTS[k]
  return { config, source, defaults, limits: LIMITS, file: displayPath(file, home), warnings }
}
