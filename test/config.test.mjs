// Testes da config do graph-eng (bin/config.mjs e o CLI bin/graph-config.mjs), conforme o D2 §7.1 da run
// .graph-runs/20260928-0213-fases-esforco-teto. Tudo grava em diretório de os.tmpdir(): nenhum teste toca o
// ~/.claude real (o CLI roda com GRAPH_ENG_CONFIG e HOME apontando para o tmp).

import { test, describe, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONFIG_KEYS,
  LIMITS,
  MAX_BODY,
  defaultConfigPath,
  validateConfig,
  readConfig,
  writeConfig,
  resolveConfig,
  describeTargets,
  publicConfig,
} from '../bin/config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'bin', 'graph-config.mjs')

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'graph-eng-config-'))

const FACTORY = { effort: 'auto', ceiling: 24, economy: 'balanced', planGate: false, maxRounds: 3, maxRepairs: 2 }
const ALL_DEFAULT = Object.fromEntries(CONFIG_KEYS.map((k) => [k, 'default']))

function cli(args, { file } = {}) {
  const home = tmpDir()
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, GRAPH_ENG_CONFIG: file || path.join(home, 'nada', 'config.json') },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('config: padrões e caminho', () => {
  test('sem arquivo → padrão de fábrica 24/auto, com todas as origens default', () => {
    const file = path.join(tmpDir(), 'config.json')
    const { stored, warnings } = readConfig(file)
    assert.deepEqual(stored, {})
    assert.deepEqual(warnings, [])
    const r = resolveConfig({ stored })
    assert.deepEqual(r.config, FACTORY)
    assert.deepEqual(r.source, ALL_DEFAULT)
    assert.deepEqual(Object.keys(r.config), CONFIG_KEYS)
  })

  test('defaultConfigPath: ~/.claude/graph-eng/config.json, sobrescrito por GRAPH_ENG_CONFIG', () => {
    assert.equal(defaultConfigPath({}, '/casa/u'), path.join('/casa/u', '.claude', 'graph-eng', 'config.json'))
    assert.equal(defaultConfigPath({ GRAPH_ENG_CONFIG: '/tmp/x.json' }, '/casa/u'), '/tmp/x.json')
  })

  test('LIMITS: teto de 8 a 100 e as listas de esforço e economia', () => {
    assert.deepEqual(LIMITS.ceiling, { min: 8, max: 100 })
    assert.deepEqual(LIMITS.maxRounds, { min: 1, max: 5 })
    assert.deepEqual(LIMITS.maxRepairs, { min: 1, max: 3 })
    assert.deepEqual(LIMITS.effort, ['manual', 'auto', 'low', 'medium', 'high', 'max'])
    assert.deepEqual(LIMITS.economy, ['lean', 'balanced', 'max'])
    assert.equal(MAX_BODY, 4096)
  })
})

describe('config: precedência flag > arquivo > padrão', () => {
  test('arquivo {ceiling:40} vale 40 com origem config; flag 30 vence com origem flag', () => {
    const file = path.join(tmpDir(), 'config.json')
    fs.writeFileSync(file, JSON.stringify({ ceiling: 40, effort: 'high' }))
    const { stored } = readConfig(file)
    const fromFile = resolveConfig({ stored })
    assert.equal(fromFile.config.ceiling, 40)
    assert.equal(fromFile.source.ceiling, 'config')
    assert.equal(fromFile.config.effort, 'high')
    assert.equal(fromFile.source.economy, 'default')

    const withFlag = resolveConfig({ flags: { ceiling: 30 }, stored })
    assert.equal(withFlag.config.ceiling, 30)
    assert.equal(withFlag.source.ceiling, 'flag')
    assert.equal(withFlag.config.effort, 'high') // campo sem flag continua vindo do arquivo
    assert.equal(withFlag.source.effort, 'config')
  })
})

describe('config: leitura tolerante', () => {
  test('JSON quebrado → aviso e padrões', () => {
    const file = path.join(tmpDir(), 'config.json')
    fs.writeFileSync(file, '{ "ceiling": ')
    const { stored, warnings } = readConfig(file)
    assert.deepEqual(stored, {})
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /^config\.json ilegível: .*; usando padrões$/)
  })

  test('JSON que não é objeto → aviso e padrões', () => {
    const file = path.join(tmpDir(), 'config.json')
    fs.writeFileSync(file, '[1, 2]')
    const { stored, warnings } = readConfig(file)
    assert.deepEqual(stored, {})
    assert.match(warnings[0], /ilegível/)
  })

  test('teto abaixo do piso no arquivo → aviso "mínimo 8" e vale o padrão 24', () => {
    const file = path.join(tmpDir(), 'config.json')
    fs.writeFileSync(file, JSON.stringify({ ceiling: 5, effort: 'low' }))
    const { stored, warnings } = readConfig(file)
    assert.deepEqual(stored, { effort: 'low' })
    assert.deepEqual(warnings, ['ceiling: mínimo 8 (ignorado)'])
    assert.equal(resolveConfig({ stored }).config.ceiling, 24)
  })

  test('campo desconhecido no arquivo → aviso, e o resto vale', () => {
    const file = path.join(tmpDir(), 'config.json')
    fs.writeFileSync(file, JSON.stringify({ x: 1, maxRounds: 4 }))
    const { stored, warnings } = readConfig(file)
    assert.deepEqual(stored, { maxRounds: 4 })
    assert.deepEqual(warnings, ['x: campo desconhecido (ignorado)'])
  })

  test('erro de E/S que não é ENOENT sobe (diretório no lugar do arquivo)', () => {
    const dir = tmpDir()
    assert.throws(() => readConfig(dir))
  })
})

describe('config: validateConfig (estrita, sem coerção)', () => {
  const err = (obj, opts) => validateConfig(obj, opts).errors

  test('teto: abaixo do piso, acima do máximo, fracionário, string e booleano', () => {
    assert.deepEqual(err({ ceiling: 7 }), { ceiling: 'mínimo 8' })
    assert.deepEqual(err({ ceiling: 101 }), { ceiling: 'máximo 100' })
    assert.deepEqual(err({ ceiling: 12.5 }), { ceiling: 'use um número inteiro' })
    assert.deepEqual(err({ ceiling: '24' }), { ceiling: 'use um número inteiro' })
    assert.deepEqual(err({ ceiling: true }), { ceiling: 'use um número inteiro' })
    assert.equal(validateConfig({ ceiling: 8 }).ok, true)
    assert.equal(validateConfig({ ceiling: 100 }).ok, true)
  })

  test('teto com modo: o piso desce ao do modo (research 4, architecture 6), e auto fica em 8', () => {
    assert.equal(validateConfig({ ceiling: 5 }, { mode: 'research' }).ok, true)
    assert.deepEqual(err({ ceiling: 3 }, { mode: 'research' }), { ceiling: 'mínimo 4' })
    assert.deepEqual(err({ ceiling: 5 }, { mode: 'architecture' }), { ceiling: 'mínimo 6' })
    assert.deepEqual(err({ ceiling: 5 }, { mode: 'auto' }), { ceiling: 'mínimo 8' })
  })

  test('esforço, economia, planGate, rounds e reparos fora da faixa; campo desconhecido', () => {
    assert.deepEqual(err({ effort: 'xhigh' }), { effort: 'use manual, auto, low, medium, high ou max' })
    assert.deepEqual(err({ economy: 'turbo' }), { economy: 'use lean, balanced ou max' })
    assert.deepEqual(err({ planGate: 'sim' }), { planGate: 'use true ou false' })
    assert.deepEqual(err({ maxRounds: 0 }), { maxRounds: 'de 1 a 5' })
    assert.deepEqual(err({ maxRounds: 6 }), { maxRounds: 'de 1 a 5' })
    assert.deepEqual(err({ maxRepairs: 0 }), { maxRepairs: 'de 1 a 3' })
    assert.deepEqual(err({ maxRepairs: 4 }), { maxRepairs: 'de 1 a 3' })
    assert.deepEqual(err({ foo: 1 }), { foo: 'campo desconhecido' })
    const proto = validateConfig(JSON.parse('{"__proto__": {"ceiling": 5}}'))
    assert.equal(proto.ok, false)
    assert.deepEqual(Object.keys(proto.errors), ['__proto__'])
    assert.equal(Object.getOwnPropertyDescriptor(proto.errors, '__proto__').value, 'campo desconhecido')
  })

  test('não objeto → erro; objeto válido devolve as chaves na ordem de CONFIG_KEYS', () => {
    for (const bad of [null, [], 'x', 3]) assert.equal(validateConfig(bad).ok, false)
    const r = validateConfig({ maxRepairs: 1, ceiling: 30, effort: 'manual', planGate: true })
    assert.equal(r.ok, true)
    assert.deepEqual(r.errors, {})
    assert.deepEqual(Object.keys(r.value), ['effort', 'ceiling', 'planGate', 'maxRepairs'])
  })
})

describe('config: gravação atômica (tmp + rename)', () => {
  afterEach(() => mock.restoreAll())

  test('grava num tmp do mesmo diretório e renomeia por cima; ida e volta sem sobra de *.tmp-*', () => {
    const dir = path.join(tmpDir(), 'sub', 'graph-eng') // diretório ainda não existe
    const file = path.join(dir, 'config.json')
    const writes = mock.method(fs, 'writeFileSync')
    const renames = mock.method(fs, 'renameSync')
    writeConfig(file, { ceiling: 30, effort: 'high' })

    assert.equal(writes.mock.callCount(), 1)
    const tmp = writes.mock.calls[0].arguments[0]
    assert.equal(path.dirname(tmp), dir, 'tmp no mesmo diretório (rename atômico no mesmo sistema de arquivos)')
    assert.match(path.basename(tmp), /^config\.json\.tmp-\d+-\d+$/)
    assert.equal(writes.mock.calls[0].arguments[2].flag, 'wx')
    assert.equal(renames.mock.callCount(), 1)
    assert.deepEqual(renames.mock.calls[0].arguments, [tmp, file])

    assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "effort": "high",\n  "ceiling": 30\n}\n')
    assert.deepEqual(readConfig(file).stored, { effort: 'high', ceiling: 30 })
    assert.deepEqual(fs.readdirSync(dir), ['config.json'])
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  })

  test('rename falhando: o arquivo anterior fica intacto, o tmp é apagado e o erro sobe', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'config.json')
    writeConfig(file, { ceiling: 40 })
    const before = fs.readFileSync(file, 'utf8')
    mock.method(fs, 'renameSync', () => {
      throw Object.assign(new Error('falha simulada'), { code: 'EIO' })
    })
    assert.throws(() => writeConfig(file, { ceiling: 50 }), /falha simulada/)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert.deepEqual(fs.readdirSync(dir), ['config.json'])
  })
})

describe('config: describeTargets e publicConfig', () => {
  test('describeTargets: tabela com piso 8 sem modo, 5 em research, ask só com manual', () => {
    const d = describeTargets(FACTORY)
    assert.deepEqual(d, { mode: null, floor: 8, targets: { low: 8, medium: 10, high: 17, max: 24 }, range: { min: 8, max: 24 }, ask: false })
    assert.equal(describeTargets({ ...FACTORY, effort: 'manual' }).ask, true)
    assert.equal(describeTargets(FACTORY, 'research').targets.low, 5)
  })

  test('publicConfig: config efetiva, origem, padrões, limites, arquivo com ~ e avisos', () => {
    const home = tmpDir()
    const file = path.join(home, '.claude', 'graph-eng', 'config.json')
    writeConfig(file, { ceiling: 30 })
    const p = publicConfig(file, { home })
    assert.deepEqual(p.config, { ...FACTORY, ceiling: 30 })
    assert.equal(p.source.ceiling, 'config')
    assert.equal(p.source.effort, 'default')
    assert.deepEqual(p.defaults, FACTORY)
    assert.deepEqual(p.limits, LIMITS)
    assert.equal(p.file, path.join('~', '.claude', 'graph-eng', 'config.json'))
    assert.deepEqual(p.warnings, [])
  })
})

describe('CLI graph-config', () => {
  test('sem arquivo, --json: 24/auto, tabela de alvos, ask false e args prontos para o Workflow', () => {
    const r = cli(['--json'])
    assert.equal(r.code, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.deepEqual(j.config, FACTORY)
    assert.deepEqual(j.source, ALL_DEFAULT)
    assert.equal(j.mode, null)
    assert.equal(j.floor, 8)
    assert.deepEqual(j.targets, { low: 8, medium: 10, high: 17, max: 24 })
    assert.deepEqual(j.range, { min: 8, max: 24 })
    assert.equal(j.ask, false)
    assert.deepEqual(j.args, { effort: 'auto', effortSource: 'default', ceiling: 24, economy: 'balanced', maxRounds: 3, maxRepairs: 2 })
    assert.equal(j.planGate, false)
    assert.deepEqual(j.warnings, [])
    assert.equal(typeof j.file, 'string')
  })

  test('--effort manual → ask true', () => {
    const j = JSON.parse(cli(['--effort', 'manual', '--json']).stdout)
    assert.equal(j.ask, true)
    assert.equal(j.source.effort, 'flag')
  })

  test('flags vencem o arquivo campo a campo', () => {
    const file = path.join(tmpDir(), 'config.json')
    fs.writeFileSync(file, JSON.stringify({ ceiling: 40, economy: 'lean', planGate: true }))
    const r = cli(['--effort', 'high', '--ceiling', '48', '--mode', 'implement', '--json'], { file })
    assert.equal(r.code, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.equal(j.targets.max, 48)
    assert.equal(j.source.effort, 'flag')
    assert.equal(j.source.ceiling, 'flag')
    assert.equal(j.config.economy, 'lean')
    assert.equal(j.source.economy, 'config')
    assert.equal(j.planGate, true)
    assert.equal(j.mode, 'implement')
    assert.equal(j.args.ceiling, 48)
    assert.equal(j.args.effortSource, 'flag')
  })

  test('--max-agents é sinônimo de --ceiling; com os dois, --ceiling vence com aviso', () => {
    assert.equal(JSON.parse(cli(['--max-agents', '30', '--json']).stdout).config.ceiling, 30)
    const j = JSON.parse(cli(['--max-agents', '30', '--ceiling', '40', '--json']).stdout)
    assert.equal(j.config.ceiling, 40)
    assert.deepEqual(j.warnings, ['--max-agents ignorado: --ceiling tem precedência'])
  })

  test('--ceiling 5 --mode research é aceito (piso 4)', () => {
    const r = cli(['--ceiling', '5', '--mode', 'research', '--json'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).config.ceiling, 5)
  })

  test('--ceiling 5 sem modo → exit 1 com "mínimo 8" no stderr', () => {
    const r = cli(['--ceiling', '5'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /graph-config: --ceiling 5: mínimo 8/)
    assert.equal(r.stdout, '')
  })

  test('--effort xhigh, flag desconhecida, flag sem valor e --mode inválido → exit 1', () => {
    for (const args of [['--effort', 'xhigh'], ['--turbo'], ['--ceiling'], ['--mode', 'deploy'], ['--max-rounds', '9'], ['solto']]) {
      const r = cli(args)
      assert.equal(r.code, 1, `esperava exit 1 para ${args.join(' ')}`)
      assert.match(r.stderr, /^graph-config: /)
    }
  })

  test('arquivo inválido não é erro: vira aviso com exit 0', () => {
    const file = path.join(tmpDir(), 'config.json')
    fs.writeFileSync(file, JSON.stringify({ ceiling: 5 }))
    const r = cli(['--json'], { file })
    assert.equal(r.code, 0)
    const j = JSON.parse(r.stdout)
    assert.equal(j.config.ceiling, 24)
    assert.deepEqual(j.warnings, ['ceiling: mínimo 8 (ignorado)'])
  })

  test('sem --json: resumo legível com a origem de cada campo e a linha de alvos', () => {
    const r = cli([])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /effort: auto \(padrão\)/)
    assert.match(r.stdout, /alvos \(piso 8\): low 8 · medium 10 · high 17 · max 24/)
  })
})
