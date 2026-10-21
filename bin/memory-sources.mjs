import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { assertDescendant, readRunRegistry, validateRegistryEntry, validateRunIdentity } from './run-registry.mjs'

// Adaptador de fontes para createRunMemory (E4). Só lê: nunca escreve na runDir nem no registry.
//
// resolveSource(ref) devolve { verified: true, bytes, identity } ou null. Qualquer falha (run não
// registrada, runDir trocada por symlink, marker ou identity divergente, journal que é symlink,
// id fora do mapa) vira null, sem detalhe para o chamador.
//
//  - kind 'event': bytes = a linha do journal com seq = eventSeq, sem o \n final; identity = { runId, eventSeq }.
//    É esse conteúdo exato que o eventHash do registro deve carregar (contrato para a alimentação da E7).
//  - demais kinds (decision, contract, receipt, snapshot, feedback): o supervisor registra com
//    registerArtifact({ runId, kind, id, relPath, identity }). relPath aceita outputs/<nome>,
//    receipts/<nome> ou, só para receipts do check (R-E7b), receipt-<uuid>.json na raiz da runDir.
//    identity é a string registrada. artifactRef não carrega runId, então o id precisa ser único no
//    mapa (o supervisor gera ids opacos). O mapa é persistido em artifactsDir (R-E7c): um arquivo
//    por id, sha256(kind:id).json, 0600, escrita atômica. Id duplicado é recusado. O mapa só localiza:
//    resolveArtifact confere identity e hash relendo a runDir.
//
// dataDir é o stateDir do registry (<dataDir>/runs-v2). currentRun, opcional, é a entrada da run em
// curso, para resolver fontes antes de ela estar no registry.

const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const ARTIFACT_KINDS = new Set(['decision', 'contract', 'receipt', 'snapshot', 'feedback'])
const ARTIFACT_ID = /^[A-Za-z0-9._-]{1,200}$/
const RELATIVE_PATH = /^(outputs|receipts)\/[A-Za-z0-9._-]{1,200}$/
// R-E7b: receipts do check (run-evidence.mjs) ficam na raiz da runDir com id UUID. Só esse nome exato.
const ROOT_RECEIPT_PATH = /^receipt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/

// R-E7c: artifactsDir (opcional) guarda o mapa id -> runId/relPath/identity em disco, para a seleção de outra run ou processo.
// O mapa só localiza a fonte: resolveArtifact relê a runDir e confere hash e identidade da referência.
export function createSourceResolver({ dataDir, currentRun = null, artifactsDir = null } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir é obrigatório')
  const artifacts = new Map()
  const artifactFile = (kind, id) => path.join(path.resolve(artifactsDir), `${createHash('sha256').update(`${kind}:${id}`).digest('hex')}.json`)
  function loadArtifact(kind, id) {
    const key = `${kind}:${id}`
    if (artifacts.has(key)) return artifacts.get(key)
    if (!artifactsDir) return null
    try {
      const file = artifactFile(kind, id)
      if (!lstatSync(file).isFile()) return null
      const value = JSON.parse(readFileSync(file, 'utf8'))
      if (value?.schemaVersion !== 1 || value.kind !== kind || value.id !== id || typeof value.runId !== 'string' || !RUN_ID.test(value.runId)) return null
      if (typeof value.relPath !== 'string' || !(RELATIVE_PATH.test(value.relPath) || ROOT_RECEIPT_PATH.test(value.relPath)) || value.relPath.split('/').includes('..')) return null
      if (typeof value.identity !== 'string' || !value.identity) return null
      return { runId: value.runId, relPath: value.relPath, identity: value.identity }
    } catch { return null }
  }
  function persistArtifact(kind, id, value) {
    if (!artifactsDir) return
    mkdirSync(path.resolve(artifactsDir), { recursive: true, mode: 0o700 })
    const file = artifactFile(kind, id)
    const temp = path.join(path.resolve(artifactsDir), `.${randomUUID()}.tmp`)
    writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, kind, id, ...value })}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temp, file)
  }

  async function locateRun(runId) {
    if (currentRun && currentRun.runId === runId) return validateRegistryEntry(currentRun)
    const { entries } = await readRunRegistry({ stateDir: dataDir })
    const matches = entries.filter(entry => entry.runId === runId)
    if (matches.length !== 1) return null
    // FIX6 3E: a run de origem precisa ser do mesmo repositório (cwd real) da run atual. Sem currentRun, o chamador não tem repositório para comparar.
    if (currentRun && matches[0].cwd !== currentRun.cwd) return null
    return matches[0]
  }

  async function verifiedRun(entry) {
    const cwd = await realpath(entry.cwd)
    const runDir = await realpath(entry.runDir)
    if (cwd !== entry.cwd || runDir !== entry.runDir) throw new Error('runDir registrada deixou de ser o caminho real')
    assertDescendant(cwd, runDir)
    await validateRunIdentity(cwd, runDir, entry.runId, entry.host)
    return { cwd, runDir }
  }

  async function resolveEvent(ref) {
    const { runId, eventSeq } = ref
    if (typeof runId !== 'string' || !RUN_ID.test(runId) || !Number.isSafeInteger(eventSeq) || eventSeq < 1) return null
    const entry = await locateRun(runId)
    if (!entry) return null
    const run = await verifiedRun(entry)
    const journal = await readRegularFile(run.runDir, 'journal.jsonl')
    const line = findEventLine(journal, runId, eventSeq)
    if (!line) return null
    return { verified: true, bytes: line, identity: { runId, eventSeq } }
  }

  async function resolveArtifact(ref) {
    const registered = loadArtifact(ref.kind, ref.id)
    if (!registered) return null
    // O mapa só localiza: a referência precisa bater com a identidade registrada.
    if (ref.identity !== undefined && ref.identity !== registered.identity) return null
    const entry = await locateRun(registered.runId)
    if (!entry) return null
    const run = await verifiedRun(entry)
    const bytes = await readRegularFile(run.runDir, registered.relPath)
    if (ref.hash !== undefined && createHash('sha256').update(bytes).digest('hex') !== ref.hash) return null
    return { verified: true, bytes, identity: registered.identity }
  }

  async function resolveSource(ref) {
    try {
      if (!ref || typeof ref !== 'object') return null
      if (ref.kind === 'event') return await resolveEvent(ref)
      if (!ARTIFACT_KINDS.has(ref.kind) || typeof ref.id !== 'string') return null
      return await resolveArtifact(ref)
    } catch {
      return null
    }
  }

  function registerArtifact({ runId, kind, id, relPath, identity } = {}) {
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new TypeError('runId inválido')
    if (!ARTIFACT_KINDS.has(kind)) throw new TypeError('kind de artefato inválido')
    if (typeof id !== 'string' || !ARTIFACT_ID.test(id)) throw new TypeError('id de artefato inválido')
    if (typeof relPath !== 'string' || !(RELATIVE_PATH.test(relPath) || ROOT_RECEIPT_PATH.test(relPath)) || relPath.split('/').includes('..')) throw new Error('relPath precisa ser outputs/, receipts/ ou receipt-<uuid>.json na raiz, sem escape')
    if (typeof identity !== 'string' || !identity) throw new TypeError('identity de artefato precisa ser texto não vazio')
    const key = `${kind}:${id}`
    const value = { runId, relPath, identity }
    const previous = loadArtifact(kind, id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('id de artefato já registrado com outro conteúdo')
    if (!previous) persistArtifact(kind, id, value)
    artifacts.set(key, value)
  }

  return { resolveSource, registerArtifact }
}

async function readRegularFile(runDir, relPath) {
  const parent = path.join(runDir, path.dirname(relPath))
  if (await realpath(parent) !== parent) throw new Error('diretório do arquivo não é o caminho real')
  const file = path.join(runDir, relPath)
  let handle
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) }
  catch (error) { if (error.code === 'ELOOP') throw new Error(`${relPath} não é arquivo regular`); throw error }
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`${relPath} não é arquivo regular`)
    return await handle.readFile()
  } finally { await handle.close() }
}

// Varre o journal em bytes, sem re-codificar, para devolver exatamente a linha persistida.
// Um final parcial (sem \n) é ignorado, como em run-view-v2.
function findEventLine(journal, runId, eventSeq) {
  let found = null
  let start = 0
  while (start < journal.length) {
    const end = journal.indexOf(0x0a, start)
    if (end === -1) break
    const line = journal.subarray(start, end)
    start = end + 1
    const event = JSON.parse(line.toString('utf8'))
    if (event?.seq !== eventSeq) continue
    if (event.runId !== runId) throw new Error('journal contém runId divergente')
    if (found) throw new Error('journal contém sequência duplicada')
    found = Buffer.from(line)
  }
  return found
}
