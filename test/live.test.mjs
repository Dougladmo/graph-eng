// Testes do modo `live` (spec §6.6, §8.2 item 10), chamando `runLive` diretamente com um
// `stdout` de TTY falso — spawnar o binário não dá um TTY de verdade, então o redesenho e a
// sequência de escapes são exercitados chamando a função exportada, não via CLI.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')
const fx = (name) => path.join(FIXTURES, name)

const { runLive } = await import('../bin/graph-watch.mjs')

function fakeTTY({ isTTY = true } = {}) {
  const stream = new EventEmitter()
  stream.isTTY = isTTY
  stream.columns = 120
  stream.rows = 40
  stream.chunks = []
  stream.write = (s) => {
    stream.chunks.push(s)
    return true
  }
  return stream
}

describe('modo live (§6.6, §8.2 item 10)', () => {
  test('TTY: entra na tela alternativa, redesenha com CUP+ED e sai com ?1049l ao terminar', async () => {
    const stdout = fakeTTY()
    await runLive(fx('happy'), { stdout, stdin: { isTTY: false }, maxTicks: 1, intervalMs: 5 })
    const all = stdout.chunks.join('')
    assert.ok(all.includes('\x1b[?1049h'), 'esperava entrar na tela alternativa')
    assert.ok(all.includes('\x1b[?25l'), 'esperava esconder o cursor')
    assert.ok(all.includes('\x1b[?2026h'), 'esperava o synchronized output')
    assert.ok(all.includes('\x1b[H'), 'esperava CUP (cursor home)')
    assert.ok(all.includes('\x1b[J'), 'esperava ED (limpar o resto)')
    assert.ok(all.includes('\x1b[?1049l'), 'esperava sair da tela alternativa ao terminar')
    assert.ok(all.includes('\x1b[?25h'), 'esperava mostrar o cursor de volta')
  })

  test('um quadro novo só é escrito quando o texto muda (sem run-dir/journal mudando, nenhum quadro repete o anterior)', async () => {
    const stdout = fakeTTY()
    await runLive(fx('happy'), { stdout, stdin: { isTTY: false }, maxTicks: 3, intervalMs: 5 })
    const frames = stdout.chunks.filter((c) => c.includes('\x1b[?2026h'))
    // O rodapé tem relógio ("atualizado HH:MM:SS · último evento há Ns"): se os 3 ticks cruzam a virada
    // de um segundo, o texto muda de verdade e sai um 2º quadro — contar "só 1" falhava sob carga. O que
    // não pode é escrever de novo um quadro igual ao anterior.
    assert.ok(frames.length >= 1, 'o 1º tick deveria desenhar')
    for (let i = 1; i < frames.length; i++) assert.notEqual(frames[i], frames[i - 1], `o quadro ${i + 1} repete o anterior: o texto não mudou`)
  })

  test('SIGINT (via AbortSignal) restaura a tela alternativa antes de o processo seguir', async () => {
    const stdout = fakeTTY()
    const controller = new AbortController()
    const p = runLive(fx('happy'), { stdout, stdin: { isTTY: false }, intervalMs: 20, signal: controller.signal })
    // deixa rodar um quadro e então simula o SIGINT via abort do signal.
    await new Promise((r) => setTimeout(r, 30))
    controller.abort()
    await p
    const all = stdout.chunks.join('')
    const enterIdx = all.indexOf('\x1b[?1049h')
    const leaveIdx = all.lastIndexOf('\x1b[?1049l')
    assert.ok(enterIdx >= 0 && leaveIdx > enterIdx, 'esperava sair da tela alternativa depois de entrar')
  })

  test('sem TTY: nenhum escape ANSI, e o quadro sai inteiro só quando muda', async () => {
    const stdout = fakeTTY({ isTTY: false })
    await runLive(fx('happy'), { stdout, stdin: { isTTY: false }, maxTicks: 2, intervalMs: 5 })
    const all = stdout.chunks.join('')
    assert.ok(!all.includes('\x1b'), 'sem TTY não deveria emitir escape nenhum')
    assert.ok(all.includes('graph-eng'), 'ainda deveria imprimir o cabeçalho do grafo')
  })

  test('resize: força um novo quadro mesmo com o modelo igual', async () => {
    const stdout = fakeTTY()
    // maxTicks alto, mas o resize deve gerar mais de 1 quadro mesmo o modelo não mudando entre ticks.
    const p = runLive(fx('happy'), { stdout, stdin: { isTTY: false }, intervalMs: 15, maxTicks: 4 })
    await new Promise((r) => setTimeout(r, 20))
    stdout.emit('resize')
    await p
    const frames = stdout.chunks.filter((c) => c.includes('\x1b[?2026h')).length
    assert.ok(frames >= 2, `esperava redesenho extra por causa do resize, veio ${frames}`)
  })

  test('"atualizado HH:MM:SS" usa a hora local, não UTC (TZ fixado)', async () => {
    const prev = process.env.TZ
    // +05:30: os minutos locais nunca coincidem com os de UTC
    process.env.TZ = 'Asia/Kolkata'
    try {
      const pad = (x) => String(x).padStart(2, '0')
      const local = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      const before = new Date()
      const stdout = fakeTTY({ isTTY: false })
      await runLive(fx('happy'), { stdout, stdin: { isTTY: false }, maxTicks: 1, intervalMs: 5 })
      const after = new Date()
      const m = stdout.chunks.join('').match(/atualizado (\d\d:\d\d:\d\d)/)
      assert.ok(m, 'esperava a linha de status')
      const ok = new Set()
      for (let t = before.getTime() - 1000; t <= after.getTime() + 1000; t += 500) ok.add(local(new Date(t)))
      assert.ok(ok.has(m[1]), `esperava hora local (${[...ok].join(', ')}), veio ${m[1]}`)
      assert.notEqual(m[1].slice(0, 5), before.toISOString().slice(11, 16))
    } finally {
      if (prev === undefined) delete process.env.TZ
      else process.env.TZ = prev
    }
  })
})
