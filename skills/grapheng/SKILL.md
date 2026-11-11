---
name: grapheng
description: Planeje ou implemente uma tarefa com o graph-eng no fluxo advisor: um modelo médio planeja, o forte revisa e aconselha, o barato faz os passos simples, e a run só fecha com npm test e build passando. Com --power, o Fable 5.2 planeja e aconselha e as ondas do plano rodam em paralelo.
argument-hint: "plan <tarefa> | implemente [<tarefa>], com --effort low|medium|max, --haiku-max low|medium|off, --executor sonnet|haiku, --power ou --fable-min high|off opcionais"
---

# grapheng

Esta skill é a entrada para o runner do graph-eng no host atual. Desde a 1.3.0 o graph-eng tem um fluxo só, o **advisor**; desde a 1.4.0 ele tem o **Power Mode** (`--power`). Papéis e modelos são definidos pelo adapter confiável do host; não escolha modelo, papel nem limite.

Invocações nativas: Claude Code `/graph-eng:grapheng <comando>`, e também os commands `/graph-eng:plan` e `/graph-eng:implemente`. No Codex, use o nome da skill que o cliente mostra (ex.: `graph-eng:grapheng`); o Codex não tem slash global do plugin, então não há atalho `/plan` ali.

## Comandos

- `plan <tarefa>`: o planejador escreve os passos, marca a complexidade de cada um (`low`, `medium` ou `high`) e o modelo forte revisa o plano uma vez. Mostra o plano e qual modelo vai executar cada passo, e salva tudo em `.graph-runs/advisor-plan.json`. Não toca no código. Termina com `planned`.
- `implemente <tarefa>`: faz tudo numa run só (plano, revisão, execução e gate).
- `implemente` sem tarefa: executa o último plano salvo pelo `plan`, com o roteamento escolhido no `plan`. Sem plano salvo, bloqueia com `advisor_plan_missing`.

## Como a run funciona

1. O planejador (modelo médio) escreve os passos; o modelo forte revisa o plano uma vez.
2. O executor trabalha numa sessão contínua, passo a passo, e pode pedir conselho ao modelo forte no máximo 3 vezes por run.
3. O shell do executor só roda `npm test` e `npm run build`. No fim, o supervisor roda os dois; a run só fica `done` com esse gate passando. Se falhar, até mais 2 sessões de conserto (sempre no modelo médio).

**Roteamento por complexidade.** Os passos até o nível de `--haiku-max` vão para o modelo barato; o resto vai para o médio. Passos seguidos no mesmo modelo dividem uma sessão. O padrão no Claude é `low`: só os passos simples e repetitivos vão para o barato.

**Power Mode (`--power`).** O modelo mais forte da família (Fable 5.2) escreve o plano com esforço alto e fica de advisor; o forte revisa o plano, pega os passos `high` e os consertos do gate; o médio pega os `medium` e o barato os `low`. O plano sai em ondas: cada passo nomeia seus arquivos e sua onda, e dentro de uma onda os passos viram raias por modelo que rodam ao mesmo tempo em arquivos diferentes. As ondas rodam em série e o gate roda uma vez no fim. O advisor aceita até 6 chamadas por run, 2 por raia. `--fable-min high` manda os passos `high` para o próprio Fable 5.2. Desenho completo em `docs/power-mode.md`.

## Flags

Sempre na forma separada (`--effort max`); `--effort=max` é recusado.

- `--effort low|medium|max` (padrão `medium`): esforço de raciocínio de todas as chamadas da run. No Power Mode, o planejador tem piso `high`.
- `--haiku-max low|medium|off` (padrão `low` no Claude): complexidade máxima que vai para o modelo barato. `off` deixa todos os passos no médio.
- `--executor sonnet|haiku`: um modelo para todos os passos. Desliga o roteamento e não combina com `--haiku-max` nem com `--power`.
- `--power`: liga o Power Mode. Sem valor.
- `--fable-min high|off` (padrão `off`): com `high`, os passos `high` vão para o Fable 5.2. Exige `--power`.

`--haiku-max`, `--executor`, `--power` e `--fable-min` só existem no host Claude; no Codex o fluxo não roteia. Em `implemente` sem tarefa, o roteamento vem do plano salvo, então essas flags vão no `plan`.

## Status e bloqueios

- `planned`: o `plan` terminou e o plano foi salvo.
- `done`: o gate passou e o executor declarou todos os passos prontos.
- `blocked`, com um destes motivos:
  - `advisor_gate_missing_test`: o `package.json` do repositório não tem script `test`.
  - `advisor_plan_missing`: `implemente` sem tarefa e sem plano salvo.
  - `advisor_plan_host_mismatch`: o plano salvo é de outro host.
  - `advisor_gate_failed`: `npm test` ou `npm run build` continuou falhando depois das sessões de conserto.
  - `advisor_executor_blocked`: o gate passou, mas o executor declarou algum passo bloqueado.
  - `advisor_call_failed`: uma chamada de modelo falhou.

Quando um comando devolve `blocked`, mostre o motivo exato que veio. Não trate `blocked` como sucesso e não invente checks.

## Chamada segura

O host deve fornecer `host` confiável (`claude` ou `codex`) e gravar a invocação em arquivo JSON usando sua ferramenta de escrita. O envelope aceita só as chaves `host` e `argv`; qualquer outra é recusada. Passe o caminho do arquivo como argumento separado ao Node; nunca concatene a tarefa num comando shell, use `eval`, interpolação ou backticks. Exemplo conceitual do wrapper:

```js
const invocation = { host: 'claude', argv: ['plan', 'revisar o parser $(isso é dado)', '--effort', 'medium'] }
// Grave invocation em arquivo JSON via ferramenta de arquivo e invoque:
// node <raiz-portatil-do-plugin>/bin/grapheng.mjs --invocation <caminho-do-json>
```

Cada run deixa a evidência em `.graph-runs/<runId>/advisor-run.json` dentro do repositório: plano, revisão, sessões, gate, chamadas e custo. No Power Mode, `routing` lista as ondas com as raias de cada uma, e cada sessão traz `wave`, `steps`, `model` e `ms`.
