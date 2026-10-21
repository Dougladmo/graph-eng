---
description: Responde as perguntas pendentes do plano do graph-eng, uma por vez, e registra só as respostas do usuário. Sem resposta inventada.
argument-hint: "[--effort low|medium|max]"
---

Esta invocação não recebe tarefa: ela usa o plano aprovado do workspace.

Protocolo:

1. Rode primeiro `{"host":"claude","argv":["clarify"]}` sem `clarification`. Se o runner devolver perguntas (`"status":"needs_clarification"`, com `clarification.questionSetId` e `clarification.questions`, no máximo 5), siga para o passo 2. Se devolver outro status, mostre-o como está.
2. Faça uma pergunta por vez, com as opções quando houver. Espere a resposta do usuário para cada uma. Se o usuário pular, registre `skipped: true` para ela. Nunca escreva uma resposta que o usuário não deu.
3. Quando todas tiverem resposta ou pulo, crie um arquivo JSON temporário por ferramenta de arquivo com `{"host":"claude","argv":["clarify"],"clarification":{"questionSetId":"<valor devolvido pelo runner>","answers":[{"questionId":"Q1","answer":"<texto>"}]}}`. Use `skipped: true` no lugar de `answer` quando a pergunta foi pulada. Se `$ARGUMENTS` contiver `--effort <valor>`, inclua `"--effort"` e `"<valor>"` em `argv` depois de `"clarify"`.
4. Rode `node "${CLAUDE_PLUGIN_ROOT}/bin/grapheng.mjs" --invocation <caminho-do-json>`. Passe o caminho como argumento separado e nunca concatene conteúdo variável no comando.

Mostre o status real que o comando devolver. Se vier `"status":"blocked"`, por exemplo `clarification_stale` ou `clarification_incomplete`, mostre o motivo e o bloqueio sem tratá-lo como sucesso. Não escolha modelo, papel ou limite: quem define isso é o runner.
