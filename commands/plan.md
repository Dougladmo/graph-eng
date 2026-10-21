---
description: Cria um plano com o graph-eng, sem executar implementação nem checks.
argument-hint: "<tarefa> [--effort low|medium|max]"
---

Crie um arquivo JSON temporário por ferramenta de arquivo com `{"host":"claude","argv":["plan", ...]}`.

Monte `argv` assim:

1. O segundo elemento é o texto de `$ARGUMENTS` inteiro como um único valor de texto JSON, com aspas e barras escapadas. Não divida, não interprete e não acrescente nada.
2. Se `$ARGUMENTS` contiver `--effort <valor>`, separe esse par em dois elementos (`"--effort"` e `"<valor>"`) e mantenha o restante da tarefa como um único elemento.
3. Se a tarefa começar com hífen, coloque `"--"` antes dela.

Depois rode `node "${CLAUDE_PLUGIN_ROOT}/bin/grapheng.mjs" --invocation <caminho-do-json>`. Passe o caminho como argumento separado e nunca concatene conteúdo variável no comando.

Mostre o status real que o comando devolver. Se vier `"status":"blocked"`, mostre o motivo e o bloqueio sem tratá-lo como sucesso. Não escolha modelo, papel ou limite: quem define isso é o runner.
