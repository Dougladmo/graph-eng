// Testes do modo `agent <nó>` (§6.7, §8.2 item 12 é do motor — aqui só o graph-watch).
// Usa uma fixture sintética própria e isolada (tmpdir), para não depender de qual transcript
// existe em qual fixture compartilhada com outros arquivos de teste.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildAgentView, GraphWatchError } from '../bin/graph-watch.mjs'

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-agent-'))
  const journal = [
    { type: 'launched' },
    { type: 'started', key: 'k1', agentId: 'ag0001', label: 'verify:X', phase: 'Verify' },
    {
      type: 'result',
      key: 'k1',
      agentId: 'ag0001',
      result: { pass: false, confidence: 'high', blocking: [{ issue: 'bloqueio de exemplo', where: 'arquivo.js', evidence: 'ev', fix: 'corrigir' }] },
    },
  ]
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), journal.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const transcript = [
    { type: 'assistant', timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo oi', description: 'roda exemplo' } }] } },
    { type: 'user', timestamp: '2026-01-01T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'saída' }] } },
    { type: 'assistant', timestamp: '2026-01-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } },
    { type: 'assistant', timestamp: '2026-01-01T10:00:06.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'StructuredOutput', input: { pass: false } }] } },
  ]
  fs.writeFileSync(path.join(dir, 'agent-ag0001.jsonl'), transcript.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return dir
}

describe('buildAgentView (§6.7)', () => {
  test('nó com transcrição: cabeçalho, tool calls, veredito e contagem de thinking vazio', () => {
    const dir = makeFixture()
    const view = buildAgentView(dir, 'verify:X', 8)
    assert.match(view.text, /verify:X · agente ag0001 · terminou · 2 tool calls/)
    assert.match(view.text, /Bash  roda exemplo/)
    assert.match(view.text, /veredito: REPROVOU \(confiança high\) · 1 bloqueio\(s\)/)
    assert.match(view.text, /bloqueio de exemplo/)
    assert.match(view.text, /raciocínio: 2 bloco\(s\) de thinking, 2 gravado\(s\) vazio\(s\)/)
    assert.equal(view.notStarted, false)
  })

  test('busca por id curto casa com ":<id>" no fim do label', () => {
    const dir = makeFixture()
    const view = buildAgentView(dir, 'X', 8)
    assert.match(view.text, /verify:X/)
  })

  test('nó que nunca começou: sem erro, texto claro, notStarted true', () => {
    const dir = makeFixture()
    const view = buildAgentView(dir, 'Y', 8)
    assert.match(view.text, /nó Y ainda não começou/)
    assert.equal(view.notStarted, true)
  })

  test('sem transcript para o agentId: GraphWatchError(4)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-agent-notr-'))
    fs.writeFileSync(
      path.join(dir, 'journal.jsonl'),
      JSON.stringify({ type: 'started', key: 'k1', agentId: 'semtranscript', label: 'work:Z', phase: 'Execute' }) + '\n',
    )
    assert.throws(() => buildAgentView(dir, 'Z', 8), (err) => err instanceof GraphWatchError && err.code === 4)
  })

  test('limite -n corta para as últimas N tool calls', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-watch-agent-many-'))
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify({ type: 'started', key: 'k1', agentId: 'ag2', label: 'work:M', phase: 'Execute' }) + '\n')
    const calls = Array.from({ length: 5 }, (_, i) => ({
      type: 'assistant',
      timestamp: `2026-01-01T10:00:0${i}.000Z`,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `cmd${i}` } }] },
    }))
    fs.writeFileSync(path.join(dir, 'agent-ag2.jsonl'), calls.map((e) => JSON.stringify(e)).join('\n') + '\n')
    const view = buildAgentView(dir, 'M', 2)
    assert.match(view.text, /5 tool calls/)
    assert.match(view.text, /últimas 2 tool calls:/)
    assert.doesNotMatch(view.text, /cmd0/)
    assert.match(view.text, /cmd4/)
  })
})
