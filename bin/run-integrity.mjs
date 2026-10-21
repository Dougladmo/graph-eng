import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'

// Inventário puro da runDir: lstat em todo caminho (symlink nunca é seguido), dotfiles incluídos,
// sem mtime. Entradas: file {sha256, executable}, symlink {target}, dir {dev, ino}, other {dev, ino}.
export async function inventory(root) {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory()) throw new Error('inventory: raiz precisa ser diretório real')
  const map = new Map([['.', { type: 'dir', dev: rootStat.dev, ino: rootStat.ino }]])
  await walk(root, '.', map)
  return map
}

async function walk(root, rel, map) {
  for (const name of (await readdir(path.join(root, rel))).sort()) {
    const childRel = rel === '.' ? name : `${rel}/${name}`
    const abs = path.join(root, childRel)
    const stat = await lstat(abs)
    map.set(childRel, await entryOf(abs, stat))
    if (stat.isDirectory()) await walk(root, childRel, map)
  }
}

async function entryOf(abs, stat) {
  if (stat.isSymbolicLink()) return { type: 'symlink', target: await readlink(abs) }
  if (stat.isDirectory()) return { type: 'dir', dev: stat.dev, ino: stat.ino }
  if (stat.isFile()) {
    const sha256 = createHash('sha256').update(await readFile(abs)).digest('hex')
    return { type: 'file', sha256, executable: (stat.mode & 0o111) !== 0 }
  }
  return { type: 'other', dev: stat.dev, ino: stat.ino }
}

// Caminhos (ordenados) cuja entrada mudou, apareceu ou sumiu entre os dois inventários.
export function diffInventory(expected, actual) {
  const paths = new Set([...expected.keys(), ...actual.keys()])
  return [...paths].filter(p => entryKey(expected.get(p)) !== entryKey(actual.get(p))).sort()
}

function entryKey(entry) {
  if (entry === undefined) return 'absent'
  return JSON.stringify(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

// Guard do supervisor (C11/C12). Detecta deltas observáveis e impede absorvê-los: a violação é sticky.
// scope 'tree' (C11): inventário inteiro e listagem dos pais. scope 'critical' (C12): só os caminhos críticos;
// privados do supervisor ainda sem guard (outputs, agentes, evidence) não são delta até o C13.
// Não detecta ABA nem adulteração offline coerente; o escopo é o processo supervisor vivo.
const inOperation = new AsyncLocalStorage()

export function createIntegrityGuard({ root, critical = [], scope = 'tree' } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('root absoluto obrigatório')
  if (scope !== 'tree' && scope !== 'critical') throw new TypeError('scope precisa ser tree ou critical')
  const criticalPaths = critical.map(relPath)
  let rootReal = null
  let expected = null
  let children = null
  let violation = null
  let queue = Promise.resolve()
  const ephemerals = new Set()

  // Fila curta. Chamada feita de dentro de uma operação protegida falha já, sem entrar na fila (sem deadlock).
  function enqueue(task) {
    if (inOperation.getStore()) return Promise.reject(guardError('integrity_reentrant', 'chamada ao guard dentro de operação protegida'))
    const run = queue.then(task)
    queue = run.catch(() => {})
    return run
  }

  function requireInstalled() {
    if (!expected) throw guardError('integrity_not_installed', 'install() precisa rodar antes')
  }

  function requireClean() {
    if (violation) throw violation
  }

  function fail(paths) {
    violation = guardError('run_integrity_violation', `Integridade da runDir violada: ${paths.join(', ')}`, paths)
    throw violation
  }

  function install() {
    return enqueue(async () => {
      if (expected) throw guardError('integrity_already_installed', 'baseline já instalado')
      rootReal = await realpath(root)
      if (scope === 'tree') {
        expected = await inventory(rootReal)
        children = childIndex(expected)
      } else {
        expected = new Map()
        for (const p of criticalPaths) {
          const entry = await entryAt(rootReal, p)
          if (entry !== undefined) expected.set(p, entry)
        }
        children = new Map()
      }
    })
  }

  // scope 'tree': inventário inteiro, menos os efêmeros ativos (caminhos exatos registrados pelo dono do handle).
  async function treeDelta() {
    const actual = await inventory(rootReal)
    for (const p of ephemerals) actual.delete(p)
    return diffInventory(expected, actual)
  }

  function assertIntegrity() {
    return enqueue(async () => {
      requireInstalled()
      requireClean()
      const delta = scope === 'tree' ? await treeDelta() : await verify(criticalPaths, [], new Map())
      if (delta.length) fail(delta)
    })
  }

  // Escopo: críticos + caminhos declarados + listagem dos diretórios pais deles (só em scope 'tree').
  // expect: { path: { bytes, executable } | null | { dir: true } }. dir: true só para caminho ausente antes da operação.
  function trustedWrite(spec, op) {
    return enqueue(() => trustedWriteNow(spec, op))
  }

  async function trustedWriteNow({ paths = [], expect } = {}, op) {
    requireInstalled()
    requireClean()
    if (typeof op !== 'function') throw new TypeError('op obrigatória')
    const specs = typeof expect === 'function' ? expect() : {}
    const declared = paths.map(relPath).sort()
    const specKeys = Object.keys(specs).map(relPath).sort()
    if (declared.join('\0') !== specKeys.join('\0')) throw new TypeError('expect e paths divergem')
    const dirPaths = declared.filter(p => isDirSpec(specs[p]))
    for (const p of dirPaths) {
      if (expected.has(p)) throw new TypeError(`dir: true só vale para caminho ausente: ${p}`)
    }
    const overlay = new Map(declared.map(p => [p, dirPaths.includes(p) ? undefined : entryFromSpec(specs[p])]))
    const touched = unique([...criticalPaths, ...declared])
    const dirs = scope === 'tree' ? unique(touched.map(p => path.posix.dirname(p))) : []

    const before = await verify(touched, dirs, new Map())
    if (before.length) fail(before)

    let result
    let opError = null
    try {
      result = await inOperation.run(true, op)
    } catch (error) {
      opError = error
    }
    if (!opError) {
      // O dir criado é lido do disco depois da operação: dev/ino vêm do lstat, e a operação não pode ter deixado outra coisa no lugar.
      for (const p of dirPaths) {
        const actual = await entryAt(rootReal, p)
        if (actual?.type !== 'dir') fail([p])
        overlay.set(p, actual)
      }
    }
    // Falha da operação não aceita nada: qualquer rastro parcial conta como delta.
    const after = await verify(touched, dirs, opError ? new Map() : overlay)
    if (after.length) fail(after)
    if (opError) throw opError
    commit(overlay)
    return result
  }

  // Cria os diretórios ausentes de rel (de cima para baixo), cada um como escrita confiável com expect { dir: true }.
  function ensureDir(rel, { mode } = {}) {
    return enqueue(async () => {
      requireInstalled()
      requireClean()
      const target = relPath(rel)
      const parts = target.split('/')
      for (let index = 1; index <= parts.length; index += 1) {
        const dir = parts.slice(0, index).join('/')
        if (expected.has(dir)) continue
        await trustedWriteNow({ paths: [dir], expect: () => ({ [dir]: { dir: true } }) }, () => mkdir(path.join(rootReal, dir), { mode }))
      }
    })
  }

  // Efêmeros ativos: caminhos exatos fora da comparação enquanto o handle vive.
  function registerEphemeral(paths) {
    return enqueue(async () => {
      requireInstalled()
      for (const value of paths) {
        const target = relPath(value)
        if (expected.has(target)) throw new TypeError(`efêmero não pode ser caminho já rastreado: ${target}`)
        if ((await entryAt(rootReal, target)) !== undefined) fail([target])
        ephemerals.add(target)
      }
    })
  }

  // Adoção: o caminho sai da lista de efêmeros e entra no baseline com o hash dos bytes informados.
  function adoptEphemeral(value, spec) {
    return enqueue(async () => {
      requireInstalled()
      requireClean()
      const target = relPath(value)
      if (!ephemerals.has(target)) throw new TypeError(`caminho não é efêmero ativo: ${target}`)
      const entry = entryFromSpec(spec)
      if (!entry) throw new TypeError('adoção exige { bytes }')
      const actual = await entryAt(rootReal, target)
      if (entryKey(actual) !== entryKey(entry)) fail([target])
      ephemerals.delete(target)
      commit(new Map([[target, entry]]))
    })
  }

  // Liberação: o handle terminou e o caminho precisa estar ausente. Sobra no disco é delta.
  function releaseEphemeral(paths) {
    return enqueue(async () => {
      requireInstalled()
      requireClean()
      const targets = paths.map(relPath)
      for (const target of targets) {
        if (!ephemerals.has(target)) throw new TypeError(`caminho não é efêmero ativo: ${target}`)
      }
      const present = []
      for (const target of targets) {
        if ((await entryAt(rootReal, target)) !== undefined) present.push(target)
      }
      if (present.length) fail(present)
      for (const target of targets) ephemerals.delete(target)
    })
  }

  async function verify(scope, dirs, overlay) {
    const delta = []
    for (const p of scope) {
      if (entryKey(expectedAt(p, overlay)) !== entryKey(await entryAt(rootReal, p))) delta.push(p)
    }
    for (const d of dirs) {
      if (entryKey(expectedAt(d, overlay)) !== entryKey(await entryAt(rootReal, d))) {
        delta.push(d)
        continue
      }
      const want = namesAt(d, overlay)
      const got = new Set((await dirNames(path.join(rootReal, d))).filter(name => !ephemerals.has(path.posix.join(d, name))))
      for (const name of unique([...want, ...got])) {
        if (want.has(name) !== got.has(name)) delta.push(path.posix.join(d, name))
      }
    }
    return unique(delta).sort()
  }

  function expectedAt(p, overlay) {
    return overlay.has(p) ? overlay.get(p) : expected.get(p)
  }

  function namesAt(d, overlay) {
    const names = new Set(children.get(d) ?? [])
    for (const [p, entry] of overlay) {
      if (path.posix.dirname(p) !== d) continue
      if (entry === undefined) names.delete(path.posix.basename(p))
      else names.add(path.posix.basename(p))
    }
    return names
  }

  function commit(overlay) {
    for (const [p, entry] of overlay) {
      const parent = path.posix.dirname(p)
      const name = path.posix.basename(p)
      if (entry === undefined) {
        expected.delete(p)
        children.get(parent)?.delete(name)
      } else {
        expected.set(p, entry)
        if (!children.has(parent)) children.set(parent, new Set())
        children.get(parent).add(name)
      }
    }
  }

  return { install, assertIntegrity, trustedWrite, ensureDir, registerEphemeral, adoptEphemeral, releaseEphemeral }
}

function childIndex(map) {
  const index = new Map()
  for (const key of map.keys()) {
    if (key === '.') continue
    const parent = path.posix.dirname(key)
    if (!index.has(parent)) index.set(parent, new Set())
    index.get(parent).add(path.posix.basename(key))
  }
  return index
}

function isDirSpec(spec) {
  return spec !== null && typeof spec === 'object' && spec.dir === true
}

function entryFromSpec(spec) {
  if (spec === null || spec === undefined) return undefined
  if (isDirSpec(spec)) throw new TypeError('dir: true só vale para caminho ausente e é tratado antes')
  if (typeof spec !== 'object' || spec.bytes === undefined) throw new TypeError('expect deve devolver { bytes, executable } ou null')
  return { type: 'file', sha256: createHash('sha256').update(spec.bytes).digest('hex'), executable: Boolean(spec.executable) }
}

async function entryAt(root, rel) {
  const abs = path.join(root, rel)
  try {
    return await entryOf(abs, await lstat(abs))
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  }
}

async function dirNames(abs) {
  try {
    return await readdir(abs)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw error
  }
}

function relPath(value) {
  if (typeof value !== 'string' || value === '' || value === '.' || value.endsWith('/') || path.posix.isAbsolute(value) || value.includes('\\')) {
    throw new TypeError(`caminho relativo inválido: ${value}`)
  }
  if (path.posix.normalize(value) !== value || value.split('/').includes('..')) throw new TypeError(`caminho relativo inválido: ${value}`)
  return value
}

function unique(values) {
  return [...new Set(values)]
}

function guardError(code, message, paths = []) {
  const error = new Error(message)
  error.code = code
  error.paths = paths
  return error
}
