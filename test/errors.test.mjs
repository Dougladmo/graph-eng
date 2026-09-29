// Testes de erro, exit code e do modo `events` do graph-watch, rodando o binário como processo
// (spec §7 "Tratamento de erro", §8.2 itens 6 e 7). Ver o topo de model.test.mjs para o contrato
// completo de flags/exports; aqui usamos só a CLI.
//
// bin/graph-watch.mjs ainda não existe: todo teste abaixo falha (spawn devolve ENOENT ou o processo
// não roda como esperado) — vermelho esperado desta etapa, sem erro de sintaxe no teste.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const BIN = path.join(ROOT, 'bin', 'graph-watch.mjs')
const FIXTURES = path.join(__dirname, 'fixtures')
const fx = (name) => path.join(FIXTURES, name)

function run(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => resolve({ code: null, stdout, stderr, spawnError: err }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    if (input !== undefined) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

// `events` numa run interrompida NÃO sai sozinho (§7: "Não sai sozinho") — só emite a linha
// "parada?" e continua esperando. Um `run()` que espera o processo fechar travaria para sempre,
// então este helper mata o filho depois de `killAfterMs` e devolve o que já foi lido até lá.
// Com `stopWhen`, mata `graceMs` depois da primeira saída que casa, e `killAfterMs` vira só o teto.
// Um prazo fixo curto falhava com a máquina carregada (várias suítes em paralelo): o filho morria
// antes de subir o node e emitir a linha esperada.
function runKillable(args, { killAfterMs = 700, stopWhen = null, graceMs = 600 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT })
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
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL')
    }, killAfterMs)
  })
}

describe('exit codes e erros (§7, §8.2 item 6)', () => {
  test('formato antigo (sem label/phase): exit 2 e uma linha', async () => {
    const { code, stdout, stderr } = await run(['snapshot', '--run-dir', fx('old-format'), '--no-color'])
    assert.equal(code, 2)
    const line = (stdout + stderr).trim()
    assert.ok(line.length > 0)
    assert.equal((stdout + stderr).trim().split('\n').length, 1)
    assert.match(line, /não reconhecido|workflows/)
  })

  test('run de outro workflow com --run explícito: exit 2', async () => {
    const { code, stdout, stderr } = await run(['snapshot', '--run-dir', fx('other-wf'), '--no-color'])
    assert.equal(code, 2)
    assert.match((stdout + stderr), /não é run do graph-eng|graph-eng/)
  })

  test('agent sem transcrição: exit 4', async () => {
    const { code, stdout, stderr } = await run(['agent', 'R1', '--run-dir', fx('happy'), '--no-color'])
    // R1 nunca teve modo `agent` chamado com um id sem transcript correspondente: usamos um nó real
    // que existe no journal mas cujo agent-<id>.jsonl não foi gravado.
    assert.equal(code, 4)
    assert.match((stdout + stderr), /sem transcri/)
  })

  test('nó ainda não começou (agent): exit 0 e mensagem clara', async () => {
    const { code, stdout } = await run(['agent', 'r2-G1', '--run-dir', fx('wf_deferred_check'), '--no-color'])
    // r2-G1 não existe nesta fixture: qualquer nó sem nenhum started deve sair 0 com aviso, não erro.
    assert.equal(code, 0)
    assert.match(stdout, /ainda não começou/)
  })

  test('sem run nenhuma para o cwd: exit 3', async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-empty-'))
    const { code, stdout, stderr } = await run(['snapshot', '--projects-dir', projectsDir, '--wait-ms', '10', '--no-color'])
    assert.equal(code, 3)
    assert.match((stdout + stderr), /nenhuma run/)
  })

  test('snapshot de run terminada: "sem --run" só sai quando a run foi escolhida sozinha', async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-terminada-'))
    try {
      const dest = path.join(projectsDir, ROOT.replace(/[^A-Za-z0-9]/g, '-'), 'sess', 'subagents', 'workflows', 'wf_hhhh0000-hhh')
      fs.cpSync(fx('happy'), dest, { recursive: true })
      const auto = await run(['snapshot', '--projects-dir', projectsDir, '--no-color'])
      assert.equal(auto.code, 0)
      assert.match(auto.stdout, /aviso: sem --run, usando wf_hhhh0000-hhh \(terminada\)/)
      const explicit = await run(['snapshot', '--projects-dir', projectsDir, '--run', 'wf_hhhh0000-hhh', '--no-color'])
      assert.equal(explicit.code, 0)
      assert.doesNotMatch(explicit.stdout, /sem --run/)
    } finally {
      fs.rmSync(projectsDir, { recursive: true, force: true })
    }
  })

  test('linha JSON parcial/cortada: fica pendurada até completar, sem crash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-partial-'))
    const full = fs.readFileSync(path.join(fx('happy'), 'journal.jsonl'), 'utf8')
    const lines = full.split('\n').filter(Boolean)
    // corta a última linha ao meio, simulando um write em andamento
    const truncated = lines.slice(0, -1).join('\n') + '\n' + lines[lines.length - 1].slice(0, 20)
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), truncated)
    const { code, stdout, stderr } = await run(['snapshot', '--run-dir', dir, '--no-color'])
    assert.equal(code, 0)
    assert.doesNotMatch((stdout + stderr).toLowerCase(), /unexpected token|syntaxerror|throw/)
  })
})

describe('modo events (§5.1, §8.2 item 7)', () => {
  function writeJournalIncrementally(dir, lines, delayMs = 15) {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'journal.jsonl')
    fs.writeFileSync(file, '')
    let i = 0
    const timer = setInterval(() => {
      if (i >= lines.length) return clearInterval(timer)
      fs.appendFileSync(file, JSON.stringify(lines[i]) + '\n')
      i++
    }, delayMs)
    return () => clearInterval(timer)
  }

  test('primeira linha é "retomando"; nenhuma linha de started work/verify/draft; total <= nº de started; sai 0 após TERMINADO', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-events-'))
    fs.cpSync(fx('happy'), dir, { recursive: true })
    const { code, stdout } = await run(['events', '--run-dir', dir, '--no-color'])
    const outLines = stdout.trim().split('\n').filter(Boolean)
    assert.match(outLines[0], /retomando/)
    for (const l of outLines) assert.doesNotMatch(l, /started (work|verify|draft)/)
    const journalText = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')
    const startedCount = journalText.split('\n').filter((l) => l.includes('"type":"started"')).length
    assert.ok(outLines.length <= startedCount)
    assert.equal(code, 0)
    assert.match(outLines[outLines.length - 1], /TERMINADO/)
  })

  test('sobre o journal completo, com --run: só "retomando" e "TERMINADO"; sem --run: nunca emite TERMINADO', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-events-full-'))
    fs.cpSync(fx('happy'), dir, { recursive: true })

    const withRun = await run(['events', '--run-dir', dir, '--run', 'wf_exemplo0000-fff', '--no-color'])
    const withRunLines = withRun.stdout.trim().split('\n').filter(Boolean)
    assert.ok(withRunLines.every((l) => /retomando|TERMINADO/.test(l)))

    const noRun = await run(['events', '--projects-dir', dir, '--wait-ms', '10', '--no-color'])
    assert.doesNotMatch(noRun.stdout, /TERMINADO/)
  })

  test('journal parado (mtime velho): emite "parada?" uma vez só', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-events-stalled-'))
    fs.cpSync(fx('interrupted'), dir, { recursive: true })
    const old = new Date(Date.now() - 15 * 60 * 1000)
    fs.utimesSync(path.join(dir, 'journal.jsonl'), old, old)
    // Run interrompida: o modo `events` não termina sozinho (§7), então não dá para esperar o
    // processo fechar — mata-se o filho um tempo depois do "parada?", o bastante para ver que ele
    // não se repete (com --wait-ms 50, uma dúzia de voltas do laço).
    const { stdout } = await runKillable(['events', '--run-dir', dir, '--no-color', '--wait-ms', '50'], { killAfterMs: 10000, stopWhen: /parada\?/ })
    const matches = stdout.split('\n').filter((l) => /parada\?/.test(l))
    assert.equal(matches.length, 1)
  })
})

describe('porta do painel: --port > GRAPH_ENG_PORT > padrão (spec painel-web item 1b)', async () => {
  const { parsePort } = await import('../bin/graph-watch.mjs')
  test('precedência', () => {
    assert.equal(parsePort(undefined, 4477, undefined), 4477)
    assert.equal(parsePort(undefined, 4477, ''), 4477)
    assert.equal(parsePort(undefined, 4477, '5001'), 5001)
    assert.equal(parsePort('5002', 4477, '5001'), 5002)
    assert.equal(parsePort('0', 4477, undefined), 0)
  })
  test('valor inválido diz de onde veio', () => {
    assert.throws(() => parsePort('abc', 4477, undefined), /--port inválida: abc/)
    assert.throws(() => parsePort(undefined, 4477, '70000'), /GRAPH_ENG_PORT inválida: 70000/)
  })
})
