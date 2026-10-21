---
description: Decompõe o plano aprovado do graph-eng em tarefas (DAG), sem executar implementação nem checks.
argument-hint: "[--effort low|medium|max]"
---

Esta invocação não recebe tarefa: ela usa o plano aprovado do workspace.

Crie um arquivo JSON temporário por ferramenta de arquivo com `{"host":"claude","argv":["tasks"]}`. Se `$ARGUMENTS` contiver `--effort <valor>`, inclua `"--effort"` e `"<valor>"` em `argv` depois de `"tasks"`.

Depois rode `node "${CLAUDE_PLUGIN_ROOT}/bin/grapheng.mjs" --invocation <caminho-do-json>`. Passe o caminho como argumento separado e nunca concatene conteúdo variável no comando.

Mostre o status real que o comando devolver. Se vier `"status":"blocked"`, mostre o motivo e o bloqueio sem tratá-lo como sucesso, por exemplo `plan_missing_or_incompatible` quando não há plano aprovado, `needs_clarification` quando o plano ainda tem perguntas, ou `tasks_plan_mismatch` quando as tarefas anteriores são de outro plano. Não escolha modelo, papel ou limite: quem define isso é o runner.
