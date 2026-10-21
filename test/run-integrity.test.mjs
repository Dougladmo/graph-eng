import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createIntegrityGuard, diffInventory, inventory } from '../bin/run-integrity.mjs'

async function tempTree(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-integrity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('C10: dotfile novo na runDir é delta', async t => {
  const root = await tempTree(t)
  await writeFile(path.join(root, 'state.json'), '{}')
  const before = await inventory(root)
  await writeFile(path.join(root, '.hidden-new'), 'x')
  const after = await inventory(root)
  assert.deepEqual(diffInventory(before, after), ['.hidden-new'])
})

test('C10: symlink não é seguido e troca de alvo é delta', async t => {
  const root = await tempTree(t)
  const outside = await tempTree(t)
  await writeFile(path.join(root, 'a.txt'), 'same')
  await writeFile(path.join(root, 'b.txt'), 'same')
  await symlink(outside, path.join(root, 'ext'))
  await symlink('a.txt', path.join(root, 'link'))
  const before = await inventory(root)
  assert.equal(before.get('link').type, 'symlink')
  assert.equal(before.get('ext').type, 'symlink')
  assert.equal([...before.keys()].some(key => key.startsWith('ext/')), false)
  await writeFile(path.join(outside, 'escondido.txt'), 'fora')
  assert.deepEqual(diffInventory(before, await inventory(root)), [])
  await rm(path.join(root, 'link'))
  await symlink('b.txt', path.join(root, 'link'))
  assert.deepEqual(diffInventory(before, await inventory(root)), ['link'])
})

test('C10: bit de execução é delta', async t => {
  const root = await tempTree(t)
  const script = path.join(root, 'run.sh')
  await writeFile(script, 'echo oi\n')
  await chmod(script, 0o644)
  const before = await inventory(root)
  await chmod(script, 0o755)
  assert.deepEqual(diffInventory(before, await inventory(root)), ['run.sh'])
})

test('C10: arquivo trocado por diretório é delta', async t => {
  const root = await tempTree(t)
  await writeFile(path.join(root, 'x'), 'arquivo')
  const before = await inventory(root)
  await rm(path.join(root, 'x'))
  await mkdir(path.join(root, 'x'))
  assert.deepEqual(diffInventory(before, await inventory(root)), ['x'])
})

test('C10: touch sem mudar bytes não é delta', async t => {
  const root = await tempTree(t)
  const file = path.join(root, 'state.json')
  await writeFile(file, '{"ok":true}')
  const before = await inventory(root)
  const future = new Date(Date.now() + 60_000)
  await utimes(file, future, future)
  assert.deepEqual(diffInventory(before, await inventory(root)), [])
})

test('C10: raiz entra no inventário como diretório', async t => {
  const root = await tempTree(t)
  const map = await inventory(root)
  assert.equal(map.get('.')?.type, 'dir')
})

const stateSpec = bytes => ({ 'state.json': { bytes } })

test('C11: mudança externa entre writes bloqueia antes de executar op', async t => {
  const root = await tempTree(t)
  await writeFile(path.join(root, 'state.json'), '{"v":1}')
  const guard = createIntegrityGuard({ root, critical: ['state.json'] })
  await guard.install()
  await writeFile(path.join(root, 'state.json'), '{"v":"forjado"}')
  let ran = 0
  await assert.rejects(
    guard.trustedWrite({ paths: ['state.json'], expect: () => stateSpec('{"v":2}') }, async () => {
      ran += 1
      await writeFile(path.join(root, 'state.json'), '{"v":2}')
    }),
    { code: 'run_integrity_violation' }
  )
  assert.equal(ran, 0)
})

test('C11: op que escreve path não declarado bloqueia', async t => {
  const root = await tempTree(t)
  await writeFile(path.join(root, 'state.json'), '{"v":1}')
  const guard = createIntegrityGuard({ root, critical: ['state.json'] })
  await guard.install()
  await assert.rejects(
    guard.trustedWrite({ paths: ['state.json'], expect: () => stateSpec('{"v":2}') }, async () => {
      await writeFile(path.join(root, 'state.json'), '{"v":2}')
      await writeFile(path.join(root, 'rogue.txt'), 'fora da lista')
    }),
    error => error.code === 'run_integrity_violation' && error.paths.includes('rogue.txt')
  )
})

test('C11: violação é sticky mesmo se a chamada seguinte for limpa', async t => {
  const root = await tempTree(t)
  const file = path.join(root, 'state.json')
  await writeFile(file, '{"v":1}')
  const guard = createIntegrityGuard({ root, critical: ['state.json'] })
  await guard.install()
  await writeFile(file, '{"v":"forjado"}')
  await assert.rejects(guard.trustedWrite({ paths: [], expect: () => ({}) }, async () => {}), { code: 'run_integrity_violation' })
  await writeFile(file, '{"v":1}')
  await assert.rejects(guard.trustedWrite({ paths: [], expect: () => ({}) }, async () => {}), { code: 'run_integrity_violation' })
  await assert.rejects(guard.assertIntegrity(), { code: 'run_integrity_violation' })
})

test('C11: reentrância lança integrity_reentrant sem deadlock', { timeout: 5000 }, async t => {
  const root = await tempTree(t)
  await writeFile(path.join(root, 'state.json'), '{"v":1}')
  const guard = createIntegrityGuard({ root, critical: ['state.json'] })
  await guard.install()
  await assert.rejects(
    guard.trustedWrite({ paths: [], expect: () => ({}) }, async () => {
      await guard.trustedWrite({ paths: [], expect: () => ({}) }, async () => {})
    }),
    { code: 'integrity_reentrant' }
  )
  await assert.rejects(
    guard.trustedWrite({ paths: [], expect: () => ({}) }, async () => {
      await guard.assertIntegrity()
    }),
    { code: 'integrity_reentrant' }
  )
})

test('C11: escrita legítima no padrão atomicJson passa e não gera violação', async t => {
  const root = await tempTree(t)
  await writeFile(path.join(root, 'state.json'), '{"v":1}')
  const guard = createIntegrityGuard({ root, critical: ['state.json'] })
  await guard.install()
  const atomicWrite = bytes => async () => {
    const temp = path.join(root, `state.json.${Math.random().toString(16).slice(2)}.tmp`)
    await writeFile(temp, bytes)
    await rename(temp, path.join(root, 'state.json'))
  }
  await guard.trustedWrite({ paths: ['state.json'], expect: () => stateSpec('{"v":2}') }, atomicWrite('{"v":2}'))
  await guard.trustedWrite({ paths: ['state.json'], expect: () => stateSpec('{"v":3}') }, atomicWrite('{"v":3}'))
  await guard.assertIntegrity()
})

test('C11: assertIntegrity pega arquivo novo fora de qualquer escrita declarada', async t => {
  const root = await tempTree(t)
  await writeFile(path.join(root, 'state.json'), '{"v":1}')
  await mkdir(path.join(root, 'sub'))
  await writeFile(path.join(root, 'sub', 'antigo.txt'), 'ok')
  const guard = createIntegrityGuard({ root, critical: ['state.json'] })
  await guard.install()
  await writeFile(path.join(root, 'sub', 'novo.txt'), 'nao declarado')
  await assert.rejects(guard.assertIntegrity(), error => error.code === 'run_integrity_violation' && error.paths.includes('sub/novo.txt'))
})

test('C12: escopo critical ignora arquivo de privado não crítico e ainda pega delta do crítico', async t => {
  const root = await tempTree(t)
  await writeFile(path.join(root, 'state.json'), '{"v":1}')
  const guard = createIntegrityGuard({ root, critical: ['state.json'], scope: 'critical' })
  await guard.install()
  await mkdir(path.join(root, 'outputs'))
  await writeFile(path.join(root, 'outputs', 'x.json'), 'privado do supervisor, ainda sem guard')
  await guard.assertIntegrity()
  await guard.trustedWrite({ paths: ['state.json'], expect: () => stateSpec('{"v":2}') }, async () => {
    await writeFile(path.join(root, 'state.json'), '{"v":2}')
  })
  await writeFile(path.join(root, 'state.json'), '{"v":"forjado"}')
  await assert.rejects(guard.assertIntegrity(), error => error.code === 'run_integrity_violation' && error.paths.includes('state.json'))
})

// C13: expect { dir: true } só cria caminho ausente; diretório que já existia não é aceito como criado.
test('C13: expect {dir:true} não aceita diretório que já existia', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graph-eng-dirspec-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'existente'))
  const guard = createIntegrityGuard({ root, scope: 'tree' })
  await guard.install()
  await assert.rejects(guard.trustedWrite({ paths: ['existente'], expect: () => ({ existente: { dir: true } }) }, async () => {}), TypeError)
  await guard.trustedWrite({ paths: ['novo'], expect: () => ({ novo: { dir: true } }) }, () => mkdir(path.join(root, 'novo')))
  await guard.assertIntegrity()
})

test('C13 FIX1: registerEphemeral em caminho já presente é violação', async t => {
  const root = await tempTree(t)
  const guard = createIntegrityGuard({ root, scope: 'tree' })
  await guard.install()
  await writeFile(path.join(root, 'check-planted.stdout'), 'planted')
  await assert.rejects(guard.registerEphemeral(['check-planted.stdout']), error => error.code === 'run_integrity_violation' && error.paths.includes('check-planted.stdout'))
  await assert.rejects(guard.assertIntegrity(), error => error.code === 'run_integrity_violation')
})
