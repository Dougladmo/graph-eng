#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runGraph } from './graph-run.mjs'
import { NODE_CHECK_MAPPING_HASH, NODE_CHECK_POLICY_ID } from './node-check-policy.mjs'
import { defaultConfigPath, readConfig, resolveConfig, validateConfig } from './config.mjs'

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REMOVED = new Set(['--ceiling', '--economy', '--width', '--model', '--planner-model', '--reviewer-model', '--executor-model', '--max-rounds', '--max-repairs', '--plan-gate', '--lean', '--high', '--manual', '--auto', '--max-agents'])
const EFFORTS = new Set(['low', 'medium', 'max'])
const ADAPTIVE = new Set(['on', 'off'])
const COMMANDS = ['plan', 'clarify', 'tasks', 'implemente', 'init']
const TASK_FREE_COMMANDS = new Set(['clarify', 'tasks'])
// Tabela do brief (I1): cada comando vira exatamente um runGraph com este pipeline.
const PIPELINE_BY_COMMAND = {
  plan: { from: 'plan', to: 'plan' },
  clarify: { from: 'clarify', to: 'clarify' },
  tasks: { from: 'tasks', to: 'tasks' },
  implemente: { from: 'auto', to: 'implement' },
}
const INTERNAL = new Set(['--stage', '--pipeline', '--plan', '--plan-only', '--from', '--to', '--reuse', '--no-reuse', '--run-dir', '--run-id', '--resume', '--mode', '--checks', '--context', '--spec', '--done-when', '--host', '--answers'])
const ENVELOPE_KEYS = new Set(['host', 'argv', 'clarification'])
const CLARIFY_QUESTION_IDS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']
const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/

export function parseGrapheng(argv) {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) throw new TypeError('argv precisa ser uma lista de textos')
  const [command, ...tail] = argv
  if (!COMMANDS.includes(command)) throw new Error(command === 'implement' ? 'comando desconhecido; use implemente' : `comando desconhecido; use ${COMMANDS.join(', ')}`)
  let effort
  let adaptive
  const taskTokens = []
  let literal = false
  for (let i = 0; i < tail.length; i++) {
    const token = tail[i]
    if (!literal && token === '--') { literal = true; continue }
    if (!literal && token.startsWith('--effort=')) {
      const value = token.slice('--effort='.length)
      throw new Error(`--effort=${value} não é aceito; use --effort ${value}`)
    }
    if (!literal && token === '--effort') {
      if (effort !== undefined) throw new Error('--effort repetido')
      const value = tail[++i]
      if (!EFFORTS.has(value)) throw new Error('--effort aceita somente low, medium ou max')
      effort = value
      continue
    }
    if (!literal && token.startsWith('--adaptive=')) {
      const value = token.slice('--adaptive='.length)
      throw new Error(`--adaptive=${value} não é aceito; use --adaptive ${value}`)
    }
    if (!literal && token === '--adaptive') {
      if (adaptive !== undefined) throw new Error('--adaptive repetido')
      const value = tail[++i]
      if (!ADAPTIVE.has(value)) throw new Error('--adaptive aceita somente on ou off')
      adaptive = value
      continue
    }
    if (!literal && token.startsWith('-')) {
      const flag = token.split('=')[0]
      if (REMOVED.has(flag)) throw new Error(`${flag}: opção removida`)
      if (INTERNAL.has(flag)) throw new Error(`${flag}: opção interna, não pública`)
      throw new Error(`opção desconhecida: ${token}; use -- para tarefa iniciada por hífen`)
    }
    taskTokens.push(token)
  }
  if (command === 'init') {
    if (taskTokens.length || effort !== undefined || adaptive !== undefined) throw new Error('init não recebe tarefa, esforço nem --adaptive')
    return { command }
  }
  if (TASK_FREE_COMMANDS.has(command)) {
    if (taskTokens.length) throw new Error('clarify/tasks usam o plano aprovado do workspace; não recebem tarefa')
    return { command, ...(effort ? { effort } : {}), ...(adaptive ? { adaptive } : {}) }
  }
  const task = taskTokens.join(' ')
  if (taskTokens.length && !task.trim()) throw new Error('tarefa vazia')
  if (command === 'plan' && !task) throw new Error('plan exige uma tarefa')
  return { command, ...(task ? { task } : {}), ...(effort ? { effort } : {}), ...(adaptive ? { adaptive } : {}) }
}

// Valida a forma das respostas de clarify. Não compara questionSetId com o slot: isso só entra no passo R.
export function validateClarificationAnswers(value) {
  const fail = message => { throw new Error(`clarification inválida: ${message}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('objeto esperado')
  for (const key of Object.keys(value)) if (!['questionSetId', 'answers'].includes(key)) fail(`campo não permitido: ${key}`)
  if (typeof value.questionSetId !== 'string' || !/^[a-f0-9]{64}$/.test(value.questionSetId)) fail('questionSetId precisa ser hash hex de 64 caracteres')
  if (!Array.isArray(value.answers) || value.answers.length < 1 || value.answers.length > 5) fail('answers precisa ter de 1 a 5 itens')
  const seen = new Set()
  for (const item of value.answers) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('cada resposta precisa ser objeto')
    for (const key of Object.keys(item)) if (!['questionId', 'answer', 'skipped'].includes(key)) fail(`campo não permitido: ${key}`)
    if (!CLARIFY_QUESTION_IDS.includes(item.questionId)) fail(`questionId desconhecido: ${item.questionId}`)
    if (seen.has(item.questionId)) fail(`questionId duplicado: ${item.questionId}`)
    seen.add(item.questionId)
    if (item.skipped !== undefined && typeof item.skipped !== 'boolean') fail(`skipped precisa ser boolean (${item.questionId})`)
    if (item.skipped === true) {
      if (item.answer !== undefined) fail(`skipped:true não aceita answer (${item.questionId})`)
      continue
    }
    if (typeof item.answer !== 'string') fail(`${item.questionId} precisa de resposta ou skipped:true explícito`)
    if (!item.answer.trim()) fail(`resposta vazia (${item.questionId})`)
    if ([...item.answer].length > 500) fail(`${item.questionId}: resposta acima de 500 caracteres`)
    if (CONTROL_CHARS.test(item.answer)) fail(`${item.questionId}: caractere de controle não permitido`)
  }
  return value
}


function validateHost(host) {
  if (!['claude', 'codex'].includes(host)) throw new Error('host confiável obrigatório: claude ou codex')
  return host
}

async function configuredEffort(flag) {
  const raw = flag === undefined ? {} : { effort: flag }
  const checked = validateConfig(raw)
  if (!checked.ok) throw new Error(`esforço inválido: ${checked.errors.effort}`)
  const configFile = defaultConfigPath()
  const read = readConfig(configFile)
  const resolved = resolveConfig({ flags: checked.value, stored: read.stored })
  return { effort: resolved.config.effort, effortSource: resolved.source.effort }
}

export async function discoverChecks(cwd, { packageReader = file => readFile(file, 'utf8'), affectedTests } = {}) {
  const unsupported = 'Execução ainda suportada apenas para Node com scripts.test exatamente node --test; este repositório exige adapter confiável de checks que ainda não está implementado. Planejamento permanece disponível.'
  if (affectedTests !== undefined) return { checks: [], block: 'seleção local de testes só pode ser derivada pela política confiável do supervisor' }
  let pkg
  let source
  try {
    source = await packageReader(path.join(cwd, 'package.json'))
    pkg = JSON.parse(source)
  }
  catch { return { checks: [], block: unsupported } }
  if (pkg?.scripts?.test !== 'node --test') return { checks: [], block: unsupported }
  const args = ['--test', '--test-concurrency=2']
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8')
  return {
    checks: [{ id: 'node-test', command: process.execPath, args, cwd: '.', timeoutMs: 1_800_000, heavy: true }],
    checkContract: { path: 'package.json', sha256: createHash('sha256').update(bytes).digest('hex'), source: 'scripts.test=node --test' },
    nodeCheckPolicy: { id: NODE_CHECK_POLICY_ID, mappingHash: NODE_CHECK_MAPPING_HASH, adapter: 'node-test-v1', concurrency: 2 },
  }
}

async function startPanel({ spawnImpl = spawn } = {}) {
  const watchPath = path.join(PLUGIN_ROOT, 'bin', 'graph-watch.mjs')
  const child = spawnImpl(process.execPath, [watchPath, 'ui', '--detach', '--no-open'], { cwd: process.cwd(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (code !== 0) throw new Error((stderr || `graph-watch terminou com código ${code}`).trim())
  const match = stdout.match(/graph-eng: painel: (https?:\/\/\S+)/)
  if (!match) throw new Error('graph-watch não devolveu a URL do painel')
  return { status: 'started', url: match[1].replace(/[.,;]+$/, '') }
}

export async function executeGrapheng({ invocation, clarification, cwd = process.cwd(), host, runGraphImpl = runGraph, startPanelImpl = startPanel, discoverChecksImpl = discoverChecks, configImpl = configuredEffort } = {}) {
  const trustedHost = validateHost(host)
  const parsed = parseGrapheng(invocation)
  if (clarification !== undefined) {
    if (parsed.command !== 'clarify') throw new Error('clarification só vale com clarify')
    validateClarificationAnswers(clarification)
  }
  if (parsed.command === 'init') return startPanelImpl()
  const config = await configImpl(parsed.effort)
  const runId = `grapheng-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  const args = {
    mode: 'implement',
    effort: config.effort,
    effortSource: config.effortSource,
    runId,
    runDir: path.join('.graph-runs', runId),
    context: '',
    pipeline: PIPELINE_BY_COMMAND[parsed.command],
  }
  // Tarefa só entra em plan e implemente com tarefa; clarify/tasks/implemente sem tarefa usam o slot único "feature corrente" no runner.
  if (parsed.task) args.task = parsed.task
  if (parsed.adaptive) args.adaptive = parsed.adaptive
  if (parsed.command === 'clarify' && clarification !== undefined) args.clarification = clarification
  if (parsed.command === 'implemente') {
    const discovery = await discoverChecksImpl(cwd)
    if (discovery.block) return { status: 'blocked', runId, runDir: path.resolve(cwd, args.runDir), feedback: { kind: 'BLOCK', reason: 'trusted_check_discovery_failed', detail: discovery.block, severity: 'high', affectedNodes: [], evidenceIds: [] } }
    args.checks = discovery.checks
    args.checkContract = discovery.checkContract
    if (discovery.nodeCheckPolicy) args.nodeCheckPolicy = discovery.nodeCheckPolicy
  } else {
    // plan, clarify e tasks são só de leitura no runner: nenhum check entra.
    args.checks = []
  }
  return runGraphImpl({ hostName: trustedHost, args, cwd })
}

// Código de saída do driver: blocked e needs_clarification saem com 2 (§6.2 do brief).
export function exitCodeOf(result) {
  return result?.status === 'blocked' || result?.status === 'needs_clarification' ? 2 : 0
}

export async function readGraphengInvocationFile(argv) {
  if (argv.length !== 2 || argv[0] !== '--invocation') throw new Error('uso: grapheng.mjs --invocation <arquivo-json>')
  const envelope = JSON.parse(await readFile(path.resolve(argv[1]), 'utf8'))
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !['claude', 'codex'].includes(envelope.host) || !Array.isArray(envelope.argv)) throw new Error('arquivo de invocação precisa conter host confiável e argv[]')
  for (const key of Object.keys(envelope)) if (!ENVELOPE_KEYS.has(key)) throw new Error(`chave não permitida no envelope: ${key}`)
  if (envelope.clarification !== undefined) {
    if (envelope.argv[0] !== 'clarify') throw new Error('clarification só vale com clarify')
    validateClarificationAnswers(envelope.clarification)
  }
  return envelope
}

async function main() {
  const envelope = await readGraphengInvocationFile(process.argv.slice(2))
  const result = await executeGrapheng({ invocation: envelope.argv, clarification: envelope.clarification, cwd: process.cwd(), host: envelope.host })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (exitCodeOf(result) === 2) process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`grapheng: ${error.message}\n`); process.exitCode = 1 })
}
