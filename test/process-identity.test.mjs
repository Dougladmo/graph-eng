import assert from 'node:assert/strict'
import test from 'node:test'
import { localHostIdentity, lookupProcessIdentity, processIdentity } from '../bin/process-identity.mjs'

test('lookup usa somente ps lstart com argv e enriquece Linux com boot_id e starttime', async () => {
  const calls = []
  const result = await lookupProcessIdentity(41, localHostIdentity(), {
    platform: 'linux', kill: () => {},
    execFileImpl: async (...args) => { calls.push(args); return { stdout: 'Sat Oct 17 12:34:56 2026\n' } },
    readFileImpl: async file => file.endsWith('/stat') ? '41 (process name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 98765' : 'boot-123\n',
  })
  assert.equal(result.status, 'alive')
  assert.match(result.startIdentity, /^linux:41:Sat Oct 17 12:34:56 2026:boot-123:98765$/)
  assert.deepEqual(calls[0].slice(0, 2), ['ps', ['-p', '41', '-o', 'lstart=']])
  assert.equal(calls[0][2].shell, false)
  assert.equal(calls[0][2].env.LC_ALL, 'C')
})

test('lookup só confirma dead com ESRCH', async () => {
  const dead = await lookupProcessIdentity(41, localHostIdentity(), { kill: () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error } })
  const denied = await lookupProcessIdentity(41, localHostIdentity(), { kill: () => { const error = new Error('denied'); error.code = 'EPERM'; throw error } })
  assert.deepEqual(dead, { status: 'dead' })
  assert.equal(denied.status, 'unknown')
})

test('ps vazio ou erro sem ESRCH é unknown, e host remoto é unknown', async () => {
  const empty = await lookupProcessIdentity(41, localHostIdentity(), { kill: () => {}, execFileImpl: async () => ({ stdout: '' }) })
  const failed = await lookupProcessIdentity(41, localHostIdentity(), { kill: () => {}, execFileImpl: async () => { throw new Error('ps indisponível') } })
  const remote = await lookupProcessIdentity(41, 'claude')
  assert.equal(empty.status, 'unknown')
  assert.equal(failed.status, 'unknown')
  assert.equal(remote.status, 'unknown')
})

test('processIdentity exige lookup vivo', async () => {
  await assert.rejects(processIdentity({ pid: 41, host: 'codex' }), /indisponível/)
})
