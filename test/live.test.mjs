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

  test('um quadro novo só é escrito quando o texto muda (sem run-dir/journal mudando, 3 ticks -> 1 quadro)', async () => {
    const stdout = fakeTTY()
    await runLive(fx('happy'), { stdout, stdin: { isTTY: false }, maxTicks: 3, intervalMs: 5 })
    const frames = stdout.chunks.filter((c) => c.includes('\x1b[?2026h')).length
    assert.equal(frames, 1, 'o modelo não muda entre os ticks: só o 1º deveria desenhar')
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
})
