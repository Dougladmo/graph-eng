import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

// Mapping is executable policy, versioned with the supervisor. It is deliberately
// not accepted from the plan, worker, package.json, or user configuration.
export const NODE_CHECK_POLICY_ID = 'node-check-policy-v1'
const SOURCE_TESTS = Object.freeze({
  'bin/grapheng.mjs': Object.freeze(['test/grapheng.test.mjs']),
  'bin/graph-run.mjs': Object.freeze(['test/graph-run.test.mjs']),
  'workflows/graph-eng.js': Object.freeze(['test/workflow-final-gate.test.mjs']),
})

export const NODE_CHECK_MAPPING_HASH = createHash('sha256').update(JSON.stringify({ id: NODE_CHECK_POLICY_ID, sources: SOURCE_TESTS })).digest('hex')

export function validRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && !path.isAbsolute(value) && !/^[a-zA-Z]:[\\/]/.test(value) && !value.split(/[\\/]/).some(part => !part || part === '.' || part === '..') && !value.startsWith('-') && !value.includes('\\')
}

// C7: grants nunca miram caminho privado do supervisor (.graph-runs/, runDir), nunca usam glob
// e nunca escapam da raiz por symlink, mesmo quando o arquivo ainda não existe.
const GLOB_CHARS = /[*?[\]{}]/
const DEFAULT_PRIVATE_PREFIXES = Object.freeze(['.graph-runs'])

function insideRoot(real, rootReal) {
  return real === rootReal || real.startsWith(`${rootReal}${path.sep}`)
}

function privateRelative(relative, privatePrefixes) {
  const rel = relative.split(path.sep).join('/')
  return privatePrefixes.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))
}

function normalizePrefixes(privatePrefixes = []) {
  return [...new Set([...DEFAULT_PRIVATE_PREFIXES, ...privatePrefixes.map(prefix => String(prefix).split(path.sep).join('/').replace(/\/+$/, ''))])].filter(prefix => prefix && !prefix.startsWith('..') && !path.isAbsolute(prefix))
}

// Resolve o diretório pai de um arquivo que ainda não existe. Qualquer componente que aponte para fora
// da raiz (inclusive symlink quebrado) bloqueia; retorna o realpath do pai.
async function realParentOf(absolute, rootReal, relative) {
  let dir = path.dirname(absolute)
  for (;;) {
    try { await lstat(dir) }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      const up = path.dirname(dir)
      if (up === dir) throw new Error(`grant_path_escape: ${relative}`)
      dir = up
      continue
    }
    const real = await realpath(dir).catch(() => null)
    if (!real || !insideRoot(real, rootReal)) throw new Error(`grant_path_escape: ${relative}`)
    return real
  }
}

async function inspectRepoFile(root, relative, { allowMissing = false, privatePrefixes = [] } = {}) {
  if (!validRelativePath(relative)) throw new Error(`caminho de check inválido: ${String(relative)}`)
  const absolute = path.resolve(root, relative)
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`caminho de check fora do repositório: ${relative}`)
  const rootReal = await realpath(root)
  let stat
  try { stat = await lstat(absolute) }
  catch (error) {
    if (allowMissing && error.code === 'ENOENT') {
      const realParent = await realParentOf(absolute, rootReal, relative)
      const realPath = path.join(realParent, path.basename(absolute))
      if (privateRelative(path.relative(rootReal, realPath), privatePrefixes) || privateRelative(relative, privatePrefixes)) throw new Error(`grant_private_path: ${relative}`)
      return { relative, exists: false, absolute }
    }
    throw new Error(`arquivo de check não existe: ${relative}`)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`arquivo de check precisa ser arquivo regular sem symlink: ${relative}`)
  const resolved = await realpath(absolute)
  if (!insideRoot(resolved, rootReal) || resolved === rootReal) throw new Error(`arquivo de check fora do repositório: ${relative}`)
  if (privateRelative(relative, privatePrefixes) || privateRelative(path.relative(rootReal, resolved), privatePrefixes)) throw new Error(`grant_private_path: ${relative}`)
  return { relative, exists: true, absolute }
}

export async function resolveNodeCheckSelection({ root, files, actualChangedPaths = [], finalChecks, phase, nodeId, planVersion }) {
  if (!['node', 'final'].includes(phase)) throw new Error('fase de check inválida')
  if (phase === 'final') {
    if (nodeId !== undefined || planVersion !== undefined) throw new Error('check final não aceita nodeId nem planVersion')
    return {
      selection: { policyId: NODE_CHECK_POLICY_ID, mappingHash: NODE_CHECK_MAPPING_HASH, phase, nodeId: null, planVersion: null, files: [], actualChangedPaths: [], coverage: 'complete', limitation: null, checkIds: finalChecks.map(check => check.id), checkSpecs: finalChecks },
      checks: finalChecks,
    }
  }
  if (typeof nodeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(nodeId) || !Number.isInteger(planVersion) || planVersion < 1 || !Array.isArray(files)) throw new Error('seleção local exige nodeId, planVersion e files aprovados')
  const uniqueFiles = [...new Set(files)]
  if (uniqueFiles.length !== files.length) throw new Error('seleção local contém arquivos duplicados')
  if (!Array.isArray(actualChangedPaths) || actualChangedPaths.some(file => !uniqueFiles.includes(file))) throw new Error('diff auditado inclui arquivo fora do grant aprovado para o nó')
  const checkedFiles = []
  for (const file of uniqueFiles) checkedFiles.push(await inspectRepoFile(root, file, { allowMissing: true }))

  const tests = new Set()
  let incomplete = checkedFiles.length === 0
  const syntax = []
  for (const file of checkedFiles) {
    const relative = file.relative
    if (!file.exists) incomplete = true
    if (relative.startsWith('test/') && relative.endsWith('.test.mjs')) {
      if (!file.exists) { incomplete = true; continue }
      tests.add(relative)
      continue
    }
    const mapped = SOURCE_TESTS[relative]
    if (mapped) {
      for (const testFile of mapped) {
        const checkedTest = await inspectRepoFile(root, testFile)
        tests.add(checkedTest.relative)
      }
      continue
    }
    incomplete = true
    if (file.exists && /\.(?:js|mjs|cjs)$/.test(relative)) syntax.push(relative)
  }

  const checks = []
  if (tests.size) {
    const testFiles = [...tests].sort()
    checks.push({ id: `node-tests-${createHash('sha256').update(testFiles.join('\n')).digest('hex').slice(0, 12)}`, command: process.execPath, args: ['--test', '--test-concurrency=2', ...testFiles], cwd: '.', timeoutMs: 1_800_000, heavy: true })
  }
  for (const file of [...new Set(syntax)].sort()) checks.push({ id: `node-check-${createHash('sha256').update(file).digest('hex').slice(0, 12)}`, command: process.execPath, args: ['--check', file], cwd: '.', timeoutMs: 60_000, heavy: false })
  const coverage = incomplete ? 'syntax-contract-only' : 'affected-tests'
  return {
    selection: {
      policyId: NODE_CHECK_POLICY_ID, mappingHash: NODE_CHECK_MAPPING_HASH, phase, nodeId, planVersion,
      files: checkedFiles.map(file => ({ path: file.relative, exists: file.exists })), actualChangedPaths: [...new Set(actualChangedPaths)].sort(), coverage,
      limitation: incomplete ? 'mapping incompleto; checks locais limitados aos testes conhecidos, sintaxe Node aplicável e contrato/grants' : null,
      checkIds: checks.map(check => check.id), checkSpecs: checks,
    },
    checks,
  }
}

export async function assertSafeApprovedFiles(root, files, { privatePrefixes = [] } = {}) {
  if (!Array.isArray(files)) throw new Error('files do nó precisa conter caminhos relativos canônicos')
  for (const file of files) {
    if (typeof file === 'string' && GLOB_CHARS.test(file)) throw new Error(`grant_glob_unsupported: ${file}`)
  }
  if (files.some(file => !validRelativePath(file))) throw new Error('files do nó precisa conter caminhos relativos canônicos')
  const prefixes = normalizePrefixes(privatePrefixes)
  const canonical = []
  for (const file of files) {
    // Approved grants may name a deleted file; it remains part of the node scope.
    await inspectRepoFile(root, file, { allowMissing: true, privatePrefixes: prefixes })
    canonical.push(file)
  }
  return canonical
}
