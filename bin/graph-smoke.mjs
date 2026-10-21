import { spawn as nodeSpawn } from 'node:child_process'
import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHost } from './hosts.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const execFile = promisify(nodeExecFile)
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const ROLES = ['worker', 'planReviewer']
const VERSION_TIMEOUT_MS = 10_000
const SMOKE_TIMEOUT_MS = 3 * 60 * 1000
const WORKER_SCHEMA = {
  type: 'object',
  required: ['nonce', 'status'],
  properties: {
    nonce: { type: 'string' },
    status: { enum: ['ok', 'blocked'] },
    detail: { type: 'string' },
  },
}
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['nonce', 'verifiedWorkerNonce', 'verifiedWorkerStatus', 'verification'],
  properties: {
    nonce: { type: 'string' },
    verifiedWorkerNonce: { type: 'string' },
    verifiedWorkerStatus: { enum: ['ok', 'blocked'] },
    verification: { enum: ['valid', 'invalid'] },
    detail: { type: 'string' },
  },
}
const CANCEL_SCHEMA = { type: 'object', properties: { stopped: { type: 'boolean' } }, required: ['stopped'] }
const WRITE_PROBE_FILE = 'write-probe.txt'

function sanitizeCode(error) {
  const known = new Set(['AUTH_FAILED', 'MODEL_UNAVAILABLE', 'CLI_MISSING', 'SPAWN_FAILED', 'CLI_FAILED', 'TIMEOUT', 'CANCELLED', 'INVALID_OUTPUT', 'OUTPUT_LIMIT', 'UNSUPPORTED_SCHEMA'])
  return known.has(error?.code) ? error.code : 'SMOKE_FAILED'
}

function parseVersion(text) {
  return text.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+]?[A-Za-z][A-Za-z0-9.-]*)?\b/)?.[0] ?? null
}

async function cliVersion(host, cwd, spawn) {
  const command = host === 'claude' ? 'claude' : 'codex'
  return new Promise(resolve => {
    let child
    try { child = spawn(command, ['--version'], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) {
      resolve({ version: null, errorCode: error.code === 'ENOENT' ? 'CLI_MISSING' : 'SPAWN_FAILED' })
      return
    }
    let output = ''
    let done = false
    const finish = result => { if (done) return; done = true; clearTimeout(timer); resolve(result) }
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', chunk => { if (output.length < 4096) output += chunk })
    child.stderr?.on('data', chunk => { if (output.length < 4096) output += chunk })
    child.on('error', error => finish({ version: null, errorCode: error.code === 'ENOENT' ? 'CLI_MISSING' : 'SPAWN_FAILED' }))
    child.on('close', code => finish(code === 0
      ? { version: parseVersion(output), errorCode: parseVersion(output) ? null : 'VERSION_UNAVAILABLE' }
      : { version: null, errorCode: 'VERSION_UNAVAILABLE' }))
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      finish({ version: null, errorCode: 'VERSION_TIMEOUT' })
    }, VERSION_TIMEOUT_MS)
  })
}

async function safeOutputDirectory(baseDir, out) {
  const repo = await realpath(baseDir)
  const graphRuns = path.resolve(baseDir, '.graph-runs')
  await mkdir(graphRuns, { recursive: true, mode: 0o700 })
  const realGraphRuns = await realpath(graphRuns)
  const insideRepo = path.relative(repo, realGraphRuns)
  if (insideRepo.startsWith('..') || path.isAbsolute(insideRepo)) throw new Error('A pasta .graph-runs precisa ficar dentro do repositório')
  const requested = path.resolve(baseDir, out ?? '.graph-runs/smoke')
  const rel = path.relative(graphRuns, requested)
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('--out precisa apontar para dentro de .graph-runs')
  await mkdir(requested, { recursive: true, mode: 0o700 })
  const realOut = await realpath(requested)
  const realRel = path.relative(realGraphRuns, realOut)
  if (realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) throw new Error('--out não pode escapar de .graph-runs por symlink')
  return realOut
}

function evidenceError(error) {
  const code = sanitizeCode(error)
  const messages = {
    AUTH_FAILED: 'Autenticação indisponível.', MODEL_UNAVAILABLE: 'Modelo solicitado indisponível.',
    CLI_MISSING: 'CLI não encontrado.', TIMEOUT: 'Tempo limite excedido.',
    INVALID_OUTPUT: 'Saída não correspondeu ao contrato estruturado.',
  }
  return { code, message: messages[code] ?? 'A execução do smoke falhou.' }
}

/** Prova de escrita do executor: o PASS depende do arquivo gravado pelo CLI, não da resposta do modelo. */
async function runWriteProbe({ host, hostName, fixtureDir, runId, capabilities, version, cliCapabilityError, timeoutMs }) {
  const nonce = randomUUID()
  const started = Date.now()
  const base = { runId, host: hostName, role: 'worker', probe: 'write', file: WRITE_PROBE_FILE, startedAt: new Date().toISOString(), cliVersion: version.version, capabilities, nonce }
  if (cliCapabilityError) {
    return { ...base, status: 'BLOCK', durationMs: Date.now() - started, error: { code: cliCapabilityError, message: cliCapabilityError === 'CAPABILITY_MISSING' ? 'Host sem o papel exigido.' : evidenceError({ code: cliCapabilityError }).message } }
  }
  try {
    const handle = await host.spawn({
      role: 'worker',
      prompt: `Use a ferramenta Write para criar o arquivo ${WRITE_PROBE_FILE} no diretório atual, com exatamente este conteúdo e nada mais: ${nonce}. Não leia outros arquivos. Depois responda apenas no schema, com nonce igual a esse valor e status "ok". Nonce da escrita: ${nonce}`,
      schema: WORKER_SCHEMA,
      timeoutMs,
    })
    const result = await host.wait(handle)
    let fileMatched = false
    try { fileMatched = (await readFile(path.join(fixtureDir, WRITE_PROBE_FILE), 'utf8')).trim() === nonce } catch {}
    const status = fileMatched ? 'PASS' : 'BLOCK'
    return {
      ...base,
      status,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      requestedModel: result.requestedModel,
      effectiveModel: result.effectiveModel,
      usage: result.usage,
      responseNonceMatched: result.output?.nonce === nonce,
      fileMatched,
      ...(status === 'BLOCK' ? { error: { code: 'WRITE_PROBE_FAILED', message: 'Arquivo de escrita ausente ou diferente do nonce.' } } : {}),
    }
  } catch (error) {
    return { ...base, status: 'BLOCK', finishedAt: new Date().toISOString(), durationMs: Date.now() - started, fileMatched: false, error: evidenceError(error) }
  }
}

async function writeEvidence(directory, name, data) {
  await writeFile(path.join(directory, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
}

function waitForText(stream, getText, expected, timeoutMs) {
  if (getText().includes(expected)) return Promise.resolve(true)
  return new Promise(resolve => {
    let done = false
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      stream.off('data', onData)
      resolve(value)
    }
    const onData = () => { if (getText().includes(expected)) finish(true) }
    const timer = setTimeout(() => finish(false), timeoutMs)
    stream.on('data', onData)
    if (getText().includes(expected)) finish(true)
  })
}

async function processGroupGone(pid, timeoutMs = 2000) {
  if (!Number.isInteger(pid) || process.platform === 'win32') return false
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const { stdout } = await execFile('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 1000, maxBuffer: 256 * 1024 })
      const active = stdout.split(/\r?\n/).some(line => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/)
        return match?.[2] === String(pid) && !match[3].startsWith('Z')
      })
      if (!active) return true
    } catch { return false }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

async function cancellationProbe({ hostName, fixtureDir, runtimeDir, runId, killProcess }) {
  if (process.platform === 'win32') return { status: 'BLOCK', durationMs: 0, descendantReady: false, waitCode: 'CAPABILITY_MISSING', processGroupGone: false, signalPolicy: 'process-group não suportado nesta plataforma' }
  const resistantChild = "process.on('SIGTERM',()=>{});process.send('ready');process.stdin.resume();setInterval(()=>{},1000)"
  const commandTransform = ({ cwd }) => {
    const resistantParent = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',${JSON.stringify(resistantChild)}],{stdio:['ignore','ignore','ignore','ipc']});child.on('message',()=>{process.stderr.write('GRAPH_SMOKE_GRANDCHILD_READY\\n')});setInterval(()=>{},1000)`
    return { command: process.execPath, args: ['-e', resistantParent], cwd }
  }
  const host = createHost({
    host: hostName,
    cwd: fixtureDir,
    runDir: runtimeDir,
    runId: `${runId}-cancel-probe`,
    commandTransform,
    killProcess,
    timeoutMs: 20_000,
  })
  const started = Date.now()
  let handle
  try {
    handle = await host.spawn({ role: 'executor', prompt: 'Aguarde cancelamento do supervisor.', schema: CANCEL_SCHEMA, timeoutMs: 20_000 })
    const pid = handle.child.pid
    const ready = await waitForText(handle.child.stderr, () => handle.stderr, 'GRAPH_SMOKE_GRANDCHILD_READY', 3000)
    const cancelRequested = host.cancel(handle)
    let waitCode = 'UNEXPECTED_SUCCESS'
    try { await host.wait(handle) } catch (error) { waitCode = error.code ?? 'HOST_FAILED' }
    const groupGone = await processGroupGone(pid)
    return {
      status: ready && cancelRequested && waitCode === 'CANCELLED' && groupGone ? 'PASS' : 'BLOCK',
      durationMs: Date.now() - started,
      descendantReady: ready,
      cancelRequested,
      waitCode,
      processGroupGone: groupGone,
      signalPolicy: 'SIGTERM then SIGKILL after 1000 ms',
    }
  } catch (error) {
    if (handle) {
      host.cancel(handle)
      await host.wait(handle).catch(() => {})
    }
    return { status: 'BLOCK', durationMs: Date.now() - started, descendantReady: false, cancelRequested: Boolean(handle), waitCode: sanitizeCode(error), processGroupGone: false, signalPolicy: 'SIGTERM then SIGKILL after 1000 ms' }
  }
}

/** Executa smoke contratual sequencial; o import do módulo não chama nenhum CLI. */
export async function runSmoke({ host: hostName, out, baseDir = REPO_ROOT, spawn = nodeSpawn, killProcess, onEvent, timeoutMs = SMOKE_TIMEOUT_MS }) {
  if (!['claude', 'codex'].includes(hostName)) throw new TypeError('--host deve ser claude ou codex')
  const safeOut = await safeOutputDirectory(baseDir, out)
  const runId = `${hostName}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`
  const runDir = path.join(safeOut, runId)
  const fixtureDir = path.join(runDir, 'fixture')
  const runtimeDir = path.join(runDir, 'runtime')
  await mkdir(fixtureDir, { recursive: true, mode: 0o700 })
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 })

  const transport = spawn === nodeSpawn ? null : { spawn, killCalls: [] }
  const host = createHost({ host: hostName, cwd: fixtureDir, runDir: runtimeDir, runId, ...(transport ? { transport } : {}), killProcess: transport ? (...args) => transport.killCalls.push(args) : killProcess, onEvent, timeoutMs })
  const capabilities = host.capabilities()
  const version = await cliVersion(hostName, fixtureDir, spawn)
  const cliCapabilityError = !capabilities.roles.includes('executor') || !capabilities.roles.includes('planReviewer')
    || !capabilities.structuredOutput || capabilities.promptTransport !== 'stdin' || !capabilities.schemaTransport
    ? 'CAPABILITY_MISSING'
    : version.errorCode
  const evidence = []
  let overallStatus = 'PASS'
  let workerEvidence = null
  const workerResultPath = path.join(fixtureDir, 'worker-result.json')

  for (const role of ROLES) {
    const startedAt = new Date().toISOString()
    const started = Date.now()
    const nonce = randomUUID()
    const base = { runId, host: hostName, role, startedAt, cliVersion: version.version, capabilities, requestedModel: null, effectiveModel: null, usage: null, nonce }
    if (cliCapabilityError) {
      const row = { ...base, status: 'BLOCK', durationMs: Date.now() - started, error: { code: cliCapabilityError, message: cliCapabilityError === 'CAPABILITY_MISSING' ? 'Host sem o papel exigido.' : evidenceError({ code: cliCapabilityError }).message } }
      evidence.push(row)
      overallStatus = 'BLOCK'
      await writeEvidence(runDir, `${role}.json`, row)
      continue
    }
    if (role === 'planReviewer' && !workerEvidence) {
      const row = { ...base, status: 'BLOCK', durationMs: Date.now() - started, error: { code: 'WORKER_EVIDENCE_MISSING', message: 'Não há fixture válida do worker para revisar.' } }
      evidence.push(row)
      overallStatus = 'BLOCK'
      await writeEvidence(runDir, `${role}.json`, row)
      continue
    }
    let handle
    try {
      const prompt = role === 'worker'
        ? `Responda apenas com JSON estruturado conforme o schema. Copie nonce exatamente: ${nonce}. Defina status como "ok" e, se quiser, inclua detail curto. Não use ferramentas nem leia arquivos.`
        : `Leia a fixture worker-result.json no diretório atual. Confirme seu conteúdo real e responda apenas no schema. Copie nonce do revisor exatamente: ${nonce}. Copie nonce e status do worker para verifiedWorkerNonce e verifiedWorkerStatus. Defina verification como "valid" somente se a fixture for JSON válida e status for "ok"; caso contrário use "invalid". Não invente campos.`
      handle = await host.spawn({
        role,
        prompt,
        schema: role === 'worker' ? WORKER_SCHEMA : REVIEW_SCHEMA,
        readOnly: true,
        timeoutMs,
      })
      const result = await host.wait(handle)
      const nonceMatched = result.output?.nonce === nonce
      let evidenceMatched = null
      let workerStatus = null
      if (role === 'worker') {
        workerEvidence = { nonce: result.output?.nonce, status: result.output?.status, detail: result.output?.detail ?? null }
        await writeFile(workerResultPath, `${JSON.stringify(workerEvidence, null, 2)}\n`, { mode: 0o600 })
        workerStatus = result.output?.status
      } else {
        evidenceMatched = result.output?.verifiedWorkerNonce === workerEvidence?.nonce
          && result.output?.verifiedWorkerStatus === workerEvidence?.status
          && result.output?.verification === 'valid'
        workerStatus = result.output?.verifiedWorkerStatus
      }
      const status = nonceMatched && (role === 'worker'
        ? result.output?.status === 'ok'
        : evidenceMatched) ? 'PASS' : 'BLOCK'
      const row = {
        ...base,
        status,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        requestedModel: result.requestedModel,
        effectiveModel: result.effectiveModel,
        usage: result.usage,
        nonceMatched,
        ...(role === 'planReviewer' ? { evidenceMatched, verifiedWorkerStatus: workerStatus, workerFixture: 'fixture/worker-result.json' } : {}),
        output: result.output,
      }
      evidence.push(row)
      if (status !== 'PASS') overallStatus = 'BLOCK'
      await writeEvidence(runDir, `${role}.json`, row)
    } catch (error) {
      const row = { ...base, status: 'BLOCK', finishedAt: new Date().toISOString(), durationMs: Date.now() - started, requestedModel: handle?.built?.model ?? null, error: evidenceError(error) }
      evidence.push(row)
      overallStatus = 'BLOCK'
      await writeEvidence(runDir, `${role}.json`, row)
    }
  }

  const writeProbe = await runWriteProbe({ host, hostName, fixtureDir, runId, capabilities, version, cliCapabilityError, timeoutMs })
  await writeEvidence(runDir, 'writeProbe.json', writeProbe)
  if (writeProbe.status !== 'PASS') overallStatus = 'BLOCK'

  const cancellation = await cancellationProbe({ hostName, fixtureDir, runtimeDir, runId, killProcess })
  await writeEvidence(runDir, 'cancellation.json', cancellation)
  if (cancellation.status !== 'PASS') overallStatus = 'BLOCK'
  const summary = { runId, host: hostName, status: overallStatus, cliVersion: version.version, capabilities, roles: evidence, writeProbe, cancellation, completedAt: new Date().toISOString() }
  await writeEvidence(runDir, 'run.json', summary)
  return { ...summary, outputDirectory: runDir }
}

function parseArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host') options.host = args[++i]
    else if (args[i] === '--out') options.out = args[++i]
    else throw new Error(`Argumento desconhecido: ${args[i]}`)
  }
  if (!options.host) throw new Error('Uso: node bin/graph-smoke.mjs --host claude|codex [--out .graph-runs/smoke]')
  return options
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSmoke(parseArgs(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result.status !== 'PASS') process.exitCode = 2
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
  }
}

