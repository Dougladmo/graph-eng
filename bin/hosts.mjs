import { spawn as nodeSpawn } from 'node:child_process'
import { childEnv } from './child-env.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MODEL_BY_ROLE = {
  claude: {
    planner: 'sonnet', planReviewer: 'opus', designReviewer: 'opus', critic: 'sonnet',
    researcher: 'sonnet', designer: 'sonnet', notetaker: 'haiku',
    executor: 'haiku', verifier: 'haiku', synth: 'haiku',
  },
  codex: {
    planner: 'gpt-6.1-sol', planReviewer: 'gpt-6.1-sol', designReviewer: 'gpt-6.1-sol', critic: 'gpt-6.1-sol',
    researcher: 'gpt-6.1-sol', designer: 'gpt-6.1-sol', notetaker: 'gpt-6-luna',
    executor: 'gpt-6-luna', verifier: 'gpt-6-luna', synth: 'gpt-6-luna',
  },
}
const ROLE_ALIASES = {
  'plan-review': 'planReviewer', 'design-review': 'designReviewer',
  worker: 'executor', verify: 'verifier', repair: 'executor', polish: 'executor',
}
// Esforço de raciocínio por chamada (--effort do Claude Code). Fora desta lista a chamada é recusada; ausente = padrão do modelo.
const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const WEB_TOOLS = 'WebSearch,WebFetch'
const READ_ONLY = new Set(['planner', 'planReviewer', 'designReviewer', 'verifier', 'critic', 'synth', 'researcher', 'designer', 'notetaker'])
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_MS = 60 * 60 * 1000
const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 1024 * 1024
const TERMINATION_GRACE_MS = 1000
const SCHEMA_KEYS = new Set([
  '$schema', '$id', 'title', 'description', 'type', 'properties', 'required', 'items',
  'minItems', 'maxItems', 'enum', 'anyOf', 'minimum', 'maximum', 'minLength', 'maxLength',
  'additionalProperties',
])
const execFileAsync = promisify(execFile)
const SUPERVISOR_PATH = fileURLToPath(new URL('./host-supervisor.mjs', import.meta.url))

export class HostError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'HostError'
    this.code = code
    Object.assign(this, details)
  }
}

function roleFor(role) { return ROLE_ALIASES[role] ?? role }

function assertSchema(schema, at = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new HostError('INVALID_SCHEMA', `JSON Schema inválido em ${at}`)
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.has(key)) throw new HostError('UNSUPPORTED_SCHEMA', `Palavra-chave de schema não suportada: ${at}.${key}`)
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.length || types.some(type => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))) throw new HostError('INVALID_SCHEMA', `type inválido em ${at}`)
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) throw new HostError('INVALID_SCHEMA', `properties inválido em ${at}`)
    for (const [key, child] of Object.entries(schema.properties)) assertSchema(child, `${at}.properties.${key}`)
  }
  if (schema.items !== undefined) assertSchema(schema.items, `${at}.items`)
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || !schema.anyOf.length) throw new HostError('INVALID_SCHEMA', `anyOf inválido em ${at}`)
    schema.anyOf.forEach((child, i) => assertSchema(child, `${at}.anyOf[${i}]`))
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) throw new HostError('INVALID_SCHEMA', `required inválido em ${at}`)
  if (schema.required?.some(key => !Object.hasOwn(schema.properties ?? {}, key))) throw new HostError('INVALID_SCHEMA', `required referencia propriedade ausente em ${at}`)
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new HostError('INVALID_SCHEMA', `enum inválido em ${at}`)
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) throw new HostError('INVALID_SCHEMA', `${key} inválido em ${at}`)
  for (const key of ['minimum', 'maximum']) if (schema[key] !== undefined && typeof schema[key] !== 'number') throw new HostError('INVALID_SCHEMA', `${key} inválido em ${at}`)
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new HostError('UNSUPPORTED_SCHEMA', `additionalProperties deve ser false em ${at}`)
}

function hasNull(schema) {
  if (schema.anyOf) return schema.anyOf.some(hasNull)
  if (schema.type === 'null' || Array.isArray(schema.type) && schema.type.includes('null')) return true
  return schema.enum?.some(value => value === null) ?? false
}

function wireSchema(schema) {
  const result = {}
  for (const key of ['$schema', '$id', 'title', 'description', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined) result[key] = schema[key]
  }
  if (schema.anyOf) result.anyOf = schema.anyOf.map(wireSchema)
  if (schema.type !== undefined) result.type = schema.type
  else if (schema.enum?.length) {
    const types = [...new Set(schema.enum.map(jsonType))]
    if (types.length === 1) result.type = types[0]
    else result.anyOf = [...new Set(types)].map(type => ({ type }))
  }
  if (schema.items) result.items = wireSchema(schema.items)
  if (schema.properties) {
    result.type = 'object'
    const originalRequired = new Set(schema.required ?? [])
    result.properties = {}
    result.required = Object.keys(schema.properties)
    for (const [key, child] of Object.entries(schema.properties)) {
      const strictChild = wireSchema(child)
      result.properties[key] = originalRequired.has(key) || hasNull(child)
        ? strictChild
        : { anyOf: [strictChild, { type: 'null' }] }
    }
    result.additionalProperties = false
  } else if (schema.required || schema.additionalProperties === false) {
    result.type ??= 'object'
    result.properties ??= {}
    result.required = schema.required ?? []
    result.additionalProperties = false
  }
  return result
}

function jsonType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value === 'object' ? 'object' : typeof value
}

function normalizeOutput(value, original, wire) {
  if (wire.anyOf) {
    if (value === null && !hasNull(original)) return null
    const branch = wire.anyOf.find(candidate => matchesSimple(value, candidate))
    return branch ? normalizeOutput(value, original, branch) : value
  }
  if (wire.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const out = { ...value }
    for (const key of Object.keys(wire.properties ?? {})) {
      const originalChild = original.properties?.[key]
      if (out[key] === null && originalChild && !hasNull(originalChild) && !(original.required ?? []).includes(key)) delete out[key]
      else if (key in out && originalChild) out[key] = normalizeOutput(out[key], originalChild, wire.properties[key])
    }
    return out
  }
  if (wire.type === 'array' && Array.isArray(value) && original.items) return value.map(item => normalizeOutput(item, original.items, wire.items))
  return value
}

function matchesSimple(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(child => matchesSimple(value, child))
  if (schema.type === undefined) return true
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  return types.includes(jsonType(value)) || types.includes('number') && typeof value === 'number' || types.includes('object') && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateSchema(value, schema, at = '$') {
  if (schema.anyOf) {
    if (!schema.anyOf.some(candidate => { try { validateSchema(value, candidate, at); return true } catch { return false } })) throw new HostError('INVALID_OUTPUT', `Saída não corresponde a anyOf em ${at}`)
  }
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new HostError('INVALID_OUTPUT', `Valor fora do enum em ${at}`)
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]
  if (types.length && !types.some(type => type === jsonType(value) || type === 'number' && typeof value === 'number' || type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value))) throw new HostError('INVALID_OUTPUT', `Tipo inválido em ${at}`)
  if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) throw new HostError('INVALID_OUTPUT', `Número fora do intervalo em ${at}`)
  if (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength) throw new HostError('INVALID_OUTPUT', `Texto fora do tamanho permitido em ${at}`)
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) throw new HostError('INVALID_OUTPUT', `Array fora do tamanho permitido em ${at}`)
    if (schema.items) value.forEach((item, i) => validateSchema(item, schema.items, `${at}[${i}]`))
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) throw new HostError('INVALID_OUTPUT', `Campo obrigatório ausente: ${at}.${key}`)
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) validateSchema(child, schema.properties[key], `${at}.${key}`)
      else if (schema.additionalProperties === false) throw new HostError('INVALID_OUTPUT', `Campo inesperado: ${at}.${key}`)
    }
  }
}

function errorFromCli(host, code, message, stderr = '', extra = {}) {
  const detail = `${message}\n${stderr}`
  if (/auth|login|credential|unauthorized|api key|subscription.{0,30}(disabled|access)|organization.{0,30}disabled/i.test(detail)) return new HostError('AUTH_FAILED', `${host}: autenticação falhou`, { stderr, ...extra })
  if (/model.{0,30}(not found|unavailable|unknown)|does not exist/i.test(detail)) return new HostError('MODEL_UNAVAILABLE', `${host}: modelo indisponível`, { stderr, ...extra })
  return new HostError(code, `${host}: ${message}`, { stderr, ...extra })
}

// Envelope is_error do Claude: sem `result`, o motivo está em subtype/errors. Uso, modelo e negações seguem
// no erro para o benchmark contar o custo da chamada que falhou.
function claudeEnvelopeError(host, envelope, stderr) {
  const errors = Array.isArray(envelope.errors) ? envelope.errors.map(String) : []
  const why = [envelope.subtype, errors.join('; ')].filter(Boolean).join(': ')
  const message = envelope.result ?? (why ? `Claude retornou erro (${why})` : 'Claude retornou erro')
  const usage = envelope.modelUsage ?? envelope.usage ?? null
  const modelIds = Object.keys(envelope.modelUsage ?? {})
  return errorFromCli(host, 'CLI_FAILED', message, stderr, {
    subtype: envelope.subtype ?? null,
    usage,
    effectiveModel: modelIds.length === 1 ? modelIds[0] : null,
    permissionDenials: Array.isArray(envelope.permission_denials) ? envelope.permission_denials : [],
  })
}

function classifyExitFailure(host, stdout, stderr, exitCode, signal) {
  if (host === 'claude') {
    try {
      const envelope = JSON.parse(stdout)
      if (envelope?.is_error) return claudeEnvelopeError(host, envelope, stderr)
    } catch { /* saída sem envelope: classificar pelo código de processo */ }
  } else {
    const rows = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
    const failed = rows.find(row => row && typeof row === 'object' && (row.type === 'turn.failed' || row.type === 'error' || row.type === 'item.completed' && row.item?.type === 'error'))
    if (failed) return errorFromCli(host, 'CLI_FAILED', JSON.stringify(failed), stderr)
  }
  return errorFromCli(host, 'CLI_FAILED', `CLI terminou com código ${exitCode ?? signal}`, stderr)
}

function samePath(left, right) { return path.resolve(left) === path.resolve(right) }

// Transporte experimental do benchmark (B4): só existe quando createHost recebe experimentalPolicy.
// Sem essa opção, o caminho de produto (MODEL_BY_ROLE, READ_ONLY, MODEL_MISMATCH) permanece idêntico.
function validateExperimentalPolicy(policy, host) {
  if (!policy || typeof policy !== 'object') throw new TypeError('experimentalPolicy inválida')
  if (policy.host !== host) throw new TypeError('experimentalPolicy.host diverge do host')
  for (const field of ['models', 'readOnly']) if (!policy[field] || typeof policy[field] !== 'object') throw new TypeError(`experimentalPolicy.${field} é obrigatório`)
  for (const [role, model] of Object.entries(policy.models)) if (typeof model !== 'string' || !model) throw new TypeError(`modelo experimental inválido para ${role}`)
  for (const [role, flag] of Object.entries(policy.readOnly)) if (typeof flag !== 'boolean') throw new TypeError(`readOnly experimental inválido para ${role}`)
}

/**
 * Adapta Claude Code ou Codex CLI. Papéis canônicos: planner, planReviewer,
 * designReviewer, executor, verifier, critic e synth. Aliases aceitos:
 * plan-review, design-review, worker, verify, repair e polish. readOnly pode
 * restringir executor; papéis de revisão/verificação já são sempre read-only.
 * writeScope é rejeitado até haver enforcement real. A disponibilidade de
 * modelo permanece desconhecida até o CLI executar e reportar o identificador.
 */
// C14: onTransportPaths({ id, files, phase: 'created' | 'removed' }) recebe os nomes exatos (relativos à runDir) dos arquivos de transporte
// do codex. 'created' roda antes de gravar o schema; 'removed' roda depois da limpeza, e o dono exige que os caminhos tenham sumido.
export function createHost({ host, cwd, runDir, runId = randomUUID(), transport, commandTransform = spec => spec, killProcess = process.kill.bind(process), onEvent = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, onTransportPaths = null, experimentalPolicy = null }) {
  if (!MODEL_BY_ROLE[host]) throw new TypeError(`Host desconhecido: ${host}`)
  if (experimentalPolicy) validateExperimentalPolicy(experimentalPolicy, host)
  if (!cwd || !runDir) throw new TypeError('cwd e runDir são obrigatórios')
  let eventSeq = 0

  function emit(event, request, handle, extra = {}) {
    try { (request.onEvent ?? onEvent)({ event, host, role: roleFor(request.role), id: handle.id, runId, seq: ++eventSeq, at: new Date().toISOString(), ...extra }) } catch { /* callbacks são observabilidade */ }
  }

  function prepare(request, id) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new HostError('INVALID_REQUEST', 'Solicitação inválida')
    const role = roleFor(request.role)
    const model = experimentalPolicy
      ? (Object.hasOwn(experimentalPolicy.models, role) ? experimentalPolicy.models[role] : undefined)
      : MODEL_BY_ROLE[host][role]
    if (experimentalPolicy && !model) throw new HostError('EXPERIMENT_ROLE_UNMAPPED', `Papel fora do mapa experimental: ${request.role}`)
    if (!model) throw new HostError('UNKNOWN_ROLE', `Papel desconhecido: ${request.role}`)
    if (request.model && request.model !== model) throw new HostError('MODEL_MISMATCH', `Modelo do papel ${request.role} deve ser ${model}`)
    if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw new HostError('INVALID_PROMPT', 'prompt deve ser texto não vazio')
    if (!request.schema || typeof request.schema !== 'object' || Array.isArray(request.schema)) throw new HostError('INVALID_SCHEMA', 'Cada solicitação exige JSON Schema')
    if (request.writeScope !== undefined) throw new HostError('UNSUPPORTED_WRITE_SCOPE', 'writeScope ainda não é aplicado pelo adaptador')
    if (request.effort !== undefined && !REASONING_EFFORTS.has(request.effort)) throw new HostError('INVALID_EFFORT', `effort deve ser um de ${[...REASONING_EFFORTS].join(', ')}`)
    assertSchema(request.schema)
    const effectiveTimeout = request.timeoutMs ?? timeoutMs
    if (!Number.isFinite(effectiveTimeout) || effectiveTimeout <= 0 || effectiveTimeout > MAX_TIMEOUT_MS) throw new HostError('INVALID_TIMEOUT', `timeoutMs deve estar entre 1 e ${MAX_TIMEOUT_MS}`)
    if (request.cwd !== undefined && !samePath(request.cwd, cwd)) throw new HostError('CWD_MISMATCH', 'request.cwd diverge do cwd configurado no host')
    const readonly = experimentalPolicy ? experimentalPolicy.readOnly[role] === true || request.readOnly === true : READ_ONLY.has(role) || request.readOnly === true
    // B3: o Claude Code nega Write em cwd com segmento .claude (dontAsk); recusa antes do spawn em vez de falhar no meio.
    if (host === 'claude' && !readonly && path.resolve(cwd).split(path.sep).includes('.claude')) throw new HostError('CWD_PROTECTED_PATH', 'papel de escrita do claude não roda sob diretório .claude (dontAsk nega Write)')
    const strict = wireSchema(request.schema)
    // Isolado do ambiente do usuário (MCPs, skills, settings globais): sem isso cada turno carregava ~75k tokens.
    // dontAsk nega toda ferramenta sem regra de permissão: a escrita do executor precisa de --allowedTools,
    // e Edit(./**) (vale também para Write) a prende ao cwd do spawn.
    // Só o researcher (Sonnet, só leitura) lê a web: docs atuais da biblioteca na versão instalada. Nenhum papel de escrita tem web.
    const readTools = role === 'researcher' && readonly ? `Read,Glob,Grep,${WEB_TOOLS}` : 'Read,Glob,Grep'
    if (host === 'claude') return {
      role, model, readonly, schema: request.schema, wireSchema: strict,
      command: 'claude', args: ['-p', '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(strict), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', 'project,local', '--permission-mode', 'dontAsk', '--allowedTools', readonly ? readTools : 'Read,Glob,Grep,Edit(./**)', '--tools', readonly ? readTools : 'Read,Glob,Grep,Edit,Write', ...(request.effort ? ['--effort', request.effort] : [])],
    }
    const schemaFile = path.join(runDir, `.host-${id}.schema.json`)
    const outputFile = path.join(runDir, `.host-${id}.output.json`)
    return { role, model, readonly, schema: request.schema, wireSchema: strict, command: 'codex', args: ['exec', '--model', model, '-s', readonly ? 'read-only' : 'workspace-write', '--json', '--output-schema', schemaFile, '--output-last-message', outputFile, '-C', cwd, '-'], schemaFile, outputFile, schemaText: JSON.stringify(strict) }
  }

  function capabilities() {
    const readOnlyEnforced = host === 'claude' || process.platform !== 'win32'
    const readOnlyEnforcement = host === 'claude'
      ? 'Claude Code usa permission-mode dontAsk e limita as ferramentas a Read, Glob e Grep; não oferece ferramenta de escrita nem shell. Papéis de escrita só gravam dentro do cwd (Edit(./**)).'
      : readOnlyEnforced ? 'Codex CLI usa -s read-only para restringir gravações no sandbox do sistema de arquivos.' : null
    return { host, cli: host === 'claude' ? 'claude' : 'codex', roles: Object.keys(MODEL_BY_ROLE[host]), structuredOutput: true, schemaTransport: host === 'claude' ? 'json-schema-argument' : 'schema-file', promptTransport: 'stdin', lifecycleEvents: true, cancellation: process.platform === 'win32' ? 'process' : 'process-group', modelAvailability: 'unknown', readOnlyEnforced, readOnlyEnforcement, agentShell: host === 'codex', agentWeb: host === 'claude' && !experimentalPolicy }
  }

  async function spawnRequest(request) {
    const id = randomUUID()
    const built = prepare(request, id)
    const effectiveTimeout = request.timeoutMs ?? timeoutMs
    await mkdir(runDir, { recursive: true })
    const transportNames = built.schemaFile ? [built.schemaFile, built.outputFile].map(file => path.basename(file)) : []
    const schemaHash = built.schemaFile ? createHash('sha256').update(built.schemaText).digest('hex') : null
    if (built.schemaFile && onTransportPaths) await onTransportPaths({ id, files: transportNames, phase: 'created' })
    if (built.schemaFile) {
      try { await writeFile(built.schemaFile, built.schemaText, { mode: 0o600 }) }
      catch (error) {
        // Falha ao gravar o schema: remove o que sobrou e solta o efêmero; sobra no disco fica como violação no release.
        await rm(built.schemaFile, { force: true }).catch(() => {})
        if (onTransportPaths) await onTransportPaths({ id, files: transportNames, phase: 'removed' }).catch(() => {})
        throw error
      }
    }
    let child
    const injectedTransport = transport ?? null
    try {
      child = injectedTransport
        ? injectedTransport.spawn(built.command, built.args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() })
        : process.platform === 'win32'
          ? nodeSpawn(built.command, built.args, { cwd, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() })
          // O supervisor herda este env filtrado e o repassa ao CLI do agente.
          : nodeSpawn(process.execPath, [SUPERVISOR_PATH, String(effectiveTimeout)], { cwd, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: childEnv() })
    } catch (error) {
      await Promise.all([built.schemaFile, built.outputFile].filter(Boolean).map(file => rm(file, { force: true }).catch(() => {})))
      if (built.schemaFile && onTransportPaths) await onTransportPaths({ id, files: transportNames, phase: 'removed' }).catch(() => {})
      const code = error.code === 'ENOENT' ? 'CLI_MISSING' : 'SPAWN_FAILED'
      throw new HostError(code, `${host}: ${built.command} indisponível (${error.message})`, { cause: error })
    }
    let resolveSettlement
    const settlement = new Promise(resolve => { resolveSettlement = resolve })
    const handle = {
      id, child, request, built, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
      settled: false, finalizing: false, cancelled: false, timedOut: false, termination: null, timer: null, killTimer: null,
      startedAt: Date.now(), supervised: !injectedTransport && process.platform !== 'win32', cliExit: null, supervisorError: null, drainAck: null, closeSignal: null, pendingTermination: null,
    }
    emit('spawn', request, handle, { pid: child.pid, requestedModel: built.model, ...(experimentalPolicy ? { experimental: true } : {}) })

    const safeCleanup = async () => {
      clearTimeout(handle.timer)
      const cleanupErrors = []
      // C14: o schema é imutável durante o handle; qualquer troca de bytes vira falha de limpeza (fechada).
      if (built.schemaFile) {
        const current = await readFile(built.schemaFile).catch(() => null)
        if (!current || createHash('sha256').update(current).digest('hex') !== schemaHash) cleanupErrors.push(new HostError('TRANSPORT_SCHEMA_CHANGED', `${host}: schema de transporte alterado durante a execução`))
      }
      for (const file of [built.schemaFile, built.outputFile].filter(Boolean)) {
        try { await rm(file, { force: true }) } catch (error) { cleanupErrors.push(error) }
      }
      if (built.schemaFile && onTransportPaths) {
        // Os dois caminhos precisam ter sumido: sobra é violação no dono do guard.
        try { await onTransportPaths({ id, files: transportNames, phase: 'removed' }) } catch (error) { cleanupErrors.push(error) }
      }
      return cleanupErrors
    }
    const signalGroup = signal => {
      if (process.platform === 'win32') { try { child.kill(signal) } catch {} ; return }
      if (!child.pid) return
      try { killProcess(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') handle.killError ??= error }
    }
    const terminate = reason => {
      if (handle.termination) return handle.termination
      handle.cancelled = reason === 'cancelled'
      handle.timedOut = reason === 'timeout'
      emit(reason === 'cancelled' ? 'cancelling' : 'terminating', request, handle, { reason })
      if (handle.supervised) {
        handle.pendingTermination = reason
        try { child.send?.({ type: 'terminate', reason }) } catch {}
        handle.termination = Promise.resolve()
        return handle.termination
      }
      signalGroup('SIGTERM')
      handle.termination = new Promise(resolve => {
        handle.killTimer = setTimeout(() => { signalGroup('SIGKILL'); resolve() }, TERMINATION_GRACE_MS)
      })
      return handle.termination
    }
    const finish = async (error, result) => {
      if (handle.settled) return
      handle.settled = true
      clearTimeout(handle.timer)
      if (handle.termination) await handle.termination
      clearTimeout(handle.killTimer)
      let drainError = null
      if (handle.supervised && process.platform !== 'win32' && child.pid) {
        try {
          // This is a read-only postcondition check. It never authorizes a
          // signal: a reused PGID can only make us fail closed. The sentinel
          // owns TERM/KILL while alive; its loss or a setsid escape is outside
          // the guarantee and must not be repaired by signaling this number.
          const started = Date.now()
          while (Date.now() - started < 2000) {
            const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pgid=,stat='], { timeout: 1000, maxBuffer: 256 * 1024 })
            const states = stdout.split(/\r?\n/).flatMap(line => {
              const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/)
              return match?.[2] === String(child.pid) ? [match[3]] : []
            })
            if (!states.length || states.every(state => state.startsWith('Z'))) break
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pgid=,stat='], { timeout: 1000, maxBuffer: 256 * 1024 })
          const states = stdout.split(/\r?\n/).flatMap(line => {
            const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/)
            return match?.[2] === String(child.pid) ? [match[3]] : []
          })
          if (states.some(state => !state.startsWith('Z'))) drainError = new Error('Ainda há processos ativos no grupo supervisionado')
        } catch (failure) {
          if (failure.code !== 'ESRCH') drainError = failure
        }
      }
      const cleanupErrors = await safeCleanup()
      if (handle.supervised && (!handle.drainAck?.flushed || handle.closeSignal !== 'SIGKILL')) {
        drainError ??= new Error('O supervisor não confirmou a drenagem e o encerramento esperado')
      }
      if (handle.supervisorError) drainError ??= new Error(`Falha no supervisor: ${handle.supervisorError.message}`)
      const cleanupFailure = drainError || cleanupErrors.length ? new HostError('CLEANUP_FAILED', 'Não foi possível confirmar a limpeza completa da execução', { cause: drainError, errors: cleanupErrors }) : null
      let finalError = error ?? cleanupFailure
      if (error && cleanupFailure) {
        // Keep the agent's own code, but never let it hide an unproven drain.
        error.drainUnproven = true
        error.cleanupCause = cleanupFailure
        error.cleanupErrors = cleanupErrors
      }
      if (finalError) {
        emit(handle.cancelled ? 'cancelled' : 'failed', request, handle, { code: finalError.code ?? 'HOST_FAILED', message: finalError.message })
        resolveSettlement({ error: finalError })
      } else {
        emit('completed', request, handle, { output: result.output })
        resolveSettlement({ result })
      }
    }

    const append = (stream, chunk) => {
      const text = String(chunk)
      const bytes = Buffer.byteLength(text)
      if (stream === 'stdout') {
        handle.stdoutBytes += bytes
        if (handle.stdoutBytes > MAX_STDOUT_BYTES) { handle.outputOverflow = 'stdout'; terminate('output-limit'); return }
        handle.stdout += text
      } else {
        handle.stderrBytes += bytes
        if (handle.stderrBytes <= MAX_STDERR_BYTES) handle.stderr += text
        else handle.stderrOverflow = true
      }
    }
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', chunk => append('stdout', chunk))
    child.stderr?.on('data', chunk => append('stderr', chunk))
    child.stdout?.on('error', error => { handle.streamError ??= error; terminate('stream-error') })
    child.stderr?.on('error', error => { handle.streamError ??= error; terminate('stream-error') })
    child.stdin?.on('error', error => { handle.stdinError ??= error })
    child.on('error', error => {
      const code = error.code === 'ENOENT' ? 'CLI_MISSING' : 'SPAWN_FAILED'
      void finish(new HostError(code, `${host}: ${built.command} indisponível (${error.message})`, { cause: error }))
    })
    if (handle.supervised) child.on('message', message => {
      if (message?.type === 'ready') {
        if (handle.pendingTermination || handle.cancelled || handle.timedOut) {
          try { child.send({ type: 'terminate', reason: handle.pendingTermination ?? 'cancelled' }) } catch {}
        } else {
          try {
            const spec = commandTransform({ command: built.command, args: built.args, cwd, request })
            child.send({ type: 'start', command: spec.command, args: spec.args, cwd: spec.cwd ?? cwd, timeoutMs: Math.max(1, effectiveTimeout - (Date.now() - handle.startedAt)) })
          } catch (error) {
            handle.supervisorError ??= error
            try { child.send({ type: 'terminate', reason: 'transport-error' }) } catch {}
          }
        }
      } else if (message?.type === 'cliExit') {
        handle.cliExit = message
        handle.finalizing = true
        clearTimeout(handle.timer)
      } else if (message?.type === 'cliError') {
        handle.cliError = message
        handle.finalizing = true
        clearTimeout(handle.timer)
      }
      else if (message?.type === 'timeout' && !handle.timedOut) {
        handle.timedOut = true
        clearTimeout(handle.timer)
        emit('terminating', request, handle, { reason: 'timeout' })
      }
      else if (message?.type === 'supervisorError') handle.supervisorError = message
      else if (message?.type === 'drainAck') handle.drainAck = message
      else if (message?.type === 'stdinError') handle.stdinError ??= new Error(message.message)
      else if (message?.type === 'streamError') handle.streamError ??= new Error(message.message)
    })
    child.on('close', async (exitCode, signal) => {
      handle.closeSignal = signal
      if (handle.supervised && !handle.cliExit && !handle.cliError && !handle.cancelled && !handle.timedOut) {
        void finish(new HostError('CLEANUP_FAILED', 'O supervisor encerrou sem metadados confiáveis do CLI', { supervisorError: handle.supervisorError }))
        return
      }
      if (handle.supervised && handle.cliError) {
        const code = handle.cliError.code === 'ENOENT' ? 'CLI_MISSING' : 'SPAWN_FAILED'
        void finish(new HostError(code, `${host}: ${built.command} indisponível (${handle.cliError.message})`))
        return
      }
      const actualExitCode = handle.supervised ? handle.cliExit?.code : exitCode
      const actualSignal = handle.supervised ? handle.cliExit?.signal : signal
      let error = null
      let output
      if (handle.cancelled) error = new HostError('CANCELLED', `${host}: execução cancelada`)
      else if (handle.timedOut) error = new HostError('TIMEOUT', `${host}: excedeu ${effectiveTimeout} ms`)
      else if (handle.outputOverflow) error = new HostError('OUTPUT_LIMIT', `${host}: stdout excedeu ${MAX_STDOUT_BYTES} bytes`)
      else if (handle.streamError) error = new HostError('STREAM_FAILED', `${host}: falha ao ler saída (${handle.streamError.message})`, { cause: handle.streamError })
      else if (actualExitCode !== 0) {
        error = classifyExitFailure(host, handle.stdout, handle.stderr, actualExitCode, actualSignal)
        if (error.code === 'CLI_FAILED' && handle.stdinError) error = new HostError('STDIN_FAILED', `${host}: falha ao enviar prompt (${handle.stdinError.message})`, { cause: handle.stdinError })
      }
      else if (handle.stdinError) error = new HostError('STDIN_FAILED', `${host}: falha ao enviar prompt (${handle.stdinError.message})`, { cause: handle.stdinError })
      if (!error) {
        try {
          let finalText
          if (host === 'claude') {
            const envelope = JSON.parse(handle.stdout)
            if (envelope.is_error) throw claudeEnvelopeError(host, envelope, handle.stderr)
            finalText = envelope.structured_output ?? envelope.result
            const modelIds = Object.keys(envelope.modelUsage ?? {})
            handle.effectiveModel = modelIds.length === 1 ? modelIds[0] : null
            handle.usage = envelope.modelUsage ?? envelope.usage ?? null
            // B3: negações de permissão do Claude ficam visíveis ao benchmark (calls.jsonl).
            handle.permissionDenials = Array.isArray(envelope.permission_denials) ? envelope.permission_denials : []
          } else {
            const rows = handle.stdout.split(/\r?\n/).filter(Boolean).map(row => JSON.parse(row))
    const failed = rows.find(row => row && typeof row === 'object' && (row.type === 'turn.failed' || row.type === 'error' || row.type === 'item.completed' && row.item?.type === 'error'))
            if (failed) throw errorFromCli(host, 'CLI_FAILED', JSON.stringify(failed), handle.stderr)
            const completed = rows.findLast(row => row.type === 'turn.completed')
            handle.effectiveModel = rows.findLast(row => typeof row.model === 'string')?.model ?? null
            handle.usage = completed?.usage ?? null
            // C14: a saída precisa ser arquivo regular do próprio handle; symlink no caminho é recusado antes da leitura.
            const outputStat = await lstat(built.outputFile)
            if (!outputStat.isFile()) throw new HostError('TRANSPORT_OUTPUT_UNSAFE', `${host}: arquivo de saída não é regular`)
            if (outputStat.size > MAX_STDOUT_BYTES) throw new HostError('OUTPUT_LIMIT', `${host}: arquivo de saída excedeu ${MAX_STDOUT_BYTES} bytes`)
            finalText = await readFile(built.outputFile, 'utf8')
          }
          output = typeof finalText === 'string' ? JSON.parse(finalText) : finalText
          output = normalizeOutput(output, built.schema, built.wireSchema)
          validateSchema(output, built.schema)
        } catch (failure) {
          error = failure instanceof HostError ? failure : new HostError('INVALID_OUTPUT', `${host}: saída estruturada inválida (${failure.message})`, { cause: failure })
        }
      }
      await finish(error, { output, requestedModel: built.model, effectiveModel: handle.effectiveModel ?? null, usage: handle.usage ?? null, exitCode: actualExitCode, permissionDenials: handle.permissionDenials ?? [] })
    })
    child.stdin?.end(request.prompt)
    handle.timer = setTimeout(() => { if (!handle.settled) void terminate('timeout') }, effectiveTimeout)
    handle.timer.unref?.()
    handle.wait = () => settlement.then(({ error, result }) => { if (error) throw error; return result })
    return handle
  }

  return {
    capabilities,
    spawn: spawnRequest,
    wait(handle) { return handle.wait() },
    cancel(handle) {
      if (!handle || handle.settled || handle.finalizing) return false
      void terminateForHandle(handle)
      return true
    },
  }

  function terminateForHandle(handle) {
    if (handle.termination) return handle.termination
    handle.cancelled = true
    emit('cancelling', handle.request, handle)
    const child = handle.child
    if (handle.supervised) {
      handle.pendingTermination = 'cancelled'
      try { child.send?.({ type: 'terminate', reason: 'cancelled' }) } catch {}
      handle.termination = Promise.resolve()
      return handle.termination
    }
    const signalGroup = signal => {
      if (process.platform === 'win32') { try { child.kill(signal) } catch {}; return }
      if (child.pid) { try { killProcess(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') handle.killError ??= error } }
    }
    signalGroup('SIGTERM')
    handle.termination = new Promise(resolve => {
      handle.killTimer = setTimeout(() => { signalGroup('SIGKILL'); resolve() }, TERMINATION_GRACE_MS)
    })
    return handle.termination
  }
}

