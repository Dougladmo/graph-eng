import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runSmoke } from '../bin/graph-smoke.mjs'

function fakeSpawn(calls, { writeMode = 'write' } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.pid = 100
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = () => {}
    if (args[0] === '--version') {
      queueMicrotask(() => {
        child.stdout.end('codex-cli 0.163.0-alpha\n')
        child.stderr.end()
        child.emit('close', 0, null)
      })
    }
    child.stdin.on('end', async () => {
      let prompt = ''
      // The pass-through may already have delivered stdin chunks before end.
      prompt = child.prompt ?? ''
      const nonceLabel = args[args.indexOf('--model') + 1] === 'gpt-6-luna' ? 'Copie nonce exatamente: ' : 'Copie nonce do revisor exatamente: '
      const nonce = prompt.match(new RegExp(`${nonceLabel}([a-f0-9-]+)`))?.[1]
      const outputPath = args[args.indexOf('--output-last-message') + 1]
      if (prompt.includes('write-probe.txt')) {
        // writeMode 'skip' simula o modelo que responde o nonce sem gravar o arquivo.
        const probeNonce = prompt.match(/Nonce da escrita: ([a-f0-9-]+)/)?.[1]
        if (writeMode === 'write') await writeFile(path.join(options.cwd, 'write-probe.txt'), probeNonce)
        await writeFile(outputPath, JSON.stringify({ nonce: probeNonce, status: 'ok' }))
        child.stdout.end(`${JSON.stringify({ type: 'turn.completed' })}\n`)
        child.stderr.end()
        child.emit('close', 0, null)
        return
      }
      let output
      if (args[args.indexOf('--model') + 1] === 'gpt-6-luna') {
        output = { nonce, status: 'ok', detail: null }
      } else {
        assert.match(prompt, /worker-result\.json/)
        const fixture = JSON.parse(await readFile(path.join(options.cwd, 'worker-result.json'), 'utf8'))
        assert.equal(prompt.includes(fixture.nonce), false)
        output = { nonce, verifiedWorkerNonce: fixture.nonce, verifiedWorkerStatus: fixture.status, verification: 'valid', detail: null }
      }
      await writeFile(outputPath, JSON.stringify(output))
      child.stdout.end(`${JSON.stringify({ type: 'turn.completed' })}\n`)
      child.stderr.end()
      child.emit('close', 0, null)
    })
    child.stdin.on('data', chunk => { child.prompt = (child.prompt ?? '') + chunk })
    return child
  }
}

// CLI do claude simulado: captura argumentos e falha o processo, sem dizer nada útil.
function claudeCaptureSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.pid = 101
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = () => {}
    if (args[0] === '--version') {
      queueMicrotask(() => {
        child.stdout.end('2.1.304 (Claude Code)\n')
        child.stderr.end()
        child.emit('close', 0, null)
      })
      return child
    }
    child.stdin.resume()
    child.stdin.on('end', () => {
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 1, null)
    })
    return child
  }
}

test('runSmoke é inerte ao importar, usa os papéis em sequência e grava evidência sem segredos', async t => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'graph-smoke-'))
  t.after(() => rm(baseDir, { recursive: true, force: true }))
  const calls = []
  assert.equal(calls.length, 0)
  const result = await runSmoke({ host: 'codex', baseDir, spawn: fakeSpawn(calls) })
  assert.equal(result.status, 'PASS')
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map(call => call.args[0] === '--version' ? 'version' : call.args[call.args.indexOf('--model') + 1]), ['version', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-luna'])
  assert.equal(result.writeProbe.status, 'PASS')
  assert.ok(calls.every(call => call.options.shell === false))
  assert.deepEqual(result.roles.map(role => role.role), ['worker', 'planReviewer'])
  assert.equal(result.roles[0].requestedModel, 'gpt-6-luna')
  assert.equal(result.roles[1].requestedModel, 'gpt-6.1-sol')
  assert.equal(result.roles[0].effectiveModel, null)
  assert.equal(result.roles[0].output.detail, undefined)
  assert.equal(result.roles[1].evidenceMatched, true)
  assert.equal(result.cancellation.status, 'PASS')
  const saved = JSON.parse(await readFile(path.join(result.outputDirectory, 'worker.json'), 'utf8'))
  assert.equal(saved.status, 'PASS')
  assert.equal(Object.hasOwn(saved, 'stderr'), false)
  assert.equal(Object.hasOwn(saved, 'prompt'), false)
  const workerFixture = JSON.parse(await readFile(path.join(result.outputDirectory, 'fixture', 'worker-result.json'), 'utf8'))
  assert.equal(workerFixture.status, 'ok')
  const cancelFile = JSON.parse(await readFile(path.join(result.outputDirectory, 'cancellation.json'), 'utf8'))
  assert.equal(cancelFile.processGroupGone, true)
})

test('runSmoke rejeita saída fora de .graph-runs antes de iniciar qualquer CLI', async t => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'graph-smoke-safe-'))
  t.after(() => rm(baseDir, { recursive: true, force: true }))
  const calls = []
  await assert.rejects(runSmoke({ host: 'codex', baseDir, out: '../outside', spawn: fakeSpawn(calls) }), /dentro de \.graph-runs/)
  assert.equal(calls.length, 0)
})

test('writeProbe PASS só quando o executor grava write-probe.txt com o nonce, sem read-only', async t => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'graph-smoke-write-'))
  t.after(() => rm(baseDir, { recursive: true, force: true }))
  const calls = []
  const result = await runSmoke({ host: 'codex', baseDir, spawn: fakeSpawn(calls, { writeMode: 'write' }) })
  assert.equal(result.writeProbe.status, 'PASS')
  assert.equal(result.writeProbe.fileMatched, true)
  const probeCall = calls.at(-1)
  assert.ok(probeCall.args.includes('workspace-write'))
  assert.equal(probeCall.args.includes('read-only'), false)
  const file = await readFile(path.join(result.outputDirectory, 'fixture', 'write-probe.txt'), 'utf8')
  assert.equal(file.trim(), result.writeProbe.nonce)
  const saved = JSON.parse(await readFile(path.join(result.outputDirectory, 'writeProbe.json'), 'utf8'))
  assert.equal(saved.status, 'PASS')
})

test('writeProbe BLOCK com WRITE_PROBE_FAILED quando o modelo responde o nonce mas não grava o arquivo (regressão do falso PASS)', async t => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'graph-smoke-nowrite-'))
  t.after(() => rm(baseDir, { recursive: true, force: true }))
  const calls = []
  const result = await runSmoke({ host: 'codex', baseDir, spawn: fakeSpawn(calls, { writeMode: 'skip' }) })
  assert.equal(result.writeProbe.responseNonceMatched, true)
  assert.equal(result.writeProbe.status, 'BLOCK')
  assert.equal(result.writeProbe.error.code, 'WRITE_PROBE_FAILED')
  assert.equal(result.status, 'BLOCK')
  assert.ok(result.roles.every(role => role.status === 'PASS'))
})

test('writeProbe usa papel sem readOnly: no claude o worker fica só em leitura e o probe recebe Edit(./**)', async t => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'graph-smoke-claude-'))
  t.after(() => rm(baseDir, { recursive: true, force: true }))
  const calls = []
  const result = await runSmoke({ host: 'claude', baseDir, spawn: claudeCaptureSpawn(calls) })
  const modelCalls = calls.filter(call => call.args[0] !== '--version')
  assert.equal(modelCalls.length, 2)
  const allowed = call => call.args[call.args.indexOf('--allowedTools') + 1]
  const tools = call => call.args[call.args.indexOf('--tools') + 1]
  assert.equal(allowed(modelCalls[0]), 'Read,Glob,Grep')
  assert.equal(allowed(modelCalls[1]), 'Read,Glob,Grep,Edit(./**)')
  assert.equal(tools(modelCalls[1]), 'Read,Glob,Grep,Edit,Write')
  assert.equal(modelCalls[1].args[modelCalls[1].args.indexOf('--model') + 1], 'haiku')
  assert.equal(result.writeProbe.status, 'BLOCK')
  assert.equal(result.status, 'BLOCK')
})
