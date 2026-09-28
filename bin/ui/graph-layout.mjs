// Núcleo puro do painel: modelo → grafo → layout → posição na tela. Sem DOM, testável no Node
// (test/ui-layout.test.mjs). O app.js importa daqui e só aplica o resultado nos elementos.

// Geometria. O layout trabalha numa grade fixa (um passo do grafo a cada COL, nós do mesmo passo a cada ROW)
// e placeGraph a estica na tela. Cada fase é uma coluna; fase com passos em sequência (implementação em
// cadeia, por exemplo) é uma coluna larga, um passo ao lado do outro, sem vão entre eles. O passo cresce até
// LANE_MAX para ocupar o espaço livre, e há GAP entre colunas. As arestas vão de centro a centro e a bolinha,
// opaca, cobre a ponta.
export const LAYOUT = {
  COL: 170, // unidade da grade: distância entre passos no layout
  LANE_W: 150, // largura mínima de um passo (a coluna do design; no celular é fixa)
  LANE_MAX: 260, // largura máxima de um passo: mais largo que isso só espalha o grafo
  GAP: 20, // espaço entre colunas (fases)
  LABEL_PAD: 14, // respiro do rótulo do nó em cada lado, dentro do passo
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
  if (lane.kind === 'design-review') return 'Revisão do design'
  if (lane.kind === 'polish') return 'Síntese: polimento'
  const names = [...new Set(kinds.map((k) => KIND_TEXT[k] || 'Etapa'))]
  return names.length ? names.join(' + ') : 'Etapa'
}

// Rótulo do nó sem o nome da fase na frente: a coluna já diz "Implementação", então
// "Implementação: config e API" vira "I2 · config e API" e sobra espaço para o que importa. O título
// inteiro continua no tooltip e na gaveta.
export function nodeLabel(v) {
  if (v.kind !== 'node') return v.title
  const kind = v.node && v.node.kind
  const names = [KIND_TEXT[kind], kind].filter(Boolean).map((s) => s.toLowerCase())
  const m = /^\s*([^:—–]+?)\s*[:—–]\s*(\S.*)$/.exec(v.title)
  return `${v.id} · ${m && names.includes(m[1].toLowerCase()) ? m[2] : v.title}`
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
  const dr = model.designReview || null
  const polish = model.polish || []
  add({ id: 'plan', kind: 'plan', round: 1, title: 'plano', state: nodes.length || ended ? 'pronto' : 'trabalhando' })
  for (const n of nodes) {
    const v = { id: n.id, kind: 'node', round: n.round || 1, title: n.title || n.id, state: n.state, node: n }
    if (n.injected) v.injected = true
    add(v)
  }
  // Revisão do design (D3 §5.2): pseudo-vértice único, uma tentativa vira estado e título dele.
  if (dr) add({ id: 'design-review', kind: 'design-review', round: 1, title: dr.attempts > 1 ? `revisão do design r${dr.attempts}` : 'revisão do design', state: dr.state })
  for (let r = 1; r <= maxRound; r++) {
    let state = 'aguardando'
    if (critic && r < critic.r) state = 'pronto'
    else if (critic && r === critic.r) state = critic.running ? 'verificando' : 'pronto'
    // Revisão do design reprovada e terminada: o critic do round 1 nunca roda de fato.
    if (dr && r === 1 && dr.state === 'falhou' && ended) state = 'pulado'
    add({ id: `critic:r${r}`, kind: 'critic', round: r, title: maxRound > 1 ? `critic r${r}` : 'critic', state })
  }
  // Polidores (D3 §5.2, spec item 9): agentes da síntese visíveis, um vértice por polidor.
  for (const p of polish) {
    const state = p.state === 'trabalhando' ? 'trabalhando' : p.state === 'erro' ? 'erro' : 'pronto'
    add({ id: `polish:${p.k}`, kind: 'polish', round: maxRound, title: `polidor ${p.k}`, state })
  }
  add({ id: 'synth', kind: 'synth', round: maxRound, title: 'síntese', state: model.synth === 'pronto' ? 'pronto' : model.synth === 'rodando' ? 'trabalhando' : 'aguardando' })

  // Aresta só entre nós do mesmo round: dependência de um round anterior já está garantida pelo critic que
  // abre o round (e, desenhada, jogaria o nó na coluna do critic).
  const byNode = new Map(nodes.map((n) => [n.id, n]))
  const roundOf = new Map(nodes.map((n) => [n.id, n.round || 1]))
  const sameRoundDeps = (n) => (n.deps || []).filter((d) => ids.has(d) && roundOf.get(d) === (n.round || 1))
  const dependedOn = new Set(nodes.flatMap(sameRoundDeps))
  // Redução transitiva: I4 depende de D1 e de I3, e I3 já depende de D1 → a aresta D1→I4 não é desenhada (a
  // ordem já está no caminho D1→I1→I3→I4). Sem isso, cada dependência implícita vira uma linha cruzando o grafo.
  const ancestors = new Map()
  const ancestorsOf = (id, visiting = new Set()) => {
    if (ancestors.has(id)) return ancestors.get(id)
    if (visiting.has(id)) return new Set() // ciclo (não deveria existir): corta
    visiting.add(id)
    const all = new Set()
    for (const d of sameRoundDeps(byNode.get(id))) {
      all.add(d)
      for (const a of ancestorsOf(d, visiting)) all.add(a)
    }
    visiting.delete(id)
    ancestors.set(id, all)
    return all
  }
  const directDeps = (n) => {
    const deps = sameRoundDeps(n)
    return deps.filter((d) => !deps.some((o) => o !== d && ancestorsOf(o).has(d)))
  }
  for (let r = 1; r <= maxRound; r++) {
    const inRound = nodes.filter((n) => (n.round || 1) === r)
    const source = r === 1 ? 'plan' : `critic:r${r - 1}`
    if (r === 1 && dr) {
      // Estágio 1 (não-implement) termina na revisão do design; estágio 2 (implement) sai dela e
      // vai para o critic:r1 (D3 §5.2). A revisão substitui a aresta design→implement direta.
      const stage1 = inRound.filter((n) => n.kind !== 'implement')
      const stage2 = inRound.filter((n) => n.kind === 'implement')
      const stage1Ids = new Set(stage1.map((n) => n.id))
      const stage2Ids = new Set(stage2.map((n) => n.id))
      const stage1DirectDeps = new Map(stage1.map((n) => [n.id, directDeps(n).filter((d) => stage1Ids.has(d))]))
      for (const n of stage1) {
        const deps = stage1DirectDeps.get(n.id)
        if (deps.length) for (const d of deps) E.push({ from: d, to: n.id })
        else E.push({ from: source, to: n.id })
      }
      const stage1DependedOn = new Set([...stage1DirectDeps.values()].flat())
      const stage1Leaves = stage1.filter((n) => !stage1DependedOn.has(n.id))
      if (stage1Leaves.length) for (const l of stage1Leaves) E.push({ from: l.id, to: 'design-review' })
      else E.push({ from: source, to: 'design-review' })

      const stage2DirectDeps = new Map(stage2.map((n) => [n.id, directDeps(n).filter((d) => stage2Ids.has(d))]))
      for (const n of stage2) {
        const deps = stage2DirectDeps.get(n.id)
        if (deps.length) for (const d of deps) E.push({ from: d, to: n.id })
        else E.push({ from: 'design-review', to: n.id })
      }
      const stage2DependedOn = new Set([...stage2DirectDeps.values()].flat())
      const stage2Leaves = stage2.filter((n) => !stage2DependedOn.has(n.id))
      if (stage2Leaves.length) for (const l of stage2Leaves) E.push({ from: l.id, to: 'critic:r1' })
      else E.push({ from: 'design-review', to: 'critic:r1' })
    } else {
      for (const n of inRound) {
        const deps = directDeps(n)
        if (deps.length) for (const d of deps) E.push({ from: d, to: n.id })
        else E.push({ from: source, to: n.id })
      }
      const leaves = inRound.filter((n) => !dependedOn.has(n.id))
      if (leaves.length) for (const l of leaves) E.push({ from: l.id, to: `critic:r${r}` })
      else E.push({ from: source, to: `critic:r${r}` })
    }
  }
  if (polish.length) {
    for (const p of polish) {
      E.push({ from: `critic:r${maxRound}`, to: `polish:${p.k}` })
      E.push({ from: `polish:${p.k}`, to: 'synth' })
    }
  } else {
    E.push({ from: `critic:r${maxRound}`, to: 'synth' })
  }
  return { V, E }
}

// ── Layout em camadas (Sugiyama simplificado) ──
// 1) camada (passo) = caminho mais longo desde o plan; 2) aresta que pula camadas ganha vértices fantasma,
// para a reta nunca atravessar um nó; 3) ordem na camada por baricentro (reduz cruzamentos), em varreduras
// alternadas; 4) coordenadas: x pela camada; y o mais perto possível da média dos antecessores, sem dois
// vértices a menos de ROW (cadeia em sequência fica reta); 5) camadas vizinhas da mesma fase viram uma
// coluna só. Determinístico: mesmo modelo, mesmo desenho.
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

  // x pela camada; y alinhado aos antecessores (que estão todos na camada anterior, por causa dos fantasmas).
  // A primeira camada centra em 0.
  const pos = new Map()
  layers.forEach((ids, l) => {
    if (!ids) return
    const want = ids.map((id) => {
      const ps = up.get(id) || []
      return ps.length ? ps.reduce((s, p) => s + pos.get(p).y, 0) / ps.length : 0
    })
    spread(want, LAYOUT.ROW).forEach((y, i) => pos.set(ids[i], { x: l * LAYOUT.COL, y }))
  })

  const segments = []
  for (const c of chains) {
    for (let i = 0; i + 1 < c.path.length; i++) {
      const p = pos.get(c.path[i])
      const q = pos.get(c.path[i + 1])
      segments.push({ key: `${c.from}>${c.to}#${i}`, from: c.from, to: c.to, ...segment(p, q) })
    }
  }

  // Uma coluna por fase: plan, critic e synth ficam sozinhos na camada deles; camadas de nós vizinhas, do
  // mesmo round e com os mesmos tipos (research/design/implement), viram uma coluna larga com `steps` passos.
  // Nós em paralelo ficam empilhados no mesmo passo; em sequência, um passo depois do outro.
  const lanes = []
  let lastKey = null
  layers.forEach((ids, l) => {
    const real = (ids || []).filter((id) => byId.has(id)).map((id) => byId.get(id))
    const special = real.find((v) => v.kind !== 'node')
    const kind = special ? special.kind : 'node'
    const round = special ? special.round : Math.max(1, ...real.map((v) => v.round || 1))
    const kinds = [...new Set(real.map((v) => v.node && v.node.kind).filter(Boolean))].sort().join('+')
    const key = special ? `${kind}:${round}:${l}` : real.length ? `node:${round}:${kinds}` : lastKey
    const prev = lanes[lanes.length - 1]
    if (prev && key === lastKey && kind === 'node') {
      prev.ids.push(...real.map((v) => v.id))
      prev.count += real.length
      prev.steps++
      prev.maxParallel = Math.max(prev.maxParallel, real.length)
    } else {
      lanes.push({ index: lanes.length, kind, round, first: l, steps: 1, ids: real.map((v) => v.id), count: real.length, maxParallel: real.length })
    }
    lastKey = key
  })
  const ys = [...pos.values()].map((p) => p.y)
  return { pos, segments, lanes, minY: Math.min(0, ...ys), maxY: Math.max(0, ...ys) }
}

// Posições numa camada, na ordem dada, o mais perto possível de `want` (mínimos quadrados) com pelo menos
// `gap` entre vizinhos: regressão isotônica (pool adjacent violators) sobre want[i] - i·gap.
function spread(want, gap) {
  const blocks = []
  want.forEach((w, i) => {
    blocks.push({ sum: w - i * gap, n: 1 })
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]
      const a = blocks[blocks.length - 2]
      if (a.sum / a.n <= b.sum / b.n) break
      a.sum += b.sum
      a.n += b.n
      blocks.pop()
    }
  })
  const out = []
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.sum / b.n + out.length * gap)
  return out
}

function segment(p, q) {
  const dx = q.x - p.x
  const dy = q.y - p.y
  return { x: p.x, y: p.y, len: Math.hypot(dx, dy), angle: (Math.atan2(dy, dx) * 180) / Math.PI }
}

// ── Posição na tela ──
// Coloca o layout num quadro de `width` × `height` (o viewport do grafo). `reserveLeft`/`reserveRight` são
// as larguras que os cards flutuantes cobrem (lateral de runs e gaveta de detalhe): os passos esticam
// (LANE_W..LANE_MAX) e o grafo centra no espaço entre eles. Não coube nem com a largura mínima: começa no
// PAD_X depois do card e o quadro rola. Devolve as colunas, as posições dos vértices e os segmentos das
// arestas já em px, a largura de um passo (`stepW`; a coluna tem steps × stepW) e o tamanho total do quadro.
export function placeGraph(layout, { width, height, reserveLeft = 0, reserveRight = 0, mobile = false }) {
  const M = mobile ? LAYOUT.mobile : LAYOUT.desktop
  const lanes = layout.lanes.length ? layout.lanes : [{ index: 0, first: 0, steps: 1 }]
  const steps = lanes.reduce((s, l) => s + l.steps, 0)
  const gaps = (lanes.length - 1) * LAYOUT.GAP
  const free = Math.max(0, width - reserveLeft - reserveRight)
  const fit = Math.floor((free - 2 * M.PAD_X - gaps) / steps)
  const stepW = mobile ? LAYOUT.LANE_W : Math.min(LAYOUT.LANE_MAX, Math.max(LAYOUT.LANE_W, fit))
  const span = steps * stepW + gaps
  const left = reserveLeft + Math.max(M.PAD_X, Math.round((free - span) / 2))
  const laneH = Math.max(height - M.LANE_TOP - M.LANE_BOTTOM, layout.maxY - layout.minY + M.EXTRA)
  const originY = Math.round(M.LANE_TOP + laneH / 2 + M.SHIFT - (layout.minY + layout.maxY) / 2)

  // centro de cada passo na tela: contíguos dentro da coluna, GAP entre colunas
  const stepX = []
  const placed = lanes.map((l, i) => {
    const x0 = left + l.first * stepW + i * LAYOUT.GAP
    for (let k = 0; k < l.steps; k++) stepX[l.first + k] = x0 + k * stepW + stepW / 2
    return { ...l, left: x0, top: M.LANE_TOP, width: l.steps * stepW, height: laneH }
  })
  const stepOf = (x) => Math.round(x / LAYOUT.COL)
  const at = (x, y) => ({ x: stepX[stepOf(x)], y: originY + y })

  const pos = new Map([...layout.pos].map(([id, p]) => [id, { ...at(p.x, p.y), col: stepOf(p.x) }]))
  const segments = layout.segments.map((s) => {
    const r = (s.angle * Math.PI) / 180
    const a = at(s.x, s.y)
    const b = at(s.x + Math.cos(r) * s.len, s.y + Math.sin(r) * s.len)
    return { ...s, ...segment(a, b), col: stepOf(s.x) }
  })
  return {
    stepW,
    labelW: stepW - 2 * LAYOUT.LABEL_PAD,
    pos,
    segments,
    lanes: layout.lanes.length ? placed : [],
    width: Math.max(width, left + span + M.PAD_X + reserveRight),
    height: Math.max(height, M.LANE_TOP + laneH + M.LANE_BOTTOM),
  }
}
