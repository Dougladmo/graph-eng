// Teste do §8.2 item 12: graphText() em workflows/graph-eng.js não pode ser importado (o motor não
// aceita import(), §5.5), então o teste extrai a função do arquivo por regex/contagem de chaves, a
// avalia sobre NODES/RESULTS/BLOCKED sintéticos, e compara o resultado, linha a linha, com o modo
// compacto do graph-watch (bin/graph-watch.mjs graphText()) sobre um Model com os mesmos estados.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { graphText as watchGraphText, buildModel } from '../bin/graph-watch.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_PATH = path.join(__dirname, '..', 'workflows', 'graph-eng.js')
const FIXTURES = path.join(__dirname, 'fixtures')

// Extrai o corpo de `function graphText() { ... }` contando chaves (a função tem ternários e
// arrow functions com seu próprio bloco, então um regex ganancioso simples não fecha certo).
function extractGraphText(source) {
  const start = source.indexOf('function graphText()')
  assert.notEqual(start, -1, 'function graphText() não encontrada em workflows/graph-eng.js')
  const braceStart = source.indexOf('{', start)
  let depth = 0
  let i = braceStart
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  assert.ok(depth === 0, 'chaves de graphText() não fecharam (extração falhou)')
  return source.slice(start, i + 1)
}

function runEngineGraphText(nodes, results, blocked) {
  const source = fs.readFileSync(ENGINE_PATH, 'utf8')
  const fnSource = extractGraphText(source)
  const factory = new Function('NODES', 'RESULTS', 'BLOCKED', `${fnSource}\nreturn graphText();`)
  return factory(nodes, results, blocked)
}

// Estado sintético: cobre todo estado que o motor consegue saber sem journal (aguardando, pulado,
// bloqueado, pronto, pronto-sem-verif, sem-reverificacao, falhou, falhou-check). Os estados
// transitórios (trabalhando/verificando/reparando/erro) exigem o journal e não são deste teste.
function buildFixture() {
  const mk = (id, deps) => ({ id, kind: 'research', risk: 'medium', round: 1, title: id, deps, explore: false })
  const order = [
    mk('n1', []), // aguardando
    mk('n2', []), // pronto
    mk('n7', []), // bloqueado
    mk('n3', ['n2']), // pronto-sem-verif
    mk('n4', ['n2']), // sem-reverificacao
    mk('n8', ['n7']), // pulado
    mk('n5', ['n3']), // falhou
    mk('n6', ['n3']), // falhou-check
  ]
  const NODES = new Map(order.map((n) => [n.id, n]))
  const RESULTS = new Map([
    ['n2', { status: 'done', verified: true, attempts: 1 }],
    ['n3', { status: 'done', verified: false, attempts: 1 }],
    ['n4', { status: 'done', verified: false, attempts: 2 }],
    ['n5', { status: 'failed', verdict: { blocking: [{ issue: 'a lógica X não cobre o caso Y' }] }, attempts: 2 }],
    ['n6', { status: 'failed', verdict: { blocking: [{ issue: 'check failing: npm test' }] }, attempts: 1 }],
    ['n7', { status: 'blocked', attempts: 1 }],
    ['n8', { status: 'skipped' }],
  ])
  const BLOCKED = new Set(['n7', 'n8'])
  const stateById = {
    n1: 'aguardando',
    n2: 'pronto',
    n7: 'bloqueado',
    n3: 'pronto-sem-verif',
    n4: 'sem-reverificacao',
    n8: 'pulado',
    n5: 'falhou',
    n6: 'falhou-check',
  }
  const watchNodes = order.map((n) => ({ ...n, state: stateById[n.id], reps: 0 }))
  return { NODES, RESULTS, BLOCKED, watchNodes }
}

function watchCompactLines(watchNodes) {
  const model = {
    wf: 'wf_test',
    round: 1,
    status: 'rodando',
    idleSec: 0,
    warns: [],
    nodes: watchNodes,
    critic: null,
    synth: 'aguardando',
    spent: watchNodes.length,
  }
  // cols bem estreito: nenhuma camada cabe em caixas (BOX_W=22 + bordas), força o modo compacto.
  const text = watchGraphText(model, { cols: 60 })
  const lines = text.split('\n')
  const firstBlank = lines.indexOf('')
  const rest = lines.slice(firstBlank + 1)
  const nextBlank = rest.indexOf('')
  return rest.slice(0, nextBlank)
}

test('graphText() do motor bate, linha a linha, com o compacto do graph-watch sobre o mesmo estado', () => {
  const { NODES, RESULTS, BLOCKED, watchNodes } = buildFixture()
  const engineOut = runEngineGraphText(NODES, RESULTS, BLOCKED).split('\n')
  const watchOut = watchCompactLines(watchNodes)
  assert.equal(engineOut.length, watchOut.length, `linhas: motor=${engineOut.length} watch=${watchOut.length}\nmotor:\n${engineOut.join('\n')}\nwatch:\n${watchOut.join('\n')}`)
  for (let i = 0; i < engineOut.length; i++) {
    assert.equal(engineOut[i], watchOut[i], `linha ${i} difere`)
  }
})

test('graphText() do motor: nó sem resultado ainda sai como aguardando, sem marcador de progresso', () => {
  const NODES = new Map([['solo', { id: 'solo', kind: 'research', risk: 'low', round: 1, title: 'solo', deps: [], explore: false }]])
  const RESULTS = new Map()
  const BLOCKED = new Set()
  const out = runEngineGraphText(NODES, RESULTS, BLOCKED)
  assert.equal(out, '[ ] solo aguardando  ← plan')
})

// D3 §10 "Outros": um caso sobre a fixture wf_phases, com o sufixo "(injetada)" e a linha da
// revisão do design.
test('graphText() da fixture wf_phases: nó injetado com sufixo e linha "revisão do design"', async () => {
  const model = await buildModel({ runDir: path.join(FIXTURES, 'wf_phases') })
  const text = watchGraphText(model, { cols: 200 })
  assert.ok(model.nodes.find((n) => n.id === 'research-base').reason.length > 0, 'nó injetado com motivo')
  assert.match(text, /\(injetado\) = nó que o motor acrescentou ao plano/)
  assert.match(text, /revisão do design: pronto r2/)
  assert.match(text, /polimento 2\/2/)
})
