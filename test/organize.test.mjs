// Testes puros de bin/organize.mjs (spec docs/specs/2026-09-28-acoes-no-painel.md C1, C10 e C11; casos do
// D4 §8.1). Tudo em dirs de os.tmpdir(); nada toca ~/.claude.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const {
  RUN_ID_RE,
  GROUP_RE,
  ORG_LIMITS,
  runKey,
  emptyOrg,
  readOrg,
  writeOrg,
  publicOrg,
  validateOrgBody,
  applyOrgOp,
  pruneRevived,
  isInFinishedSection,
  pickRepresentative,
  resolveRunDir,
  removeRunDir,
} = await import('../bin/organize.mjs')

const tmp = (p = 'graph-eng-org-') => fs.mkdtempSync(path.join(os.tmpdir(), p))
const RID = '20260101-0000-exemplo-org'

// ids de grupo determinísticos
function ids(...list) {
  let i = 0
  return () => list[i++]
}

describe('readOrg / writeOrg', () => {
  test('arquivo ausente → vazio, sem aviso', () => {
    const r = readOrg(path.join(tmp(), 'organize.json'))
    assert.deepEqual(r.org, emptyOrg())
    assert.deepEqual(r.warnings, [])
  })

  test('JSON ruim ou version 2 → vazio com aviso', () => {
    const dir = tmp()
    const f = path.join(dir, 'organize.json')
    fs.writeFileSync(f, '{ruim')
    let r = readOrg(f)
    assert.deepEqual(r.org, emptyOrg())
    assert.match(r.warnings[0], /ilegível/)
    fs.writeFileSync(f, JSON.stringify({ version: 2, pinned: [RID] }))
    r = readOrg(f)
    assert.deepEqual(r.org.pinned, [])
    assert.match(r.warnings[0], /ilegível/)
  })

  test('entradas inválidas caem uma a uma; __proto__ não polui nada', () => {
    const f = path.join(tmp(), 'organize.json')
    fs.writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        pinned: [RID, RID, 42, 'sem-formato', '-slug/wf_abc'],
        groups: [
          { id: 'g-0000000a', name: 'Salesbud' },
          { id: 'g-0000000b', name: 'salesbud' }, // nome repetido sem caixa
          { id: 'x-1', name: 'Id ruim' },
          { id: 'g-0000000c', name: '' },
        ],
        placement: { [RID]: 'g-0000000a', '-slug/wf_abc': 'g-ffffffff' },
        archived: { [RID]: 'NaN', '-slug/wf_abc': 1000 },
      }).replace(/}$/, ',"deleted":{"__proto__":5,"20260101-0000-outra":7}}'),
    )
    const r = readOrg(f)
    assert.deepEqual(r.org.pinned, [RID, '-slug/wf_abc'])
    assert.deepEqual(r.org.groups, [{ id: 'g-0000000a', name: 'Salesbud' }])
    assert.deepEqual(r.org.placement, { [RID]: 'g-0000000a' })
    assert.deepEqual(r.org.archived, { '-slug/wf_abc': 1000 })
    assert.deepEqual(r.org.deleted, { '20260101-0000-outra': 7 })
    assert.equal(Object.getPrototypeOf(r.org.deleted), Object.prototype)
    assert.equal({}.polluted, undefined)
    assert.match(r.warnings[0], /entradas inválidas ignoradas/)
  })

  test('writeOrg: 0600, sem .tmp-* sobrando, e volta igual ao ler', () => {
    const dir = path.join(tmp(), 'estado')
    const f = path.join(dir, 'organize.json')
    const org = { ...emptyOrg(), pinned: [RID], groups: [{ id: 'g-0123abcd', name: 'Grupo' }], placement: { [RID]: 'g-0123abcd' }, archived: { [RID]: 5 } }
    writeOrg(f, org)
    assert.equal(fs.statSync(f).mode & 0o777, 0o600)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    assert.deepEqual(fs.readdirSync(dir), ['organize.json'])
    assert.deepEqual(readOrg(f).org, org)
    assert.deepEqual(publicOrg(org, ['x']), { groups: [{ id: 'g-0123abcd', name: 'Grupo' }], pinned: [RID], warnings: ['x'] })
  })
})

describe('runKey', () => {
  test('mesmo runId em dois wfs, ou sob outro slug → mesma key (o runId)', () => {
    const a = runKey({ slug: '-a', runId: RID, wf: 'wf_1' })
    const b = runKey({ slug: '-a', runId: RID, wf: 'wf_2' })
    const c = runKey({ slug: '-outro-cwd', runId: RID, wf: 'wf_3' })
    assert.equal(a, RID)
    assert.equal(b, RID)
    assert.equal(c, RID)
    assert.ok(!a.includes('/'))
  })

  test('runId adhoc ou ausente → <slug>/<wf>, e dois wfs nunca dividem key', () => {
    assert.equal(runKey({ slug: '-a', runId: 'adhoc', wf: 'wf_1' }), '-a/wf_1')
    assert.equal(runKey({ slug: '-a', runId: undefined, wf: 'wf_2' }), '-a/wf_2')
    assert.notEqual(runKey({ slug: '-a', runId: 'x', wf: 'wf_1' }), runKey({ slug: '-a', runId: 'x', wf: 'wf_2' }))
    assert.ok(RUN_ID_RE.test(RID) && !RUN_ID_RE.test('exemplo-feito') && !RUN_ID_RE.test('20260101-0000-Maiuscula'))
  })
})

describe('validateOrgBody', () => {
  test('estrita: campo a mais, tipo errado e wf fora da regex', () => {
    let v = validateOrgBody('pin', { wf: 'wf_a', pinned: true, extra: 1 })
    assert.equal(v.ok, false)
    assert.equal(v.errors.extra, 'campo desconhecido')
    v = validateOrgBody('pin', { wf: '../x', pinned: 'sim' })
    assert.equal(v.errors.wf, 'id de run inválido')
    assert.equal(v.errors.pinned, 'use true ou false')
    v = validateOrgBody('pin', {})
    assert.ok(v.errors.wf && v.errors.pinned)
  })

  test('nome de grupo: vazio, longo, controle; trim no valor', () => {
    assert.equal(validateOrgBody('group-create', { name: '  ' }).errors.name, 'dê um nome ao grupo')
    assert.equal(validateOrgBody('group-create', { name: 'x'.repeat(41) }).errors.name, 'até 40 caracteres')
    assert.equal(validateOrgBody('group-create', { name: 'a\u0007b' }).errors.name, 'sem caracteres de controle')
    assert.equal(validateOrgBody('group-create', { name: ' Ação ' }).value.name, 'Ação')
  })

  test('move: group null ou gid; delete-finished: 1-50 sem repetir e "apagar N"', () => {
    assert.equal(validateOrgBody('move', { wf: 'wf_a', group: null }).ok, true)
    assert.equal(validateOrgBody('move', { wf: 'wf_a', group: 'g-zz' }).errors.group, 'id de grupo inválido')
    assert.equal(validateOrgBody('delete-finished', { wfs: [], confirm: 'apagar 0' }).errors.wfs, 'de 1 a 50 runs, sem repetir')
    assert.equal(validateOrgBody('delete-finished', { wfs: ['wf_a', 'wf_a'], confirm: 'apagar 2' }).errors.wfs, 'de 1 a 50 runs, sem repetir')
    assert.equal(validateOrgBody('delete-finished', { wfs: ['wf_a', 'wf_b'], confirm: 'apagar 1' }).errors.confirm, 'digite apagar 2')
    assert.equal(validateOrgBody('delete-finished', { wfs: ['wf_a', 'wf_b'], confirm: 'apagar 2' }).ok, true)
  })
})

describe('applyOrgOp (O1-O9)', () => {
  const base = () => ({ ...emptyOrg(), groups: [{ id: 'g-0000000a', name: 'Salesbud' }] })

  test('não muda a org recebida', () => {
    const org = base()
    const copy = structuredClone(org)
    applyOrgOp(org, 'pin', { key: RID, pinned: true })
    assert.deepEqual(org, copy)
  })

  test('O1: fixar entra no topo; desafixar sai; limite de 100 → 409', () => {
    let r = applyOrgOp(base(), 'pin', { key: 'a/wf_1', pinned: true })
    r = applyOrgOp(r.org, 'pin', { key: RID, pinned: true })
    assert.deepEqual(r.org.pinned, [RID, 'a/wf_1'])
    r = applyOrgOp(r.org, 'pin', { key: RID, pinned: false })
    assert.deepEqual(r.org.pinned, ['a/wf_1'])
    const full = { ...base(), pinned: Array.from({ length: ORG_LIMITS.pinned }, (_, i) => `s/wf_${i}`) }
    const over = applyOrgOp(full, 'pin', { key: RID, pinned: true })
    assert.equal(over.ok, false)
    assert.equal(over.status, 409)
    assert.equal(over.error, 'limite de 100 fixadas')
    // refixar quem já está fixado não conta como nova
    assert.equal(applyOrgOp(full, 'pin', { key: 's/wf_3', pinned: true }).ok, true)
  })

  test('O2: nome duplicado sem caixa nem acento → 400; limite de 20 → 409; com key, entra e desafixa', () => {
    const org = { ...base(), groups: [{ id: 'g-0000000a', name: 'Salesbud' }, { id: 'g-0000000b', name: 'Ação' }], pinned: [RID] }
    for (const name of ['salesbud', 'SALESBUD', 'acao', 'AÇÃO']) {
      const r = applyOrgOp(org, 'group-create', { name })
      assert.equal(r.status, 400, name)
      assert.equal(r.fields.name, 'já existe um grupo com esse nome')
    }
    const r = applyOrgOp(org, 'group-create', { name: 'Novo', key: RID }, { randomId: ids('g-0000000a', 'g-1234abcd') })
    assert.equal(r.ok, true)
    assert.deepEqual(r.extra.group, { id: 'g-1234abcd', name: 'Novo' }) // o id repetido foi pulado
    assert.equal(r.org.placement[RID], 'g-1234abcd')
    assert.deepEqual(r.org.pinned, [])
    const full = { ...emptyOrg(), groups: Array.from({ length: 20 }, (_, i) => ({ id: `g-${String(i).padStart(8, '0')}`, name: `G${i}` })) }
    const over = applyOrgOp(full, 'group-create', { name: 'G21' })
    assert.equal(over.status, 409)
    assert.equal(over.error, 'limite de 20 grupos')
    assert.ok(GROUP_RE.test(applyOrgOp(base(), 'group-create', { name: 'Aleatório' }).extra.group.id))
  })

  test('O3/O4: renomear (o próprio nome vale) e mover grupo; 404 e posição inválida', () => {
    const org = { ...emptyOrg(), groups: [{ id: 'g-0000000a', name: 'A' }, { id: 'g-0000000b', name: 'B' }, { id: 'g-0000000c', name: 'C' }] }
    assert.equal(applyOrgOp(org, 'group-rename', { gid: 'g-0000000a', name: 'a' }).ok, true)
    assert.equal(applyOrgOp(org, 'group-rename', { gid: 'g-0000000a', name: 'b' }).status, 400)
    assert.equal(applyOrgOp(org, 'group-rename', { gid: 'g-ffffffff', name: 'Z' }).status, 404)
    const moved = applyOrgOp(org, 'group-move', { gid: 'g-0000000c', index: 0 })
    assert.deepEqual(
      moved.org.groups.map((g) => g.name),
      ['C', 'A', 'B'],
    )
    const bad = applyOrgOp(org, 'group-move', { gid: 'g-0000000c', index: 3 })
    assert.equal(bad.status, 400)
    assert.equal(bad.fields.index, 'posição inválida')
    assert.equal(applyOrgOp(org, 'group-move', { gid: 'g-ffffffff', index: 0 }).status, 404)
  })

  test('O5: apagar grupo devolve as runs (placement some) e conta released', () => {
    const org = { ...base(), placement: { [RID]: 'g-0000000a', 'a/wf_1': 'g-0000000a' } }
    const r = applyOrgOp(org, 'group-delete', { gid: 'g-0000000a' })
    assert.equal(r.extra.released, 2)
    assert.deepEqual(r.org.groups, [])
    assert.deepEqual(r.org.placement, {})
  })

  test('O6: mover desafixa; null tira do grupo; grupo inexistente → 400 fields.group', () => {
    const org = { ...base(), pinned: [RID] }
    let r = applyOrgOp(org, 'move', { key: RID, group: 'g-0000000a' })
    assert.deepEqual(r.org.pinned, [])
    assert.equal(r.org.placement[RID], 'g-0000000a')
    r = applyOrgOp(r.org, 'move', { key: RID, group: null })
    assert.deepEqual(r.org.placement, {})
    const bad = applyOrgOp(org, 'move', { key: RID, group: 'g-ffffffff' })
    assert.equal(bad.status, 400)
    assert.equal(bad.fields.group, 'esse grupo não existe')
  })

  test('O7: arquivar grava a data e não mexe em pin nem grupo; desarquivar volta', () => {
    const org = { ...base(), pinned: [RID], placement: { [RID]: 'g-0000000a' } }
    const r = applyOrgOp(org, 'archive', { key: RID, archived: true }, { now: 123 })
    assert.equal(r.org.archived[RID], 123)
    assert.deepEqual(r.org.pinned, [RID])
    assert.equal(r.org.placement[RID], 'g-0000000a')
    assert.deepEqual(applyOrgOp(r.org, 'archive', { key: RID, archived: false }).org.archived, {})
  })

  test('O8/O9: apagar tira a key de pinned, placement e archived e marca deleted', () => {
    const org = { ...base(), pinned: [RID], placement: { [RID]: 'g-0000000a' }, archived: { [RID]: 1 } }
    const r = applyOrgOp(org, 'delete', { key: RID }, { now: 99 })
    assert.deepEqual(r.org.pinned, [])
    assert.deepEqual(r.org.placement, {})
    assert.deepEqual(r.org.archived, {})
    assert.deepEqual(r.org.deleted, { [RID]: 99 })
    const many = applyOrgOp(org, 'delete-finished', { keys: [RID, 'a/wf_1'] }, { now: 5 })
    assert.deepEqual(many.org.deleted, { [RID]: 5, 'a/wf_1': 5 })
  })

  test('pruneRevived: a key com wf mais novo que o apagar sai de deleted', () => {
    const org = { ...emptyOrg(), deleted: { [RID]: 100, 'a/wf_1': 100 } }
    const r = pruneRevived(org, new Map([[RID, 200], ['a/wf_1', 50]]))
    assert.deepEqual(r.deleted, { 'a/wf_1': 100 })
  })
})

describe('isInFinishedSection e representante', () => {
  test('tabela de casos, na ordem do sectionOf', () => {
    const cases = [
      [{ status: 'terminado' }, true],
      [{ status: 'rodando', planOnly: true }, false],
      [{ status: 'parada?', planOnly: true }, true],
      [{ status: 'parada?' }, false],
      [{ status: 'terminado', pinned: true }, false],
      [{ status: 'terminado', group: 'g-0000000a' }, false],
      [{ status: 'terminado', archived: true }, false],
    ]
    for (const [run, want] of cases) assert.equal(isInFinishedSection(run), want, JSON.stringify(run))
  })

  test('uma execução nova rodando (ainda só com o plan) vence a velha parada', () => {
    const rep = pickRepresentative([
      { wf: 'wf_velha', status: 'parada?', planOnly: false, mtime: 100 },
      { wf: 'wf_nova', status: 'rodando', planOnly: false, mtime: 50 },
    ])
    assert.equal(rep.wf, 'wf_nova')
    assert.equal(rep.status, 'rodando')
    assert.equal(rep.planOnly, false)
  })

  test('sem rodando: o mais novo que não é planOnly; só planOnly: o planOnly mais novo', () => {
    assert.equal(
      pickRepresentative([
        { wf: 'wf_plano', status: 'terminado', planOnly: true, mtime: 300 },
        { wf: 'wf_real', status: 'parada?', planOnly: false, mtime: 200 },
      ]).wf,
      'wf_real',
    )
    assert.equal(
      pickRepresentative([
        { wf: 'wf_p1', status: 'terminado', planOnly: true, mtime: 1 },
        { wf: 'wf_p2', status: 'terminado', planOnly: true, mtime: 2 },
      ]).wf,
      'wf_p2',
    )
  })
})

describe('resolveRunDir (contenção do apagar)', () => {
  // <root>/repo/.graph-runs/<RID>, <root>/projects, <root>/home, <root>/graph-runs
  function world() {
    const root = fs.realpathSync(tmp('graph-eng-contencao-'))
    const projectsDir = path.join(root, 'projects')
    const home = path.join(root, 'home')
    const graphRunsHome = path.join(root, 'graph-runs')
    for (const d of [projectsDir, home, graphRunsHome]) fs.mkdirSync(d, { recursive: true })
    const runDir = path.join(root, 'repo', '.graph-runs', RID)
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(path.join(runDir, 'plan.md'), '# plano\n')
    return { root, projectsDir, home, graphRunsHome, runDir, opts: { projectsDir, home, graphRunsHome } }
  }

  test('caso válido: .graph-runs/<runId> e dentro do graph-runs global', () => {
    const w = world()
    assert.deepEqual(resolveRunDir(w.runDir, RID, w.opts), { ok: true, real: w.runDir })
    const global = path.join(w.graphRunsHome, 'qualquer', RID)
    fs.mkdirSync(global, { recursive: true })
    assert.equal(resolveRunDir(global, RID, w.opts).ok, true)
  })

  test('sem pasta: caminho ausente, runId fora do formato ou pasta inexistente → absent', () => {
    const w = world()
    assert.equal(resolveRunDir(null, RID, w.opts).absent, true)
    assert.equal(resolveRunDir(path.join(w.root, 'repo', '.graph-runs', 'adhoc'), 'adhoc', w.opts).absent, true)
    const r = resolveRunDir(path.join(w.root, 'repo', '.graph-runs', '20260101-0000-nao-existe'), '20260101-0000-nao-existe', w.opts)
    assert.equal(r.ok, false)
    assert.equal(r.absent, true)
  })

  test('cada passo que falha (e nada é absent)', () => {
    const w = world()
    const fail = (raw, runId = RID, opts = w.opts) => {
      const r = resolveRunDir(raw, runId, opts)
      assert.equal(r.ok, false, raw)
      assert.ok(!r.absent, `não devia ser absent: ${raw} (${r.why})`)
      return r.why
    }
    // 1. relativo e com ..
    assert.match(fail(path.relative(process.cwd(), w.runDir)), /absoluto/)
    assert.match(fail(`${w.root}/repo/.graph-runs/x/../${RID}`), /absoluto/)
    assert.match(fail(`${w.root}/repo//.graph-runs/${RID}`), /absoluto/)
    // 2. basename ≠ runId
    assert.match(fail(w.runDir, '20260101-0000-outro-nome'), /runId/)
    // 3. symlink para a pasta de verdade
    const link = path.join(w.root, 'repo2', '.graph-runs', RID)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(w.runDir, link)
    assert.match(fail(link), /link simbólico/)
    // 4. dentro do projectsDir, home, raiz
    const inProjects = path.join(w.projectsDir, '.graph-runs', RID)
    fs.mkdirSync(inProjects, { recursive: true })
    assert.match(fail(inProjects), /históricos/)
    const homeRun = path.join(w.root, 'h', RID)
    fs.mkdirSync(homeRun, { recursive: true })
    assert.match(fail(homeRun, RID, { ...w.opts, home: homeRun }), /home ou a raiz/)
    // pasta que contém o projectsDir
    const wrap = path.join(w.root, 'wrap', '.graph-runs', RID)
    fs.mkdirSync(path.join(wrap, 'projects'), { recursive: true })
    assert.match(fail(wrap, RID, { ...w.opts, projectsDir: path.join(wrap, 'projects') }), /históricos/)
    // 5. pai que não é .graph-runs, fora do graph-runs global
    const loose = path.join(w.root, 'solta', RID)
    fs.mkdirSync(loose, { recursive: true })
    assert.match(fail(loose), /\.graph-runs/)
  })

  test('removeRunDir apaga só a pasta e não segue symlink interno', () => {
    const w = world()
    const outside = path.join(w.root, 'fora.txt')
    fs.writeFileSync(outside, 'fica')
    fs.symlinkSync(outside, path.join(w.runDir, 'link.txt'))
    const r = resolveRunDir(w.runDir, RID, w.opts)
    removeRunDir(r.real)
    assert.equal(fs.existsSync(w.runDir), false)
    assert.equal(fs.readFileSync(outside, 'utf8'), 'fica')
    assert.ok(fs.existsSync(path.join(w.root, 'repo', '.graph-runs')))
  })
})
