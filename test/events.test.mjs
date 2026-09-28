// Testes do modo `events` (spec §5.1, §8.2 item 7), rodando o binário como processo e alimentando
// o journal da fixture `happy` linha a linha num diretório temporário, para exercitar o streaming
// de verdade (não só um journal já completo, como em errors.test.mjs).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRequest, listenersDir } from '../bin/requests.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const BIN = path.join(ROOT, 'bin', 'graph-watch.mjs')
const FIXTURES = path.join(__dirname, 'fixtures')
const fx = (name) => path.join(FIXTURES, name)

function feedIncrementally(dir, lines, delayMs) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'journal.jsonl')
  fs.writeFileSync(file, '')
  let i = 0
  const timer = setInterval(() => {
    if (i >= lines.length) {
      clearInterval(timer)
      return
    }
    fs.appendFileSync(file, lines[i] + '\n')
    i++
  }, delayMs)
  return () => clearInterval(timer)
}

// Roda `events` até o processo sair sozinho (TERMINADO) ou até `maxMs`, o que vier primeiro —
// nunca deixa um processo pendurado no fim da suíte. Com `stopWhen`, mata `graceMs` depois da
// primeira saída que casa, e `maxMs` vira só o teto: um prazo fixo curto falhava com a máquina
// carregada (várias suítes em paralelo), porque o filho morria antes de emitir a linha esperada.
function runEventsUntilExit(args, maxMs, { stopWhen = null, graceMs = 600 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'events', ...args, '--no-color'], { cwd: ROOT })
    let stdout = ''
    let stderr = ''
    let settled = false
    let grace = null
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      resolve({ code, stdout, stderr })
    }
    child.stdout.on('data', (d) => {
      stdout += d
      if (stopWhen && !grace && stopWhen.test(stdout)) grace = setTimeout(() => child.kill('SIGKILL'), graceMs)
    })
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => finish(code))
    child.on('error', () => finish(null))
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL')
    }, maxMs)
  })
}

// Sobe o processo e resolve assim que `pattern` bate no stdout acumulado, sem esperar o processo
// sair sozinho — devolve o `child` vivo, para o chamador matar com SIGTERM (simula o Monitor
// encerrando o watcher no timeout de 30 min, antes do rearme, C3/C4). Se `pattern` nunca bater em
// `maxMs`, resolve do mesmo jeito (o chamador confere `stdout` e falha a asserção certa).
function runEventsUntilMatch(args, pattern, maxMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'events', ...args, '--no-color'], { cwd: ROOT })
    let stdout = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ child, stdout: () => stdout })
    }
    child.stdout.on('data', (d) => {
      stdout += d
      if (pattern.test(stdout)) finish()
    })
    child.on('close', () => finish())
    child.on('error', () => finish())
    const timer = setTimeout(finish, maxMs)
  })
}

describe('modo events, alimentado linha a linha (§8.2 item 7)', () => {
  test('happy completo, escrito aos poucos: retomando primeiro, marcos coerentes, TERMINADO por último, exit 0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-stream-'))
    const lines = fs.readFileSync(fx('happy/journal.jsonl'), 'utf8').split('\n').filter(Boolean)
    const stopFeeding = feedIncrementally(dir, lines, 12)

    const { code, stdout } = await runEventsUntilExit(['--run-dir', dir], 8000)
    stopFeeding()

    const outLines = stdout.trim().split('\n').filter(Boolean)
    assert.ok(outLines.length > 0, 'esperava pelo menos uma linha')
    assert.match(outLines[0], /retomando/)
    assert.match(outLines[outLines.length - 1], /TERMINADO/)
    for (const l of outLines) {
      assert.doesNotMatch(l, /started (work|verify|draft)/)
      assert.doesNotMatch(l, /work:|verify:|draft-[ab]:/)
    }
    const startedCount = lines.filter((l) => l.includes('"type":"started"')).length
    assert.ok(outLines.length <= startedCount, `outLines=${outLines.length} startedCount=${startedCount}`)
    assert.equal(code, 0)

    // marcos esperados por conta do journal da fixture (I1 reparado duas vezes; critic r1 com gaps;
    // critic r2 sem gaps): confere que aparecem, sem exigir o texto inteiro.
    const joined = outLines.join('\n')
    assert.match(joined, /I1 reparo 1/)
    assert.match(joined, /I1 reparo 2/)
    assert.match(joined, /critic r1/)
    assert.match(joined, /critic r2/)

    // nenhum marco de nó final se repete com o mesmo estado.
    const seen = new Set()
    for (const l of outLines) {
      const m = l.match(/· ([A-Za-z0-9_-]+) (pronto\S*|falhou\S*|bloqueado|erro|pulado|sem reverificação) ·/)
      if (!m) continue
      const key = m[1] + ':' + m[2]
      assert.ok(!seen.has(key), `marco repetido: ${key}`)
      seen.add(key)
    }
  })

  test('run interrompida (--run-dir), sem --run: nunca emite TERMINADO mesmo esperando', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-noterm-'))
    fs.cpSync(fx('interrupted'), dir, { recursive: true })
    const { stdout } = await runEventsUntilExit(['--run-dir', dir, '--wait-ms', '50'], 700)
    assert.doesNotMatch(stdout, /TERMINADO/)
  })

  // Repair: "parada?" só vale com 10 min sem evento e sem result do synth (§5.1) — não pode
  // sair antes do "plano:" nem com contagem "0/0", nem "roubar" o lugar do parada? legítimo.
  test('journal com mtime velho mas TERMINADO (happy): nunca emite "parada?"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-oldmtime-happy-'))
    fs.cpSync(fx('happy'), dir, { recursive: true })
    const old = new Date(Date.now() - 15 * 60 * 1000)
    fs.utimesSync(path.join(dir, 'journal.jsonl'), old, old)
    const { code, stdout } = await runEventsUntilExit(['--run-dir', dir, '--no-color'], 8000)
    assert.doesNotMatch(stdout, /parada\?/)
    assert.match(stdout, /TERMINADO/)
    assert.equal(code, 0)
  })

  test('run interrompida com mtime velho: emite "parada?" uma vez, depois de "plano:", com N>0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-oldmtime-interrupted-'))
    fs.cpSync(fx('interrupted'), dir, { recursive: true })
    const old = new Date(Date.now() - 15 * 60 * 1000)
    fs.utimesSync(path.join(dir, 'journal.jsonl'), old, old)
    // Não sai sozinho (run interrompida): para 600 ms depois do "parada?", o bastante para ver que
    // ele não se repete (com --wait-ms 50, uma dúzia de voltas do laço).
    const { stdout } = await runEventsUntilExit(['--run-dir', dir, '--wait-ms', '50'], 10000, { stopWhen: /parada\?/ })
    const outLines = stdout.trim().split('\n').filter(Boolean)
    const paradaLines = outLines.filter((l) => /parada\?/.test(l))
    assert.equal(paradaLines.length, 1, `esperava 1 linha de parada?, achou ${paradaLines.length}`)
    const paradaIdx = outLines.findIndex((l) => /parada\?/.test(l))
    const planoIdx = outLines.findIndex((l) => /plano:/.test(l))
    assert.ok(planoIdx >= 0, 'esperava linha "plano:" antes de "parada?"')
    assert.ok(paradaIdx > planoIdx, `parada? (linha ${paradaIdx}) deveria vir depois de plano: (linha ${planoIdx})`)
    const m = outLines[paradaIdx].match(/(\d+)\/(\d+) prontos/)
    assert.ok(m, 'linha de parada? deveria trazer contagem N/M prontos')
    assert.ok(Number(m[2]) > 0, `esperava total de nós > 0 na linha de parada?, achou ${outLines[paradaIdx]}`)
  })

  // Repair: sem --economy, o estado transitório "pronto-sem-verif?" não pode virar um marco final
  // falso para um nó ainda aberto — só quando o nó realmente fecha (§5.1, anti-enxurrada).
  test('happy sem --economy: nenhum nó recebe dois marcos finais diferentes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-nodup-final-'))
    fs.cpSync(fx('happy'), dir, { recursive: true })
    const { stdout } = await runEventsUntilExit(['--run-dir', dir, '--no-color'], 8000)
    const outLines = stdout.trim().split('\n').filter(Boolean)
    const finalRe = /· ([A-Za-z0-9_-]+) (pronto s\/ verif\.\?|pronto s\/ verif\.|pronto|falhou \(check\)|falhou|bloqueado|sem reverificação|erro|pulado) ·/
    const seenIds = new Map()
    for (const l of outLines) {
      const m = l.match(finalRe)
      if (!m) continue
      const [, id, marker] = m
      assert.ok(!seenIds.has(id), `nó ${id} recebeu dois marcos finais: "${seenIds.get(id)}" e "${marker}" (linha: ${l})`)
      seenIds.set(id, marker)
    }
    assert.ok(seenIds.size > 0, 'esperava pelo menos um marco final na fixture happy')
  })

  // D3 §10 "Outros": um caso sobre a wf_phases, com o marco do trilho R1 e os dois vereditos da
  // revisão do design (reprovada no r1, aprovada no r2).
  test('wf_phases: marcos de trilho e de revisão do design', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-phases-'))
    const lines = fs.readFileSync(fx('wf_phases/journal.jsonl'), 'utf8').split('\n').filter(Boolean)
    const stopFeeding = feedIncrementally(dir, lines, 12)
    const { code, stdout } = await runEventsUntilExit(['--run-dir', dir], 8000)
    stopFeeding()
    assert.equal(code, 0)
    const joined = stdout
    assert.match(joined, /trilho R1: research-base injetado/)
    assert.match(joined, /revisão do design r1: reprovada \(1 bloqueio\(s\): D1\) → reparo/)
    assert.match(joined, /revisão do design r2: aprovada/)
    assert.match(joined, /TERMINADO/)
  })

  test('sem \\x1b em pipe (§8.2 item 9)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-noansi-'))
    fs.cpSync(fx('happy'), dir, { recursive: true })
    const { stdout, stderr } = await runEventsUntilExit(['--run-dir', dir], 5000)
    assert.ok(!(stdout + stderr).includes('\x1b'))
  })
})

// Fila de pedidos e sinal de vida (spec docs/specs/2026-09-28-acoes-no-painel.md C1-C4, I3): só
// existem quando o runDir tem a forma <projectsDir>/<slug>/<sessão>/subagents/workflows/<wf>
// (ownerPathInfo). Estado (requests/, listeners/) num --state-dir de os.tmpdir(), nunca ~/.claude.
describe('modo events: fila de pedidos e sinal de vida (C1-C4)', () => {
  const SESSION = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
  const PROJECT = '-slug-do-projeto-de-teste'

  function ownerRunDir(base) {
    return path.join(base, PROJECT, SESSION, 'subagents', 'workflows', 'wf_evtest01')
  }

  test('emite a linha do pedido pendente elegível e grava o sinal de vida do watcher', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-owner-'))
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-state-'))
    const runDir = ownerRunDir(base)
    fs.cpSync(fx('happy'), runDir, { recursive: true })

    const req = createRequest(stateDir, {
      type: 'rerun-node',
      wf: 'wf_evtest01',
      node: 'I3',
      dependents: false,
      dependentsList: [],
      runKey: 'rk-evtest',
      runId: 'rk-evtest',
      project: PROJECT,
      ownerSession: SESSION,
      runDir,
      route: 'project',
    })

    // --listen-min 0: volta ao comportamento de hoje (sai na hora do TERMINADO, sem entrar em
    // listen) — o teste de entrada/saída do listen é o de baixo.
    const { code, stdout } = await runEventsUntilExit(['--run-dir', runDir, '--state-dir', stateDir, '--listen-min', '0'], 8000)
    assert.equal(code, 0)
    assert.match(stdout, /TERMINADO/)
    assert.doesNotMatch(stdout, /ouvindo o painel/)

    const pedidoLines = stdout.split('\n').filter((l) => l.includes('graph-eng pedido'))
    assert.equal(pedidoLines.length, 1, `esperava 1 linha de pedido, veio: ${JSON.stringify(pedidoLines)}`)
    assert.match(pedidoLines[0], new RegExp(`graph-eng pedido ${req.id} · rerun-node · run rk-evtest \\(wf_evtest01\\) · nó I3 · confirmado no painel · aceite: node ".*bin/requests\\.mjs" accept ${req.id} --session ${SESSION}`))

    // sinal de vida: um listeners/<sessão>.<pid>.json, com beatAt e o pid do processo do watcher
    const files = fs.readdirSync(listenersDir(stateDir))
    assert.equal(files.length, 1)
    assert.ok(files[0].startsWith(`${SESSION}.`))
    const hb = JSON.parse(fs.readFileSync(path.join(listenersDir(stateDir), files[0]), 'utf8'))
    assert.equal(hb.session, SESSION)
    assert.equal(hb.project, PROJECT)
    assert.equal(hb.wf, 'wf_evtest01')
    assert.ok(hb.beatAt, 'beatAt deveria estar preenchido')
    assert.ok(hb.exitedAt, 'exitedAt deveria estar preenchido: o processo terminou sozinho (TERMINADO)')
  })

  test('um pedido de outro project não é emitido (elegibilidade por route)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-owner2-'))
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-state2-'))
    const runDir = ownerRunDir(base)
    fs.cpSync(fx('happy'), runDir, { recursive: true })

    createRequest(stateDir, {
      type: 'rerun-node',
      wf: 'wf_evtest01',
      node: 'I3',
      runKey: 'rk-evtest2',
      runId: 'rk-evtest2',
      project: 'outro-projeto-qualquer',
      ownerSession: SESSION,
      runDir,
      route: 'project',
    })

    const { code, stdout } = await runEventsUntilExit(['--run-dir', runDir, '--state-dir', stateDir, '--listen-min', '0'], 8000)
    assert.equal(code, 0)
    assert.doesNotMatch(stdout, /graph-eng pedido/)
  })

  test('P2: depois do TERMINADO, com dona e --listen-min > 0, entra e sai da escuta (C3/C4)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-listen-'))
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-listen-state-'))
    const runDir = ownerRunDir(base)
    fs.cpSync(fx('happy'), runDir, { recursive: true })

    // 0.05 min = 3 s: prazo curto o bastante para o teste não durar 2 h (o padrão), longo o
    // bastante para observar as duas linhas de ciclo de vida antes da saída.
    const { code, stdout } = await runEventsUntilExit(['--run-dir', runDir, '--state-dir', stateDir, '--listen-min', '0.05'], 8000)
    assert.equal(code, 0)
    assert.match(stdout, /TERMINADO/)
    assert.match(stdout, /graph-eng wf_evtest01 · ouvindo o painel até \d\d:\d\d/)
    assert.match(stdout, /graph-eng wf_evtest01 · escuta do painel encerrada/)
    // "ouvindo" vem depois do TERMINADO, e "escuta encerrada" é a última linha.
    const outLines = stdout.trim().split('\n')
    const iTerm = outLines.findIndex((l) => /TERMINADO/.test(l))
    const iOuvindo = outLines.findIndex((l) => /ouvindo o painel/.test(l))
    assert.ok(iOuvindo > iTerm)
    assert.match(outLines[outLines.length - 1], /escuta do painel encerrada/)

    // o sinal de vida final registra a fase de escuta, não "run" (mode não depende de --run).
    const files = fs.readdirSync(listenersDir(stateDir))
    const hb = JSON.parse(fs.readFileSync(path.join(listenersDir(stateDir), files[0]), 'utf8'))
    assert.equal(hb.mode, 'listen')
    assert.ok(hb.listenUntil, 'listenUntil deveria estar preenchido durante a escuta')
    assert.ok(hb.exitedAt, 'exitedAt deveria estar preenchido ao sair da escuta')
  })

  test('rearme (--run) numa run já terminada: não recomeça a janela nem repete o TERMINADO (C4)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-rearm-'))
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-rearm-state-'))
    const runDir = ownerRunDir(base)
    fs.cpSync(fx('happy'), runDir, { recursive: true })

    // 1º arme, sem --run: detecta o TERMINADO e entra em listen com uma janela de 60 s — bem mais
    // longa que o tempo entre os dois armes deste teste, para o marcador de término (C4) ainda
    // valer no 2º arme. Espera só até ver "ouvindo o painel até", depois mata como o Monitor mataria
    // no timeout de 30 min (SIGTERM, que grava exitedAt — C3).
    const first = await runEventsUntilMatch(['--run-dir', runDir, '--state-dir', stateDir, '--listen-min', '1'], /ouvindo o painel até/, 8000)
    const firstOut = first.stdout()
    assert.match(firstOut, /TERMINADO/)
    assert.match(firstOut, /ouvindo o painel até \d\d:\d\d/)
    const firstListenUntilLine = firstOut.match(/ouvindo o painel até (\d\d:\d\d)/)[1]
    first.child.kill('SIGTERM')
    await new Promise((r) => first.child.on('close', r))

    // marcador de término já gravado por este 1º arme (C4).
    const files = fs.readdirSync(listenersDir(stateDir))
    const hbAfterFirst = JSON.parse(fs.readFileSync(path.join(listenersDir(stateDir), files[0]), 'utf8'))
    assert.ok(hbAfterFirst.exitedAt, 'o 1º arme deveria ter saído por SIGTERM com exitedAt gravado')

    // 2º arme, com --run (explicitRun): mesmo runDir e stateDir, ainda dentro da janela do 1º arme.
    // Não deve repetir o TERMINADO, deve imprimir só "ouvindo…", e a janela ("ouvindo o painel até
    // HH:MM") tem de ser a mesma do 1º arme — não HH:MM + 1 min de novo.
    const second = await runEventsUntilMatch(['--run-dir', runDir, '--state-dir', stateDir, '--run', 'wf_evtest01', '--listen-min', '1'], /ouvindo…/, 8000)
    const secondOut = second.stdout()
    second.child.kill('SIGTERM')
    await new Promise((r) => second.child.on('close', r))

    assert.doesNotMatch(secondOut, /TERMINADO/, 'o rearme não deveria repetir o TERMINADO (C4)')
    assert.match(secondOut, /graph-eng wf_evtest01 · ouvindo…/)
    assert.doesNotMatch(secondOut, /ouvindo o painel até/, 'o rearme imprime só "ouvindo…", não a linha completa de novo')

    // controle indireto de que a janela não recomeçou: o sinal de vida do 2º arme (identificado
    // pelo pid do próprio processo, já que os dois armes deixam um listener file cada) carrega o
    // mesmo listenUntil (HH:MM) do 1º, não um novo +1 min a partir de agora.
    const secondFile = fs.readdirSync(listenersDir(stateDir)).find((f) => f.endsWith(`.${second.child.pid}.json`))
    assert.ok(secondFile, 'esperava um listener file para o pid do 2º arme')
    const hbSecond = JSON.parse(fs.readFileSync(path.join(listenersDir(stateDir), secondFile), 'utf8'))
    const secondListenUntilHHMM = new Date(hbSecond.listenUntil).toTimeString().slice(0, 5)
    assert.equal(secondListenUntilHHMM, firstListenUntilLine, 'o 2º arme deveria herdar o mesmo listenUntil do 1º, não recomeçar a janela')
  })

  test('rearme (--run) numa run terminada sem sessão UUID (owner null): TERMINADO e exit 0, sem TypeError', async () => {
    // Achado da verificação: ownerPathInfo devolve null quando o dir da sessão não casa com
    // SESSION_RE, e o ramo explicitRun lia `owner.wf` sem checar owner antes de afterTerminated()
    // tratar o caso null — TypeError. O caminho <projectsDir>/<slug>/<sessão-não-uuid>/... continua
    // achável por findRun via --run (varredura completa, não só o "own" do cwd), só não tem dona.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-noowner-'))
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-noowner-state-'))
    const runDir = path.join(base, PROJECT, 'sess-nao-uuid', 'subagents', 'workflows', 'wf_evtest99')
    fs.cpSync(fx('happy'), runDir, { recursive: true })

    const { code, stdout, stderr } = await runEventsUntilExit(['--projects-dir', base, '--state-dir', stateDir, '--run', 'wf_evtest99', '--listen-min', '1'], 8000)
    assert.equal(code, 0)
    assert.doesNotMatch(stderr, /TypeError/)
    assert.match(stdout, /TERMINADO/)
  })

  test('computeStop do events usa a janela 3·N: a própria dona ouvindo não dá "parada?" com N < idle < 3N', async () => {
    // O events É a dona (owner != null) e, ao subir, já grava seu próprio sinal de vida "ouvindo"
    // antes do 1º snap (beat() roda antes de qualquer snap() no código). Pela regra do C6
    // (L = N·60·(ownerListening ? 3 : 1)), com stallMinutes padrão 5 a janela vira 15 min. Sem a
    // ligação ownerListening/ownerGone deste nó (I3), a janela ficaria em 5 min e "parada?" sairia
    // cedo demais — exatamente o falso positivo que a spec descreve (C6, "no I3 o events passa a
    // ler os listeners").
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-3n-'))
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-3n-state-'))
    const runDir = ownerRunDir(base)
    fs.cpSync(fx('wf_dead'), runDir, { recursive: true })
    // agente aberto (work:X, sem result) com tail "vivo" (sem marcador de orçamento/interrupção):
    // só a folga do idle decide se está parado. 6 min: > N (5) mas < 3N (15).
    const old = new Date(Date.now() - 6 * 60 * 1000)
    for (const f of fs.readdirSync(runDir)) fs.utimesSync(path.join(runDir, f), old, old)

    // Espera o 1º retrato ("retomando") e mais 600 ms de voltas do laço antes de afirmar que o
    // "parada?" não saiu. Com um prazo fixo, a máquina carregada deixava o filho morrer antes do 1º
    // retrato, e a afirmação passava sem ter conferido nada.
    const { stdout } = await runEventsUntilExit(['--run-dir', runDir, '--state-dir', stateDir, '--wait-ms', '50', '--listen-min', '0'], 10000, { stopWhen: /retomando/ })
    assert.match(stdout, /retomando/, 'o events deveria emitir o 1º retrato')
    assert.doesNotMatch(stdout, /parada\?/, 'com a própria dona ouvindo, 6 min de idle não deveria bater a janela de 15 min (3·5)')

    // controle: a mesma folga de 6 min, mas SEM sinal de vida nenhum (project diferente do da
    // fixture, para não ser reconhecido como owner) usa a janela de 1×N e dá "parada?".
    const looseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-3n-loose-'))
    fs.cpSync(fx('wf_dead'), looseDir, { recursive: true })
    for (const f of fs.readdirSync(looseDir)) fs.utimesSync(path.join(looseDir, f), old, old)
    const looseStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-3n-loose-state-'))
    const control = await runEventsUntilExit(['--run-dir', looseDir, '--state-dir', looseStateDir, '--wait-ms', '50'], 10000, { stopWhen: /parada\?/ })
    assert.match(control.stdout, /parada\?/, 'sem dona ouvindo (--run-dir solto), a janela de 1×N deveria bater em 6 min')
  })

  test('--run-dir solto (fora da forma <slug>/<sessão>/subagents/workflows/<wf>): sem sinal de vida', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-state3-'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-ev-loose-'))
    fs.cpSync(fx('happy'), dir, { recursive: true })
    const { code } = await runEventsUntilExit(['--run-dir', dir, '--state-dir', stateDir], 8000)
    assert.equal(code, 0)
    assert.ok(!fs.existsSync(listenersDir(stateDir)), 'não deveria existir listeners/ sem sessão dona')
  })
})
