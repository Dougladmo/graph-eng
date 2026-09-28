// Núcleo puro do painel: modelo → grafo → layout → posição na tela. Sem DOM, testável no Node
// (test/ui-layout.test.mjs). O app.js importa daqui e só aplica o resultado nos elementos.

// Geometria. O layout trabalha numa grade fixa (colunas a cada COL, nós da mesma etapa a cada ROW) e
// placeGraph a estica na tela: as colunas crescem até LANE_MAX para ocupar o espaço livre, com GAP entre
// elas. As arestas vão de centro a centro e a bolinha, opaca, cobre a ponta.
export const LAYOUT = {
  COL: 170, // unidade da grade: distância entre colunas no layout (LANE_W + GAP)
  LANE_W: 150, // largura mínima da coluna de etapa (a do design; no celular é fixa)
  LANE_MAX: 260, // largura máxima: coluna mais larga que isso só espalha o grafo
  GAP: 20, // espaço entre colunas
  LABEL_PAD: 14, // respiro do rótulo do nó em cada lado, dentro da coluna
  ROW: 80, // distância vertical entre nós da mesma etapa
  // PAD_X: margem lateral; LANE_TOP/LANE_BOTTOM: do quadro à coluna (no desktop, LANE_BOTTOM deixa a legenda
  // flutuante livre); EXTRA: o que a coluna tem além do vão entre o nó de cima e o de baixo (título + rótulos);
  // SHIFT: desce o eixo do grafo abaixo do centro da coluna (no celular, abre espaço para o título)
  desktop: { PAD_X: 16, LANE_TOP: 28, LANE_BOTTOM: 114, EXTRA: 260, SHIFT: 0 },
  mobile: { PAD_X: 12, LANE_TOP: 12, LANE_BOTTOM: 18, EXTRA: 110, SHIFT: 13 },
}

// Nome da coluna: a fase do graph-eng que ela representa. Coluna de nós leva o tipo dos nós dela
// (research/design/implement, os tipos que o planner usa); tipos misturados viram "Pesquisa + Design".
export const KIND_TEXT = { research: 'Pesquisa', design: 'Design', implement: 'Implementação' }
export function laneTitle(lane, kinds, maxRound) {
  if (lane.kind === 'plan') return 'Plano'
  if (lane.kind === 'synth') return 'Síntese'
  if (lane.kind === 'critic') return maxRound > 1 ? `Crítica r${lane.round}` : 'Crítica'
  const names = [...new Set(kinds.map((k) => KIND_TEXT[k] || 'Etapa'))]
  return names.length ? names.join(' + ') : 'Etapa'
}

// ── Estado do nó → variante visual ──
export const VARIANT = {
  trabalhando: 'running',
  verificando: 'running',
  reparando: 'running',
  pronto: 'done',
  'pronto-sem-verif': 'done',
  'pronto-sem-verif?': 'done',
  'sem-reverificacao': 'done',
  falhou: 'fail',
  'falhou-check': 'fail',
  bloqueado: 'fail',
  erro: 'fail',
  aguardando: 'empty',
  pulado: 'skipped',
}
export const variantOf = (state) => VARIANT[state] || 'empty'
export const hasRun = (state) => ['done', 'fail'].includes(variantOf(state))

export const STATE_TEXT = {
  trabalhando: 'trabalhando',
  verificando: 'verificando',
  reparando: 'reparando',
  pronto: 'pronto',
  'pronto-sem-verif': 'pronto sem verificação',
  'pronto-sem-verif?': 'pronto sem verificação (?)',
  'sem-reverificacao': 'pronto, sem reverificação',
  falhou: 'falhou',
  'falhou-check': 'falhou no check',
  bloqueado: 'bloqueado',
  erro: 'erro',
  aguardando: 'ainda não rodou',
  pulado: 'pulado',
}

// ── Grafo: modelo → vértices (nós + pseudo-nós) e arestas ──
// plan → raízes do round 1; folhas do round r → critic:r; critic:r → raízes do round r+1; último critic → synth.
export function buildGraph(model) {
  const nodes = model.nodes || []
  const ids = new Set(nodes.map((n) => n.id))
  const maxRound = Math.max(model.round || 1, ...nodes.map((n) => n.round || 1), 1)
  const V = []
  const E = []
  const add = (v) => (V.push(v), v)

  const critic = model.critic || null
  const ended = model.synth === 'pronto' || model.status === 'terminado'
  add({ id: 'plan', kind: 'plan', round: 1, title: 'plano', state: nodes.length || ended ? 'pronto' : 'trabalhando' })
  for (const n of nodes) add({ id: n.id, kind: 'node', round: n.round || 1, title: n.title || n.id, state: n.state, node: n })
  for (let r = 1; r <= maxRound; r++) {
    let state = 'aguardando'
    if (critic && r < critic.r) state = 'pronto'
    else if (critic && r === critic.r) state = critic.running ? 'verificando' : 'pronto'
    add({ id: `critic:r${r}`, kind: 'critic', round: r, title: maxRound > 1 ? `critic r${r}` : 'critic', state })
  }
  add({ id: 'synth', kind: 'synth', round: maxRound, title: 'síntese', state: model.synth === 'pronto' ? 'pronto' : model.synth === 'rodando' ? 'trabalhando' : 'aguardando' })

  // Aresta só entre nós do mesmo round: dependência de um round anterior já está garantida pelo critic que
  // abre o round (e, desenhada, jogaria o nó na coluna do critic).
  const roundOf = new Map(nodes.map((n) => [n.id, n.round || 1]))
  const sameRoundDeps = (n) => (n.deps || []).filter((d) => ids.has(d) && roundOf.get(d) === (n.round || 1))
  const dependedOn = new Set(nodes.flatMap(sameRoundDeps))
  for (let r = 1; r <= maxRound; r++) {
    const inRound = nodes.filter((n) => (n.round || 1) === r)
    const source = r === 1 ? 'plan' : `critic:r${r - 1}`
    for (const n of inRound) {
      const deps = sameRoundDeps(n)
      if (deps.length) for (const d of deps) E.push({ from: d, to: n.id })
      else E.push({ from: source, to: n.id })
    }
    const leaves = inRound.filter((n) => !dependedOn.has(n.id))
    if (leaves.length) for (const l of leaves) E.push({ from: l.id, to: `critic:r${r}` })
    else E.push({ from: source, to: `critic:r${r}` })
  }
  E.push({ from: `critic:r${maxRound}`, to: 'synth' })
  return { V, E }
}

// ── Layout em camadas (Sugiyama simplificado) ──
// 1) camada = caminho mais longo desde o plan; 2) aresta que pula camadas ganha vértices fantasma, para a
// reta nunca atravessar um nó; 3) ordem na camada por baricentro (reduz cruzamentos), em varreduras
// alternadas; 4) coordenadas: x pela camada, y centrado na camada. Determinístico: mesmo modelo, mesmo desenho.
export function layoutGraph({ V, E }) {
  const byId = new Map(V.map((v) => [v.id, v]))
  const preds = new Map(V.map((v) => [v.id, []]))
  for (const e of E) if (byId.has(e.from) && byId.has(e.to)) preds.get(e.to).push(e.from)

  const layer = new Map()
  const visiting = new Set()
  const layerOf = (id) => {
    if (layer.has(id)) return layer.get(id)
    if (visiting.has(id)) return 0 // ciclo (não deveria existir): corta
    visiting.add(id)
    const ps = preds.get(id) || []
    const l = ps.length ? 1 + Math.max(...ps.map(layerOf)) : 0
    visiting.delete(id)
    layer.set(id, l)
    return l
  }
  V.forEach((v) => layerOf(v.id))
  // synth sempre na última camada, sozinho no fim
  const maxL = Math.max(...layer.values())
  if (layer.has('synth')) layer.set('synth', Math.max(layer.get('synth'), maxL))

  // cadeias com fantasmas
  const chains = [] // { from, to, path: [id...] }
  const ghosts = []
  for (const e of E) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    const a = layer.get(e.from)
    const b = layer.get(e.to)
    const path = [e.from]
    for (let l = a + 1; l < b; l++) {
      const gid = `~${e.from}>${e.to}@${l}`
      ghosts.push(gid)
      layer.set(gid, l)
      path.push(gid)
    }
    path.push(e.to)
    chains.push({ from: e.from, to: e.to, path })
  }

  const layers = []
  const put = (id) => {
    const l = layer.get(id)
    ;(layers[l] = layers[l] || []).push(id)
  }
  V.forEach((v) => put(v.id))
  ghosts.forEach(put)

  const up = new Map()
  const down = new Map()
  for (const c of chains) {
    for (let i = 0; i + 1 < c.path.length; i++) {
      const [u, w] = [c.path[i], c.path[i + 1]]
      ;(down.get(u) || down.set(u, []).get(u)).push(w)
      ;(up.get(w) || up.set(w, []).get(w)).push(u)
    }
  }
  const index = new Map()
  const reindex = () => layers.forEach((ids) => ids.forEach((id, i) => index.set(id, i)))
  reindex()
  const sortBy = (ids, nbrs) => {
    const bary = new Map(
      ids.map((id, i) => {
        const ns = nbrs.get(id) || []
        return [id, ns.length ? ns.reduce((s, n) => s + index.get(n), 0) / ns.length : i]
      }),
    )
    ids.sort((x, y) => bary.get(x) - bary.get(y) || index.get(x) - index.get(y))
    ids.forEach((id, i) => index.set(id, i))
  }
  for (let it = 0; it < 4; it++) {
    for (let l = 1; l < layers.length; l++) if (layers[l]) sortBy(layers[l], up)
    for (let l = layers.length - 2; l >= 0; l--) if (layers[l]) sortBy(layers[l], down)
  }

  // x pela camada, y centrado em 0 dentro da camada (a etapa fica alinhada ao eixo do grafo)
  const pos = new Map()
  layers.forEach((ids, l) => {
    if (!ids) return
    ids.forEach((id, i) => pos.set(id, { x: l * LAYOUT.COL, y: (i - (ids.length - 1) / 2) * LAYOUT.ROW }))
  })

  const segments = []
  for (const c of chains) {
    for (let i = 0; i + 1 < c.path.length; i++) {
      const p = pos.get(c.path[i])
      const q = pos.get(c.path[i + 1])
      segments.push({ key: `${c.from}>${c.to}#${i}`, from: c.from, to: c.to, ...segment(p, q) })
    }
  }

  // uma coluna por camada: tipo pelo vértice real que está nela (plan, critic e synth ficam sozinhos na
  // camada deles; o resto é etapa de nós)
  const lanes = layers.map((ids, index) => {
    const real = (ids || []).filter((id) => byId.has(id)).map((id) => byId.get(id))
    const special = real.find((v) => v.kind !== 'node')
    return { index, kind: special ? special.kind : 'node', round: special ? special.round : Math.max(1, ...real.map((v) => v.round || 1)), ids: real.map((v) => v.id), count: real.length }
  })
  const ys = [...pos.values()].map((p) => p.y)
  return { pos, segments, lanes, minY: Math.min(0, ...ys), maxY: Math.max(0, ...ys) }
}

function segment(p, q) {
  const dx = q.x - p.x
  const dy = q.y - p.y
  return { x: p.x, y: p.y, len: Math.hypot(dx, dy), angle: (Math.atan2(dy, dx) * 180) / Math.PI }
}

// ── Posição na tela ──
// Coloca o layout num quadro de `width` × `height` (o viewport do grafo). `reserveLeft`/`reserveRight` são
// as larguras que os cards flutuantes cobrem (lateral de runs e gaveta de detalhe): as colunas esticam
// (LANE_W..LANE_MAX) e o grafo centra no espaço entre eles. Não coube nem com a largura mínima: começa no
// PAD_X depois do card e o quadro rola. Devolve as colunas, as posições dos vértices e os segmentos das
// arestas já em px, a largura da coluna e o tamanho total do quadro.
export function placeGraph(layout, { width, height, reserveLeft = 0, reserveRight = 0, mobile = false }) {
  const M = mobile ? LAYOUT.mobile : LAYOUT.desktop
  const cols = Math.max(1, layout.lanes.length)
  const free = Math.max(0, width - reserveLeft - reserveRight)
  const fit = Math.floor((free - 2 * M.PAD_X - (cols - 1) * LAYOUT.GAP) / cols)
  const laneW = mobile ? LAYOUT.LANE_W : Math.min(LAYOUT.LANE_MAX, Math.max(LAYOUT.LANE_W, fit))
  const col = laneW + LAYOUT.GAP
  const span = (cols - 1) * col + laneW
  const left = reserveLeft + Math.max(M.PAD_X, Math.round((free - span) / 2))
  const laneH = Math.max(height - M.LANE_TOP - M.LANE_BOTTOM, layout.maxY - layout.minY + M.EXTRA)
  const originX = left + laneW / 2
  const originY = Math.round(M.LANE_TOP + laneH / 2 + M.SHIFT - (layout.minY + layout.maxY) / 2)
  const sx = col / LAYOUT.COL
  const at = (x, y) => ({ x: originX + x * sx, y: originY + y })

  const pos = new Map([...layout.pos].map(([id, p]) => [id, { ...at(p.x, p.y), col: Math.round(p.x / LAYOUT.COL) }]))
  const segments = layout.segments.map((s) => {
    const r = (s.angle * Math.PI) / 180
    const a = at(s.x, s.y)
    const b = at(s.x + Math.cos(r) * s.len, s.y + Math.sin(r) * s.len)
    return { ...s, ...segment(a, b), col: Math.round(s.x / LAYOUT.COL) }
  })
  return {
    laneW,
    labelW: laneW - 2 * LAYOUT.LABEL_PAD,
    pos,
    segments,
    lanes: layout.lanes.map((l) => ({ ...l, left: left + l.index * col, top: M.LANE_TOP, width: laneW, height: laneH })),
    width: Math.max(width, left + span + M.PAD_X + reserveRight),
    height: Math.max(height, M.LANE_TOP + laneH + M.LANE_BOTTOM),
  }
}
