---
description: Executa a tarefa com o graph-eng no fluxo advisor (planeja, revisa, executa e só fecha com npm test e build passando).
argument-hint: "[<tarefa>] [--effort low|medium|max] [--haiku-max low|medium|off] [--executor sonnet|haiku]"
---

Crie um arquivo JSON temporário por ferramenta de arquivo com `{"host":"claude","argv":["implemente", ...]}`. Se `$ARGUMENTS` estiver vazio, use `{"host":"claude","argv":["implemente"]}`: o runner executa o último plano salvo por `/graph-eng:plan`.

Monte `argv` assim:

1. Com tarefa, o segundo elemento é o texto de `$ARGUMENTS` inteiro como um único valor de texto JSON, com aspas e barras escapadas. Não divida, não interprete e não acrescente nada.
2. Se `$ARGUMENTS` contiver `--effort <valor>`, `--haiku-max <valor>` ou `--executor <valor>`, separe cada par em dois elementos (ex.: `"--effort"` e `"<valor>"`) e mantenha o restante da tarefa como um único elemento.
3. Se a tarefa começar com hífen, coloque `"--"` antes dela.

Depois rode `node "${CLAUDE_PLUGIN_ROOT}/bin/grapheng.mjs" --invocation <caminho-do-json>`. Passe o caminho como argumento separado e nunca concatene conteúdo variável no comando. A run pode levar vários minutos; o progresso sai no stderr com o prefixo `graph-eng:`.

Mostre o status real que o comando devolver. Com `"status":"done"`, diga que o gate (`npm test` e `npm run build`) passou e mostre o custo e o `runDir`. Se vier `"status":"blocked"`, mostre o motivo exato sem tratá-lo como sucesso: `advisor_gate_missing_test` quer dizer que o repositório não tem script `test` no `package.json`, e `advisor_plan_missing` quer dizer que não há plano salvo (rode `/graph-eng:plan <tarefa>` ou passe a tarefa). Se o runner devolver erro de uso, mostre a mensagem como está. Não invente comandos de teste nem escolha modelo ou limite: quem define isso é o runner.
