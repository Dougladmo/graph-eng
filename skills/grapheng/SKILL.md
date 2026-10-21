---
name: grapheng
description: Planeje, esclareça, decomponha ou implemente tarefas complexas com o graph-eng, ou use init para abrir o painel local.
argument-hint: "plan <tarefa> | clarify | tasks | implemente [<tarefa>] | init, com --effort low|medium|max opcional"
---

# grapheng

Esta skill é a entrada para o runner GraphEng2 do host atual. Papéis e modelos são definidos pelo adapter confiável do host; não escolha modelo, papéis, tamanho do grafo ou limites internos.

Invocações nativas: Claude Code `/graph-eng:grapheng <comando>`, e também os commands `/graph-eng:plan`, `/graph-eng:clarify`, `/graph-eng:tasks`, `/graph-eng:implemente` e `/graph-eng:init`. No Codex, use o nome da skill que o cliente mostra (ex.: `graph-eng:grapheng`); o Codex não tem slash global do plugin, então não há atalho `/plan` ali.

## Comandos

Os cinco comandos rodam no mesmo runner. Cada um vira uma única execução, com um pipeline próprio:

- `plan <tarefa>`: gera o plano da tarefa e o publica no slot de plano. Não executa implementação nem checks. Se o planejador tiver perguntas, a run termina com `needs_clarification`.
- `clarify`: responde as perguntas pendentes do plano aprovado do workspace. Não recebe tarefa. As respostas entram como dado, e um novo plano é revisado com elas.
- `tasks`: decompõe o plano aprovado em tarefas (DAG) e publica no slot de tarefas. Não recebe tarefa e não executa nada.
- `implemente [<tarefa>]`: executa o fluxo completo e roda os checks descobertos por mapeamento confiável. Sem tarefa, usa o plano e as tarefas do slot da feature corrente.
- `init`: inicia ou reutiliza o painel local e devolve a URL real. Não recebe tarefa nem esforço.

Ordem típica: `plan` → (`clarify`, se houver perguntas) → `tasks` → `implemente`. `implemente <tarefa>` também pode ser usado direto: ele planeja, decompõe e executa numa só run quando não há artefato reutilizável.

Esforço aceito: `low`, `medium` (padrão) ou `max`, sempre na forma separada (`--effort max`). `--effort` válido substitui a configuração em `plan`, `clarify`, `tasks` e `implemente`. Não existe `--effort=max`. `init` não aceita esforço.

## Reuso de artefatos e slot único

Há um slot de plano e um de tarefas por repositório: a **feature corrente**. Um `plan` aprovado novo substitui o slot de plano anterior. Antes de usar um artefato, o runner confere a identidade da tarefa, a origem verificada na run que o publicou e a identidade do workspace. Se algo não bate, ele não reutiliza o artefato silenciosamente: a decisão e o motivo ficam no journal da run.

Motivos de bloqueio ou de recusa de reuso que o host pode ver:

- `plan_task_required`: `plan` sem tarefa.
- `plan_missing_or_incompatible:absent|artifact_invalid|not_approved:*`: falta plano aprovado (use `plan`, ou `clarify` se houver perguntas).
- `needs_clarification`: o plano tem perguntas; rode `clarify` com as respostas.
- `clarification_stale` e `clarification_incomplete`: as respostas não correspondem às perguntas atuais do plano; responda o conjunto completo do plano atual.
- `tasks_plan_mismatch`: as tarefas foram geradas de outro plano; rode `tasks` de novo.
- `workspace_changed`: o repositório mudou (arquivo editado, criado, removido ou commit novo) depois do plano; o artefato não é reutilizado e o planejamento roda de novo.
- `task_changed`: a tarefa, o contexto, o host ou a política mudou; o artefato não serve.
- `source_unverified` e `artifact_tampered`: o artefato não bate com a run de origem ou foi adulterado; não há reuso.

Quando um comando devolve `blocked`, mostre o motivo exato que veio. Não trate `blocked` como sucesso, não invente respostas de clarify, não invente tarefas e não invente checks.

## Chamada segura

O host deve fornecer `host` confiável (`claude` ou `codex`) e gravar a invocação em arquivo JSON usando sua ferramenta de escrita. O envelope aceita só as chaves `host`, `argv` e `clarification`; `clarification` só vale com `clarify`. Qualquer outra chave é recusada. Passe o caminho do arquivo como argumento separado ao Node; nunca concatene a tarefa num comando shell, use `eval`, interpolação ou backticks. Exemplo conceitual do wrapper:

```js
const invocation = { host: 'claude', argv: ['plan', 'revisar o parser $(isso é dado)', '--effort', 'medium'] }
// Grave invocation em arquivo JSON via ferramenta de arquivo e invoque:
// node <raiz-portatil-do-plugin>/bin/grapheng.mjs --invocation <caminho-do-json>
```

O runner mantém evidências por execução em `.graph-runs/` dentro do repositório e lê a configuração pública de esforço. Checks são descobertos de forma determinística e executados como argv sem shell. Se não houver um mapeamento confiável, `implemente` fica `BLOCK` com `trusted_check_discovery_failed`; não invente comandos.

Apresente o estado e os bloqueios que o runner realmente informar. Não trate um `BLOCK` como sucesso, não invente checks quando não houver mapeamento confiável, e não maquie uma resposta bloqueada como se o comando tivesse rodado.

A fundamentação do desenho anterior está em [DESIGN.md](DESIGN.md).
