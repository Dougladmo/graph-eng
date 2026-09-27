// Testes do renderer (§6.3, §6.4, §8.2 itens 1, 8 e 9): goldens byte a byte, largura (nenhuma
// linha passa de `cols` em code points, caixas vizinhas com >=1 espaço, cada nó aparece uma vez),
// e ausência de `\x1b` sem cor/TTY.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import os from 'node:os'
import { buildModel, graphText, buildNowBlock, codePointLength } from '../bin/graph-watch.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')
const GOLDEN = path.join(__dirname, 'golden')
const fx = (name) => path.join(FIXTURES, name)

describe('goldens (§8.2 item 1)', () => {
  for (const cols of [120, 50]) {
    test(`happy em cols=${cols} bate byte a byte com o golden`, async () => {
      const model = await buildModel({ runDir: fx('happy'), economy: 'balanced', mode: 'implement' })
      const text = graphText(model, { cols, color: false })
      const golden = fs.readFileSync(path.join(GOLDEN, `happy-${cols}.txt`), 'utf8')
      assert.equal(text, golden.replace(/\n$/, ''))
    })
  }
})

const ALL_FIXTURES = [
  'happy', 'wf_blocked', 'wf_repair_noverify', 'wf_repair_open', 'wf_deferred_check',
  'wf_draft_failed', 'wf_verify_failed', 'wf_work_failed', 'wf_judge_cut', 'wf_readonly_implement',
]

describe('propriedades de largura (§8.2 item 8)', () => {
  for (const name of ALL_FIXTURES) {
    for (const cols of [120, 51, 50, 40]) {
      test(`${name} @ cols=${cols}: nenhuma linha passa de cols (code points)`, async () => {
        const model = await buildModel({ runDir: fx(name), economy: 'balanced', mode: 'implement' })
        const text = graphText(model, { cols, color: false })
        for (const line of text.split('\n')) {
          assert.ok(codePointLength(line) <= cols, `linha maior que ${cols}: "${line}" (${codePointLength(line)})`)
        }
      })
    }
  }

  test('cada nó tem exatamente uma caixa/linha própria no desenho (happy, cols 120 e 50)', async () => {
    const model = await buildModel({ runDir: fx('happy'), economy: 'balanced', mode: 'implement' })
    for (const cols of [120, 50]) {
      const text = graphText(model, { cols, color: false })
      const lines = text.split('\n')
      for (const n of model.nodes) {
        // a caixa (`<id> · <kind>`) ou a linha compacta (`[m] <id> <estado>`) — nunca as duas, e nunca 0 ou 2+.
        const own = lines.filter((l) => l.includes(`${n.id} · ${n.kind}`) || l.includes(`] ${n.id} `))
        assert.equal(own.length, 1, `${n.id} apareceu em ${own.length} linha(s) própria(s) em cols=${cols}: ${JSON.stringify(own)}`)
      }
    }
  })

  test('caixas vizinhas (cols=120, modo caixa) têm pelo menos um espaço entre si', async () => {
    const model = await buildModel({ runDir: fx('happy'), economy: 'balanced', mode: 'implement' })
    const text = graphText(model, { cols: 120, color: false })
    const boxRows = text.split('\n').filter((l) => l.includes('┐') || l.includes('┘') || l.startsWith('│'))
    for (const l of boxRows) {
      // duas bordas de caixa nunca ficam coladas: procura "┐ " logo antes de outra "┌"/"│" (nunca "┐┌" ou "┐│")
      assert.doesNotMatch(l, /[┐┘][┌│]/)
    }
  })

  test('cols 51 usa caixas e cols 50 usa compacto (happy tem camada com 2 nós)', async () => {
    const model = await buildModel({ runDir: fx('happy'), economy: 'balanced', mode: 'implement' })
    const at51 = graphText(model, { cols: 51, color: false })
    const at50 = graphText(model, { cols: 50, color: false })
    assert.ok(at51.includes('┌'), 'cols=51 deveria desenhar caixas')
    assert.ok(!at50.includes('┌'), 'cols=50 deveria cair para o modo compacto')
  })
})

describe('bloco "agora" (§5 de render-design.md, acrescentado pelo snapshot)', () => {
  test('nada rodando, sem próximos: happy terminou, nenhum nó aguardando', async () => {
    const model = await buildModel({ runDir: fx('happy'), economy: 'balanced', mode: 'implement' })
    assert.equal(buildNowBlock(model, fx('happy')), 'agora: nada rodando')
  })

  test('nada rodando, com próximos: só entra o nó aguardando cujas deps já estão prontas', () => {
    const model = {
      nodes: [
        { id: 'A', deps: [], state: 'pronto' },
        { id: 'B', deps: ['A'], state: 'aguardando' },
        { id: 'C', deps: ['Z'], state: 'aguardando' }, // dep Z não existe no modelo → não conta como pronta
      ],
    }
    assert.equal(buildNowBlock(model, '/inexistente'), 'agora: nada rodando · próximos: B')
  })

  test('nó em andamento: label, agentId curto e última tool call com idade calculada', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-now-'))
    const model = {
      wf: 'wf_now',
      round: 1,
      status: 'rodando',
      idleSec: 1,
      warns: [],
      critic: null,
      synth: 'aguardando',
      spent: 1,
      nodes: [{ id: 'X', kind: 'implement', risk: 'medium', round: 1, title: 'nó de exemplo', deps: [], explore: false, state: 'trabalhando', reps: 0, running: { label: 'work:X', agentId: 'abcdef1234567890' } }],
    }
    const transcript = [
      { type: 'assistant', timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo oi' } }] } },
    ]
    fs.writeFileSync(path.join(dir, 'agent-abcdef1234567890.jsonl'), transcript.map((e) => JSON.stringify(e)).join('\n') + '\n')
    const now = Date.parse('2026-01-01T10:00:12.000Z')
    const out = buildNowBlock(model, dir, { now })
    assert.equal(out, 'agora: work:X · agente abcdef12… · última tool call Bash há 12s')
  })
})

describe('sem TTY / NO_COLOR (§8.2 item 9)', () => {
  test('snapshot sem cor nunca emite \\x1b', async () => {
    for (const name of ALL_FIXTURES) {
      const model = await buildModel({ runDir: fx(name), economy: 'balanced', mode: 'implement' })
      for (const cols of [120, 50]) {
        const text = graphText(model, { cols, color: false })
        assert.ok(!text.includes('\x1b'), `${name} @ cols=${cols} emitiu \\x1b sem cor`)
      }
    }
  })
})
