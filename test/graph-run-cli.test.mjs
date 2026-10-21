import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { directCliPolicyError } from '../bin/graph-run.mjs'

const GRAPH_RUN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'graph-run.mjs')
const POLICY = { id: 'node-check-policy', mappingHash: 'h', adapter: 'node-test-v1', concurrency: 2 }

test('D-C2 unit: implement sem nodeCheckPolicy bloqueia write_audit_unavailable', () => {
  const result = directCliPolicyError({ runId: 'u1', task: 't', mode: 'implement' })
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback.reason, 'write_audit_unavailable')
  assert.equal(result.runId, 'u1')
  assert.equal(result.report, null)
})

test('D-C2 unit: modo auto sem política também bloqueia (mesma regra de hoje)', () => {
  assert.equal(directCliPolicyError({ task: 't' }).feedback.reason, 'write_audit_unavailable')
})

test('D-C2 unit: planOnly passa sem política', () => {
  assert.equal(directCliPolicyError({ mode: 'implement', planOnly: true }), null)
})

test('D-C2 unit: research, architecture e review passam sem política', () => {
  for (const mode of ['research', 'architecture', 'review']) assert.equal(directCliPolicyError({ mode }), null, mode)
  assert.equal(directCliPolicyError({ plan: { mode: 'research' } }), null)
})

test('D-C2 unit: implement com nodeCheckPolicy passa', () => {
  assert.equal(directCliPolicyError({ mode: 'implement', nodeCheckPolicy: POLICY }), null)
})

test('D-C2 CLI: implement sem política sai com código 2, imprime write_audit_unavailable e não cria runDir', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'graph-run-cli-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const argsFile = path.join(cwd, 'args.json')
  await writeFile(argsFile, JSON.stringify({ runId: 'cli-d-c2', task: 'implementar sem auditoria', mode: 'implement' }))
  const run = spawnSync(process.execPath, [GRAPH_RUN, '--host', 'codex', '--args', argsFile], { cwd, encoding: 'utf8', timeout: 20_000 })
  assert.equal(run.status, 2, run.stderr)
  const printed = JSON.parse(run.stdout)
  assert.equal(printed.status, 'blocked')
  assert.equal(printed.feedback.reason, 'write_audit_unavailable')
  assert.deepEqual((await readdir(cwd)).filter(name => name !== 'args.json'), [])
})

test('D-C2 CLI: retomar só com {runId, resume} sem mode nem nodeCheckPolicy bloqueia write_audit_unavailable (exit 2, sem host)', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'graph-run-cli-resume-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const argsFile = path.join(cwd, 'resume.json')
  await writeFile(argsFile, JSON.stringify({ runId: 'cli-resume', resume: { requestedRerunIds: [] } }))
  const run = spawnSync(process.execPath, [GRAPH_RUN, '--host', 'codex', '--args', argsFile], { cwd, encoding: 'utf8', timeout: 20_000 })
  assert.equal(run.status, 2, run.stderr)
  const printed = JSON.parse(run.stdout)
  assert.equal(printed.feedback.reason, 'write_audit_unavailable')
  assert.deepEqual((await readdir(cwd)).filter(name => name !== 'resume.json'), [])
})
