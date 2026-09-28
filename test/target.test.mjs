// D1 §12: fórmula, piso e a tabela idêntica entre bin/ui/agent-target.mjs e o espelho inline em
// workflows/graph-eng.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as target from '../bin/ui/agent-target.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_PATH = path.join(__dirname, '..', 'workflows', 'graph-eng.js')

test('targetTable(24, mode) bate com a tabela do D1 §2.3', () => {
  assert.deepEqual(target.targetTable(24, 'implement'), { low: 8, medium: 10, high: 17, max: 24 })
  assert.deepEqual(target.targetTable(24, 'architecture'), { low: 6, medium: 10, high: 17, max: 24 })
  assert.deepEqual(target.targetTable(24, 'research'), { low: 5, medium: 10, high: 17, max: 24 })
  assert.deepEqual(target.targetTable(24, 'review'), { low: 5, medium: 10, high: 17, max: 24 })
})

test('piso por modo', () => {
  assert.equal(target.floorOf('implement'), 8)
  assert.equal(target.floorOf('architecture'), 6)
  assert.equal(target.floorOf('research'), 4)
  assert.equal(target.floorOf('review'), 4)
  assert.equal(target.floorOf('auto'), 8) // conservador: maior piso
  assert.equal(target.floorOf(undefined), 8)
})

test('padrão de fábrica 24/auto', () => {
  assert.equal(target.DEFAULTS.ceiling, 24)
  assert.equal(target.DEFAULTS.effort, 'auto')
})

test('validateCeiling: inteiro, piso do modo, teto 100', () => {
  assert.equal(target.validateCeiling(7, 'implement').ok, false)
  assert.equal(target.validateCeiling(7, 'implement').error, 'mínimo 8')
  assert.equal(target.validateCeiling(8, 'implement').ok, true)
  assert.equal(target.validateCeiling(24, 'implement').ok, true)
  assert.equal(target.validateCeiling(101, 'implement').error, 'máximo 100')
  assert.equal(target.validateCeiling(3.5, 'implement').error, 'use um número inteiro')
  assert.equal(target.validateCeiling('abc', 'implement').error, 'use um número inteiro')
})

test('sizing: largura e máx. de nós derivam do alvo', () => {
  assert.deepEqual(target.sizing(8, 'implement'), { width: 2, maxNodes: 3 })
  assert.deepEqual(target.sizing(10, 'implement'), { width: 2, maxNodes: 3 })
  assert.deepEqual(target.sizing(17, 'implement'), { width: 3, maxNodes: 6 })
  assert.deepEqual(target.sizing(24, 'implement'), { width: 4, maxNodes: 10 })
})

test('outros tetos: implement 48 e 100', () => {
  assert.deepEqual(target.targetTable(48, 'implement'), { low: 10, medium: 19, high: 34, max: 48 })
  assert.deepEqual(target.targetTable(100, 'implement'), { low: 20, medium: 40, high: 70, max: 100 })
})

// Extrai o bloco espelhado entre os marcadores (D1 §2.2) e o avalia sozinho, sem depender do resto
// do motor (que tem `return` de topo e não é importável).
function extractMirror(source) {
  const start = source.indexOf('// ── agent-target (espelho de bin/ui/agent-target.mjs) ──')
  const end = source.indexOf('// ── fim agent-target ──')
  assert.notEqual(start, -1, 'marcador de início do espelho não encontrado')
  assert.notEqual(end, -1, 'marcador de fim do espelho não encontrado')
  assert.ok(end > start, 'marcadores fora de ordem')
  return source.slice(start, end)
}

test('espelho: o bloco inline de workflows/graph-eng.js é idêntico à tabela de bin/ui/agent-target.mjs', () => {
  const source = fs.readFileSync(ENGINE_PATH, 'utf8')
  const block = extractMirror(source)
  const factory = new Function(`${block}\nreturn { EFFORT_PCT, MODE_FLOOR, MODE_FIXED, MODE_MINNODES, CEILING_MAX, floorOf, targetFor, targetTable, targetRange, sizing, validateCeiling, estimateAgents }`)
  const mirror = factory()

  assert.deepEqual(mirror.EFFORT_PCT, target.EFFORT_PCT)
  assert.deepEqual(mirror.MODE_FLOOR, target.MODE_FLOOR)
  assert.deepEqual(mirror.MODE_FIXED, target.MODE_FIXED)
  assert.deepEqual(mirror.MODE_MINNODES, target.MODE_MINNODES)
  assert.equal(mirror.CEILING_MAX, target.CEILING_MAX)

  const modes = ['implement', 'architecture', 'research', 'review']
  const levels = ['low', 'medium', 'high', 'max']
  for (let ceiling = 4; ceiling <= 100; ceiling += 3) {
    for (const mode of modes) {
      assert.deepEqual(mirror.sizing(mirror.targetFor('max', ceiling, mode), mode), target.sizing(target.targetFor('max', ceiling, mode), mode), `sizing diverge em ceiling=${ceiling} mode=${mode}`)
      for (const level of levels) {
        assert.equal(mirror.targetFor(level, ceiling, mode), target.targetFor(level, ceiling, mode), `targetFor diverge em ceiling=${ceiling} mode=${mode} level=${level}`)
      }
    }
  }
  // Um caso concreto por completude (o laço acima já cobre estes valores)
  assert.deepEqual(mirror.targetTable(24, 'implement'), target.targetTable(24, 'implement'))
})
