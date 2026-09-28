#!/usr/bin/env node
// graph-config: imprime a config efetiva do graph-eng (flag > ~/.claude/graph-eng/config.json > padrão) e a
// tabela de alvos de agentes. A skill roda isto antes de disparar o Workflow, que não lê disco, e passa o
// trecho `args` adiante. Contrato: .graph-runs/20260928-0213-fases-esforco-teto/D2.md §5.
//
//   node "${CLAUDE_PLUGIN_ROOT}/bin/graph-config.mjs" [--effort <manual|auto|low|medium|high|max>]
//        [--ceiling <N>] [--max-agents <N>] [--economy <lean|balanced|max>] [--plan-gate]
//        [--max-rounds <N>] [--max-repairs <N>] [--mode <auto|implement|architecture|research|review>]
//        [--config <arquivo>] [--json]
//
// Saída --json (uma linha): { config, source, mode, floor, targets, range, ask, args, planGate, file, warnings }.
// Flag inválida → exit 1 com `graph-config: <flag> <valor>: <motivo>` no stderr. Arquivo inválido não é erro:
// o campo volta ao padrão e o motivo vai em `warnings`.

import { defaultConfigPath, readConfig, resolveConfig, validateConfig, describeTargets, CONFIG_KEYS } from './config.mjs'

const USAGE = `uso: graph-config [--effort <manual|auto|low|medium|high|max>] [--ceiling <N>] [--max-agents <N>]
       [--economy <lean|balanced|max>] [--plan-gate] [--max-rounds <N>] [--max-repairs <N>]
       [--mode <auto|implement|architecture|research|review>] [--config <arquivo>] [--json]`

const FLAGS_WITH_VALUE = new Set(['--effort', '--ceiling', '--max-agents', '--economy', '--max-rounds', '--max-repairs', '--mode', '--config'])
const FLAGS_BOOL = new Set(['--plan-gate', '--json', '--help', '-h'])
const MODES = ['auto', 'implement', 'architecture', 'research', 'review']
const FLAG_OF = { effort: '--effort', ceiling: '--ceiling', economy: '--economy', planGate: '--plan-gate', maxRounds: '--max-rounds', maxRepairs: '--max-repairs' }
const SOURCE_PT = { flag: 'flag', config: 'arquivo', default: 'padrão' }

class UsageError extends Error {}

function parseArgs(rest) {
  const opts = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (FLAGS_WITH_VALUE.has(a)) {
      const v = rest[++i]
      if (v === undefined) throw new UsageError(`${a}: falta o valor`)
      opts[a] = v
    } else if (FLAGS_BOOL.has(a)) opts[a] = true
    else if (a.startsWith('-')) throw new UsageError(`${a}: flag desconhecida`)
    else throw new UsageError(`${a}: argumento inesperado`)
  }
  return opts
}

// "48" → 48; qualquer outra coisa segue como string e cai no "use um número inteiro" da validação.
const toInt = (v) => (/^-?\d+$/.test(v) ? Number(v) : v)

function main(argv) {
  const opts = parseArgs(argv)
  if (opts['--help'] || opts['-h']) {
    console.log(USAGE)
    return 0
  }
  const mode = opts['--mode']
  if (mode !== undefined && !MODES.includes(mode)) throw new UsageError(`--mode ${mode}: use ${MODES.join(', ')}`)

  const warnings = []
  const flags = {}
  const raw = {} // valor como veio na linha de comando, para a mensagem de erro
  const ceilingFlag = opts['--ceiling'] !== undefined ? '--ceiling' : opts['--max-agents'] !== undefined ? '--max-agents' : null
  if (opts['--ceiling'] !== undefined && opts['--max-agents'] !== undefined) warnings.push('--max-agents ignorado: --ceiling tem precedência')
  if (opts['--effort'] !== undefined) flags.effort = raw.effort = opts['--effort']
  if (ceilingFlag) flags.ceiling = toInt((raw.ceiling = opts[ceilingFlag]))
  if (opts['--economy'] !== undefined) flags.economy = raw.economy = opts['--economy']
  if (opts['--plan-gate']) flags.planGate = raw.planGate = true
  if (opts['--max-rounds'] !== undefined) flags.maxRounds = toInt((raw.maxRounds = opts['--max-rounds']))
  if (opts['--max-repairs'] !== undefined) flags.maxRepairs = toInt((raw.maxRepairs = opts['--max-repairs']))

  const checked = validateConfig(flags, { mode })
  if (!checked.ok) {
    const [k, msg] = Object.entries(checked.errors)[0]
    const flag = k === 'ceiling' ? ceilingFlag : FLAG_OF[k]
    const where = k === 'ceiling' && mode ? ` (modo ${mode})` : ''
    throw new UsageError(`${flag} ${raw[k]}: ${msg}${where}`)
  }

  const file = opts['--config'] || defaultConfigPath()
  let stored
  try {
    const read = readConfig(file)
    stored = read.stored
    warnings.push(...read.warnings)
  } catch (e) {
    throw new UsageError(`não consegui ler ${file}: ${e.message}`)
  }

  const { config, source } = resolveConfig({ flags: checked.value, stored })
  const t = describeTargets(config, mode)
  const out = {
    config,
    source,
    ...t,
    args: {
      effort: config.effort,
      effortSource: source.effort,
      ceiling: config.ceiling,
      economy: config.economy,
      maxRounds: config.maxRounds,
      maxRepairs: config.maxRepairs,
    },
    planGate: config.planGate,
    file,
    warnings,
  }

  if (opts['--json']) {
    console.log(JSON.stringify(out))
    return 0
  }
  const lines = [`graph-eng: config (${file})`]
  for (const k of CONFIG_KEYS) lines.push(`  ${k}: ${config[k]} (${SOURCE_PT[source[k]]})`)
  const tb = t.targets
  lines.push(`  alvos (piso ${t.floor}): low ${tb.low} · medium ${tb.medium} · high ${tb.high} · max ${tb.max}`)
  if (t.ask) lines.push('  esforço manual: a skill pergunta o nível a cada disparo')
  for (const w of warnings) lines.push(`  aviso: ${w}`)
  console.log(lines.join('\n'))
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  if (!(e instanceof UsageError)) throw e
  console.error(`graph-config: ${e.message}`)
  process.exitCode = 1
}
