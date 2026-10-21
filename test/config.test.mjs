import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CONFIG_KEYS, LIMITS, MAX_BODY, DEFAULTS, defaultConfigPath, defaultStateDir, validateConfig, readConfig, writeConfig, resolveConfig, describeTargets, publicConfig } from '../bin/config.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ge-config-'))

describe('configuração pública', () => {
  test('defaults, limits e resolveConfig expõem somente effort', () => {
    assert.deepEqual(CONFIG_KEYS, ['effort'])
    assert.deepEqual(DEFAULTS, { effort: 'medium' })
    assert.deepEqual(LIMITS, { effort: ['low', 'medium', 'max'] })
    assert.equal(MAX_BODY, 4096)
    assert.deepEqual(resolveConfig(), { config: { effort: 'medium' }, source: { effort: 'default' }, warnings: [] })
    assert.deepEqual(resolveConfig({ flags: { effort: 'max' }, stored: { effort: 'low' } }), { config: { effort: 'max' }, source: { effort: 'flag' }, warnings: [] })
  })
  test('validateConfig é estrita, inclusive falsy, chaves legadas e __proto__ próprio', () => {
    for (const value of ['low', 'medium', 'max']) assert.deepEqual(validateConfig({ effort: value }), { ok: true, value: { effort: value }, errors: {} })
    for (const value of ['auto', 'manual', 'high', '', false, 0, null]) assert.equal(validateConfig({ effort: value }).ok, false)
    for (const key of ['ceiling', 'economy', 'planGate', 'maxRounds', 'maxRepairs', 'stallMinutes', 'width', 'model']) assert.equal(validateConfig({ [key]: 1 }).ok, false, key)
    const proto = validateConfig(JSON.parse('{"__proto__":{"effort":"max"}}'))
    assert.equal(proto.ok, false)
    assert.equal(Object.getOwnPropertyDescriptor(proto.errors, '__proto__').value, 'campo desconhecido')
    for (const invalid of [null, [], 4, 'x']) assert.equal(validateConfig(invalid).ok, false)
  })
  test('paths mantêm override de ambiente', () => {
    assert.equal(defaultConfigPath({}, '/casa/u'), '/casa/u/.claude/graph-eng/config.json')
    assert.equal(defaultConfigPath({ GRAPH_ENG_CONFIG: '/tmp/c.json' }, '/casa/u'), '/tmp/c.json')
    assert.equal(defaultStateDir({ GRAPH_ENG_STATE_DIR: '/tmp/state' }, '/casa/u'), '/tmp/state')
  })
  test('arquivo legacy é tolerante e público omite operacional', () => {
    const home = tmp()
    const file = path.join(home, '.claude', 'graph-eng', 'config.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ effort: 'high', ceiling: 40, stallMinutes: 12 }))
    const read = readConfig(file)
    assert.deepEqual(read.stored, { effort: 'medium' })
    assert.deepEqual(read.operational, { stallMinutes: 12 })
    assert.ok(read.warnings.some((warning) => warning.includes('effort')))
    assert.ok(read.warnings.some((warning) => warning.includes('ceiling')))
    assert.equal(fs.readFileSync(file, 'utf8').includes('schemaVersion'), false)
    const body = publicConfig(file, { home })
    assert.deepEqual(Object.keys(body).sort(), ['config', 'defaults', 'file', 'limits', 'source', 'warnings'])
    assert.deepEqual(body.config, { effort: 'medium' })
    assert.deepEqual(body.defaults, { effort: 'medium' })
    assert.equal(JSON.stringify(body).includes('stallMinutes'), false)
  })
  test('describeTargets depreciado não deriva métricas', () => {
    assert.deepEqual(describeTargets({ effort: 'medium' }), { mode: null, targets: null, range: null, ask: false })
  })
})
