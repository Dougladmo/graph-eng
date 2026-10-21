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
  assert.equal(portable.version, '2.0.0')
  assert.equal(codex.version, portable.version)
  assert.equal(claude.version, portable.version)
  assert.match(portable.version, /^\d+\.\d+\.\d+$/)
  const iface = portable.extensions['com.openai'].interface
  assert.ok(iface.shortDescription.length <= 30)
  assert.equal(codex.interface.shortDescription, iface.shortDescription)
  assert.equal(codex.interface.defaultPrompt, iface.defaultPrompt)
  for (const forbidden of ['skills', 'mcpServers', 'apps', 'interface']) assert.equal(Object.hasOwn(portable, forbidden), false)
})

test('skill portátil tem nome correspondente à pasta e assets relativos contidos', async () => {
  const skill = await readFile(path.join(root, 'skills/grapheng/SKILL.md'), 'utf8')
  assert.match(skill, /^---\s*\nname: grapheng\n/)
  assert.match(skill, /\/graph-eng:grapheng/)
  assert.match(skill, /use o nome da skill que o cliente mostra \(ex\.: `graph-eng:grapheng`\)/)
  assert.doesNotMatch(skill, /Codex `\$grapheng/)
  for (const command of ['plan', 'implemente', 'init', 'clarify', 'tasks']) assert.match(skill, new RegExp(`\`${command}`))
  // Os 5 comandos estão ligados: o SKILL não pode mais anunciar estágio pendente.
  assert.doesNotMatch(skill, /em implementação|stage_unsupported/)
  assert.match(skill, /feature corrente/)
  assert.match(skill, /needs_clarification/)
  assert.match(skill, /tasks_plan_mismatch/)
  await access(path.join(root, 'skills/grapheng/DESIGN.md'))
  const names = await readdir(path.join(root, 'skills'))
  assert.deepEqual(names, ['grapheng'])
  const commands = await readdir(path.join(root, 'commands'))
  assert.equal(commands.includes('painel.md'), false)
})

test('commands de Claude são exatamente clarify, implemente, init, plan e tasks, com envelope e argv[0] corretos', async () => {
  const commands = (await readdir(path.join(root, 'commands'))).sort()
  assert.deepEqual(commands, ['clarify.md', 'implemente.md', 'init.md', 'plan.md', 'tasks.md'])
  for (const file of commands) {
    const name = path.basename(file, '.md')
    const text = await readFile(path.join(root, 'commands', file), 'utf8')
    assert.match(text, /^---\s*\ndescription: .+\n/, file)
    assert.match(text, /^argument-hint: /m, file)
    assert.match(text, /--invocation/, file)
    assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}/, file)
    assert.match(text, new RegExp(`"argv"\\s*:\\s*\\["${name}"`), file)
  }
})

test('commands, SKILL e README não citam full, ceiling, economy, --model nem nomes de modelo', async () => {
  for (const file of ['commands/plan.md', 'commands/implemente.md', 'commands/init.md', 'skills/grapheng/SKILL.md', 'README.md']) {
    const text = await readFile(path.join(root, file), 'utf8')
    assert.doesNotMatch(text, /\b(full|ceiling|economy)\b|--model\b|\b(opus|sonnet|haiku)\b|gpt-/i, file)
  }
})

test('package não contém caminhos locais ou registro de Workflow no manifest portátil', async () => {
  const portable = await readFile(path.join(root, 'plugin.json'), 'utf8')
  assert.doesNotMatch(portable, /\/Users\/|\/Volumes\/|\.codex\/plugins\/cache/)
  assert.doesNotMatch(portable, /"workflows"\s*:/)
})
