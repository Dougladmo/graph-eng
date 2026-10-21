import { test, describe, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readConfig, writeConfig } from '../bin/config.mjs'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ge-config-migration-'))
const backupFor = (file, bytes) => `${file}.v1-backup-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`

afterEach(() => mock.restoreAll())

describe('migração explícita de config', () => {
  test('GET tolerante não grava; PUT preserva operacional e cria backup byte a byte', () => {
    const dir = temp()
    const file = path.join(dir, 'config.json')
    const original = Buffer.from(' { "effort": "low", "stallMinutes": 12, "ceiling": 32 }\n')
    fs.writeFileSync(file, original)
    const read = readConfig(file)
    assert.deepEqual(read.stored, { effort: 'low' })
    assert.deepEqual(read.operational, { stallMinutes: 12 })
    assert.deepEqual(fs.readFileSync(file), original)
    writeConfig(file, { effort: 'max' })
    assert.deepEqual(fs.readFileSync(backupFor(file, original)), original)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schemaVersion: 2, effort: 'max', operational: { stallMinutes: 12 } })
  })

  test('auto/manual/high viram medium com aviso; v2 não trata operational como desconhecido', () => {
    for (const effort of ['auto', 'manual', 'high']) {
      const file = path.join(temp(), 'config.json')
      fs.writeFileSync(file, JSON.stringify({ effort, stallMinutes: 9, ceiling: 30 }))
      const read = readConfig(file)
      assert.deepEqual(read.stored, { effort: 'medium' })
      assert.deepEqual(read.operational, { stallMinutes: 9 })
      assert.ok(read.warnings.some((warning) => warning.includes('effort')))
      writeConfig(file, read.stored)
      assert.deepEqual(readConfig(file).warnings, [])
    }
  })

  test('backup é exclusivo e idempotente para bytes iguais; colisão aborta sem trocar origem', () => {
    const file = path.join(temp(), 'config.json')
    const original = Buffer.from('{"effort":"low"}')
    fs.writeFileSync(file, original)
    writeConfig(file, { effort: 'medium' })
    const migrated = fs.readFileSync(file)
    assert.deepEqual(fs.readFileSync(backupFor(file, original)), original)
    // Regravar v2 não cria outro backup.
    writeConfig(file, { effort: 'max' })
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), [path.basename(file), path.basename(backupFor(file, original))].sort())
    assert.notDeepEqual(fs.readFileSync(file), migrated)

    const colliding = path.join(temp(), 'config.json')
    fs.writeFileSync(colliding, original)
    fs.writeFileSync(backupFor(colliding, original), 'bytes diferentes')
    assert.throws(() => writeConfig(colliding, { effort: 'max' }), /colisão no backup/)
    assert.deepEqual(fs.readFileSync(colliding), original)
  })

  test('backup que não pode ser criado e rename que falha preservam a origem', () => {
    const blocked = path.join(temp(), 'config.json')
    const bytes = Buffer.from('{"effort":"low"}')
    fs.writeFileSync(blocked, bytes)
    fs.mkdirSync(backupFor(blocked, bytes))
    assert.throws(() => writeConfig(blocked, { effort: 'medium' }), /backup/)
    assert.deepEqual(fs.readFileSync(blocked), bytes)

    const file = path.join(temp(), 'config.json')
    fs.writeFileSync(file, bytes)
    mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('rename falhou'), { code: 'EIO' }) })
    assert.throws(() => writeConfig(file, { effort: 'medium' }), /rename falhou/)
    assert.deepEqual(fs.readFileSync(file), bytes)
    assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.includes('.tmp-')), false)
  })

  test('JSON corrompido recebe backup integral antes de ser substituído', () => {
    const file = path.join(temp(), 'config.json')
    const bytes = Buffer.from('{ invalid\n\u0000')
    fs.writeFileSync(file, bytes)
    assert.deepEqual(readConfig(file).operational, { stallMinutes: 5 })
    writeConfig(file, { effort: 'low' })
    assert.deepEqual(fs.readFileSync(backupFor(file, bytes)), bytes)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schemaVersion: 2, effort: 'low', operational: { stallMinutes: 5 } })
  })

  test('schema desconhecido é somente leitura até escrita explícita e então recebe backup', () => {
    const file = path.join(temp(), 'config.json')
    const bytes = Buffer.from('{"schemaVersion":99,"effort":"max","operational":{"stallMinutes":14}}')
    fs.writeFileSync(file, bytes)
    const read = readConfig(file)
    assert.deepEqual(read.stored, {})
    assert.deepEqual(read.operational, { stallMinutes: 5 })
    assert.ok(read.warnings.some((warning) => warning.includes('schemaVersion desconhecida')))
    assert.deepEqual(fs.readFileSync(file), bytes)
    writeConfig(file, { effort: 'low' })
    assert.deepEqual(fs.readFileSync(backupFor(file, bytes)), bytes)
  })

  test('valores JSON com toString não chamável geram avisos tolerantes e backup byte a byte', () => {
    const cases = [
      Buffer.from('{"effort":{"toString":null}}'),
      Buffer.from('{"schemaVersion":{"toString":null},"effort":"max"}'),
    ]
    for (const original of cases) {
      const file = path.join(temp(), 'config.json')
      fs.writeFileSync(file, original)
      const read = readConfig(file)
      assert.ok(read.warnings.length > 0)
      assert.deepEqual(fs.readFileSync(file), original, 'a leitura não deve migrar nem reescrever')
      writeConfig(file, { effort: 'medium' })
      assert.deepEqual(fs.readFileSync(backupFor(file, original)), original)
    }
  })

  test('mudança concorrente antes do rename aborta sem sobrescrever a versão nova', () => {
    const file = path.join(temp(), 'config.json')
    const original = Buffer.from('{"effort":"low","stallMinutes":12}')
    const newer = Buffer.from('{"effort":"max","stallMinutes":20}')
    fs.writeFileSync(file, original)
    const realWrite = fs.writeFileSync
    mock.method(fs, 'writeFileSync', function (target, ...args) {
      const result = realWrite.call(this, target, ...args)
      if (String(target).includes('.tmp-')) realWrite.call(this, file, newer)
      return result
    })
    assert.throws(() => writeConfig(file, { effort: 'medium' }), /mudou durante a gravação/)
    assert.deepEqual(fs.readFileSync(file), newer)
    assert.deepEqual(fs.readFileSync(backupFor(file, original)), original)
    assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.includes('.tmp-')), false)
  })
})
