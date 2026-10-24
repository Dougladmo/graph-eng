import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const json = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'))

test('manifests preservam identidade e versão semver sincronizadas', async () => {
  const [portable, codex, claude] = await Promise.all([json('plugin.json'), json('.codex-plugin/plugin.json'), json('.claude-plugin/plugin.json')])
  assert.deepEqual([portable.name, codex.name, claude.name], ['graph-eng', 'graph-eng', 'graph-eng'])
  assert.equal(portable.version, '1.3.0')
  assert.equal(codex.version, portable.version)
  assert.equal(claude.version, portable.version)
  assert.match(portable.version, /^\d+\.\d+\.\d+$/)
  const iface = portable.extensions['com.openai'].interface
  assert.ok(iface.shortDescription.length <= 30)
  assert.equal(codex.interface.shortDescription, iface.shortDescription)
  assert.equal(codex.interface.defaultPrompt, iface.defaultPrompt)
  for (const forbidden of ['skills', 'mcpServers', 'apps', 'interface']) assert.equal(Object.hasOwn(portable, forbidden), false)
})

test('skill portátil tem nome correspondente à pasta e descreve só o fluxo advisor', async () => {
  const skill = await readFile(path.join(root, 'skills/grapheng/SKILL.md'), 'utf8')
  assert.match(skill, /^---\s*\nname: grapheng\n/)
  assert.match(skill, /\/graph-eng:grapheng/)
  assert.match(skill, /use o nome da skill que o cliente mostra \(ex\.: `graph-eng:grapheng`\)/)
  assert.doesNotMatch(skill, /Codex `\$grapheng/)
  for (const command of ['plan', 'implemente']) assert.match(skill, new RegExp(`\`${command}`))
  for (const flag of ['--effort low|medium|max', '--haiku-max low|medium|off', 'advisor-plan.json', 'advisor_plan_missing', 'advisor_gate_missing_test']) assert.ok(skill.includes(flag), flag)
  // O motor de grafo saiu na 1.3.0: nada de clarify, tasks, init, painel ou --adaptive.
  assert.doesNotMatch(skill, /`(clarify|tasks|init)`|--adaptive|--flow|painel|DESIGN\.md|needs_clarification/)
  await assert.rejects(access(path.join(root, 'skills/grapheng/DESIGN.md')))
  const names = await readdir(path.join(root, 'skills'))
  assert.deepEqual(names, ['grapheng'])
})

test('commands de Claude são exatamente implemente e plan, com envelope, argv[0] e flags do advisor', async () => {
  const commands = (await readdir(path.join(root, 'commands'))).sort()
  assert.deepEqual(commands, ['implemente.md', 'plan.md'])
  for (const file of commands) {
    const name = path.basename(file, '.md')
    const text = await readFile(path.join(root, 'commands', file), 'utf8')
    assert.match(text, /^---\s*\ndescription: .+\n/, file)
    assert.match(text, /^argument-hint: .*\[--effort low\|medium\|max\] \[--haiku-max low\|medium\|off\] \[--executor sonnet\|haiku\]/m, file)
    assert.match(text, /--invocation/, file)
    assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}/, file)
    assert.match(text, new RegExp(`"argv"\\s*:\\s*\\["${name}"`), file)
    assert.doesNotMatch(text, /--adaptive|clarify|tasks/, file)
  }
})

test('commands, SKILL e README não citam full, ceiling, economy, --model nem nomes de modelo', async () => {
  for (const file of ['commands/plan.md', 'commands/implemente.md', 'skills/grapheng/SKILL.md', 'README.md', 'README.pt-BR.md', 'README.es.md']) {
    // As flags do advisor (--haiku-max, --executor sonnet|haiku) e os valores entre crases são a única
    // menção permitida a modelo; a prosa usa forte/médio/barato.
    const text = (await readFile(path.join(root, file), 'utf8'))
      .replace(/--executor (sonnet\|haiku|sonnet|haiku)|--haiku-max|--executor|`(sonnet|haiku)`/g, 'flag')
    assert.doesNotMatch(text, /\b(full|ceiling|economy)\b|--model\b|\b(opus|sonnet|haiku)\b|gpt-/i, file)
  }
})

test('README em inglês, português e espanhol, cada um com o seletor apontando para os outros dois', async () => {
  const readmes = ['README.md', 'README.pt-BR.md', 'README.es.md']
  for (const file of readmes) {
    const text = await readFile(path.join(root, file), 'utf8')
    for (const other of readmes.filter((name) => name !== file)) assert.match(text, new RegExp(`href="${other.replace('.', '\\.')}"`), `${file} sem link para ${other}`)
  }
})

test('package não contém caminhos locais ou registro de Workflow no manifest portátil', async () => {
  const portable = await readFile(path.join(root, 'plugin.json'), 'utf8')
  assert.doesNotMatch(portable, /\/Users\/|\/Volumes\/|\.codex\/plugins\/cache/)
  assert.doesNotMatch(portable, /"workflows"\s*:/)
})
