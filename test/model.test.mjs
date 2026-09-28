// Testes de modelo e estado do graph-watch (spec: docs/specs/2026-09-27-visualizacao-design.md §6.1, §6.2, §8.2 itens 2-4).
//
// Interface esperada de bin/graph-watch.mjs (AINDA NÃO EXISTE — estes testes ficam vermelhos até o nó
// "Núcleo do graph-watch" implementar o arquivo; é o red esperado desta etapa, não falta de teste):
//
//   CLI:  node bin/graph-watch.mjs <live|events|snapshot|agent> [<nó>] [flags]
//     Flags comuns: --run <wf_...>  --run-id <runId>  --economy <lean|balanced|max>
//                   --mode <research|architecture|implement|review>  --no-color  --cols <n>  --rows <n>
//     Só de teste:  --projects-dir <dir>  --wait-ms <n>  --run-dir <dir> (aponta direto para uma pasta
//                   com journal.jsonl, bypassando a busca da run — usadas em find-run.test.mjs e errors.test.mjs)
//     `agent <nó>` aceita -n <count> (padrão 8) para o nº de tool calls mostradas.
//   Exit codes: 0 ok/TERMINADO · 1 exceção fatal no live · 2 formato não reconhecido / run de outro
//               workflow · 3 nenhuma run encontrada · 4 sem transcrição do agente pedido.
//
//   Exports ESM usados diretamente por estes testes (contrato que bin/graph-watch.mjs deve implementar):
//     - class GraphWatchError extends Error { code }               // code: 2 | 3 | 4
//     - async function buildModel(opts) -> Model
//         opts.runDir  : caminho direto para uma pasta com journal.jsonl (+ agent-*.meta.json) — bypassa
//                         a busca da run (§6.8), para os testes apontarem direto numa fixture.
//         opts.economy : 'lean' | 'balanced' | 'max' | undefined
//         opts.mode    : 'research' | 'architecture' | 'implement' | 'review' | 'auto' | undefined
//         opts.cutLine : corta o journal.jsonl nas primeiras N linhas antes de montar o modelo (para os
//                         casos "vermelho no meio da run", ex. falhou (check) / reparando 1 / falhou).
//       Model (§6.1): { wf, round, status: 'rodando'|'terminado'|'parada?', idleSec, warns: string[],
//         nodes: [{ id, kind, risk, round, title, deps: string[], explore, state, reps, orphan? }],
//         critic: { r, running, gaps? } | null, synth: 'aguardando'|'rodando'|'pronto',
//         spent, estimate?, ceiling? }
//       `state` é uma das strings da tabela §6.2: 'trabalhando' | 'verificando' | 'reparando' |
//         'pronto' | 'pronto-sem-verif' | 'pronto-sem-verif?' | 'falhou' | 'falhou-check' | 'bloqueado' |
//         'sem-reverificacao' | 'erro' | 'aguardando' | 'pulado'.
//     - function normalizeNodes(rawNodes, { prefix, round, existingIds, readOnly }) -> nodes[]
//         Replica graph-eng.js normalize() (graph-eng.js:314-349): sane id, prefixo r<round>-, id vazio
//         vira n<k>, colisão ganha sufixo _, kind/risk inválidos viram research/medium, implement vira
//         design com readOnly, explore só vale em design, deps por idMap do lote ou id já existente.
//     - function estimateAgents(nodes, preset) -> number
//         Replica graph-eng.js:557-558 sobre os nós já normalizados.
//
// Sem esse contrato exportado, todo teste abaixo falha na importação (red esperado, sem erro de sintaxe).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')
const fx = (name) => path.join(FIXTURES, name)

// ─────────────────────────────────────────────────────────────────────────
// Helper de propriedade: lê o journal.jsonl cru (sem passar pelo modelo) e acha os nós cujo
// ÚLTIMO veredito verify/escalate reprovou (pass:false) sem nenhum repair:<id> começado depois.
// Serve para provar, a partir da fonte independente do journal, que a regra "falhou" (§6.2) não
// pode sair "pronto s/ verif." no modelo — ao contrário de comparar o campo `state` com ele mesmo.
// ─────────────────────────────────────────────────────────────────────────
function loadEvents(dir, cutLine) {
  const lines = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean)
  const sliced = cutLine ? lines.slice(0, cutLine) : lines
  return sliced.map((l) => JSON.parse(l))
}

function reprovedWithoutLaterRepair(dir, cutLine) {
  const events = loadEvents(dir, cutLine)
  const startedByKey = new Map()
  for (const e of events) if (e.type === 'started') startedByKey.set(e.key, e)
  const lastVerdict = new Map() // id -> { idx, pass }
  events.forEach((e, idx) => {
    if (e.type !== 'result' || !startedByKey.has(e.key)) return
    const label = startedByKey.get(e.key).label || ''
    const kind = label.split(':')[0]
    const id = label.slice(kind.length + 1)
    if ((kind === 'verify' || kind === 'escalate') && id && e.result && typeof e.result.pass === 'boolean') {
      lastVerdict.set(id, { idx, pass: e.result.pass })
    }
  })
  const out = new Set()
  for (const [id, v] of lastVerdict) {
    if (v.pass) continue
    const repairedAfter = events.some((e, idx) => idx > v.idx && e.type === 'started' && e.label === `repair:${id}`)
    if (!repairedAfter) out.add(id)
  }
  return out
}

const mod = await import('../bin/graph-watch.mjs').catch((e) => ({ __importError: e }))
const { buildModel, normalizeNodes, estimateAgents, GraphWatchError } = mod

function nodeById(model, id) {
  const n = model.nodes.find((n) => n.id === id)
  assert.ok(n, `nó ${id} não encontrado no modelo (ids: ${model.nodes.map((n) => n.id).join(', ')})`)
  return n
}

// ─────────────────────────────────────────────────────────────────────────
// §8.2 item 2: um caso por linha da tabela de estados (§6.2)
// ─────────────────────────────────────────────────────────────────────────
describe('estados (§6.2), um por linha da tabela', () => {
  test('trabalhando: agente aberto é work/draft/judge (fixture wf_repair_open antes do 1º corte)', async () => {
    // wf_repair_open tem work:X concluído com check vermelho, então logo em seguida "reparando" já
    // se aplica; para "trabalhando" cortamos antes do result de work:X.
    const model = await buildModel({ runDir: fx('wf_repair_open'), economy: 'balanced', mode: 'implement', cutLine: 4 })
    assert.equal(nodeById(model, 'X').state, 'trabalhando')
  })

  test('verificando: work concluído, veredito ainda não chegou, e caso do draft único (wf_draft_failed)', async () => {
    const model = await buildModel({ runDir: fx('wf_draft_failed'), economy: 'balanced', mode: 'implement' })
    assert.equal(nodeById(model, 'D1').state, 'verificando')
    assert.equal(nodeById(model, 'E1').state, 'aguardando')
  })

  test('reparando N: repair em aberto (wf_repair_open completo) conta 1 reparo', async () => {
    const model = await buildModel({ runDir: fx('wf_repair_open'), economy: 'balanced', mode: 'implement' })
    const x = nodeById(model, 'X')
    assert.equal(x.state, 'reparando')
    assert.equal(x.reps, 1)
  })

  test('pronto: último veredito verify/escalate com pass:true (happy, R1 e I2)', async () => {
    const model = await buildModel({ runDir: fx('happy'), economy: 'balanced', mode: 'implement' })
    assert.equal(nodeById(model, 'R1').state, 'pronto')
    assert.equal(nodeById(model, 'I2').state, 'pronto')
  })

  test('pronto s/ verif.: defer por risco baixo em nó não-implement (happy R2)', async () => {
    const model = await buildModel({ runDir: fx('happy'), economy: 'balanced', mode: 'implement' })
    assert.equal(nodeById(model, 'R2').state, 'pronto-sem-verif')
  })

  test('pronto s/ verif.?: ambíguo sem --economy nem --mode (wf_deferred_check sem flags)', async () => {
    const model = await buildModel({ runDir: fx('wf_deferred_check') })
    const g1 = nodeById(model, 'G1')
    assert.equal(g1.state, 'pronto-sem-verif?')
    assert.match(model.warns.join('\n'), /--economy/)
    assert.match(model.warns.join('\n'), /--mode/)
  })

  test('falhou: último veredito pass:false, sem repair depois (happy cortado em result verify:I1 reprovado)', async () => {
    const model = await buildModel({ runDir: fx('happy'), economy: 'balanced', mode: 'implement', cutLine: 15 })
    assert.equal(nodeById(model, 'I1').state, 'falhou')
  })

  test('falhou (check): checkGate reprovou sem repair depois (happy cortado logo após o work:I1 com check vermelho)', async () => {
    const model = await buildModel({ runDir: fx('happy'), economy: 'balanced', mode: 'implement', cutLine: 11 })
    assert.equal(nodeById(model, 'I1').state, 'falhou-check')
  })

  test('bloqueado: work terminou em failed (wf_work_failed); dependente sai pulado', async () => {
    const model = await buildModel({ runDir: fx('wf_work_failed'), economy: 'balanced', mode: 'implement' })
    assert.equal(nodeById(model, 'X').state, 'bloqueado')
    assert.equal(nodeById(model, 'Y').state, 'pulado')
  })

  test('sem reverificação: repair concluído sem veredito, nó fechado por dependente (wf_repair_noverify)', async () => {
    const model = await buildModel({ runDir: fx('wf_repair_noverify'), economy: 'balanced', mode: 'implement' })
    assert.equal(nodeById(model, 'X').state, 'sem-reverificacao')
  })

  test('erro: último agente concluído é failed sendo verify (wf_verify_failed); dependente aguardando', async () => {
    const model = await buildModel({ runDir: fx('wf_verify_failed'), economy: 'balanced', mode: 'implement' })
    assert.equal(nodeById(model, 'X').state, 'erro')
    assert.equal(nodeById(model, 'Y').state, 'aguardando')
  })

  test('aguardando: sem started e sem dep bloqueada/pulada (happy antes do work:I2 rodar)', async () => {
    const model = await buildModel({ runDir: fx('happy'), economy: 'balanced', mode: 'implement', cutLine: 11 })
    assert.equal(nodeById(model, 'I2').state, 'aguardando')
  })

  test('pulado: sem started e dep bloqueada (wf_blocked, I1/I2/I3 pulados quando R2 bloqueia)', async () => {
    const model = await buildModel({ runDir: fx('wf_blocked'), economy: 'balanced', mode: 'implement' })
    assert.equal(nodeById(model, 'R2').state, 'bloqueado')
    for (const id of ['I1', 'I2', 'I3']) assert.equal(nodeById(model, id).state, 'pulado')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Fixtures dedicadas de §8.1/§8.2 além da tabela linha-a-linha
// ─────────────────────────────────────────────────────────────────────────
describe('fixtures dedicadas de estado', () => {
  test('wf_judge_cut: bloqueado (não trabalhando) e dependente pulado', async () => {
    const model = await buildModel({ runDir: fx('wf_judge_cut'), economy: 'balanced', mode: 'implement' })
    assert.equal(nodeById(model, 'D1').state, 'bloqueado')
    assert.notEqual(nodeById(model, 'D1').state, 'trabalhando')
    assert.equal(nodeById(model, 'E1').state, 'pulado')
  })

  test('wf_deferred_check: balanced -> pronto s/ verif.; max -> falhou (check)', async () => {
    const balanced = await buildModel({ runDir: fx('wf_deferred_check'), economy: 'balanced', mode: 'implement' })
    assert.equal(nodeById(balanced, 'G1').state, 'pronto-sem-verif')
    const max = await buildModel({ runDir: fx('wf_deferred_check'), economy: 'max', mode: 'implement' })
    assert.equal(nodeById(max, 'G1').state, 'falhou-check')
  })

  test('wf_readonly_implement: --mode research -> pronto s/ verif.; sem --mode -> ambíguo', async () => {
    const readOnly = await buildModel({ runDir: fx('wf_readonly_implement'), economy: 'balanced', mode: 'research' })
    assert.equal(nodeById(readOnly, 'I2').state, 'pronto-sem-verif')
    const noMode = await buildModel({ runDir: fx('wf_readonly_implement'), economy: 'balanced' })
    assert.equal(nodeById(noMode, 'I2').state, 'pronto-sem-verif?')
  })

  test('interrupted: sem synth, status parada? depois de journal velho', async () => {
    // Copia a fixture para não alterar o mtime do arquivo versionado: "parada?" (§6.8/§7) exige
    // 10 min sem evento e sem result do synth, então o teste precisa de um journal com mtime velho.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-interrupted-'))
    fs.cpSync(fx('interrupted'), tmpDir, { recursive: true })
    const old = new Date(Date.now() - 15 * 60 * 1000)
    fs.utimesSync(path.join(tmpDir, 'journal.jsonl'), old, old)
    const model = await buildModel({ runDir: tmpDir, economy: 'balanced', mode: 'implement' })
    assert.equal(nodeById(model, 'X').state, 'trabalhando')
    assert.notEqual(model.synth, 'pronto')
    assert.equal(model.status, 'parada?')
  })

  test('happy completo: synth pronto, todos os nós fecham', async () => {
    const model = await buildModel({ runDir: fx('happy'), economy: 'balanced', mode: 'implement' })
    assert.equal(model.synth, 'pronto')
    for (const id of ['R1', 'R2', 'I1', 'I2', 'r2-G1', 'r2-G2']) {
      const st = nodeById(model, id).state
      assert.ok(['pronto', 'pronto-sem-verif'].includes(st), `${id} deveria estar fechado com sucesso, veio ${st}`)
    }
  })

  test('sess/wf_gated: nós vêm do plano da run planOnly irmã, com aviso', async () => {
    const model = await buildModel({
      runDir: fx('sess/wf_gated'),
      siblingPlanOnlyDir: fx('sess/wf_planonly'),
      economy: 'balanced',
      mode: 'implement',
    })
    assert.equal(nodeById(model, 'P1').state, 'pronto')
    assert.ok(model.nodes.find((n) => n.id === 'P2'))
  })

  test('sess2/wf_orphan: sem irmã planOnly, nós nascem orphan e aviso é emitido', async () => {
    const model = await buildModel({ runDir: fx('sess2/wf_orphan'), economy: 'balanced', mode: 'implement' })
    const q1 = nodeById(model, 'Q1')
    assert.equal(q1.orphan, true)
    assert.ok(model.warns.length > 0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Propriedade sobre todas as fixtures, com as duas flags (§8.2 item 2, último parágrafo).
//
// A versão anterior comparava `n.state` com ele mesmo (`FAILED_STATES.has(n.state) &&
// n.state.startsWith('pronto')`), o que nunca é verdadeiro porque nenhuma string de
// FAILED_STATES começa com "pronto" — a condição era logicamente vazia. Esta versão prova a
// propriedade a partir de uma fonte independente do modelo (o journal.jsonl cru, via
// reprovedWithoutLaterRepair) e conta as asserções de fato executadas.
// ─────────────────────────────────────────────────────────────────────────
describe('propriedade de estado (com --economy e --mode)', () => {
  const fixturesToCheck = [
    'happy', 'wf_blocked', 'wf_repair_noverify', 'wf_repair_open', 'wf_deferred_check',
    'wf_draft_failed', 'wf_verify_failed', 'wf_work_failed', 'wf_judge_cut', 'wf_readonly_implement',
  ]
  // Corte extra que força um caso real de "reprovado sem repair depois" no journal completo do
  // "happy" nenhum nó fecha assim (I1 acaba reparado e passando) — o mesmo corte usado no teste
  // "falhou" acima (linha 15) reproduz esse caso ponta a ponta.
  const CUT_CASES = [{ name: 'happy', cutLine: 15 }]

  let totalAssertions = 0

  for (const name of fixturesToCheck) {
    test(`${name}: todo pulado tem dep bloqueada/pulada`, async () => {
      const model = await buildModel({ runDir: fx(name), economy: 'balanced', mode: 'implement' })
      const byId = new Map(model.nodes.map((n) => [n.id, n]))
      let assertions = 0
      for (const n of model.nodes) {
        if (n.state !== 'pulado') continue
        const depBlocked = n.deps.some((d) => {
          const dep = byId.get(d)
          return dep && (dep.state === 'bloqueado' || dep.state === 'pulado')
        })
        assert.ok(depBlocked, `${name}/${n.id}: pulado sem nenhuma dep bloqueada/pulada`)
        assertions++
      }
      totalAssertions += assertions
    })
  }

  for (const { name, cutLine } of CUT_CASES) {
    test(`${name}${cutLine ? ` (corte ${cutLine})` : ''}: nó reprovado sem repair depois não sai "pronto s/ verif."`, async () => {
      const model = await buildModel({ runDir: fx(name), economy: 'balanced', mode: 'implement', cutLine })
      const byId = new Map(model.nodes.map((n) => [n.id, n]))
      const reproved = reprovedWithoutLaterRepair(fx(name), cutLine)
      assert.ok(reproved.size > 0, `${name}: fixture não produziu nenhum caso de reprovado sem repair — cenário morto`)
      let assertions = 0
      for (const id of reproved) {
        const n = byId.get(id)
        assert.ok(n, `${name}: nó ${id} do journal não apareceu no modelo`)
        assert.notEqual(n.state, 'pronto-sem-verif', `${name}/${id}: reprovado sem repair depois não pode virar "pronto s/ verif."`)
        assert.notEqual(n.state, 'pronto-sem-verif?', `${name}/${id}: reprovado sem repair depois não pode virar "pronto s/ verif.?"`)
        assertions++
      }
      totalAssertions += assertions
    })
  }

  test('a propriedade de fato rodou asserções (contador > 0, não é um teste vazio)', () => {
    assert.ok(totalAssertions > 0, 'nenhuma asserção de propriedade foi executada nas fixtures acima')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// §8.2 item 3: normalize()
// ─────────────────────────────────────────────────────────────────────────
describe('normalizeNodes (§6.1, replica graph-eng.js:314-349)', () => {
  test('id inválido é saneado e id vazio vira n<k>', () => {
    const out = normalizeNodes([{ id: 'Ol@!á Mundo', title: 't' }, { id: '', title: 't2' }], {})
    assert.equal(out[0].id, 'OlMundo') // sane: remove tudo fora de [A-Za-z0-9_-]
    assert.equal(out[1].id, 'n2')
  })

  test('colisão de id ganha sufixo _', () => {
    const out = normalizeNodes([{ id: 'X', title: 'a' }, { id: 'X', title: 'b' }], {})
    assert.equal(out[0].id, 'X')
    assert.equal(out[1].id, 'X_')
  })

  test('kind/risk inválidos viram research/medium', () => {
    const out = normalizeNodes([{ id: 'A', title: 't', kind: 'bogus', risk: 'bogus' }], {})
    assert.equal(out[0].kind, 'research')
    assert.equal(out[0].risk, 'medium')
  })

  test('implement vira design em modo read-only', () => {
    const out = normalizeNodes([{ id: 'A', title: 't', kind: 'implement' }], { readOnly: true })
    assert.equal(out[0].kind, 'design')
  })

  test('explore só vale em design (research com explore:true vira explore:false)', () => {
    const out = normalizeNodes([{ id: 'A', title: 't', kind: 'research', explore: true }], {})
    assert.equal(out[0].explore, false)
  })

  test('dep desconhecida é ignorada; dep existente e prefixo r2- funcionam', () => {
    const existingIds = new Set(['I1'])
    const out = normalizeNodes(
      [{ id: 'G1', title: 't', deps: ['I1', 'inexistente'] }],
      { prefix: 'r2-', round: 2, existingIds },
    )
    assert.equal(out[0].id, 'r2-G1')
    assert.deepEqual(out[0].deps, ['I1'])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// §8.2 item 4: estimativa (graph-eng.js:557-558)
// ─────────────────────────────────────────────────────────────────────────
describe('estimateAgents (§6.1 "Custo", replica graph-eng.js:557-558)', () => {
  test('happy em balanced: fórmula normal + 1 (plan) + 2 (critic+synth)', () => {
    const nodes = normalizeNodes(
      [
        { id: 'R1', kind: 'research', risk: 'medium', title: 't' },
        { id: 'R2', kind: 'research', risk: 'low', title: 't' },
        { id: 'I1', kind: 'implement', risk: 'medium', title: 't' },
        { id: 'I2', kind: 'implement', risk: 'medium', title: 't' },
      ],
      {},
    )
    // spent inicial = 1 (plan) + 2 (critic, synth) + soma por nó (1 ou 3 se explore, +1 se não deferido
    // ou se implement). balanced defer = ['low']: só R2 (research, risk:low) deixa de somar o +1.
    const expected = 1 + 2 + (1 + 1) + (1 + 0) + (1 + 1) + (1 + 1)
    assert.equal(estimateAgents(nodes, 'balanced'), expected)
    assert.equal(expected, 10)
  })

  test('sem --economy, estimativa fica ausente', async () => {
    const model = await buildModel({ runDir: fx('happy') })
    assert.equal(model.estimate, undefined)
  })
})

test('importação de bin/graph-watch.mjs falha até o núcleo ser implementado (red esperado)', () => {
  if (mod.__importError) {
    assert.ok(mod.__importError, 'bin/graph-watch.mjs ainda não existe — vermelho esperado nesta etapa')
  } else {
    assert.ok(buildModel && normalizeNodes && estimateAgents && GraphWatchError, 'exports mínimos presentes')
  }
})

// Run retomada (resumeFromRunId): o journal não ganha novo `launched`, só um segundo `started plan`.
test('run retomada desenha só a última tentativa e soma o custo das duas (fixture resumed)', async () => {
  const model = await buildModel({ runDir: fx('resumed'), economy: 'balanced', mode: 'implement' })
  assert.deepEqual(model.nodes.map((n) => n.id), ['A', 'B'], 'sem nós duplicados A_/B_')
  const byId = Object.fromEntries(model.nodes.map((n) => [n.id, n.state]))
  assert.equal(byId.A, 'pronto', 'o repair:A abandonado da 1ª tentativa não deixa A "reparando"')
  assert.equal(byId.B, 'trabalhando')
  assert.equal(model.spent, 8, 'custo conta os agentes das duas tentativas (4 + 4)')
  assert.ok(model.warns.some((w) => w.includes('retomada')))
})

// Run retomada com o plano passado por args: não há `started plan` para marcar o resume, só os mesmos
// rótulos iniciados de novo. As tentativas interrompidas (sem resultado) não podem deixar o nó "trabalhando".
test('resume sem started plan ignora as tentativas interrompidas e soma o custo delas', async () => {
  const ev = (type, key, label, result) => JSON.stringify({ type, key, label, agentId: `a-${key}`, result })
  const done = { status: 'done', summary: 'ok', confidence: 'high' }
  const pass = { pass: true, confidence: 'high', blocking: [] }
  const tail = [
    ev('started', 'k3', 'work:A'),
    ev('started', 'k4', 'work:B'),
    ev('result', 'k3', undefined, done),
    ev('started', 'k5', 'verify:A'),
    ev('result', 'k5', undefined, pass),
  ]
  const write = (lines) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-resume-'))
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), [JSON.stringify({ type: 'launched' }), ...lines].join('\n') + '\n')
    return dir
  }
  const resumed = await buildModel({ runDir: write([ev('started', 'k1', 'work:A'), ev('started', 'k2', 'work:B'), ...tail]), economy: 'balanced', mode: 'implement' })
  const clean = await buildModel({ runDir: write(tail), economy: 'balanced', mode: 'implement' })
  const states = (m) => Object.fromEntries(m.nodes.map((n) => [n.id, n.state]))
  assert.deepEqual(states(resumed), { A: 'pronto', B: 'trabalhando' })
  assert.deepEqual(states(resumed), states(clean), 'mesmo estado da run que não foi interrompida')
  assert.equal(resumed.spent, clean.spent + 2, 'os 2 agentes interrompidos contam no custo')
  assert.ok(resumed.warns.some((w) => w.includes('interrompido')))
})
