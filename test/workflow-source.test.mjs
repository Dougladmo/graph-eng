import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { compileWorkflow, ENGINE_PATH, loadWorkflowSource } from '../bin/workflow-source.mjs'
import { runWorkflow } from './helpers/run-workflow.mjs'

test('runner e harness compilam o mesmo Workflow fonte', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'graph-workflow-source-'))
  const source = path.join(dir, 'sentinel.js')
  try {
    await writeFile(source, "export const meta = {\n  name: 'sentinel',\n}\nreturn { marker: args.marker, host: runtime.host }\n")
    const direct = await (await compileWorkflow(source))({ marker: 'mesma-fonte' }, async () => null, () => {}, () => {}, async () => [], {}, { host: 'test' })
    const viaHarness = await runWorkflow({ marker: 'mesma-fonte' }, async () => null, { sourcePath: source, runtime: { host: 'test' } })
    assert.deepEqual(direct, viaHarness.result)
    assert.equal(direct.marker, 'mesma-fonte')
    assert.equal(await loadWorkflowSource(source), "return { marker: args.marker, host: runtime.host }\n")
    assert.ok(ENGINE_PATH.endsWith('/workflows/graph-eng.js'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
