// Núcleo de renderização do painel (bin/ui/graph-layout.mjs): modelo → grafo → layout → posição na tela.
// Invariantes que garantem o "esqueleto encaixado": nenhum nó sobreposto, nenhuma aresta atravessando
// bolinha que não é ponta dela, arestas de centro a centro, cada nó no eixo da sua coluna de etapa, tudo
// dentro do quadro, desenho determinístico.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildGraph, layoutGraph, placeGraph, laneTitle, LAYOUT, variantOf } from '../bin/ui/graph-layout.mjs'
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
  // cada vértice real está numa coluna e no eixo dela; plan, critic e synth ficam sozinhos na sua
  for (const [id, p] of real) {
    const lane = L.lanes.find((l) => l.ids.includes(id))
    assert.ok(lane, `${id} sem coluna`)
    assert.equal(p.x, lane.index * LAYOUT.COL, `${id} fora do eixo da coluna`)
  }
  for (const l of L.lanes) if (l.kind !== 'node') assert.equal(l.count, 1, `coluna ${l.kind} com mais de um vértice`)
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
    assert.ok(P.laneW >= LAYOUT.LANE_W && P.laneW <= LAYOUT.LANE_MAX, 'largura da coluna fora da faixa')
    assert.ok(P.labelW < P.laneW, 'rótulo sem respiro dentro da coluna')
    for (const [id] of real) {
      const { x, y } = P.pos.get(id)
      const lane = P.lanes.find((l) => l.ids.includes(id))
      assert.ok(lane.left >= (opts.reserveLeft || 0) + M.PAD_X - 0.001 && lane.left + lane.width <= P.width, `${id} fora do quadro ou sob a lateral`)
      assert.ok(Math.abs(x - (lane.left + lane.width / 2)) < 0.001, `${id} fora do centro da coluna na tela`)
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
    const { L } = assertWellFormed({ round: 1, nodes: [node('A'), node('B', ['A']), node('C', ['B']), node('D', ['A', 'C'])], critic: null, synth: 'aguardando' })
    assert.ok(L.segments.filter((s) => s.from === 'A' && s.to === 'D').length === 3)
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
      assert.ok(P.lanes.every((l, i) => i === 0 || l.left - P.lanes[i - 1].left === P.laneW + LAYOUT.GAP), 'colunas com espaçamento irregular')
    }
    // tela larga: coluna maior que a do design (até o teto); espremido: não passa do mínimo, e rola
    assert.equal(placeGraph(L, { width: 2400, height: 900 }).laneW, LAYOUT.LANE_MAX)
    const tight = placeGraph(L, { width: 700, height: 900, reserveRight: 372 })
    assert.equal(tight.laneW, LAYOUT.LANE_W)
    assert.ok(tight.width > 700)
  })

  test('nome da coluna é a fase do graph-eng', () => {
    const g = buildGraph({ round: 1, nodes: [node('R', [], { kind: 'research' }), node('D', ['R'], { kind: 'design' }), node('I', ['D']), node('J', ['D'], { kind: 'research' })], critic: null, synth: 'aguardando' })
    const L = layoutGraph(g)
    const V = new Map(g.V.map((v) => [v.id, v]))
    const names = L.lanes.map((l) => laneTitle(l, l.ids.map((id) => V.get(id).node && V.get(id).node.kind).filter(Boolean), 1))
    assert.deepEqual(names, ['Plano', 'Pesquisa', 'Design', 'Implementação + Pesquisa', 'Crítica', 'Síntese'])
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
