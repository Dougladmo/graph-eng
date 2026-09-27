// Testes da flag `--svg` (spec §4.2, §6.5, §7, §8.2 item 11). O binário `d2` é opcional: o caso de
// PATH vazio roda sempre (§7 "aviso: d2 não encontrado ... segue"); o caso que de fato compila com
// `d2` é pulado se `which d2` falhar (nada instala nada nesta suíte).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const BIN = path.join(ROOT, 'bin', 'graph-watch.mjs')
const FIXTURES = path.join(__dirname, 'fixtures')
const fx = (name) => path.join(FIXTURES, name)

const { buildModel, buildD2Source } = await import('../bin/graph-watch.mjs')

function hasD2() {
  const r = spawnSync('which', ['d2'])
  return r.status === 0
}

function runKillable(args, env, killAfterMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, env })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => finish(code))
    child.on('error', () => finish(null))
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL')
    }, killAfterMs)
  })
}

describe('--svg (§8.2 item 11)', () => {
  test('PATH vazio: uma linha de aviso e o `live` segue no terminal', async () => {
    const env = { ...process.env, PATH: '' }
    const { stdout, stderr } = await runKillable(['live', '--svg', '--run-dir', fx('happy'), '--no-color'], env, 700)
    assert.match(stdout + stderr, /d2 não encontrado/)
    // segue como live normal: o cabeçalho do grafo aparece mesmo sem o d2.
    assert.match(stdout, /graph-eng/)
    assert.doesNotMatch(stdout + stderr, /unexpected token|syntaxerror|TypeError/i)
  })

  test('graph.d2 gerado é sintaxe D2 válida (compila com `d2 graph.d2 /dev/null`)', async (t) => {
    if (!hasD2()) {
      t.skip('d2 não instalado nesta máquina (`which d2` falhou)')
      return
    }
    const model = await buildModel({ runDir: fx('happy') })
    const src = buildD2Source(model)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-svg-'))
    const d2Path = path.join(dir, 'graph.d2')
    fs.writeFileSync(d2Path, src)
    const r = spawnSync('d2', [d2Path, '/dev/null'])
    assert.equal(r.status, 0, `d2 falhou ao compilar:\n${r.stderr}`)
  })

  test('buildD2Source: um nó por id, e uma aresta por dep existente', async () => {
    const model = await buildModel({ runDir: fx('happy') })
    const src = buildD2Source(model)
    for (const n of model.nodes) assert.match(src, new RegExp(`^${n.id}: "`, 'm'))
    for (const n of model.nodes) {
      for (const d of n.deps || []) {
        if (model.nodes.some((x) => x.id === d)) assert.match(src, new RegExp(`^${d} -> ${n.id}$`, 'm'))
      }
    }
  })
})
