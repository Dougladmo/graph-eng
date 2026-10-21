// Configuração pública do graph-eng: somente effort. Campos operacionais ficam no envelope privado.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const CONFIG_KEYS = ['effort']
export const LIMITS = { effort: ['low', 'medium', 'max'] }
export const DEFAULTS = { effort: 'medium' }
export const MAX_BODY = 4096
const OPERATIONAL_DEFAULTS = { stallMinutes: 5 }
const LEGACY_KEYS = new Set(['ceiling', 'economy', 'planGate', 'maxRounds', 'maxRepairs', 'width', 'models', 'model', 'targets', 'stallMinutes'])
const EFFORTS = LIMITS.effort

export function defaultConfigPath(env = process.env, home = os.homedir()) {
  return env.GRAPH_ENG_CONFIG || path.join(home, '.claude', 'graph-eng', 'config.json')
}

export function defaultStateDir(env = process.env, home = os.homedir()) {
  return env.GRAPH_ENG_STATE_DIR || path.dirname(defaultConfigPath(env, home))
}

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

export function validateConfig(obj) {
  if (!isPlainObject(obj)) return { ok: false, value: {}, errors: { config: 'o corpo deve ser um objeto' } }
  const errs = []
  for (const key of Object.keys(obj)) {
    if (key !== 'effort') errs.push([key, 'campo desconhecido'])
    else if (!EFFORTS.includes(obj[key])) errs.push([key, 'use low, medium ou max'])
  }
  const value = {}
  if (Object.hasOwn(obj, 'effort') && EFFORTS.includes(obj.effort)) value.effort = obj.effort
  return { ok: errs.length === 0, value, errors: Object.fromEntries(errs) }
}

function operationalFrom(obj) {
  const n = obj?.operational?.stallMinutes ?? obj?.stallMinutes
  return { stallMinutes: Number.isInteger(n) && n >= 1 && n <= 60 ? n : OPERATIONAL_DEFAULTS.stallMinutes }
}

// Leitura é tolerante e nunca grava. `raw` serve apenas para a gravação explícita fazer backup exato.
export function readConfig(file) {
  let raw
  try { raw = fs.readFileSync(file) } catch (error) {
    if (error?.code === 'ENOENT') return { stored: {}, operational: { ...OPERATIONAL_DEFAULTS }, warnings: [], raw: null, needsBackup: false }
    throw error
  }
  const text = raw.toString('utf8')
  let parsed
  try { parsed = JSON.parse(text) } catch (error) {
    return { stored: {}, operational: { ...OPERATIONAL_DEFAULTS }, warnings: [`config.json ilegível: ${error.message}; usando padrões`], raw, needsBackup: true }
  }
  if (!isPlainObject(parsed)) return { stored: {}, operational: { ...OPERATIONAL_DEFAULTS }, warnings: ['config.json ilegível: não é um objeto JSON; usando padrões'], raw, needsBackup: true }

  const isEnvelope = Object.hasOwn(parsed, 'schemaVersion') || Object.hasOwn(parsed, 'operational')
  if (isEnvelope && parsed.schemaVersion !== 2) {
    return { stored: {}, operational: { ...OPERATIONAL_DEFAULTS }, warnings: [`schemaVersion desconhecida (${JSON.stringify(parsed.schemaVersion)}); usando padrões`], raw, needsBackup: true }
  }
  const input = isEnvelope ? { effort: parsed.effort } : parsed
  const checked = validateConfig(input)
  const stored = checked.value
  const legacyEffort = parsed.effort !== undefined && !EFFORTS.includes(parsed.effort)
  const warnings = Object.entries(checked.errors)
    .filter(([key]) => !(key === 'effort' && legacyEffort) && key !== 'stallMinutes')
    .map(([key, message]) => `${key}: ${message} (ignorado)`)
  for (const key of Object.keys(parsed)) {
    if (key === 'stallMinutes') continue
    if (LEGACY_KEYS.has(key)) warnings.push(`${key}: opção legada ignorada`)
    else if (isEnvelope && !['schemaVersion', 'effort', 'operational'].includes(key) && key !== 'stallMinutes') warnings.push(`${key}: campo desconhecido (ignorado)`)
  }
  if (legacyEffort) {
    warnings.push(`effort: ${JSON.stringify(parsed.effort)} legado ou inválido; usando medium`)
    stored.effort = 'medium'
  }
  return { stored, operational: operationalFrom(parsed), warnings, raw, needsBackup: !isEnvelope }
}

let seq = 0
function backupOriginal(file, bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  const backup = `${file}.v1-backup-${digest}`
  try {
    fs.writeFileSync(backup, bytes, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new Error(`não consegui criar backup ${backup}: ${error.message}`)
    let existing
    try { existing = fs.readFileSync(backup) } catch (readError) { throw new Error(`não consegui conferir backup ${backup}: ${readError.message}`) }
    if (!existing.equals(bytes)) throw new Error(`colisão no backup ${backup}; arquivo original preservado`)
  }
  return backup
}

// Setter público estrito. Preserva operacional e migra bytes antigos somente na gravação explícita.
export function writeConfig(file, value) {
  const checked = validateConfig(value)
  if (!checked.ok) throw new TypeError(`configuração inválida: ${Object.entries(checked.errors).map(([k, v]) => `${k}: ${v}`).join('; ')}`)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const before = readConfig(file)
  const original = before.raw
  const operational = before.operational
  if (original && before.needsBackup) backupOriginal(file, original)
  const envelope = { schemaVersion: 2, effort: checked.value.effort ?? DEFAULTS.effort, operational }
  const tmp = `${file}.tmp-${process.pid}-${++seq}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    let current = null
    try { current = fs.readFileSync(file) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    if ((original === null && current !== null) || (original !== null && (!current || !current.equals(original)))) {
      throw new Error('config.json mudou durante a gravação; tente novamente')
    }
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* tmp pode não existir */ }
    throw error
  }
  return { effort: envelope.effort }
}

export function resolveConfig({ flags = {}, stored = {} } = {}) {
  const config = {}
  const source = {}
  for (const key of CONFIG_KEYS) {
    if (flags[key] !== undefined) [config[key], source[key]] = [flags[key], 'flag']
    else if (stored[key] !== undefined) [config[key], source[key]] = [stored[key], 'config']
    else [config[key], source[key]] = [DEFAULTS[key], 'default']
  }
  return { config, source, warnings: [] }
}

/** @deprecated Alvos saíram da configuração pública. */
export function describeTargets(_config, mode) {
  return { mode: mode || null, targets: null, range: null, ask: false }
}

export function displayPath(file, home = os.homedir()) {
  const rel = path.relative(home, file)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join('~', rel) : file
}

export function publicConfig(file, { home = os.homedir() } = {}) {
  const { stored, warnings } = readConfig(file)
  const { config, source } = resolveConfig({ stored })
  return { config, source, defaults: { ...DEFAULTS }, limits: { ...LIMITS }, file: displayPath(file, home), warnings }
}
