// Testes de bin/ui/commands.mjs: commandText (C9, copiar comando pronto).
// Extraído de test/requests.test.mjs (achado da verificação do I3): bin/ui/commands.mjs é
// arquivo do I7, não do I3, então os testes de commandText não podem morar no arquivo de teste
// do I3 (senão um commit só com os arquivos do I3 quebra por ERR_MODULE_NOT_FOUND).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { commandText } from '../bin/ui/commands.mjs'

describe('bin/ui/commands.mjs: commandText (C9)', () => {
  test('literais exatos dos quatro botões', () => {
    assert.equal(commandText({ type: 'resume', runDir: '/a/b/run dir' }), '/graph-eng:graph-eng retomar --run-dir "/a/b/run dir"')
    assert.equal(commandText({ type: 'rerun-node', runDir: '/a/b/run', node: 'I3' }), '/graph-eng:graph-eng refazer I3 --run-dir "/a/b/run"')
    assert.equal(
      commandText({ type: 'rerun-node', runDir: '/a/b/run', node: 'I3', dependents: true }),
      '/graph-eng:graph-eng refazer I3 --dependentes --run-dir "/a/b/run"',
    )
    assert.equal(commandText({ type: 'stop', wf: 'wf_abc123' }), '/graph-eng:graph-eng parar --run wf_abc123')
  })
  test('runDir com ~ também é aceito', () => {
    assert.equal(commandText({ type: 'resume', runDir: '~/graph-eng/.graph-runs/x' }), '/graph-eng:graph-eng retomar --run-dir "~/graph-eng/.graph-runs/x"')
  })
  test('null para entrada inválida: runDir relativo, com aspas ou quebra de linha; wf/node fora da regex', () => {
    assert.equal(commandText({ type: 'resume', runDir: 'relativo/sem/barra' }), null)
    assert.equal(commandText({ type: 'resume', runDir: '/a/b"c' }), null)
    assert.equal(commandText({ type: 'resume', runDir: '/a/b\nc' }), null)
    assert.equal(commandText({ type: 'resume' }), null)
    assert.equal(commandText({ type: 'rerun-node', runDir: '/a/b', node: 'nó inválido' }), null)
    assert.equal(commandText({ type: 'stop', wf: 'não-é-wf' }), null)
    assert.equal(commandText({ type: 'apagar-tudo', runDir: '/a/b' }), null)
  })
})
