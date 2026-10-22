import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost as createHostImpl } from '../bin/hosts.mjs'
import { createIntegrityGuard } from '../bin/run-integrity.mjs'

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }

function createHost(options) {
  const fakeTransport = Boolean(options.transport)
  const killCalls = options.transport?.killCalls ?? []
  return createHostImpl({
    ...options,
    ...(fakeTransport && !options.killProcess ? { killProcess: (...args) => killCalls.push(args) } : {}),
  })
}

function fixtureSpawn(handler) {
  const calls = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.pid = 424242
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.input = ''
    child.kill = signal => { child.killed = signal; handler?.kill?.(child, signal) }
    child.stdin.on('data', chunk => { child.input += chunk })
    child.stdin.on('end', () => handler?.run?.(child, command, args, options))
    calls.push({ command, args, options, child })
    return child
  }
  return { spawn, calls }
}

async function tempRun(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graph-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function close(child, code = 0) {
  child.stdout.end()
  child.stderr.end()
  child.emit('close', code, null)
}

const execFileAsync = promisify(execFile)

function waitForText(stream, getText, expected, timeoutMs) {
  if (getText().includes(expected)) return Promise.resolve(true)
  return new Promise(resolve => {
    const onData = () => { if (getText().includes(expected)) finish(true) }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const finish = value => { clearTimeout(timer); stream.off('data', onData); stream.off('close', onClose); resolve(value) }
    const onClose = () => finish(getText().includes(expected))
    stream.on('data', onData)
    stream.once('close', onClose)
    if (getText().includes(expected)) finish(true)
  })
}

test('papéis canônicos e aliases selecionam modelo; capabilities não alegam disponibilidade', async t => {
  const runDir = await tempRun(t)
  const fake = fixtureSpawn({ run(child, command, args) { child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, is_error: false })); close(child) } })
  const host = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  const capabilities = host.capabilities()
  assert.equal(capabilities.readOnlyEnforced, true)
  assert.match(capabilities.readOnlyEnforcement, /Read, Glob e Grep/)
  assert.deepEqual(Object.keys(capabilities).sort(), ['agentShell', 'agentWeb', 'cancellation', 'cli', 'host', 'lifecycleEvents', 'modelAvailability', 'promptTransport', 'readOnlyEnforced', 'readOnlyEnforcement', 'roles', 'schemaTransport', 'structuredOutput'].sort())
  assert.equal(capabilities.agentShell, false, 'Claude não dá shell ao agente')
  for (const [role, model] of [['planner', 'sonnet'], ['planReviewer', 'opus'], ['plan-review', 'opus'], ['designReviewer', 'opus'], ['critic', 'sonnet'], ['researcher', 'sonnet'], ['designer', 'sonnet'], ['notetaker', 'haiku'], ['synth', 'haiku'], ['worker', 'haiku'], ['repair', 'haiku'], ['polish', 'haiku'], ['verifier', 'haiku'], ['verify', 'haiku']]) {
    await host.wait(await host.spawn({ role, prompt: 'x', schema }))
    assert.equal(fake.calls.at(-1).args[fake.calls.at(-1).args.indexOf('--model') + 1], model)
  }
})

test('pesquisa e design escritos pelo Sonnet e só leem; o Opus revisa o design', async t => {
  // Pedido do Douglas (21/10): Sonnet pesquisa, planeja e desenha; Opus só carimba plano e design; Haiku implementa.
  const runDir = await tempRun(t)
  const fake = fixtureSpawn({ run(child) { child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, is_error: false })); close(child) } })
  const host = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  for (const role of ['researcher', 'designer', 'notetaker']) {
    await host.wait(await host.spawn({ role, prompt: 'x', schema }))
    const args = fake.calls.at(-1).args
    assert.equal(args[args.indexOf('--tools') + 1].includes('Edit'), false, `${role} não pode escrever`)
  }
})

test('effort da chamada vira --effort do Claude Code; sem effort não há flag e valor fora da lista é recusado', async t => {
  // Regressão (xadrez, 21/10): o workflow pedia effort por chamada, mas o adaptador nunca o repassava ao CLI.
  const runDir = await tempRun(t)
  const fake = fixtureSpawn({ run(child) { child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, is_error: false })); close(child) } })
  const host = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  await host.wait(await host.spawn({ role: 'planReviewer', prompt: 'x', schema, effort: 'medium' }))
  const args = fake.calls.at(-1).args
  assert.equal(args[args.indexOf('--effort') + 1], 'medium')
  await host.wait(await host.spawn({ role: 'verifier', prompt: 'x', schema }))
  assert.equal(fake.calls.at(-1).args.includes('--effort'), false)
  await assert.rejects(host.spawn({ role: 'critic', prompt: 'x', schema, effort: 'turbo' }), error => error.code === 'INVALID_EFFORT')
})

test('agentShell: só o Codex dá shell ao agente; o valor chega como capability do transporte', async t => {
  const runDir = await tempRun(t)
  const codex = createHost({ host: 'codex', cwd: runDir, runDir, transport: { spawn: fixtureSpawn({ run() {} }).spawn } })
  assert.equal(codex.capabilities().agentShell, true)
  const claude = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: fixtureSpawn({ run() {} }).spawn } })
  assert.equal(claude.capabilities().agentShell, false)
  // Claude: só o researcher ganha WebSearch/WebFetch (fluxo adaptativo, estágio de pesquisa). Codex roda sem --search.
  assert.equal(claude.capabilities().agentWeb, true)
  assert.equal(codex.capabilities().agentWeb, false)
})

test('web só para o researcher no Claude; planner, designer e executor seguem sem web', async t => {
  const runDir = await tempRun(t)
  const fake = fixtureSpawn({ run(child) { child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, is_error: false })); close(child) } })
  const host = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  const toolsOf = async role => { await host.wait(await host.spawn({ role, prompt: 'x', schema })); const args = fake.calls.at(-1).args; return [args[args.indexOf('--tools') + 1], args[args.indexOf('--allowedTools') + 1]] }
  assert.deepEqual(await toolsOf('researcher'), ['Read,Glob,Grep,WebSearch,WebFetch', 'Read,Glob,Grep,WebSearch,WebFetch'])
  for (const role of ['planner', 'designer', 'notetaker', 'critic']) assert.deepEqual(await toolsOf(role), ['Read,Glob,Grep', 'Read,Glob,Grep'], role)
  const [executorTools] = await toolsOf('executor')
  assert.equal(executorTools.includes('Web'), false)
})

// B3: escrita do Claude sob diretório .claude é negada pelo Claude Code; o host recusa antes do spawn.
test('B3: papel de escrita do claude com cwd sob .claude dá CWD_PROTECTED_PATH sem spawn', async t => {
  const runDir = await tempRun(t)
  const cwd = path.join(runDir, '.claude', 'proj')
  await mkdir(cwd, { recursive: true })
  const fake = fixtureSpawn({ run(child) { child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, is_error: false })); close(child) } })
  const host = createHost({ host: 'claude', cwd, runDir, transport: { spawn: fake.spawn } })
  await assert.rejects(host.spawn({ role: 'executor', prompt: 'x', schema }), err => err.code === 'CWD_PROTECTED_PATH')
  assert.equal(fake.calls.length, 0, 'nenhum spawn antes da recusa')
})

test('B3: permission_denials do envelope do Claude é repassado como permissionDenials; vazio quando ausente', async t => {
  const runDir = await tempRun(t)
  const denial = { tool_name: 'Write', tool_input: { file_path: '/x' } }
  const fake = fixtureSpawn({ run(child) { child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, is_error: false, permission_denials: [denial] })); close(child) } })
  const host = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  const withDenial = await host.wait(await host.spawn({ role: 'executor', prompt: 'x', schema }))
  assert.deepEqual(withDenial.permissionDenials, [denial])
  const quiet = fixtureSpawn({ run(child) { child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, is_error: false })); close(child) } })
  const host2 = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: quiet.spawn } })
  const without = await host2.wait(await host2.spawn({ role: 'executor', prompt: 'x', schema }))
  assert.deepEqual(without.permissionDenials, [])
})

test('Claude usa JSON Schema estruturado, stdin literal e restringe reviewer a leitura', async t => {
  const runDir = await tempRun(t)
  const events = []
  const fake = fixtureSpawn({ run(child, command, args, options) {
    assert.equal(options.shell, false)
    assert.equal(options.detached, true)
    assert.equal(child.input, 'retorne literalmente $(touch /tmp/nope); `echo x`')
    child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, result: 'ignored', is_error: false }))
    close(child)
  } })
  const host = createHost({ host: 'claude', cwd: runDir, runDir, runId: 'run-test', transport: { spawn: fake.spawn }, onEvent: event => events.push(event) })
  const handle = await host.spawn({ role: 'planner', prompt: 'retorne literalmente $(touch /tmp/nope); `echo x`', schema })
  const call = fake.calls[0]
  assert.equal(call.command, 'claude')
  const wire = JSON.parse(call.args[call.args.indexOf('--json-schema') + 1])
  assert.deepEqual(wire.required, ['answer'])
  assert.equal(wire.additionalProperties, false)
  assert.deepEqual(call.args.slice(-2), ['--tools', 'Read,Glob,Grep'])
  assert.deepEqual(call.args.slice(call.args.indexOf('--permission-mode'), call.args.indexOf('--permission-mode') + 2), ['--permission-mode', 'dontAsk'])
  assert.deepEqual((await host.wait(handle)).output, { answer: 'ok' })
  assert.deepEqual(events.map(({ event }) => event), ['spawn', 'completed'])
  assert.ok(events.every(event => event.runId === 'run-test'))
  assert.deepEqual(events.map(event => event.seq), [1, 2])
})

// Regressão G-W (20/10/2026): com dontAsk e só --tools, o Claude real negava todo Edit/Write
// (permission_denials) e o executor nunca gravava. A escrita precisa de regra explícita presa ao cwd.
test('Claude libera escrita do executor só dentro do cwd e mantém papéis de leitura sem Edit', async t => {
  const runDir = await tempRun(t)
  const fake = fixtureSpawn({ run(child) {
    child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, result: 'ignored', is_error: false }))
    close(child)
  } })
  const host = createHost({ host: 'claude', cwd: runDir, runDir, runId: 'run-test', transport: { spawn: fake.spawn } })
  await host.wait(await host.spawn({ role: 'executor', prompt: 'grave', schema }))
  await host.wait(await host.spawn({ role: 'planner', prompt: 'leia', schema }))
  const [writer, reader] = fake.calls
  const allowed = call => call.args[call.args.indexOf('--allowedTools') + 1]
  assert.ok(writer.args.includes('--allowedTools'), 'executor sem --allowedTools tem Edit/Write negados pelo dontAsk')
  assert.equal(allowed(writer), 'Read,Glob,Grep,Edit(./**)')
  assert.equal(writer.args[writer.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write')
  assert.equal(writer.options.cwd, runDir)
  assert.equal(allowed(reader), 'Read,Glob,Grep')
  assert.ok(!reader.args.some(arg => /Edit|Write/.test(arg)))
})

// Regressão de custo (benchmark real de 20/10/2026, US$ 88): cada `claude -p` herdava os MCPs, plugins,
// skills e settings do usuário (~75k tokens de contexto por turno, ~1M por chamada). O agente roda isolado.
test('Claude roda isolado do ambiente do usuário: sem MCP, sem skills e sem settings de usuário', async t => {
  const runDir = await tempRun(t)
  const fake = fixtureSpawn({ run(child) {
    child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, result: 'ignored', is_error: false }))
    close(child)
  } })
  const host = createHost({ host: 'claude', cwd: runDir, runDir, runId: 'run-test', transport: { spawn: fake.spawn } })
  for (const role of ['executor', 'planner']) await host.wait(await host.spawn({ role, prompt: 'x', schema }))
  for (const { args } of fake.calls) {
    assert.ok(args.includes('--strict-mcp-config'), 'sem --strict-mcp-config o agente carrega os MCPs do usuário')
    assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}')
    assert.ok(args.includes('--disable-slash-commands'))
    assert.equal(args[args.indexOf('--setting-sources') + 1], 'project,local')
  }
})

test('Codex torna schema strict recursivo e remove nulls só de campos opcionais', async t => {
  const runDir = await tempRun(t)
  const planSchema = {
    type: 'object', required: ['goal', 'nodes'], properties: {
      goal: { type: 'string' }, mode: { enum: ['implement', 'research'] },
      nodes: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, maybe: { type: ['string', 'null'] } } } },
    },
  }
  const fake = fixtureSpawn({ async run(child, command, args) {
    const schemaPath = args[args.indexOf('--output-schema') + 1]
    const outputPath = args[args.indexOf('--output-last-message') + 1]
    const wire = JSON.parse(await readFile(schemaPath, 'utf8'))
    assert.deepEqual(wire.required, ['goal', 'mode', 'nodes'])
    assert.equal(wire.additionalProperties, false)
    assert.deepEqual(wire.properties.mode.anyOf.map(item => item.type), ['string', 'null'])
    assert.deepEqual(wire.properties.nodes.items.required, ['id', 'files', 'maybe'])
    assert.equal(wire.properties.nodes.items.additionalProperties, false)
    await writeFile(outputPath, JSON.stringify({ goal: 'x', mode: null, nodes: [{ id: 'a', files: null, maybe: null }] }))
    child.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
    close(child)
  } })
  const host = createHost({ host: 'codex', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  const handle = await host.spawn({ role: 'planner', prompt: 'planejar' , schema: planSchema })
  const { args, options } = fake.calls[0]
  assert.equal(options.shell, false)
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-6.1-sol')
  assert.equal(args[args.indexOf('-s') + 1], 'read-only')
  assert.equal(host.capabilities().readOnlyEnforced, process.platform !== 'win32')
  if (host.capabilities().readOnlyEnforced) assert.match(host.capabilities().readOnlyEnforcement, /-s read-only/)
  assert.equal(args.at(-1), '-')
  const result = await host.wait(handle)
  assert.deepEqual(result.output, { goal: 'x', nodes: [{ id: 'a', maybe: null }] })
  assert.equal(result.requestedModel, 'gpt-6.1-sol')
  assert.equal(result.effectiveModel, null)
})

test('Codex worker usa Luna e readOnly restringe permissão; cwd divergente/writeScope falham', async t => {
  const runDir = await tempRun(t)
  const fake = fixtureSpawn({ async run(child, command, args) {
    await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ answer: child.input }))
    child.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
    close(child)
  } })
  const host = createHost({ host: 'codex', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  const prompt = 'texto $(echo nope); `x`'
  const handle = await host.spawn({ role: 'executor', prompt, schema, readOnly: true })
  const { args, options } = fake.calls[0]
  assert.equal(options.shell, false)
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-luna')
  assert.equal(args[args.indexOf('-s') + 1], 'read-only')
  assert.equal(args.at(-1), '-')
  assert.equal(fake.calls[0].child.input, prompt)
  assert.deepEqual((await host.wait(handle)).output, { answer: prompt })
  await assert.rejects(host.spawn({ role: 'worker', prompt, schema, cwd: '/wrong/path' }), { code: 'CWD_MISMATCH' })
  await assert.rejects(host.spawn({ role: 'worker', prompt, schema, writeScope: ['x.js'] }), { code: 'UNSUPPORTED_WRITE_SCOPE' })
})

test('validação semântica contempla anyOf, type unions, enums e limites de array; desconhecido falha fechado', async t => {
  const runDir = await tempRun(t)
  const checkSchema = { type: 'object', required: ['status', 'items'], properties: { status: { enum: ['ok', 'blocked'] }, items: { type: ['array', 'null'], minItems: 1, maxItems: 2, items: { anyOf: [{ type: 'string' }, { type: 'integer' }] } } } }
  const fake = fixtureSpawn({ async run(child, command, args) {
    await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ status: 'ok', items: ['a', 2] }))
    child.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
    close(child)
  } })
  const host = createHost({ host: 'codex', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  const valid = await host.spawn({ role: 'verifier', prompt: 'verificar', schema: checkSchema })
  assert.deepEqual((await host.wait(valid)).output, { status: 'ok', items: ['a', 2] })
  const invalidFake = fixtureSpawn({ async run(child, command, args) {
    await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ status: 'ok', items: [] }))
    child.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
    close(child)
  } })
  const invalidHost = createHost({ host: 'codex', cwd: runDir, runDir, transport: { spawn: invalidFake.spawn } })
  await assert.rejects(invalidHost.wait(await invalidHost.spawn({ role: 'verifier', prompt: 'verificar', schema: checkSchema })), { code: 'INVALID_OUTPUT' })
  await assert.rejects(host.spawn({ role: 'verifier', prompt: 'x', schema: { type: 'string', format: 'date-time' } }), { code: 'UNSUPPORTED_SCHEMA' })
  await assert.rejects(host.spawn({ role: 'verifier', prompt: ' ', schema }), { code: 'INVALID_PROMPT' })
  await assert.rejects(host.spawn({ role: 'verifier', prompt: 'x', schema, timeoutMs: 0 }), { code: 'INVALID_TIMEOUT' })
})

test('object rejeita array e anyOf ainda respeita restrições irmãs', async t => {
  const runDir = await tempRun(t)
  const outputs = [[], 'inválido']
  const schemas = [
    { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    { type: 'string', enum: ['ok'], anyOf: [{ type: 'string' }, { type: 'null' }] },
  ]
  for (let index = 0; index < schemas.length; index++) {
    const fake = fixtureSpawn({ run(child) {
      child.stdout.write(JSON.stringify({ structured_output: outputs[index], is_error: false }))
      close(child)
    } })
    const host = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
    const handle = await host.spawn({ role: 'verifier', prompt: 'validar', schema: schemas[index] })
    await assert.rejects(host.wait(handle), { code: 'INVALID_OUTPUT' })
  }
})

test('Codex não aceita turn.failed mesmo com exit 0; modelo arbitrário não é aceito', async t => {
  const runDir = await tempRun(t)
  const fake = fixtureSpawn({ async run(child, command, args) {
    await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ answer: 'não deve ser aceito' }))
    child.stdout.write(`${JSON.stringify({ type: 'turn.failed', error: { message: 'model unavailable' } })}\n`)
    close(child, 0)
  } })
  const host = createHost({ host: 'codex', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  await assert.rejects(host.spawn({ role: 'critic', prompt: 'x', schema, model: 'outro' }), { code: 'MODEL_MISMATCH' })
  const handle = await host.spawn({ role: 'critic', prompt: 'x', schema })
  await assert.rejects(host.wait(handle), { code: 'MODEL_UNAVAILABLE' })
  assert.equal(fake.calls.length, 1)
})

test('Claude rejeita is_error mesmo com exit 0 e valida saída estruturada', async t => {
  const runDir = await tempRun(t)
  const fake = fixtureSpawn({ run(child) { child.stdout.write(JSON.stringify({ is_error: true, result: 'authentication failed' })); close(child) } })
  const host = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  const handle = await host.spawn({ role: 'executor', prompt: 'x', schema })
  await assert.rejects(host.wait(handle), { code: 'AUTH_FAILED' })
})

test('regressão: is_error do Claude sem result preserva subtype, errors, uso e modelo no erro', async t => {
  const runDir = await tempRun(t)
  const modelUsage = { 'claude-haiku-5-5': { inputTokens: 4, outputTokens: 9, costUSD: 0.001 } }
  const envelope = { is_error: true, subtype: 'error_max_structured_output_retries', errors: ['schema mismatch'], modelUsage, permission_denials: [{ tool_name: 'Write' }] }
  for (const code of [0, 1]) {
    const fake = fixtureSpawn({ run(child) { child.stdout.write(JSON.stringify(envelope)); close(child, code) } })
    const host = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
    const error = await host.wait(await host.spawn({ role: 'executor', prompt: 'x', schema })).then(() => null, e => e)
    assert.equal(error?.code, 'CLI_FAILED')
    assert.match(error.message, /error_max_structured_output_retries/)
    assert.match(error.message, /schema mismatch/)
    assert.equal(error.subtype, 'error_max_structured_output_retries')
    assert.deepEqual(error.usage, modelUsage)
    assert.equal(error.effectiveModel, 'claude-haiku-5-5')
    assert.deepEqual(error.permissionDenials, [{ tool_name: 'Write' }])
  }
})

test('classifica autenticação e modelo a partir do envelope de erro com exit não zero', async t => {
  const runDir = await tempRun(t)
  const claudeFake = fixtureSpawn({ run(child) {
    child.stdout.write(JSON.stringify({ is_error: true, result: 'Your organization has disabled Claude subscription access; API key authentication is unavailable.' }))
    close(child, 1)
  } })
  const claude = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: claudeFake.spawn } })
  await assert.rejects(claude.wait(await claude.spawn({ role: 'executor', prompt: 'x', schema })), { code: 'AUTH_FAILED' })

  const codexFake = fixtureSpawn({ run(child) {
    child.stdout.write(`${JSON.stringify({ type: 'turn.failed', error: { message: 'model unknown' } })}\n`)
    close(child, 1)
  } })
  const codex = createHost({ host: 'codex', cwd: runDir, runDir, transport: { spawn: codexFake.spawn } })
  await assert.rejects(codex.wait(await codex.spawn({ role: 'planReviewer', prompt: 'x', schema })), { code: 'MODEL_UNAVAILABLE' })
})

test('JSONL com valor null em exit não zero rejeita e limpa temporários', async t => {
  const runDir = await tempRun(t)
  const fake = fixtureSpawn({ run(child) {
    child.stdout.write('null\n')
    close(child, 1)
  } })
  const host = createHost({ host: 'codex', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  const handle = await host.spawn({ role: 'planReviewer', prompt: 'x', schema })
  await assert.rejects(host.wait(handle), { code: 'CLI_FAILED' })
  assert.deepEqual(await readdir(runDir), [])
})

test('saída natural só completa depois de drenar neto resistente a TERM', { timeout: 10000 }, async t => {
  if (process.platform === 'win32') return t.skip('teste de grupo POSIX')
  const runDir = await tempRun(t)
  const events = []
  const childScript = "process.on('SIGTERM',()=>{});process.send('ready');process.stdin.resume();setInterval(()=>{},1000)"
  const commandTransform = ({ args, cwd }) => {
    const outputPath = args[args.indexOf('--output-last-message') + 1]
    const parentScript = `const {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:['ignore','inherit','inherit','ipc']});child.on('message',()=>{process.stderr.write('x'.repeat(600000),()=>{process.stderr.write('GRAPH_HOST_GRANDCHILD_READY\\n');fs.writeFileSync(${JSON.stringify(outputPath)},JSON.stringify({answer:'preservado'}));process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n',()=>process.exit(0))})});setInterval(()=>{},1000)`
    return { command: process.execPath, args: ['-e', parentScript], cwd }
  }
  const host = createHostImpl({ host: 'codex', cwd: runDir, runDir, commandTransform, onEvent: event => { events.push(event); throw new Error('observability failure') } })
  let handle
  try {
    handle = await host.spawn({ role: 'executor', prompt: 'x', schema })
    const pid = handle.child.pid
    assert.equal(await waitForText(handle.child.stderr, () => handle.stderr, 'GRAPH_HOST_GRANDCHILD_READY', 3000), true)
    const finalizeDeadline = Date.now() + 1000
    while (!handle.finalizing && Date.now() < finalizeDeadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(handle.finalizing, true)
    assert.equal(host.cancel(handle), false)
    const result = await host.wait(handle)
    assert.deepEqual(result.output, { answer: 'preservado' })
    assert.equal(result.exitCode, 0)
    assert.deepEqual(events.map(event => event.event), ['spawn', 'completed'])
    await assertProcessGroupGone(pid)
  } finally {
    if (handle) {
      host.cancel(handle)
      await host.wait(handle).catch(() => {})
    }
  }
})

test('falhas AUTH_FAILED e INVALID_OUTPUT preservam código após drenar descendentes', { timeout: 15000 }, async t => {
  if (process.platform === 'win32') return t.skip('teste de grupo POSIX')
  const runDir = await tempRun(t)
  const resistantChild = "process.on('SIGTERM',()=>{});process.send('ready');process.stdin.resume();setInterval(()=>{},1000)"
  for (const scenario of ['auth', 'invalid']) {
    const hostName = scenario === 'auth' ? 'claude' : 'codex'
    const commandTransform = ({ args, cwd }) => {
      const outputPath = args[args.indexOf('--output-last-message') + 1]
      const body = scenario === 'auth'
        ? `process.stdout.write(${JSON.stringify(JSON.stringify({ is_error: true, result: 'authentication failed' }))})`
        : `require('node:fs').writeFileSync(${JSON.stringify(outputPath)},JSON.stringify({answer:17}));process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n')`
      const parentScript = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',${JSON.stringify(resistantChild)}],{stdio:['ignore','ignore','ignore','ipc']});child.on('message',()=>{process.stderr.write('GRAPH_HOST_ERROR_READY\\n');${body};setTimeout(()=>process.exit(0),20)});setInterval(()=>{},1000)`
      return { command: process.execPath, args: ['-e', parentScript], cwd }
    }
    const host = createHostImpl({ host: hostName, cwd: runDir, runDir, commandTransform })
    let handle
    try {
      handle = await host.spawn({ role: 'executor', prompt: 'x', schema })
      const pid = handle.child.pid
      assert.equal(await waitForText(handle.child.stderr, () => handle.stderr, 'GRAPH_HOST_ERROR_READY', 3000), true)
      await assert.rejects(host.wait(handle), { code: scenario === 'auth' ? 'AUTH_FAILED' : 'INVALID_OUTPUT' })
      await assertProcessGroupGone(pid)
    } finally {
      if (handle) {
        host.cancel(handle)
        await host.wait(handle).catch(() => {})
      }
    }
  }
})

test('CLI ausente e falha síncrona de spawn limpam temporários e não fazem fallback', async t => {
  const runDir = await tempRun(t)
  const missing = fixtureSpawn({ run() { const err = new Error('missing'); err.code = 'ENOENT'; missing.calls[0].child.emit('error', err) } })
  const claude = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: missing.spawn } })
  const absent = await claude.spawn({ role: 'executor', prompt: 'x', schema })
  await assert.rejects(claude.wait(absent), { code: 'CLI_MISSING' })
  assert.equal(missing.calls.length, 1)
  const broken = createHost({ host: 'codex', cwd: runDir, runDir, transport: { spawn() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } } })
  await assert.rejects(broken.spawn({ role: 'executor', prompt: 'x', schema }), { code: 'CLI_MISSING' })
})

async function assertProcessGroupGone(pid) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pgid=,stat='], { timeout: 1000, maxBuffer: 256 * 1024 })
  const active = stdout.split(/\r?\n/).some(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/)
    return match?.[2] === String(pid) && !match[3].startsWith('Z')
  })
  assert.equal(active, false)
}

test('stdout final em múltiplos chunks chega inteiro antes da saída natural e preserva AUTH_FAILED', { timeout: 15000 }, async t => {
  if (process.platform === 'win32') return t.skip('teste de grupo POSIX')
  const runDir = await tempRun(t)
  const largeValue = 'x'.repeat(2 * 1024 * 1024)
  for (const scenario of ['success', 'auth']) {
    const envelope = scenario === 'success'
      ? { is_error: false, structured_output: { answer: largeValue } }
      : { is_error: true, result: `${largeValue} authentication failed` }
    const scriptPath = path.join(runDir, `large-${scenario}.mjs`)
    await writeFile(scriptPath, `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))},()=>process.exit(0))`)
    const commandTransform = ({ cwd }) => ({ command: process.execPath, args: [scriptPath], cwd })
    const host = createHostImpl({ host: 'claude', cwd: runDir, runDir, commandTransform })
    let handle
    try {
      handle = await host.spawn({ role: 'executor', prompt: 'x', schema })
      const pid = handle.child.pid
      if (scenario === 'success') {
        const result = await host.wait(handle)
        assert.equal(result.output.answer.length, largeValue.length)
        assert.equal(result.output.answer, largeValue)
        assert.equal(result.exitCode, 0)
      } else {
        await assert.rejects(host.wait(handle), { code: 'AUTH_FAILED' })
      }
      await assertProcessGroupGone(pid)
    } finally {
      if (handle) {
        host.cancel(handle)
        await host.wait(handle).catch(() => {})
      }
    }
  }
})

test('cancel e timeout encerram netos do processo próprio e estabilizam wait', { timeout: 10000 }, async t => {
  if (process.platform === 'win32') return t.skip('teste de grupo POSIX')
  const runDir = await tempRun(t)
  const childScript = "process.on('SIGTERM',()=>{});process.send('ready');process.stdin.resume();setInterval(()=>{},1000)"
  const commandTransform = ({ args, cwd }) => {
    const outputPath = args[args.indexOf('--output-last-message') + 1]
    const parentScript = `const {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:['ignore','ignore','ignore','ipc']});child.on('message',()=>{process.stderr.write('GRAPH_HOST_GRANDCHILD_READY\\n');fs.writeFileSync(${JSON.stringify(outputPath)},JSON.stringify({answer:'ok'}));process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n')});setInterval(()=>{},1000)`
    return { command: process.execPath, args: ['-e', parentScript], cwd }
  }
  for (const reason of ['cancel', 'timeout']) {
    const events = []
    const host = createHostImpl({ host: 'codex', cwd: runDir, runDir, commandTransform, onEvent: event => events.push(event), timeoutMs: 1500 })
    let handle
    try {
      handle = await host.spawn({ role: 'executor', prompt: 'x', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } })
      // The ready handshake proves the resistant grandchild joined the sentinel's group.
      assert.equal(await waitForText(handle.child.stderr, () => handle.stderr, 'GRAPH_HOST_GRANDCHILD_READY', 3000), true)
      const pid = handle.child.pid
      if (reason === 'cancel') {
        assert.equal(host.cancel(handle), true)
        assert.equal(host.cancel(handle), true)
      }
      await assert.rejects(host.wait(handle), { code: reason === 'cancel' ? 'CANCELLED' : 'TIMEOUT' })
      assert.equal(events.filter(event => event.event === (reason === 'cancel' ? 'cancelling' : 'terminating')).length, 1)
      await assertProcessGroupGone(pid)
    } finally {
      if (handle) {
        host.cancel(handle)
        await host.wait(handle).catch(() => {})
      }
    }
  }
})

test('cancel com limpeza falha rejeita CANCELLED marcado drainUnproven', { timeout: 10000 }, async t => {
  if (process.platform === 'win32') return t.skip('teste de grupo POSIX')
  const runDir = await tempRun(t)
  const childScript = "process.stderr.write('GRAPH_HOST_CLEANUP_READY\\n');setInterval(()=>{},1000)"
  const commandTransform = ({ args, cwd }) => {
    // A directory where the output file should be makes rm(file) fail at cleanup.
    const outputPath = args[args.indexOf('--output-last-message') + 1]
    mkdirSync(outputPath)
    writeFileSync(path.join(outputPath, 'blocker'), '')
    return { command: process.execPath, args: ['-e', childScript], cwd }
  }
  const host = createHostImpl({ host: 'codex', cwd: runDir, runDir, commandTransform, timeoutMs: 5000 })
  let handle
  try {
    handle = await host.spawn({ role: 'executor', prompt: 'x', schema })
    assert.equal(await waitForText(handle.child.stderr, () => handle.stderr, 'GRAPH_HOST_CLEANUP_READY', 3000), true)
    assert.equal(host.cancel(handle), true)
    await assert.rejects(host.wait(handle), error => {
      assert.equal(error.code, 'CANCELLED')
      assert.equal(error.drainUnproven, true)
      assert.ok(error.cleanupErrors?.length >= 1)
      return true
    })
  } finally {
    if (handle) {
      host.cancel(handle)
      await host.wait(handle).catch(() => {})
    }
  }
})

// C14: arquivos de transporte do codex (.host-<id>.schema.json e .host-<id>.output.json) são efêmeros ativos exatos do handle.
async function transportFixture(t, run) {
  const runDir = await tempRun(t)
  const guard = createIntegrityGuard({ root: runDir, scope: 'tree' })
  await guard.install()
  const fake = fixtureSpawn({ run: (child, command, args) => run({ child, args, guard, runDir }) })
  const host = createHostImpl({ host: 'codex', cwd: runDir, runDir, transport: { spawn: fake.spawn }, killProcess: () => {}, onTransportPaths: ({ files, phase }) => (phase === 'created' ? guard.registerEphemeral(files) : guard.releaseEphemeral(files)) })
  return { runDir, guard, host }
}

const outputPathOf = args => args[args.indexOf('--output-last-message') + 1]
const schemaPathOf = args => args[args.indexOf('--output-schema') + 1]
const finishWith = (child, text) => { child.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`); close(child) }

test('C14: transporte do codex não dá falso positivo durante o agente e não sobra depois', async t => {
  let midRun = null
  const { runDir, guard, host } = await transportFixture(t, async ({ child, args }) => {
    midRun = await guard.assertIntegrity().then(() => 'ok', error => error)
    await writeFile(outputPathOf(args), JSON.stringify({ answer: 'ok' }))
    finishWith(child)
  })
  const handle = await host.spawn({ role: 'executor', prompt: 'p', schema, readOnly: true })
  assert.deepEqual((await host.wait(handle)).output, { answer: 'ok' })
  assert.equal(midRun, 'ok', String(midRun?.message ?? midRun))
  await guard.assertIntegrity()
  assert.deepEqual((await readdir(runDir)).filter(name => name.startsWith('.host-')), [])
})

test('C14: schema de transporte alterado durante o handle bloqueia a limpeza com TRANSPORT_SCHEMA_CHANGED', async t => {
  const { host } = await transportFixture(t, async ({ child, args }) => {
    await writeFile(schemaPathOf(args), '{"tampered":true}\n')
    await writeFile(outputPathOf(args), JSON.stringify({ answer: 'ok' }))
    finishWith(child)
  })
  const handle = await host.spawn({ role: 'executor', prompt: 'p', schema, readOnly: true })
  await assert.rejects(host.wait(handle), error => error.code === 'CLEANUP_FAILED' && JSON.stringify(error.cleanupErrors ?? error.errors ?? []).includes('TRANSPORT_SCHEMA_CHANGED'), 'schema trocado precisa falhar fechado')
})

test('C14: output com id de outro handle fica fora dos efêmeros e bloqueia no assert', async t => {
  const otherName = '.host-00000000-0000-4000-8000-000000000000.output.json'
  const { runDir, guard, host } = await transportFixture(t, async ({ child, args }) => {
    await writeFile(path.join(runDir, otherName), JSON.stringify({ answer: 'alheio' }))
    await writeFile(outputPathOf(args), JSON.stringify({ answer: 'ok' }))
    finishWith(child)
  })
  const handle = await host.spawn({ role: 'executor', prompt: 'p', schema, readOnly: true })
  assert.deepEqual((await host.wait(handle)).output, { answer: 'ok' })
  await assert.rejects(guard.assertIntegrity(), error => error.code === 'run_integrity_violation' && error.paths.includes(otherName))
})

test('C14: output trocado por symlink bloqueia a leitura com TRANSPORT_OUTPUT_UNSAFE', async t => {
  const outside = `${await tempRun(t)}-outside.json`
  await writeFile(outside, JSON.stringify({ answer: 'fora' }))
  t.after(() => rm(outside, { force: true }))
  const { host } = await transportFixture(t, async ({ child, args }) => {
    await symlink(outside, outputPathOf(args))
    finishWith(child)
  })
  const handle = await host.spawn({ role: 'executor', prompt: 'p', schema, readOnly: true })
  await assert.rejects(host.wait(handle), error => error.code === 'TRANSPORT_OUTPUT_UNSAFE')
})

test('C14: .host-* sobrando depois do cleanup bloqueia no assert', async t => {
  const { runDir, guard, host } = await transportFixture(t, async ({ child, args }) => {
    await writeFile(path.join(runDir, `${path.basename(schemaPathOf(args))}.leftover`), 'sobra\n')
    await writeFile(outputPathOf(args), JSON.stringify({ answer: 'ok' }))
    finishWith(child)
  })
  const handle = await host.spawn({ role: 'executor', prompt: 'p', schema, readOnly: true })
  await host.wait(handle).catch(() => {})
  await assert.rejects(guard.assertIntegrity(), error => error.code === 'run_integrity_violation' && error.paths.some(name => name.startsWith('.host-') && name.endsWith('.leftover')))
})


test('C14 FIX4: falha ao gravar o schema do codex remove o que sobrou e solta o efêmero', async t => {
  const runDir = await tempRun(t)
  const guard = createIntegrityGuard({ root: runDir, scope: 'tree' })
  await guard.install()
  const host = createHostImpl({
    host: 'codex', cwd: runDir, runDir,
    transport: { spawn: () => { throw new Error('não deve spawnar: o schema falhou antes') } },
    killProcess: () => {},
    // O caminho do schema vira diretório logo depois do registro: o writeFile falha e o efêmero não pode continuar ativo.
    onTransportPaths: async ({ files, phase }) => {
      if (phase === 'created') { await guard.registerEphemeral(files); await mkdir(path.join(runDir, files[0])) }
      else await guard.releaseEphemeral(files)
    },
  })
  await assert.rejects(host.spawn({ role: 'executor', prompt: 'p', schema, readOnly: true }))
  const schemaName = (await readdir(runDir)).find(name => name.startsWith('.host-') && name.endsWith('.schema.json'))
  assert.ok(schemaName, 'o diretório plantado precisa existir na runDir')
  await assert.rejects(guard.assertIntegrity(), error => error.code === 'run_integrity_violation' && error.paths.includes(schemaName))
})

// Fluxo advisor (benchmark Minecraft, 22/10): o executor contínuo roda no Sonnet com o Opus de advisor na mesma
// sessão e ganha Bash só nos comandos do gate. O executor do grafo segue no Haiku, sem advisor e sem shell.
test('advisedExecutor Claude roda no Sonnet com --advisor opus; executor e papéis do grafo não têm advisor', async t => {
  const runDir = await tempRun(t)
  const fake = fixtureSpawn({ run(child) { child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, is_error: false, session_id: 'sess-1' })); close(child) } })
  const host = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  const result = await host.wait(await host.spawn({ role: 'advisedExecutor', prompt: 'x', schema }))
  const args = fake.calls.at(-1).args
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet')
  assert.equal(args[args.indexOf('--advisor') + 1], 'opus')
  assert.equal(result.sessionId, 'sess-1')
  for (const role of ['executor', 'planner', 'planReviewer', 'verifier', 'critic', 'synth', 'researcher']) {
    await host.wait(await host.spawn({ role, prompt: 'x', schema }))
    assert.equal(fake.calls.at(-1).args.includes('--advisor'), false, role)
  }
  const graphExecutor = fake.calls.at(-7).args
  assert.equal(graphExecutor[graphExecutor.indexOf('--model') + 1], 'haiku')
})

test('executor de escrita ganha Bash só nos comandos aprovados; leitura e papéis de revisão seguem sem shell', async t => {
  const runDir = await tempRun(t)
  const fake = fixtureSpawn({ run(child) { child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, is_error: false })); close(child) } })
  const host = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  const argsOf = async request => { await host.wait(await host.spawn({ prompt: 'x', schema, ...request })); const a = fake.calls.at(-1).args; return { tools: a[a.indexOf('--tools') + 1], allowed: a[a.indexOf('--allowedTools') + 1] } }
  const writer = await argsOf({ role: 'advisedExecutor', allowCommands: ['npm test', 'npm run build'] })
  assert.equal(writer.tools, 'Read,Glob,Grep,Edit,Write,Bash')
  assert.equal(writer.allowed, 'Read,Glob,Grep,Edit(./**),Bash(npm test),Bash(npm run build)')
  assert.equal((await argsOf({ role: 'advisedExecutor', readOnly: true, allowCommands: ['npm test'] })).tools.includes('Bash'), false)
  assert.equal((await argsOf({ role: 'verifier', allowCommands: ['npm test'] })).tools.includes('Bash'), false)
  assert.equal((await argsOf({ role: 'executor' })).tools, 'Read,Glob,Grep,Edit,Write')
})

test('allowCommands com metacaractere de shell, quebra de linha, curinga ou vazio é recusado antes do spawn', async t => {
  const runDir = await tempRun(t)
  const fake = fixtureSpawn({ run(child) { child.stdout.write(JSON.stringify({ structured_output: { answer: 'ok' }, is_error: false })); close(child) } })
  const host = createHost({ host: 'claude', cwd: runDir, runDir, transport: { spawn: fake.spawn } })
  for (const bad of [['npm test; touch x'], ['npm test && echo x'], ['npm test | cat'], ['echo $(id)'], ['npm\ntest'], [''], ['npm test *'], ['npm test > out'], 'npm test']) {
    await assert.rejects(host.spawn({ role: 'advisedExecutor', prompt: 'x', schema, allowCommands: bad }), error => error.code === 'INVALID_ALLOW_COMMANDS', JSON.stringify(bad))
  }
  assert.equal(fake.calls.length, 0)
})
