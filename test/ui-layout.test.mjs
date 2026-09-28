// Núcleo de renderização do painel (bin/ui/graph-layout.mjs): modelo → grafo → layout → posição na tela.
// Invariantes que garantem o "esqueleto encaixado": nenhum nó sobreposto, nenhuma aresta atravessando
// bolinha que não é ponta dela, arestas de centro a centro, cada nó no eixo da sua coluna de etapa, tudo
// dentro do quadro, desenho determinístico.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildGraph, layoutGraph, placeGraph, laneTitle, nodeLabel, LAYOUT, variantOf } from '../bin/ui/graph-layout.mjs'
import { buildModel } from '../bin/graph-watch.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')

const NODE_R = 16 // raio do anel de "rodando" (style.css --ring: 32px): aresta alheia passa longe disso
const node = (id, deps = [], extra = {}) => ({ id, kind: 'implement', risk: 'medium', round: 1, title: `Nó ${id}`, deps, state: 'aguardando', ...extra })

function endpoints(s) {
  const r = (s.angle * Math.PI) / 180
  return [
    { x: s.x, y: s.y },
    { x: s.x + Math.cos(r) * s.len, y: s.y + Math.sin(r) * s.len },
  ]
}

function assertWellFormed(model) {
  const g = buildGraph(model)
  const L = layoutGraph(g)
  const real = g.V.map((v) => [v.id, L.pos.get(v.id)])

  for (const [id, p] of real) assert.ok(p && Number.isFinite(p.x) && Number.isFinite(p.y), `${id} sem posição`)
  for (let i = 0; i < real.length; i++) {
    for (let j = i + 1; j < real.length; j++) {
      const [a, p] = real[i]
      const [b, q] = real[j]
      assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= LAYOUT.ROW - 0.001, `${a} e ${b} sobrepostos`)
    }
  }
  for (const s of L.segments) {
    const [A, B] = endpoints(s)
    for (const [id, p] of real) {
      if (id === s.from || id === s.to) continue
      const dx = B.x - A.x
      const dy = B.y - A.y
      const t = Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / (dx * dx + dy * dy || 1)))
      const d = Math.hypot(A.x + t * dx - p.x, A.y + t * dy - p.y)
      assert.ok(d >= NODE_R, `aresta ${s.key} atravessa ${id}`)
    }
  }
  // cada aresta sai do centro da origem e chega no centro do destino (medido na cadeia inteira)
  const byChain = new Map()
  for (const s of L.segments) {
    const k = `${s.from}>${s.to}`
    ;(byChain.get(k) || byChain.set(k, []).get(k)).push(s)
  }
  for (const [k, segs] of byChain) {
    const first = endpoints(segs[0])[0]
    const last = endpoints(segs[segs.length - 1])[1]
    const from = L.pos.get(segs[0].from)
    const to = L.pos.get(segs[0].to)
    assert.ok(Math.hypot(first.x - from.x, first.y - from.y) < 0.01, `${k} não sai do centro`)
    assert.ok(Math.hypot(last.x - to.x, last.y - to.y) < 0.01, `${k} não chega no centro`)
  }
  // cada vértice real está numa coluna, no eixo de um dos passos dela; plan, critic e synth ficam sozinhos na sua
  for (const [id, p] of real) {
    const lane = L.lanes.find((l) => l.ids.includes(id))
    assert.ok(lane, `${id} sem coluna`)
    const step = p.x / LAYOUT.COL
    assert.ok(Number.isInteger(step) && step >= lane.first && step < lane.first + lane.steps, `${id} fora dos passos da coluna`)
  }
  for (const l of L.lanes) if (l.kind !== 'node') assert.ok(l.count === 1 && l.steps === 1, `coluna ${l.kind} com mais de um vértice`)
  // colunas cobrem os passos em ordem, sem buraco nem sobreposição
  L.lanes.forEach((l, i) => assert.equal(l.first, i ? L.lanes[i - 1].first + L.lanes[i - 1].steps : 0, `coluna ${i} fora de ordem`))
  // na tela, desktop e celular, com e sem gaveta: tudo dentro do quadro, rótulo incluso
  for (const opts of [
    { width: 1176, height: 782 },
    { width: 1176, height: 782, reserveRight: 372 },
    { width: 1440, height: 900, reserveLeft: 288, reserveRight: 372 },
    { width: 390, height: 300, mobile: true },
    { width: 300, height: 200 },
  ]) {
    const P = placeGraph(L, opts)
    const M = opts.mobile ? LAYOUT.mobile : LAYOUT.desktop
    assert.ok(P.stepW >= LAYOUT.LANE_W && P.stepW <= LAYOUT.LANE_MAX, 'largura do passo fora da faixa')
    assert.ok(P.labelW < P.stepW, 'rótulo sem respiro dentro do passo')
    for (const [id] of real) {
      const { x, y } = P.pos.get(id)
      const lane = P.lanes.find((l) => l.ids.includes(id))
      assert.ok(lane.left >= (opts.reserveLeft || 0) + M.PAD_X - 0.001 && lane.left + lane.width <= P.width, `${id} fora do quadro ou sob a lateral`)
      const k = (x - lane.left - P.stepW / 2) / P.stepW // passo dentro da coluna, centrado nele
      assert.ok(Math.abs(k - Math.round(k)) < 0.001 && k > -0.001 && k < lane.steps, `${id} fora do centro de um passo da coluna`)
      assert.ok(y - NODE_R >= lane.top + 40 && y + NODE_R + 24 <= lane.top + lane.height, `${id} não cabe na coluna (título/rótulo)`)
    }
    // na tela, cada aresta continua ligando os centros das pontas
    for (const s of P.segments) {
      const [A, B] = endpoints(s)
      const next = P.segments.find((t) => t.from === s.from && t.to === s.to && t.key === s.key.replace(/#(\d+)$/, (_, i) => `#${+i + 1}`))
      if (s.key.endsWith('#0')) assert.ok(Math.hypot(A.x - P.pos.get(s.from).x, A.y - P.pos.get(s.from).y) < 0.01, `${s.key} solta na origem`)
      if (!next) assert.ok(Math.hypot(B.x - P.pos.get(s.to).x, B.y - P.pos.get(s.to).y) < 0.01, `${s.key} solta no destino`)
    }
    assert.ok(P.width >= opts.width && P.height >= opts.height, 'quadro menor que a área visível')
  }
  // determinístico
  assert.deepEqual(layoutGraph(buildGraph(model)), L)
  return { g, L }
}

describe('buildGraph', () => {
  test('plan → raízes, folhas → critic, critic → synth', () => {
    const { E } = buildGraph({ round: 1, nodes: [node('A'), node('B', ['A']), node('C', ['A'])], critic: null, synth: 'aguardando' })
    const s = E.map((e) => `${e.from}>${e.to}`).sort()
    assert.deepEqual(s, ['A>B', 'A>C', 'B>critic:r1', 'C>critic:r1', 'critic:r1>synth', 'plan>A'].sort())
  })

  test('round 2 sai do critic do round 1 e tem critic próprio', () => {
    const model = {
      round: 2,
      nodes: [node('A', [], { state: 'pronto' }), node('r2-G1', [], { round: 2, state: 'trabalhando' })],
      critic: { r: 1, running: false, gaps: 1, done: false },
      synth: 'aguardando',
    }
    const { V, E } = buildGraph(model)
    const s = E.map((e) => `${e.from}>${e.to}`)
    assert.ok(s.includes('critic:r1>r2-G1'))
    assert.ok(s.includes('r2-G1>critic:r2'))
    assert.ok(s.includes('critic:r2>synth'))
    const st = Object.fromEntries(V.map((v) => [v.id, v.state]))
    assert.equal(st['critic:r1'], 'pronto')
    assert.equal(st['critic:r2'], 'aguardando')
  })

  test('dep de round anterior não vira aresta: o round seguinte sempre começa depois do critic', () => {
    const { E } = buildGraph({ round: 2, nodes: [node('A'), node('r2-G1', ['A'], { round: 2 })], critic: { r: 1, running: false, gaps: 1 }, synth: 'aguardando' })
    const s = E.map((e) => `${e.from}>${e.to}`)
    assert.ok(!s.includes('A>r2-G1'))
    assert.ok(s.includes('critic:r1>r2-G1'))
    const L = layoutGraph(buildGraph({ round: 2, nodes: [node('A'), node('r2-G1', ['A'], { round: 2 })], critic: { r: 1, running: false, gaps: 1 }, synth: 'aguardando' }))
    assert.deepEqual(L.lanes.map((l) => l.kind), ['plan', 'node', 'critic', 'node', 'critic', 'synth'])
  })

  test('sem nós ainda: plan está rodando; dep inexistente é ignorada', () => {
    assert.equal(buildGraph({ round: 1, nodes: [], critic: null, synth: 'aguardando', status: 'rodando' }).V[0].state, 'trabalhando')
    const { E } = buildGraph({ round: 1, nodes: [node('A', ['fantasma'])], critic: null, synth: 'aguardando' })
    assert.ok(E.some((e) => e.from === 'plan' && e.to === 'A'))
  })

  test('variantes: rodando pisca, pronto/falha preenchem, aguardando fica vazia', () => {
    assert.equal(variantOf('verificando'), 'running')
    assert.equal(variantOf('pronto-sem-verif?'), 'done')
    assert.equal(variantOf('falhou-check'), 'fail')
    assert.equal(variantOf('aguardando'), 'empty')
    assert.equal(variantOf('pulado'), 'skipped')
    assert.equal(variantOf('estado-desconhecido'), 'empty')
  })
})

describe('layoutGraph: invariantes', () => {
  test('losango', () => assertWellFormed({ round: 1, nodes: [node('A'), node('B', ['A']), node('C', ['A']), node('D', ['B', 'C'])], critic: null, synth: 'aguardando' }))

  test('aresta que pula camadas vira cadeia com fantasmas e não atravessa nó', () => {
    const { L } = assertWellFormed({ round: 1, nodes: [node('A'), node('B', ['A']), node('C', ['B']), node('X'), node('D', ['X', 'C'])], critic: null, synth: 'aguardando' })
    assert.ok(L.segments.filter((s) => s.from === 'X' && s.to === 'D').length === 3)
  })

  test('dependência implícita no caminho não vira aresta (redução transitiva)', () => {
    const { E } = buildGraph({ round: 1, nodes: [node('A'), node('B', ['A']), node('C', ['B']), node('D', ['A', 'C'])], critic: null, synth: 'aguardando' })
    assert.ok(!E.some((e) => e.from === 'A' && e.to === 'D'), 'A→D já está em A→B→C→D')
    assert.ok(E.some((e) => e.from === 'C' && e.to === 'D'))
  })

  test('fases em sequência viram uma coluna larga; paralelos no mesmo passo, sequência lado a lado e reta', () => {
    // o plano desta run: D1 → (I1, I2); I1 → I3; (I2, I3) → I4 → I5, com as dependências redundantes que o planner declara
    const model = {
      round: 1,
      nodes: [
        node('D1', [], { kind: 'design' }),
        node('I1', ['D1']),
        node('I2', ['D1']),
        node('I3', ['D1', 'I1']),
        node('I4', ['D1', 'I1', 'I2', 'I3']),
        node('I5', ['I1', 'I2', 'I4']),
      ],
      critic: null,
      synth: 'aguardando',
    }
    const { g, L } = assertWellFormed(model)
    const V = new Map(g.V.map((v) => [v.id, v]))
    const names = L.lanes.map((l) => laneTitle(l, l.ids.map((id) => V.get(id).node && V.get(id).node.kind).filter(Boolean), 1))
    assert.deepEqual(names, ['Plano', 'Design', 'Implementação', 'Crítica', 'Síntese'])
    const impl = L.lanes[2]
    assert.deepEqual([impl.count, impl.steps, impl.maxParallel], [5, 4, 2])
    assert.equal(L.pos.get('I1').x, L.pos.get('I2').x, 'I1 e I2 rodam em paralelo: mesmo passo')
    assert.equal(L.pos.get('I3').y, L.pos.get('I1').y, 'I1 → I3 em sequência: mesma altura')
    assert.equal(L.pos.get('I4').y, L.pos.get('I5').y, 'I4 → I5 em sequência: mesma altura')
    assert.equal(g.E.length, 9, 'só as dependências diretas viram aresta')
    // na tela: a coluna larga tem 4 passos sem vão entre eles; entre colunas, GAP
    const P = placeGraph(L, { width: 1440, height: 900 })
    assert.equal(P.lanes[2].width, 4 * P.stepW)
    P.lanes.forEach((l, i) => i && assert.equal(l.left - (P.lanes[i - 1].left + P.lanes[i - 1].width), LAYOUT.GAP))
  })

  test('largo (6 raízes) e vários rounds', () =>
    assertWellFormed({
      round: 3,
      nodes: [
        ...['A', 'B', 'C', 'D', 'E', 'F'].map((id) => node(id)),
        node('r2-G1', [], { round: 2 }),
        node('r2-G2', ['r2-G1'], { round: 2 }),
        node('r3-G1', [], { round: 3 }),
      ],
      critic: { r: 2, running: false, gaps: 1 },
      synth: 'aguardando',
    }))

  test('run sem nós', () => assertWellFormed({ round: 1, nodes: [], critic: null, synth: 'aguardando' }))

  test('colunas esticam para ocupar o espaço livre entre a lateral e a gaveta, e o grafo centra nele', () => {
    const L = layoutGraph(buildGraph({ round: 1, nodes: [node('A'), node('B', ['A'])], critic: null, synth: 'aguardando' }))
    for (const [opts, free0, free1] of [
      [{ width: 1440, height: 900 }, 0, 1440],
      [{ width: 1440, height: 900, reserveLeft: 288 }, 288, 1440],
      [{ width: 1920, height: 900, reserveLeft: 288, reserveRight: 372 }, 288, 1920 - 372],
    ]) {
      const P = placeGraph(L, opts)
      const first = P.lanes[0]
      const last = P.lanes[P.lanes.length - 1]
      assert.ok(Math.abs((first.left + last.left + last.width) / 2 - (free0 + free1) / 2) <= 1, 'grafo fora do centro do espaço livre')
      assert.ok(P.lanes.every((l, i) => i === 0 || l.left - (P.lanes[i - 1].left + P.lanes[i - 1].width) === LAYOUT.GAP), 'colunas com espaçamento irregular')
      assert.ok(P.lanes.every((l) => l.width === l.steps * P.stepW), 'coluna com largura diferente de passos × passo')
    }
    // tela larga: coluna maior que a do design (até o teto); espremido: não passa do mínimo, e rola
    assert.equal(placeGraph(L, { width: 2400, height: 900 }).stepW, LAYOUT.LANE_MAX)
    const tight = placeGraph(L, { width: 700, height: 900, reserveRight: 372 })
    assert.equal(tight.stepW, LAYOUT.LANE_W)
    assert.ok(tight.width > 700)
  })

  test('nome da coluna é a fase do graph-eng', () => {
    const g = buildGraph({ round: 1, nodes: [node('R', [], { kind: 'research' }), node('D', ['R'], { kind: 'design' }), node('I', ['D']), node('J', ['D'], { kind: 'research' })], critic: null, synth: 'aguardando' })
    const L = layoutGraph(g)
    const V = new Map(g.V.map((v) => [v.id, v]))
    const names = L.lanes.map((l) => laneTitle(l, l.ids.map((id) => V.get(id).node && V.get(id).node.kind).filter(Boolean), 1))
    assert.deepEqual(names, ['Plano', 'Pesquisa', 'Design', 'Implementação + Pesquisa', 'Crítica', 'Síntese'])
  })

  test('rótulo do nó não repete o nome da fase, que já está na coluna', () => {
    const v = (id, kind, title) => ({ id, kind: 'node', title, node: { kind } })
    assert.equal(nodeLabel(v('I2', 'implement', 'Implementação: config, CLI e /api/config')), 'I2 · config, CLI e /api/config')
    assert.equal(nodeLabel(v('R1', 'research', 'Pesquisa: motor do workflow')), 'R1 · motor do workflow')
    assert.equal(nodeLabel(v('D1', 'design', 'design — contratos')), 'D1 · contratos')
    // prefixo de outra fase, ou sem prefixo: fica como está
    assert.equal(nodeLabel(v('DR', 'design', 'Revisão do design')), 'DR · Revisão do design')
    assert.equal(nodeLabel(v('I1', 'implement', 'Design: contratos')), 'I1 · Design: contratos')
    assert.equal(nodeLabel({ id: 'plan', kind: 'plan', title: 'plano' }), 'plano')
  })

  test('todas as fixtures do repo', async () => {
    const dirs = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const p = path.join(d, e.name)
        if (fs.existsSync(path.join(p, 'journal.jsonl'))) dirs.push(p)
        else walk(p)
      }
    }
    walk(FIXTURES)
    let checked = 0
    for (const d of dirs) {
      let model
      try {
        model = await buildModel({ runDir: d, economy: 'balanced', mode: 'implement' })
      } catch {
        continue // fixtures de erro (formato não reconhecido etc.)
      }
      assertWellFormed(model)
      checked++
    }
    assert.ok(checked >= 5, `só ${checked} fixtures verificadas`)
  })
})
