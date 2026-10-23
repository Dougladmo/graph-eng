import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { childEnv } from '../bin/child-env.mjs'
import { createHost } from '../bin/hosts.mjs'

// Regressão (review do design adaptativo, item 1): o spawn dos agentes herdava o process.env inteiro, então a chave do
// OpenRouter usada pela triagem chegava ao executor, que tem permissão de escrita. Nenhum filho recebe OPENROUTER_API_KEY
// nem GRAPH_ENG_*; o resto do ambiente (PATH, HOME, credenciais do próprio CLI) segue.
const SECRET_ENV = { OPENROUTER_API_KEY: 'sk-or-teste', GRAPH_ENG_TRIAGE_CLASSIFIER: 'on', GRAPH_ENG_HOME: '/tmp/x', PATH: '/usr/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'mantida' }

test('childEnv tira OPENROUTER_API_KEY e GRAPH_ENG_* e mantém o resto', () => {
  const env = childEnv(SECRET_ENV)
  assert.equal(Object.hasOwn(env, 'OPENROUTER_API_KEY'), false)
  assert.equal(Object.keys(env).some(key => key.startsWith('GRAPH_ENG_')), false)
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'mantida' })
})

test('spawn do agente não repassa a chave do OpenRouter ao processo filho', async t => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'graph-child-env-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const seen = []
  const spawn = (command, args, options) => {
    seen.push(options)
    const child = new EventEmitter()
    Object.assign(child, { pid: 424242, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => {} })
    child.stdin.on('data', () => {})
    child.stdin.on('end', () => { child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, is_error: false })); child.stdout.end(); child.stderr.end(); child.emit('close', 0, null) })
    return child
  }
  const saved = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, GRAPH_ENG_TRIAGE_CLASSIFIER: process.env.GRAPH_ENG_TRIAGE_CLASSIFIER }
  process.env.OPENROUTER_API_KEY = 'sk-or-teste'
  process.env.GRAPH_ENG_TRIAGE_CLASSIFIER = 'on'
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const host = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn }, killProcess: () => {} })
  await host.wait(await host.spawn({ role: 'executor', prompt: 'x', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } }))
  assert.ok(seen[0].env, 'o spawn precisa passar env explícito')
  assert.equal(Object.hasOwn(seen[0].env, 'OPENROUTER_API_KEY'), false)
  assert.equal(Object.hasOwn(seen[0].env, 'GRAPH_ENG_TRIAGE_CLASSIFIER'), false)
  assert.equal(seen[0].env.PATH, process.env.PATH)
})
