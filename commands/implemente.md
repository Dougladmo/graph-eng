---
description: Executa a tarefa com o graph-eng, com checks descobertos de forma confiável e evidências por run.
argument-hint: "<tarefa> [--effort low|medium|max]"
---

Crie um arquivo JSON temporário por ferramenta de arquivo com `{"host":"claude","argv":["implemente", ...]}`. Se `$ARGUMENTS` estiver vazio, use `{"host":"claude","argv":["implemente"]}` e o runner usa o plano e as tarefas da feature corrente.

Monte `argv` assim:

1. Com tarefa, o segundo elemento é o texto de `$ARGUMENTS` inteiro como um único valor de texto JSON, com aspas e barras escapadas. Não divida, não interprete e não acrescente nada.
2. Se `$ARGUMENTS` contiver `--effort <valor>`, separe esse par em dois elementos (`"--effort"` e `"<valor>"`) e mantenha o restante da tarefa como um único elemento.
3. Se a tarefa começar com hífen, coloque `"--"` antes dela.

Depois rode `node "${CLAUDE_PLUGIN_ROOT}/bin/grapheng.mjs" --invocation <caminho-do-json>`. Passe o caminho como argumento separado e nunca concatene conteúdo variável no comando.

Mostre o status real que o comando devolver. Se vier `"status":"blocked"`, por exemplo quando não há mapeamento confiável de checks, mostre o motivo sem tratá-lo como sucesso e não invente comandos de teste. Se o runner devolver erro de uso, mostre a mensagem como está. Se vier `needs_clarification` ou `tasks_plan_mismatch`, diga qual comando rodar antes (`clarify` ou `tasks`). Não escolha modelo, papel ou limite: quem define isso é o runner.
