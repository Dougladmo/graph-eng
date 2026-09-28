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
// nunca deixa um processo pendurado no fim da suíte.
function runEventsUntilExit(args, maxMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'events', ...args, '--no-color'], { cwd: ROOT })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => finish(code))
    child.on('error', () => finish(null))
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL')
    }, maxMs)
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
    const { stdout } = await runEventsUntilExit(['--run-dir', dir, '--wait-ms', '50'], 700)
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
