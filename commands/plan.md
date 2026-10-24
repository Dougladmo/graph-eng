---
description: Monta e revisa o plano do graph-eng (passos, complexidade e quem executa cada um), sem tocar no código.
argument-hint: "<tarefa> [--effort low|medium|max] [--haiku-max low|medium|off] [--executor sonnet|haiku]"
---

Crie um arquivo JSON temporário por ferramenta de arquivo com `{"host":"claude","argv":["plan", ...]}`.

Monte `argv` assim:

1. O segundo elemento é o texto de `$ARGUMENTS` inteiro como um único valor de texto JSON, com aspas e barras escapadas. Não divida, não interprete e não acrescente nada.
2. Se `$ARGUMENTS` contiver `--effort <valor>`, `--haiku-max <valor>` ou `--executor <valor>`, separe cada par em dois elementos (ex.: `"--effort"` e `"<valor>"`) e mantenha o restante da tarefa como um único elemento.
3. Se a tarefa começar com hífen, coloque `"--"` antes dela.

Depois rode `node "${CLAUDE_PLUGIN_ROOT}/bin/grapheng.mjs" --invocation <caminho-do-json>`. Passe o caminho como argumento separado e nunca concatene conteúdo variável no comando.

Com `"status":"planned"`, mostre o plano de forma curta: objetivo, cada passo com a complexidade (`low`, `medium` ou `high`), o modelo que vai executá-lo (campo `routing`), os critérios de pronto e as notas da revisão. Diga que o plano ficou salvo em `.graph-runs/advisor-plan.json` e que `/graph-eng:implemente` sem tarefa executa esse plano. Se vier `"status":"blocked"`, mostre o motivo exato sem tratá-lo como sucesso. Não escolha modelo nem limite: quem define isso é o runner.
