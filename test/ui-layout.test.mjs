// Núcleo de renderização do painel (bin/ui/graph-layout.mjs): modelo → grafo → layout. Invariantes que
// garantem o "esqueleto encaixado": nenhum nó sobreposto, nenhuma aresta atravessando bolinha que não é
// ponta dela, pontas aparadas na borda da bolinha, desenho determinístico.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildGraph, layoutGraph, LAYOUT, variantOf } from '../bin/ui/graph-layout.mjs'
import { buildModel } from '../bin/graph-watch.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')

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
      assert.ok(d >= LAYOUT.DOT, `aresta ${s.key} atravessa ${id}`)
    }
  }
  // cada aresta sai da borda da origem e chega na borda do destino (medido na cadeia inteira)
  const byChain = new Map()
  for (const s of L.segments) {
    const k = `${s.from}>${s.to}`
    ;(byChain.get(k) || byChain.set(k, []).get(k)).push(s)
  }
  const rim = LAYOUT.DOT / 2 + LAYOUT.EDGE_GAP
  for (const [k, segs] of byChain) {
    const first = endpoints(segs[0])[0]
    const last = endpoints(segs[segs.length - 1])[1]
    const from = L.pos.get(segs[0].from)
    const to = L.pos.get(segs[0].to)
    assert.ok(Math.abs(Math.hypot(first.x - from.x, first.y - from.y) - rim) < 0.01, `${k} não sai da borda`)
    assert.ok(Math.abs(Math.hypot(last.x - to.x, last.y - to.y) - rim) < 0.01, `${k} não chega na borda`)
  }
  // todo vértice cabe no quadro, com espaço para o rótulo
  for (const [id, p] of real) {
    assert.ok(p.x - LAYOUT.DOT / 2 >= 0 && p.x + LAYOUT.DOT / 2 <= L.width, `${id} fora do quadro na horizontal`)
    assert.ok(p.y - LAYOUT.DOT / 2 >= 0 && p.y + LAYOUT.DOT / 2 + 20 <= L.height, `${id} fora do quadro na vertical`)
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
