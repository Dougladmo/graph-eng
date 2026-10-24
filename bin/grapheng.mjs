#!/usr/bin/env node
// Entrada do graph-eng: plan e implemente, os dois no fluxo advisor (bin/advisor-flow.mjs).
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHost } from './hosts.mjs'
import { runAdvisorFlow } from './advisor-flow.mjs'

// clarify, tasks e init eram do motor de grafo, removido na 1.3.0.
const COMMANDS = ['plan', 'implemente']
const REMOVED_COMMANDS = new Set(['clarify', 'tasks', 'init'])
// Esforço de raciocínio de todas as chamadas (--effort do Claude Code).
const EFFORTS = new Set(['low', 'medium', 'max'])
const DEFAULT_EFFORT = 'medium'
// --executor: um modelo só para todos os passos. Desliga o roteamento.
const EXECUTORS = new Set(['sonnet', 'haiku'])
// --haiku-max: o planner marca a complexidade de cada passo e os passos até esse nível vão para o Haiku.
// Padrão no claude: low (benchmark Minecraft 23/10: 55/55 por US$ 1,59). off ou --executor desligam o roteamento.
const HAIKU_MAX = new Set(['low', 'medium', 'off'])
const DEFAULT_HAIKU_MAX = 'low'
const FLAGS = { '--effort': ['effort', EFFORTS, 'low, medium ou max'], '--executor': ['executor', EXECUTORS, 'sonnet ou haiku'], '--haiku-max': ['haikuMax', HAIKU_MAX, 'low, medium ou off'] }
const REMOVED = new Set(['--adaptive', '--flow', '--ceiling', '--economy', '--width', '--model', '--planner-model', '--reviewer-model', '--executor-model', '--max-rounds', '--max-repairs', '--plan-gate', '--lean', '--high', '--manual', '--auto', '--max-agents'])
const ENVELOPE_KEYS = new Set(['host', 'argv'])
// Plano salvo pelo comando plan; implemente sem tarefa executa este.
export const SAVED_PLAN = path.join('.graph-runs', 'advisor-plan.json')

export function parseGrapheng(argv) {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) throw new TypeError('argv precisa ser uma lista de textos')
  const [command, ...tail] = argv
  if (REMOVED_COMMANDS.has(command)) throw new Error(`${command} foi removido na 1.3.0; use plan ou implemente`)
  if (!COMMANDS.includes(command)) throw new Error(command === 'implement' ? 'comando desconhecido; use implemente' : `comando desconhecido; use ${COMMANDS.join(' ou ')}`)
  const parsed = { command }
  const taskTokens = []
  let literal = false
  for (let i = 0; i < tail.length; i++) {
    const token = tail[i]
    if (!literal && token === '--') { literal = true; continue }
    if (!literal && token.startsWith('-')) {
      const [flag, inline] = token.split('=')
      if (FLAGS[flag]) {
        if (inline !== undefined) throw new Error(`${token} não é aceito; use ${flag} ${inline}`)
        const [key, values, hint] = FLAGS[flag]
        if (parsed[key] !== undefined) throw new Error(`${flag} repetido`)
        const value = tail[++i]
        if (!values.has(value)) throw new Error(`${flag} aceita somente ${hint}`)
        parsed[key] = value
        continue
      }
      if (REMOVED.has(flag)) throw new Error(`${flag}: opção removida`)
      throw new Error(`opção desconhecida: ${token}; use -- para tarefa iniciada por hífen`)
    }
    taskTokens.push(token)
  }
  if (parsed.haikuMax !== undefined && parsed.executor !== undefined) throw new Error('--haiku-max não combina com --executor')
  const task = taskTokens.join(' ')
  if (taskTokens.length && !task.trim()) throw new Error('tarefa vazia')
  if (task) parsed.task = task
  if (command === 'plan' && !task) throw new Error('plan exige uma tarefa')
  if (command === 'implemente' && !task && (parsed.haikuMax !== undefined || parsed.executor !== undefined)) throw new Error('implemente sem tarefa usa o roteamento salvo pelo plan; passe --haiku-max ou --executor no plan')
  return parsed
}

function validateHost(host) {
  if (!['claude', 'codex'].includes(host)) throw new Error('host confiável obrigatório: claude ou codex')
  return host
}

// Roteamento efetivo: --executor fixa um modelo; senão --haiku-max (padrão low no claude). Codex não roteia.
function routing(parsed, host) {
  if (parsed.executor) {
    if (host !== 'claude') throw new Error('--executor vale só no host claude')
    return { executor: parsed.executor, haikuMax: null }
  }
  if (parsed.haikuMax && parsed.haikuMax !== 'off' && host !== 'claude') throw new Error('--haiku-max vale só no host claude')
  if (parsed.haikuMax === 'off' || host !== 'claude') return { executor: null, haikuMax: null }
  return { executor: null, haikuMax: parsed.haikuMax ?? DEFAULT_HAIKU_MAX }
}

export async function executeGrapheng({ invocation, cwd = process.cwd(), host, advisorFlowImpl = runAdvisorFlow, hostFactory = createHost, log = () => {} } = {}) {
  const trustedHost = validateHost(host)
  const parsed = parseGrapheng(invocation)
  const runId = `grapheng-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  const runDir = path.resolve(cwd, '.graph-runs', runId)
  const savedPlanFile = path.resolve(cwd, SAVED_PLAN)
  let task = parsed.task
  let route = routing(parsed, trustedHost)
  let planned = null
  if (parsed.command === 'implemente' && !task) {
    let saved
    try { saved = JSON.parse(await readFile(savedPlanFile, 'utf8')) }
    catch { return { status: 'blocked', runId, runDir, feedback: { kind: 'BLOCK', reason: 'advisor_plan_missing', detail: 'nenhum plano salvo: rode plan <tarefa> ou implemente <tarefa>' } } }
    if (saved.host !== trustedHost) return { status: 'blocked', runId, runDir, feedback: { kind: 'BLOCK', reason: 'advisor_plan_host_mismatch', detail: `o plano salvo é do host ${saved.host}` } }
    task = saved.task
    route = { executor: saved.executor ?? null, haikuMax: saved.haikuMax ?? null }
    planned = { plan: saved.plan, review: saved.review }
  }
  const flowHost = hostFactory({ host: trustedHost, cwd, runDir, runId, ...(route.executor ? { advisedExecutorModel: route.executor } : {}) })
  const result = await advisorFlowImpl({
    host: flowHost, hostName: trustedHost, cwd, task, runDir, log,
    effort: parsed.effort ?? DEFAULT_EFFORT,
    ...(route.haikuMax ? { haikuMax: route.haikuMax } : {}),
    ...(parsed.command === 'plan' ? { planOnly: true } : {}),
    ...(planned ? { planned } : {}),
  })
  if (parsed.command === 'plan' && result.status === 'planned') {
    await mkdir(path.dirname(savedPlanFile), { recursive: true })
    await writeFile(savedPlanFile, JSON.stringify({ host: trustedHost, task, haikuMax: route.haikuMax, executor: route.executor, runId, plan: result.plan, review: result.review }, null, 2) + '\n')
  }
  return { ...result, runId, runDir }
}

// Código de saída do driver: blocked sai com 2.
export function exitCodeOf(result) {
  return result?.status === 'blocked' ? 2 : 0
}

export async function readGraphengInvocationFile(argv) {
  if (argv.length !== 2 || argv[0] !== '--invocation') throw new Error('uso: grapheng.mjs --invocation <arquivo-json>')
  const envelope = JSON.parse(await readFile(path.resolve(argv[1]), 'utf8'))
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !['claude', 'codex'].includes(envelope.host) || !Array.isArray(envelope.argv)) throw new Error('arquivo de invocação precisa conter host confiável e argv[]')
  for (const key of Object.keys(envelope)) if (!ENVELOPE_KEYS.has(key)) throw new Error(`chave não permitida no envelope: ${key}`)
  return envelope
}

async function main() {
  const envelope = await readGraphengInvocationFile(process.argv.slice(2))
  const result = await executeGrapheng({ invocation: envelope.argv, cwd: process.cwd(), host: envelope.host, log: message => process.stderr.write(`graph-eng: ${message}\n`) })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (exitCodeOf(result) === 2) process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`grapheng: ${error.message}\n`); process.exitCode = 1 })
}
