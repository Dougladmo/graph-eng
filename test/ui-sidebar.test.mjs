// Testes puros de bin/ui/sidebar.mjs (spec docs/specs/2026-09-28-acoes-no-painel.md C13; casos do D4 §8.3).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { PAGE, STEP, STRIP_MAX, DEFAULT_OPEN, sectionOf, titleOf, metaOf, stripOf, buildSections } = await import('../bin/ui/sidebar.mjs')
const { isInFinishedSection } = await import('../bin/organize.mjs')

function run(over = {}) {
  return {
    key: over.key || over.wf || 'k',
    wf: 'wf_x',
    wfs: ['wf_x'],
    runId: null,
    project: 'demo',
    goal: null,
    status: 'rodando',
    stop: null,
    planOnly: false,
    pinned: false,
    group: null,
    archived: false,
    mtime: Date.now(),
    nodes: [],
    ...over,
  }
}

test('STRIP_MAX é 10: (262 borda - 20 padding - 10 barra - 8 padding linha - 24 bolinha/gaps - 88 título) = 104px; floor((104+3)/(7+3)) = 10', () => {
  assert.equal(STRIP_MAX, 10)
})

describe('sectionOf (precedência arquivada > fixada > grupo > estado)', () => {
  test('arquivada vence tudo', () => assert.equal(sectionOf(run({ archived: true, pinned: true, group: 'g-1', status: 'rodando' })), 'archived'))
  test('fixada vence grupo e estado', () => assert.equal(sectionOf(run({ pinned: true, group: 'g-1', status: 'rodando' })), 'pinned'))
  test('grupo vence estado', () => assert.equal(sectionOf(run({ group: 'g-1', status: 'rodando' })), 'g-1'))
  test('rodando vence planOnly', () => assert.equal(sectionOf(run({ status: 'rodando', planOnly: true })), 'active'))
  test('terminado vai para done', () => assert.equal(sectionOf(run({ status: 'terminado' })), 'done'))
  test('planOnly (não rodando) vai para done', () => assert.equal(sectionOf(run({ status: 'terminado', planOnly: true })), 'done'))
  test('o resto vai para Paradas (nunca aparece em Em andamento)', () => assert.equal(sectionOf(run({ status: 'parada?' })), 'stopped'))

  test('paridade exaustiva com isInFinishedSection de bin/organize.mjs', () => {
    const bools = [false, true]
    const statuses = ['rodando', 'parada?', 'terminado']
    const groups = [null, 'g-1']
    for (const archived of bools) {
      for (const pinned of bools) {
        for (const group of groups) {
          for (const status of statuses) {
            for (const planOnly of bools) {
              const r = run({ archived, pinned, group, status, planOnly })
              assert.equal(isInFinishedSection(r), sectionOf(r) === 'done', JSON.stringify({ archived, pinned, group, status, planOnly }))
            }
          }
        }
      }
    }
  })

  test('caso explícito {status: rodando, planOnly: true} → active no sectionOf e false no isInFinishedSection', () => {
    const r = run({ status: 'rodando', planOnly: true })
    assert.equal(sectionOf(r), 'active')
    assert.equal(isInFinishedSection(r), false)
  })
})

describe('titleOf', () => {
  test('runId sem o prefixo AAAAMMDD-HHMM-', () => assert.equal(titleOf(run({ runId: '20260928-1146-acoes-no-painel' })), 'acoes-no-painel'))
  test('sem runId, o goal cortado em 80', () => {
    const goal = 'g'.repeat(120)
    assert.equal(titleOf(run({ runId: null, goal })), `${'g'.repeat(80)}…`)
  })
  test('sem os dois, o wf curto', () => assert.equal(titleOf(run({ runId: null, goal: null, wf: 'wf_abc123' })), 'abc123'))
})

describe('metaOf', () => {
  const now = Date.now()
  test('planOnly (parada de terminar) mostra "só plano"', () => assert.equal(metaOf(run({ status: 'terminado', planOnly: true }), now), 'só plano'))
  test('terminado mostra "terminada há X"', () => assert.match(metaOf(run({ status: 'terminado', mtime: now - 2 * 3600_000 }), now), /^terminada há 2 h$/))
  test('parada mostra o stop.text', () => assert.equal(metaOf(run({ status: 'parada?', stop: { reason: 'sem-atividade', text: 'sem atividade há 7 min', idleSec: 420 } }), now), 'sem atividade há 7 min'))
  test('rodando não mostra nada', () => assert.equal(metaOf(run({ status: 'rodando' }), now), ''))
})

describe('stripOf', () => {
  test('0 nós → dots vazio, label vazio', () => assert.deepEqual(stripOf([]), { mode: 'dots', dots: [], label: '' }))

  test('10 nós → dots (o limite é inclusivo)', () => {
    const nodes = Array.from({ length: 10 }, () => ({ state: 'pronto', round: 1 }))
    const r = stripOf(nodes)
    assert.equal(r.mode, 'dots')
    assert.equal(r.dots.length, 10)
    assert.ok(r.dots.every((d) => d.variant === 'done' && d.tone === 1))
  })

  test('11 nós → sum', () => {
    const nodes = Array.from({ length: 11 }, () => ({ state: 'pronto', round: 1 }))
    assert.equal(stripOf(nodes).mode, 'sum')
  })

  test('stripOf(nodes, 3) com 4 nós → sum (max é parâmetro)', () => {
    const nodes = Array.from({ length: 4 }, () => ({ state: 'pronto', round: 1 }))
    assert.equal(stripOf(nodes, 3).mode, 'sum')
  })

  test('resumo sem estado zerado: 12 done + 3 empty', () => {
    const nodes = [...Array.from({ length: 12 }, () => ({ state: 'pronto' })), ...Array.from({ length: 3 }, () => ({ state: 'aguardando' }))]
    const r = stripOf(nodes)
    assert.deepEqual(r.items, [
      { variant: 'done', n: 12 },
      { variant: 'empty', n: 3 },
    ])
  })

  test('ordem e corte em 3: 2 fail, 3 running, 12 done, 4 empty', () => {
    const nodes = [
      ...Array.from({ length: 2 }, () => ({ state: 'falhou' })),
      ...Array.from({ length: 3 }, () => ({ state: 'trabalhando' })),
      ...Array.from({ length: 12 }, () => ({ state: 'pronto' })),
      ...Array.from({ length: 4 }, () => ({ state: 'aguardando' })),
    ]
    const r = stripOf(nodes)
    assert.deepEqual(r.items, [
      { variant: 'fail', n: 2 },
      { variant: 'running', n: 3 },
      { variant: 'done', n: 12 },
    ])
    assert.equal(r.label, '2 com erro, 3 rodando, 12 concluídos, 4 na fila')
  })

  test('"na fila se couber": 0 fail, 3 running, 8 done, 4 empty', () => {
    const nodes = [...Array.from({ length: 3 }, () => ({ state: 'trabalhando' })), ...Array.from({ length: 8 }, () => ({ state: 'pronto' })), ...Array.from({ length: 4 }, () => ({ state: 'aguardando' }))]
    const r = stripOf(nodes)
    assert.deepEqual(r.items, [
      { variant: 'running', n: 3 },
      { variant: 'done', n: 8 },
      { variant: 'empty', n: 4 },
    ])
  })

  test('singular e plural', () => {
    const one = [{ state: 'falhou' }, { state: 'trabalhando' }, { state: 'pronto' }, { state: 'aguardando' }, { state: 'pulado' }]
    const r1 = stripOf(one, 3) // força sum com poucos nós
    assert.equal(r1.label, '1 com erro, 1 rodando, 1 concluído, 1 na fila, 1 pulado')
    const two = [{ state: 'pulado' }, { state: 'pulado' }]
    assert.equal(stripOf(two, 0).label, '2 pulados')
  })

  test('estados desconhecidos contam como empty (variantOf já resolve isso)', () => {
    const r = stripOf([{ state: 'zzz' }])
    assert.equal(r.dots[0].variant, 'empty')
  })
})

describe('buildSections', () => {
  const org = { groups: [{ id: 'g-1', name: 'Grupo A' }], pinned: [] }

  test('ordem das seções: Fixadas, grupos, Em andamento, Paradas e Finalizadas; Arquivadas só com o filtro', () => {
    const runs = [
      run({ key: 'p', pinned: true, status: 'rodando' }),
      run({ key: 'a', status: 'rodando' }),
      run({ key: 's', status: 'parada?' }),
      run({ key: 'd', status: 'terminado' }),
      run({ key: 'z', archived: true, status: 'terminado' }),
    ]
    const withoutArchived = buildSections(runs, org, { now: Date.now() })
    assert.deepEqual(withoutArchived.map((s) => s.id), ['pinned', 'g-1', 'active', 'stopped', 'done'])
    const withArchived = buildSections(runs, org, { showArchived: true, now: Date.now() })
    assert.deepEqual(withArchived.map((s) => s.id), ['pinned', 'g-1', 'active', 'stopped', 'done', 'archived'])
  })

  test('run parada nunca aparece em Em andamento', () => {
    const runs = [run({ key: 's', status: 'parada?' })]
    const secs = buildSections(runs, org)
    assert.equal(secs.find((s) => s.id === 'active'), undefined)
    assert.equal(secs.find((s) => s.id === 'stopped').rows[0].key, 's')
  })

  test('run planOnly que não está rodando cai em Finalizadas, com meta "só plano" e bolinha vazia', () => {
    const runs = [run({ key: 'po', status: 'terminado', planOnly: true, nodes: [] })]
    const secs = buildSections(runs, org, { open: { done: true } })
    const done = secs.find((s) => s.id === 'done')
    assert.equal(done.rows[0].key, 'po')
    assert.equal(metaOf(done.rows[0]), 'só plano')
  })

  test('done começa fechada, e count aparece quando está fechada', () => {
    const runs = [run({ key: 'd1', status: 'terminado' }), run({ key: 'd2', status: 'terminado' })]
    const secs = buildSections(runs, org)
    const done = secs.find((s) => s.id === 'done')
    assert.equal(done.open, false)
    assert.equal(done.count, 2)
    assert.equal(done.rows.length, 0) // fechada: nada visível
  })

  test('a seleção dentro de uma seção fechada liga forcedOpen', () => {
    const runs = [run({ key: 'd1', wf: 'wf_d1', status: 'terminado' })]
    const secs = buildSections(runs, org, { selectedWf: 'wf_d1' })
    const done = secs.find((s) => s.id === 'done')
    assert.equal(done.forcedOpen, true)
    assert.equal(done.open, true)
    assert.equal(done.rows.length, 1)
  })

  test('paginação: 10 linhas, depois more = min(20, restantes); a selecionada além do limite fica visível', () => {
    const runs = Array.from({ length: 25 }, (_, i) => run({ key: `a${i}`, wf: `wf_a${i}`, status: 'rodando' }))
    const secs = buildSections(runs, org)
    const active = secs.find((s) => s.id === 'active')
    assert.equal(active.rows.length, PAGE)
    assert.equal(active.more, Math.min(STEP, 25 - PAGE))

    const withSelection = buildSections(runs, org, { selectedWf: 'wf_a24' })
    const active2 = withSelection.find((s) => s.id === 'active')
    assert.ok(active2.rows.some((r) => r.wf === 'wf_a24'), 'a selecionada além do limite continua visível')
  })

  test('busca ignora acento e caixa, e filtra por título, projeto e goal', () => {
    const runs = [run({ key: 'a', runId: '20260101-0000-ação-legal', status: 'rodando' }), run({ key: 'b', project: 'Outro Projeto', status: 'rodando' }), run({ key: 'c', goal: 'Corrigir Bug crítico', status: 'rodando' })]
    const byTitle = buildSections(runs, org, { query: 'acao' })
    assert.deepEqual(byTitle.find((s) => s.id === 'active').rows.map((r) => r.key), ['a'])
    const byProject = buildSections(runs, org, { query: 'OUTRO' })
    assert.deepEqual(byProject.find((s) => s.id === 'active').rows.map((r) => r.key), ['b'])
    const byGoal = buildSections(runs, org, { query: 'critico' })
    assert.deepEqual(byGoal.find((s) => s.id === 'active').rows.map((r) => r.key), ['c'])
  })

  test('grupo vazio aparece com empty, e some se runs saírem dele só quando também não é grupo', () => {
    const secs = buildSections([], org)
    const g = secs.find((s) => s.id === 'g-1')
    assert.equal(g.empty, 'Arraste uma run para cá')
    assert.equal(g.count, 0)
  })

  test('DEFAULT_OPEN cobre pinned/active/stopped abertos e done fechado', () => {
    assert.deepEqual(DEFAULT_OPEN, { pinned: true, active: true, stopped: true, done: false, archived: true })
  })

  test('fechar pela mão (clique) vence forcedOpen: a seção da run selecionada fecha de verdade', () => {
    const runs = [run({ key: 'd1', wf: 'wf_d1', status: 'terminado' })]
    // open[done] = false é o estado gravado depois de um clique explícito no cabeçalho (app.js toggleSection)
    const secs = buildSections(runs, org, { selectedWf: 'wf_d1', open: { done: false } })
    const done = secs.find((s) => s.id === 'done')
    assert.equal(done.forcedOpen, true) // continua marcado: é o que liga o auto-scroll/realce da selecionada
    assert.equal(done.open, false) // mas a escolha do usuário manda, e a lista fica escondida
  })

  test('sem escolha salva, a seleção ainda força aberto (comportamento inicial preservado)', () => {
    const runs = [run({ key: 'd1', wf: 'wf_d1', status: 'terminado' })]
    const secs = buildSections(runs, org, { selectedWf: 'wf_d1' })
    assert.equal(secs.find((s) => s.id === 'done').open, true)
  })

  test('run com group apontando para grupo inexistente não some: cai na seção do estado dela', () => {
    const runs = [run({ key: 'orphan', group: 'grupo-apagado', status: 'rodando' })]
    const secs = buildSections(runs, org) // org só tem g-1; 'grupo-apagado' não existe
    assert.equal(secs.find((s) => s.id === 'grupo-apagado'), undefined)
    const active = secs.find((s) => s.id === 'active')
    assert.ok(active && active.rows.some((r) => r.key === 'orphan'))
  })

  test('uma run fica num lugar só: fixada vence grupo mesmo com os dois presentes (sem duplicar seção)', () => {
    const runs = [run({ key: 'both', pinned: true, group: 'g-1', status: 'rodando' })]
    const secs = buildSections(runs, org)
    assert.equal(secs.find((s) => s.id === 'pinned').rows[0].key, 'both')
    const g1 = secs.find((s) => s.id === 'g-1')
    assert.equal(g1.rows.length, 0) // não aparece de novo no grupo
  })
})
