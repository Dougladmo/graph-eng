import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertSafeApprovedFiles, NODE_CHECK_MAPPING_HASH, NODE_CHECK_POLICY_ID, resolveNodeCheckSelection } from '../bin/node-check-policy.mjs'

const finalChecks = [{ id: 'node-test', command: process.execPath, args: ['--test', '--test-concurrency=2'], cwd: '.', heavy: true }]

test('seleção local usa mapping confiável e preserva gate final completo', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-check-policy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'bin'), { recursive: true })
  await mkdir(path.join(root, 'test'), { recursive: true })
  await writeFile(path.join(root, 'bin/grapheng.mjs'), 'export {}\n')
  await writeFile(path.join(root, 'test/grapheng.test.mjs'), 'test("fixture", () => {})\n')

  const local = await resolveNodeCheckSelection({ root, files: ['bin/grapheng.mjs'], finalChecks, phase: 'node', nodeId: 'I1', planVersion: 3 })
  assert.deepEqual(local.checks[0].args, ['--test', '--test-concurrency=2', 'test/grapheng.test.mjs'])
  assert.equal(local.selection.coverage, 'affected-tests')
  assert.equal(local.selection.mappingHash, NODE_CHECK_MAPPING_HASH)
  assert.equal(local.selection.policyId, NODE_CHECK_POLICY_ID)

  const final = await resolveNodeCheckSelection({ root, finalChecks, phase: 'final' })
  assert.equal(final.selection.coverage, 'complete')
  assert.deepEqual(final.checks, finalChecks)
})

test('cobertura sem mapping executa só syntax check aplicável e nunca descobre a suíte inteira', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-check-fallback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src/unmapped.mjs'), 'export const value = 1\n')
  const local = await resolveNodeCheckSelection({ root, files: ['src/unmapped.mjs'], finalChecks, phase: 'node', nodeId: 'I1', planVersion: 1 })
  assert.equal(local.selection.coverage, 'syntax-contract-only')
  assert.match(local.selection.limitation, /mapping incompleto/)
  assert.deepEqual(local.checks.map(check => check.args), [['--check', 'src/unmapped.mjs']])
})

test('seleção local rejeita traversal, opção e symlink', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-check-unsafe-'))
  const outside = path.join(root, 'outside.mjs')
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(outside, 'export {}\n')
  await mkdir(path.join(root, 'src'))
  await symlink(outside, path.join(root, 'src/link.mjs'))
  for (const file of ['../outside.mjs', '-e', 'src/link.mjs']) {
    await assert.rejects(resolveNodeCheckSelection({ root, files: [file], finalChecks, phase: 'node', nodeId: 'I1', planVersion: 1 }))
  }
})

test('C7: grant em caminho privado (.graph-runs) bloqueia grant_private_path, inclusive por alias symlink', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-check-private-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.graph-runs/r1'), { recursive: true })
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, '.graph-runs/r1/state.json'), '{}\n')
  await writeFile(path.join(root, 'src/a.js'), 'export {}\n')
  await symlink(path.join(root, '.graph-runs'), path.join(root, 'alias'))
  await assert.rejects(assertSafeApprovedFiles(root, ['.graph-runs/r1/state.json']), /grant_private_path/)
  await assert.rejects(assertSafeApprovedFiles(root, ['alias/r1/state.json']), /grant_private_path/)
  await assert.rejects(assertSafeApprovedFiles(root, ['.graph-runs/r1/novo.json']), /grant_private_path/)
  assert.deepEqual(await assertSafeApprovedFiles(root, ['src/a.js']), ['src/a.js'])
})

test('C7: grant com glob (* ? [ { ) bloqueia grant_glob_unsupported e nunca vira repositório inteiro', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-check-glob-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src/a.js'), 'export {}\n')
  for (const glob of ['src/*.js', 'src/?.js', 'src/[ab].js', 'src/{a,b}.js', '*']) {
    await assert.rejects(assertSafeApprovedFiles(root, [glob]), /grant_glob_unsupported/, glob)
  }
})

test('C7: grant ausente sob diretório symlink que escapa do repositório bloqueia grant_path_escape', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-check-escape-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'node-check-outside-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))
  await symlink(outside, path.join(root, 'link'))
  await assert.rejects(assertSafeApprovedFiles(root, ['link/novo.js']), /grant_path_escape/)
  await symlink(path.join(outside, 'dangling'), path.join(root, 'quebrado'))
  await assert.rejects(assertSafeApprovedFiles(root, ['quebrado/novo.js']), /grant_path_escape/)
})

