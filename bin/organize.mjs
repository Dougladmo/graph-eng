// Organização da lista lateral do painel (fixadas, grupos, arquivadas, apagadas) em
// <stateDir>/organize.json, ao lado da config, e a contenção do "apagar run". Node puro, sem dependências.
// Contrato: docs/specs/2026-09-28-acoes-no-painel.md C1, C10 (O1-O9, resolveRunDir, RUN_ID_RE) e C11,
// com o detalhe em .graph-runs/20260928-1146-acoes-no-painel/D4.md §3.
//
// Quem usa: bin/ui-server.mjs (rotas POST /api/org/* e o agrupamento do GET /api/runs); o I5 reaproveita
// `resolveRunDir` para ler artefatos e o I8 usa `RUN_ID_RE` no CLI de retomada.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isPlainObject } from './config.mjs'

// Formato do runId da skill (`$(date +%Y%m%d-%H%M)-<slug>`, skills/graph-eng/SKILL.md). É a regex única da
// chave da run, da contenção do apagar e do CLI de retomada: um runId fora dela não tem pasta de
// artefatos, retomada nem herança de organização.
export const RUN_ID_RE = /^\d{8}-\d{4}-[a-z0-9][a-z0-9-]{0,63}$/
export const GROUP_RE = /^g-[a-f0-9]{8}$/
export const ORG_LIMITS = { pinned: 100, groups: 20, groupName: 40, deleteFinished: 50 }
export const ORG_VERSION = 1

// Mesma regex do `WF_RE` de bin/ui-server.mjs (o id do diretório do workflow). Local para este módulo não
// depender do servidor; o servidor valida o caminho da URL com a dele.
const WF_ID_RE = /^wf_[A-Za-z0-9_-]+$/
const WF_KEY_RE = /^[^/\u0000-\u001f\u007f]{1,400}\/wf_[A-Za-z0-9_-]{1,64}$/
const CONTROL_RE = /[\u0000-\u001f\u007f]/

// ── Chave da run (D4 §3.1) ──

// Só o runId quando ele casa com RUN_ID_RE: sobrevive à retomada, que ganha outro wf e pode nascer sob
// outro slug (sessão aberta em outro cwd). Sem runId válido, `<slug>/<wf>`, que nunca colide com um runId
// (este não tem `/`) nem com outro wf.
export function runKey({ slug, runId, wf }) {
  if (typeof runId === 'string' && RUN_ID_RE.test(runId)) return runId
  return `${slug}/${wf}`
}

export const isRunKey = (k) => typeof k === 'string' && k.length <= 512 && (RUN_ID_RE.test(k) || WF_KEY_RE.test(k))

// ── Arquivo ──

export function emptyOrg() {
  return { version: ORG_VERSION, pinned: [], groups: [], placement: {}, archived: {}, deleted: {} }
}

const sameName = (a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }) === 0

// Motivo pt-BR para um nome de grupo inválido, ou null. A unicidade é conferida à parte (depende da org).
export function groupNameError(name) {
  if (typeof name !== 'string' || !name.trim()) return 'dê um nome ao grupo'
  const t = name.trim()
  if (CONTROL_RE.test(t)) return 'sem caracteres de controle'
  if ([...t].length > ORG_LIMITS.groupName) return `até ${ORG_LIMITS.groupName} caracteres`
  return null
}

// Normaliza um objeto lido do disco: entradas inválidas caem uma a uma, e a contagem vira aviso. As keys
// vêm de Object.entries e voltam por Object.fromEntries (um "__proto__" do JSON nunca troca protótipo).
export function normalizeOrg(raw) {
  const org = emptyOrg()
  let dropped = 0
  const pinned = Array.isArray(raw.pinned) ? raw.pinned : []
  if (raw.pinned !== undefined && !Array.isArray(raw.pinned)) dropped++
  for (const k of pinned) {
    if (isRunKey(k) && !org.pinned.includes(k) && org.pinned.length < ORG_LIMITS.pinned) org.pinned.push(k)
    else dropped++
  }
  const groups = Array.isArray(raw.groups) ? raw.groups : []
  if (raw.groups !== undefined && !Array.isArray(raw.groups)) dropped++
  for (const g of groups) {
    const ok =
      isPlainObject(g) &&
      typeof g.id === 'string' &&
      GROUP_RE.test(g.id) &&
      !groupNameError(g.name) &&
      !org.groups.some((x) => x.id === g.id || sameName(x.name, g.name.trim())) &&
      org.groups.length < ORG_LIMITS.groups
    if (ok) org.groups.push({ id: g.id, name: g.name.trim() })
    else dropped++
  }
  const ids = new Set(org.groups.map((g) => g.id))
  const entries = (v) => {
    if (v === undefined) return []
    if (!isPlainObject(v)) {
      dropped++
      return []
    }
    return Object.entries(v)
  }
  const placement = []
  for (const [k, gid] of entries(raw.placement)) {
    if (isRunKey(k) && typeof gid === 'string' && ids.has(gid)) placement.push([k, gid])
    else dropped++
  }
  org.placement = Object.fromEntries(placement)
  for (const field of ['archived', 'deleted']) {
    const pairs = []
    for (const [k, ms] of entries(raw[field])) {
      if (isRunKey(k) && typeof ms === 'number' && Number.isFinite(ms)) pairs.push([k, ms])
      else dropped++
    }
    org[field] = Object.fromEntries(pairs)
  }
  return { org, warnings: dropped ? [`organize.json: ${dropped} ${dropped === 1 ? 'entrada inválida ignorada' : 'entradas inválidas ignoradas'}`] : [] }
}

// Leitura tolerante, como readConfig: arquivo ausente = vazio; ilegível ou de outra versão = vazio com
// aviso. Só erro de E/S que não seja ENOENT sobe.
export function readOrg(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { org: emptyOrg(), warnings: [] }
    throw e
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { org: emptyOrg(), warnings: ['organize.json ilegível; comecei do zero'] }
  }
  if (!isPlainObject(parsed) || parsed.version !== ORG_VERSION) return { org: emptyOrg(), warnings: ['organize.json ilegível; comecei do zero'] }
  return normalizeOrg(parsed)
}

let seq = 0

// Gravação atômica, igual ao writeConfig (bin/config.mjs): tmp `wx` 0600 no mesmo diretório + rename, com
// o tmp apagado no erro. Sai sempre normalizada.
export function writeOrg(file, org) {
  const { org: clean } = normalizeOrg(org)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${++seq}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* tmp nem chegou a existir */
    }
    throw e
  }
  return clean
}

// OrgPublica (C11): `placement` e `archived` saem por run no RunResumo, e `deleted` nunca sai.
export function publicOrg(org, warnings = []) {
  return { groups: org.groups.map((g) => ({ id: g.id, name: g.name })), pinned: [...org.pinned], warnings: [...warnings] }
}

// ── Corpo das rotas (C10: tabela estrita no padrão do validateConfig) ──

const isWf = (v) => typeof v === 'string' && WF_ID_RE.test(v)
const wfCheck = (v) => (isWf(v) ? null : 'id de run inválido')
const boolCheck = (v) => (typeof v === 'boolean' ? null : 'use true ou false')

// op → { campo: [obrigatório, check] }
const BODY = {
  pin: { wf: [true, wfCheck], pinned: [true, boolCheck] },
  'group-create': { name: [true, groupNameError], wf: [false, wfCheck] },
  'group-rename': { name: [true, groupNameError] },
  'group-move': { index: [true, (v) => (Number.isInteger(v) && v >= 0 ? null : 'posição inválida')] },
  'group-delete': {},
  move: { wf: [true, wfCheck], group: [true, (v) => (v === null || (typeof v === 'string' && GROUP_RE.test(v)) ? null : 'id de grupo inválido')] },
  archive: { wf: [true, wfCheck], archived: [true, boolCheck] },
  delete: { wf: [true, wfCheck], confirm: [true, (v) => (typeof v === 'string' && v.length ? null : 'digite o nome da run exatamente como aparece')] },
  'delete-finished': {
    wfs: [
      true,
      (v) =>
        Array.isArray(v) && v.length >= 1 && v.length <= ORG_LIMITS.deleteFinished && v.every(isWf) && new Set(v).size === v.length
          ? null
          : `de 1 a ${ORG_LIMITS.deleteFinished} runs, sem repetir`,
    ],
    confirm: [true, (v) => (typeof v === 'string' ? null : 'digite apagar N')],
  },
}

export const ORG_OPS = Object.keys(BODY)

// → { ok, value, errors: { campo: motivo } }. Campo a mais dá "campo desconhecido".
export function validateOrgBody(op, body) {
  const spec = BODY[op]
  if (!spec) throw new Error(`operação de organização desconhecida: ${op}`)
  if (!isPlainObject(body)) return { ok: false, value: {}, errors: { corpo: 'o corpo deve ser um objeto' } }
  const errs = []
  for (const k of Object.keys(body)) if (!Object.hasOwn(spec, k)) errs.push([k, 'campo desconhecido'])
  const value = {}
  for (const [k, [required, check]] of Object.entries(spec)) {
    if (!Object.hasOwn(body, k) || body[k] === undefined) {
      if (required) errs.push([k, check(undefined) || 'obrigatório'])
      continue
    }
    const e = check(body[k])
    if (e) errs.push([k, e])
    else value[k] = body[k]
  }
  if (op === 'delete-finished' && !errs.length && value.confirm !== `apagar ${value.wfs.length}`) errs.push(['confirm', `digite apagar ${value.wfs.length}`])
  if (value.name !== undefined) value.name = value.name.trim()
  return { ok: errs.length === 0, value, errors: Object.fromEntries(errs) }
}

// ── Operações (puras: devolvem uma org nova, nunca mexem na recebida) ──

const bad = (status, error, fields) => ({ ok: false, status, error, ...(fields ? { fields } : {}) })
const badName = (msg) => bad(400, 'pedido de organização inválido', { name: msg })

function newGroupId(org, randomId) {
  for (let i = 0; i < 16; i++) {
    const id = randomId()
    if (GROUP_RE.test(id) && !org.groups.some((g) => g.id === id)) return id
  }
  throw new Error('não consegui gerar um id de grupo livre')
}

const randomGroupId = () => 'g-' + crypto.randomBytes(4).toString('hex')

// `op` é uma das ORG_OPS; `args` já validado (validateOrgBody), com `key` no lugar do `wf` (o servidor
// troca o wf pela key da run; a key nunca vem do cliente) e `gid` do caminho da URL.
// → { ok: true, org, extra } | { ok: false, status, error, fields? }
export function applyOrgOp(current, op, args = {}, { now = Date.now(), randomId = randomGroupId } = {}) {
  const org = structuredClone(current)
  const unpin = (key) => {
    org.pinned = org.pinned.filter((k) => k !== key)
  }
  const group = (gid) => org.groups.find((g) => g.id === gid)
  const nameTaken = (name, exceptId) => org.groups.some((g) => g.id !== exceptId && sameName(g.name, name))

  switch (op) {
    case 'pin': {
      unpin(args.key)
      if (args.pinned) {
        if (org.pinned.length >= ORG_LIMITS.pinned) return bad(409, `limite de ${ORG_LIMITS.pinned} fixadas`)
        org.pinned.unshift(args.key) // quem é fixado entra no topo
      }
      return { ok: true, org, extra: {} }
    }
    case 'group-create': {
      if (nameTaken(args.name)) return badName('já existe um grupo com esse nome')
      if (org.groups.length >= ORG_LIMITS.groups) return bad(409, `limite de ${ORG_LIMITS.groups} grupos`)
      const g = { id: newGroupId(org, randomId), name: args.name }
      org.groups.push(g)
      if (args.key) {
        org.placement[args.key] = g.id
        unpin(args.key) // a run aparece onde foi posta: fixada venceria o grupo
      }
      return { ok: true, org, extra: { group: { ...g } } }
    }
    case 'group-rename': {
      const g = group(args.gid)
      if (!g) return bad(404, 'grupo não encontrado')
      if (nameTaken(args.name, g.id)) return badName('já existe um grupo com esse nome')
      g.name = args.name
      return { ok: true, org, extra: {} }
    }
    case 'group-move': {
      const i = org.groups.findIndex((g) => g.id === args.gid)
      if (i < 0) return bad(404, 'grupo não encontrado')
      if (!(args.index >= 0 && args.index < org.groups.length)) return bad(400, 'pedido de organização inválido', { index: 'posição inválida' })
      const [g] = org.groups.splice(i, 1)
      org.groups.splice(args.index, 0, g)
      return { ok: true, org, extra: {} }
    }
    case 'group-delete': {
      if (!group(args.gid)) return bad(404, 'grupo não encontrado')
      org.groups = org.groups.filter((g) => g.id !== args.gid)
      const keep = Object.entries(org.placement).filter(([, gid]) => gid !== args.gid)
      const released = Object.keys(org.placement).length - keep.length
      org.placement = Object.fromEntries(keep)
      return { ok: true, org, extra: { released } }
    }
    case 'move': {
      if (args.group !== null && !group(args.group)) return bad(400, 'pedido de organização inválido', { group: 'esse grupo não existe' })
      unpin(args.key) // mover sempre desafixa
      if (args.group === null) delete org.placement[args.key]
      else org.placement[args.key] = args.group
      return { ok: true, org, extra: {} }
    }
    case 'archive': {
      if (args.archived) org.archived[args.key] = now
      else delete org.archived[args.key]
      return { ok: true, org, extra: {} }
    }
    case 'delete':
    case 'delete-finished': {
      const keys = op === 'delete' ? [args.key] : args.keys
      for (const key of keys) {
        unpin(key)
        delete org.placement[key]
        delete org.archived[key]
        org.deleted[key] = now
      }
      return { ok: true, org, extra: {} }
    }
    default:
      throw new Error(`operação de organização desconhecida: ${op}`)
  }
}

// Tira de `deleted` as keys que voltaram (um wf com mtime maior que a data do apagar, D4 §3.2).
export function pruneRevived(org, latestMtimeByKey) {
  const keep = Object.entries(org.deleted).filter(([k, ms]) => !(latestMtimeByKey.get(k) > ms))
  if (keep.length === Object.keys(org.deleted).length) return org
  return { ...org, deleted: Object.fromEntries(keep) }
}

// ── Seção e representante ──

// A regra mínima que o "apagar finalizadas" usa, na mesma ordem do `sectionOf` da página
// (bin/ui/sidebar.mjs, I6): arquivada → fixada → grupo → rodando (vence planOnly) → terminada ou planOnly.
// Um teste de paridade (I6) protege `isInFinishedSection(r) === (sectionOf(r) === 'done')`.
export function isInFinishedSection(run) {
  return !run.archived && !run.pinned && !run.group && run.status !== 'rodando' && (run.status === 'terminado' || !!run.planOnly)
}

// Representante de uma key (P3, D4 §3.2): o wf rodando mais novo; sem nenhum, o mais novo que não é
// planOnly; e, se todos forem planOnly, o planOnly mais novo. `entries`: [{ status, planOnly, mtime }].
export function pickRepresentative(entries) {
  const byNew = [...entries].sort((a, b) => b.mtime - a.mtime)
  return byNew.find((e) => e.status === 'rodando') || byNew.find((e) => !e.planOnly) || byNew[0] || null
}

// ── Contenção do apagar (D4 §3.6, C10) ──

function realOr(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

// `child` fica dentro de `parent` (ou é ele, com `orSame`).
function inside(child, parent, orSame = false) {
  if (!parent) return false
  const rel = path.relative(parent, child)
  if (rel === '') return orSame
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

// → { ok: true, real } | { ok: false, why, absent? }. `absent`: não há pasta a apagar (sem caminho, runId
// fora do formato ou pasta que não existe mais); o O8 então só tira a run da lista. Qualquer outra falha é
// uma pasta que existe e não passa na contenção, e nada é removido.
export function resolveRunDir(raw, runId, { projectsDir, graphRunsHome = path.join(os.homedir(), '.claude', 'graph-runs'), home = os.homedir() } = {}) {
  if (typeof raw !== 'string' || !raw) return { ok: false, absent: true, why: 'a run não tem pasta em .graph-runs' }
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return { ok: false, absent: true, why: 'runId fora do formato' }
  // 1. absoluto e normalizado: sem `..`, `.` nem barra dupla
  if (!path.isAbsolute(raw) || path.resolve(raw) !== raw) return { ok: false, why: 'o caminho da pasta não é absoluto e normalizado' }
  // 2. o nome da pasta é o runId
  if (path.basename(raw) !== runId) return { ok: false, why: 'o nome da pasta não é o runId da run' }
  // 3. diretório de verdade, não symlink
  let st
  try {
    st = fs.lstatSync(raw)
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, absent: true, why: 'a pasta não existe mais' }
    return { ok: false, why: `não consegui ler a pasta: ${e.message}` }
  }
  if (st.isSymbolicLink()) return { ok: false, why: 'a pasta é um link simbólico' }
  if (!st.isDirectory()) return { ok: false, why: 'o caminho não é uma pasta' }
  // 4. longe dos históricos, do home e da raiz
  const real = realOr(raw)
  if (!real) return { ok: false, why: 'não consegui resolver o caminho da pasta' }
  const projects = realOr(projectsDir)
  const homeReal = realOr(home) || home
  if (real === path.parse(real).root || real === homeReal) return { ok: false, why: 'a pasta é o home ou a raiz' }
  if (projects && (inside(real, projects, true) || inside(projects, real))) return { ok: false, why: 'a pasta fica junto dos históricos em ~/.claude/projects' }
  if (inside(homeReal, real)) return { ok: false, why: 'a pasta contém o home' }
  // 5. o pai é `.graph-runs`, ou fica dentro do graph-runs global
  if (path.basename(path.dirname(real)) !== '.graph-runs' && !inside(real, realOr(graphRunsHome))) {
    return { ok: false, why: 'a pasta não fica num .graph-runs' }
  }
  return { ok: true, real }
}

// Só depois de `resolveRunDir` ok. O rmSync desliga symlinks internos sem segui-los.
export function removeRunDir(real) {
  fs.rmSync(real, { recursive: true })
}
