// Núcleo puro do painel: modelo → grafo → layout. Sem DOM, testável no Node (test/ui-layout.test.mjs).
// O app.js importa daqui; o CSS só precisa manter a .dot com diâmetro LAYOUT.DOT.

export const LAYOUT = {
  COL: 170, // distância horizontal entre camadas
  ROW: 80, // distância vertical entre nós da mesma camada
  PAD_X: 60, // margem do quadro (cabe meio rótulo à esquerda do primeiro nó)
  PAD_Y: 32,
  LABEL_BELOW: 40, // espaço abaixo da última bolinha para o rótulo
  DOT: 16, // diâmetro da bolinha (tem que bater com o CSS)
  EDGE_GAP: 3, // folga entre a ponta da aresta e a borda da bolinha
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

  const dependedOn = new Set(nodes.flatMap((n) => (n.deps || []).filter((d) => ids.has(d))))
  for (let r = 1; r <= maxRound; r++) {
    const inRound = nodes.filter((n) => (n.round || 1) === r)
    const source = r === 1 ? 'plan' : `critic:r${r - 1}`
    for (const n of inRound) {
      const deps = (n.deps || []).filter((d) => ids.has(d))
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

  const tallest = Math.max(...layers.map((ids) => (ids ? ids.length : 0)))
  const pos = new Map()
  layers.forEach((ids, l) => {
    if (!ids) return
    const offset = (tallest - ids.length) / 2
    ids.forEach((id, i) => {
      pos.set(id, { x: LAYOUT.PAD_X + l * LAYOUT.COL, y: LAYOUT.PAD_Y + LAYOUT.DOT / 2 + (i + offset) * LAYOUT.ROW })
    })
  })

  const segments = []
  for (const c of chains) {
    for (let i = 0; i + 1 < c.path.length; i++) {
      const p = pos.get(c.path[i])
      const q = pos.get(c.path[i + 1])
      // só apara a ponta que encosta numa bolinha de verdade (fantasma não tem bolinha)
      const trimA = byId.has(c.path[i]) ? LAYOUT.DOT / 2 + LAYOUT.EDGE_GAP : 0
      const trimB = byId.has(c.path[i + 1]) ? LAYOUT.DOT / 2 + LAYOUT.EDGE_GAP : 0
      segments.push({ key: `${c.from}>${c.to}#${i}`, from: c.from, to: c.to, ...trim(p, q, trimA, trimB) })
    }
  }
  return {
    pos,
    segments,
    width: 2 * LAYOUT.PAD_X + (layers.length - 1) * LAYOUT.COL,
    height: LAYOUT.PAD_Y + LAYOUT.DOT + (tallest - 1) * LAYOUT.ROW + LAYOUT.LABEL_BELOW,
  }
}

function trim(p, q, a, b) {
  const dx = q.x - p.x
  const dy = q.y - p.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  return { x: p.x + ux * a, y: p.y + uy * a, len: Math.max(0, len - a - b), angle: (Math.atan2(dy, dx) * 180) / Math.PI }
}
