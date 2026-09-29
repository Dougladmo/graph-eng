---
name: graph-eng
description: Graph engineering enxuto. Orquestra uma tarefa complexa como um grafo pequeno de agentes, na sequência planner → workers (leitura em paralelo, escrita em paralelo só em arquivos disjuntos, executor barato) → revisão do design → verificador independente e forte → reparo → critic em loop até os critérios de pronto fecharem → relatório com gate humano. O dimensionamento é por esforço × teto (padrão de fábrica 24/auto), não um número fixo de agentes. Use quando o usuário pedir explicitamente "grafo", "graph", "graph eng", "graph engineering", "graph-eng", "roda em loop até ficar pronto" ou "faz isso com agentes/workflow" para uma tarefa complexa (feature com várias partes, refactor amplo, arquitetura de sistema, investigação profunda, auditoria). NÃO use em tarefa de um passo (explicar um arquivo, mudar uma linha, renomear), onde o grafo só custa mais.
argument-hint: "[--lean|--max] [--effort <manual|auto|low|medium|high|max>] [--ceiling <N>] [--plan-gate] [--spec <arquivo>] [research|architecture|implement|review] <tarefa>"
---

# graph-eng

Dispara o workflow `graph-eng:graph-eng`, que o plugin registra a partir de `workflows/graph-eng.js`.
Se o Workflow tool não reconhecer o nome, passe `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/graph-eng.js"`
no lugar de `name`. Invocar esta skill é o opt-in do usuário para rodar esse workflow. A fundamentação de
cada decisão, com fontes, está em [DESIGN.md](DESIGN.md).

```
PLAN ─▶ PESQUISA ─▶ DESIGN ─▶ REVISÃO DO DESIGN ─▶ [ work ─▶ checks ─▶ verify ⇄ repair ] ─▶ CRITIC ─┬─ done ─▶ SÍNTESE ─▶ gate humano (você)
                                     │                  ▲                                           │
                        reprovada: para antes de        └───────────── gaps = novos nós ────────────┘  (até maxRounds, ou sem gap novo)
                        implementar, bloqueio no relatório
```

Esse é o esqueleto de `implement`. `architecture` não tem implementação (a crítica julga o design), e
`research`/`review` vão de pesquisa direto para a crítica. Na síntese de `implement` rodam
`ceil(2/3 × nós implement)` polidores e depois 1 consolidador.

## Ações sobre uma run (painel ou comando colado)

O painel web (`bin/ui-server.mjs`) age sobre as runs por uma fila em arquivo (`bin/requests.mjs`) que o
`graph-watch events` desta seção lê e emite como uma linha de pedido, e pelo texto que os botões "Copiar"
do painel colocam no clipboard. Contrato completo:
[docs/specs/2026-09-28-acoes-no-painel.md](../../docs/specs/2026-09-28-acoes-no-painel.md) C1-C9.

- **Gatilhos**: uma linha `graph-eng pedido <id> · resume|stop|rerun-node · run <runId> (<wf>) · …` que o
  Monitor entrega (o `events` armado na etapa 6.2 já as emite); ou os args desta skill começando com
  `retomar`, `refazer` ou `parar` (aliases `resume`, `rerun`, `stop`) — é o texto que "Copiar para
  retomar/refazer/parar" do painel gera, para colar aqui.
- **Regra**: a confirmação já foi dada — no dialog do painel, ou pelo próprio ato de colar o comando.
  **Nunca** use AskUserQuestion, não faça triagem, scout nem plan gate para estes pedidos. Responda em
  até 3 linhas.
- **Pedido da fila**: aceite primeiro pelo CLI da fila, `node "${CLAUDE_PLUGIN_ROOT}/bin/requests.mjs"
  accept <id> --session <sessionId>`. Se outra sessão já aceitou (saída 3), ignore em silêncio — ela está
  cuidando. Em qualquer falha depois disso, grave `falhou` com o motivo:
  `node "${CLAUDE_PLUGIN_ROOT}/bin/requests.mjs" fail <id> --session <sessionId> --reason "<motivo>"`, e
  diga isso em 1 linha.

**Antes de todo `resume` e `rerun-node`** (pedido da fila ou texto colado), a trava contra dois
Workflows no mesmo run dir:

1. Se esta sessão tem no contexto a task do `Workflow(...)` de `<wf>` (é a dona da run), chame
   `TaskStop(<task>)` antes de seguir. Uma resposta de que a task já terminou conta como ok.
2. Se o pedido veio da fila com `route: "owner"` e esta sessão **não** acha a task de `<wf>` no
   contexto, grave `falhou` com o motivo `"esta sessão não achou a task do workflow <wf>; pare pelo
   /workflows e retome de novo"` e não dispare nada.
3. Rode o CLI de retomada:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/graph-resume.mjs" --run-dir "<runDir>" [--rerun <nó> [--rerun <nó> ...]] [--dependents] [--owner-ok]
   ```
   Passe `--owner-ok` **só** se o passo 1 rodou nesta sessão (ela é a dona e já parou a task antiga).
   Se ele sair com **4** (outra sessão pode ainda estar dona da run viva), não dispare nada: grave
   `falhou` com a 1ª linha do stderr (pedido da fila) ou devolva essa linha em 1 frase (texto colado) —
   "A sessão dona desta run ainda está ativa: pare a run nela (Copiar para parar) e cole este comando de
   novo." Qualquer outro código de erro (1) também vira `falhou`/recusa, com o motivo do stderr.
4. Só com o CLI em código **0**, leia `args` da saída JSON e dispare
   `Workflow({ name: 'graph-eng:graph-eng', args })` — os mesmos passos 5 e 6 da etapa "Executar" abaixo,
   com o `<wf>` novo.

| Pedido | Passos | `feito` quando |
| --- | --- | --- |
| `resume` (`retomar`) | 1-4 acima, sem `--rerun`. | O `Workflow(...)` disparou; grave `done --wf <novo>` (fila) ou responda `↻ RETOMANDO` (colado). |
| `rerun-node <nó>` (`refazer <nó>` [`--dependentes`]) | 1-4 acima, com `--rerun <nó>` e `--dependents` se pedido. | Igual ao `resume`. |
| `stop` (`parar`) | Se esta sessão não tem a task de `<wf>` no contexto (não é a dona), grave `falhou` — "esta sessão não é a dona da run" (fila) ou, no texto colado, diga em 1 linha para colar na sessão dona ou usar `/workflows` dela. Sendo a dona, rode `TaskStop(<task>)`. | O `TaskStop` voltou ok; grave `done` (fila) ou responda `⏹ PARADA — graph-eng <runId> · veja em <painel>` (colado), e **siga ouvindo o painel** — não derrube o listener da fila. |

- Ao disparar a retomada, abra a resposta com `↻ RETOMANDO — graph-eng <runId> · <k> prontos ·
  refazendo <ids ou "o que faltou"> · novo wf <wf>`, e daí em diante siga o fluxo normal desta skill
  (⏳ RODANDO … ✅ TERMINADO), com o `<wf>` novo em todo comando de `graph-watch`.
- **Formato exato do texto que os botões "Copiar" colocam no clipboard** (funciona colado em qualquer
  sessão nova, sem pergunta — o `runDir` absoluto torna o cwd irrelevante):

  | Botão | Texto |
  | --- | --- |
  | Copiar para retomar | `/graph-eng:graph-eng retomar --run-dir "<runDir>"` |
  | Copiar para refazer `<nó>` | `/graph-eng:graph-eng refazer <nó> --run-dir "<runDir>"` |
  | idem, com "refazer também os dependentes" | `/graph-eng:graph-eng refazer <nó> --dependentes --run-dir "<runDir>"` |
  | Copiar para parar | `/graph-eng:graph-eng parar --run <wf>` |

  O "parar" só funciona colado na sessão dona (só ela tem a task do Workflow); o título do botão avisa
  disso. "Retomar"/"refazer" colados passam pela mesma trava do passo 3: se a dona ainda pode ter o
  Workflow vivo e esta sessão não é ela, a sessão recusa em 1 linha, como descrito ali.

## Seleção de agentes

Quem escolhe os nós é o **planner**, a partir da tarefa **e do alvo de agentes** (esforço × teto — ver
etapa 3). Quem escolhe o modelo de cada nó é o **script**, por papel e risco. Nada é deixado ao acaso: sem
pin explícito, o subagente herdaria o modelo caro da sessão. O grafo segue um **esqueleto de fases
obrigatório por modo** (trilhos no código, não sugestão do planner): não existe mais atalho de 1 nó para
tarefa trivial, toda run passa pelas fases do seu modo (ver DESIGN.md).

| Papel                             | Quantos                                                          | Modelo (`balanced`)            | Esforço                     |
| ---------------------------------- | ------------------------------------------------------------------ | ------------------------------- | ---------------------------- |
| planner                            | 1                                                                    | sessão                          | high                          |
| worker `research`                  | 1 por nó                                                             | Sonnet                          | medium                        |
| worker `design`                    | 1 por nó                                                             | sessão                          | medium                        |
| **revisor do design**              | 1 (mais 1 re-revisão por reparo de design, até `maxRepairs`)         | sessão                          | high                          |
| worker `implement`                 | 1 por nó, **em paralelo quando os arquivos são disjuntos**           | Sonnet                          | medium                        |
| `explore` (decisão central)        | 2 rascunhos opostos + 1 juiz                                         | rascunhos por tipo, juiz sessão | medium / high                |
| verificador                        | 1 por nó de implementação, **sempre outro agente**, lente de boas práticas | **sessão**                | medium (high no risco alto)  |
| 2º voto                            | só se o verificador ficar em dúvida                                  | sessão, outra lente             | high                          |
| reparo (design ou implementação)   | ≤ `maxRepairs` por nó; o último sobe para a sessão                   | Sonnet → sessão                 | medium → high                 |
| critic                             | 1 por round, lente de boas práticas                                  | sessão                          | high                          |
| **polidor da síntese**             | `ceil(2/3 × nº de nós implement)`, mínimo 1                          | Sonnet                          | medium                        |
| **consolidador da síntese**        | 1 (sempre; sozinho em research/review, que não têm polidor)          | Sonnet                          | medium                        |

A regra é **executor barato, revisor forte**. O revisor precisa ser pelo menos tão forte quanto quem gerou,
porque revisor mais fraco piora o resultado. Três exceções sobem tudo para o modelo da sessão:

- nó de **risco alto** (auth, dinheiro, dados/migrations, API pública, config de produção);
- tarefa classificada como `complexity: trivial` pelo planner, em que o modelo forte direto sai mais barato do que errar;
- preset `max`.

No preset `lean`, design também vai para Sonnet.

## 0. Triagem: vale um grafo?

Vale quando os três se cumprem: **várias etapas**, **parte delas independente** e **o resultado precisa
de checagem**. Se faltar um, faça direto e diga por quê em uma linha, a menos que o usuário insista.
O grafo rende em amplitude (várias frentes, auditoria, migração com suíte de testes) e decepciona em
feature nova e ambígua sem spec. Nesse caso, aplique a etapa 1 antes.

## 1. O "o quê" é do humano, o "como" é do grafo

O workflow não pode parar no meio para perguntar. Toda ambiguidade de **comportamento** precisa sair
antes de rodar. Detalhe de código, o grafo lê sozinho. Escolha o caminho pelo tamanho da mudança:

| Situação                                                              | O que fazer antes                                                                                                                                         |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O diff cabe numa frase, há repro ou teste falhando                    | Nada. Rode direto; o planner registra as premissas.                                                                                                       |
| Várias partes, sem mudança de contrato (**padrão**)                   | **Spec leve de 10-40 linhas**, escrita na hora com o usuário: objetivo · critérios de aceite verificáveis · fora de escopo · Always / Ask first / Never · como verificar. Use `--plan-gate`. |
| Greenfield, schema, API pública, segurança, dinheiro, run longo       | **Duas rodadas:** `architecture` gera o ADR, o usuário aprova, e depois `implement` recebe o ADR como `spec`.                                             |

- **Se o usuário já tem spec em arquivo** (`--spec docs/x.md`, Spec Kit, PRD): passe o caminho em `spec`
  e copie os critérios de aceite dela **literalmente** para `doneWhen`. Assim o planner não inventa nem
  afrouxa o critério de pronto.
- **Se faltar informação:** faça no máximo 2-3 perguntas com AskUserQuestion, sobre resultado e
  comportamento, nunca sobre o que dá para ler no código.
- **Sinal de spec demais:** ela é maior que o diff esperado, ou o plano a revisar passa de ~200 linhas.
  A spec fica em nível de produto e contrato; detalhe técnico errado na spec cascateia para todos os nós.

## 2. Scout inline (barato, no contexto principal)

Faça no máximo ~6 tool calls, sem ler arquivo grande inteiro:

- `git status --short` e `git diff --stat`: baseline do que já estava mudado.
- Glob/Grep para achar onde a tarefa vive.
- Checks determinísticos (`package.json`, `Makefile`, CLAUDE.md: typecheck, test, lint). **O grafo vale o
  que vale o oráculo.** Em `implement`, sem nenhum check executável, avise o usuário: o planner vai pôr
  "escrever o teste antes" no aceite. Se um check já falha no baseline, diga isso no `context`.
- Dependências externas: se a tarefa integra ou atualiza API, SDK ou biblioteca, anote o nome e a versão
  instalada (`package.json`, lockfile) e se a sessão tem MCP de docs (ex.: Context7). Não pesquise a doc
  aqui: o planner cria um nó de pesquisa para isso, e o verificador confere a versão.

Monte o `context` em **≤ 250 palavras**: onde mexer, convenções que importam, comandos de check, falhas
pré-existentes, dependências externas com versão e estado do git. Ele vai no prefixo de todo agente.

## 3. Esforço e teto

Antes de montar os parâmetros, leia a config efetiva — a skill nunca lê o arquivo direto, porque o
workflow não acessa disco:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/graph-config.mjs" --mode <mode> [--effort <nível>] [--ceiling <N>] --json
```

Passe `--effort`/`--ceiling` só quando o usuário deu a flag; sem flag, o CLI usa o arquivo e depois o
padrão de fábrica (`effort: auto`, `ceiling: 24`). A saída é um JSON com `config`, `source` (origem de cada
campo: `flag`/`config`/`default`), `targets` (alvo por nível), `range`, `ask`, `args` (o que embutir no
`Workflow`) e `planGate` (booleano: "sempre pedir aprovação do plano", vindo da config).

- **`ask: true`** (`effort: 'manual'`) **com humano disponível:** pergunte o nível com `AskUserQuestion`,
  4 opções (`low`/`medium`/`high`/`max`), cada uma com a contagem de agentes de `targets` na descrição.
  Embuta a resposta em `args.effort` antes de disparar.
- **`ask: true` sem humano** (a skill foi chamada por outro agente, sem quem responder): use `auto` mesmo
  assim — não pare o workflow no meio para perguntar — e registre em `args.effortSource =
  'manual-fallback'`. No relatório final, deixe explícito que foi o Claude quem decidiu o nível, sem
  humano no plan gate.
- **`effort: 'auto'`:** o planner escolhe o nível e o justifica; a justificativa aparece no plan gate
  (etapa 4) e no `REPORT.md`, não é decisão da skill.
- `maxAgents` é sinônimo de `ceiling` (mesmo campo, mesma validação); no CLI, `--max-agents` vale como
  `--ceiling`, e se vierem os dois, `--ceiling` vence.
- Se `warnings` vier preenchido (campo inválido no arquivo, que voltou ao padrão), diga isso ao usuário em
  uma linha antes de disparar.
- Flag inválida faz o CLI sair com código 1 e o motivo no stderr (ex.:
  `--ceiling 5: mínimo 8 (modo implement)`; o piso segue o modo, e em `research` o mesmo 5 passa). Mostre a mensagem e peça
  outro valor, sem disparar.

## 4. Parâmetros

| arg            | valor                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`         | a tarefa refinada, com as respostas da etapa 1 embutidas                                                                                                |
| `mode`         | `implement` (código) · `architecture` (decisão/ADR) · `research` · `review` (read-only) · `auto`                                                        |
| `effort`       | `manual` · `auto` (padrão) · `low` · `medium` · `high` · `max` — vem da etapa 3                                                                          |
| `ceiling`      | teto de agentes (padrão de fábrica 24) — vem da etapa 3; `maxAgents` é sinônimo                                                                          |
| `economy`      | `balanced` (padrão, Sonnet nos workers) · `lean` (`--lean`, também Sonnet no design) · `max` (`--max`, tudo no modelo da sessão) — só escolhe **modelo**, não teto |
| `spec`         | caminho absoluto da spec, se houver                                                                                                                     |
| `doneWhen`     | critérios de aceite da spec, literais (trava o critério de pronto)                                                                                      |
| `checks`       | comandos de check para implement, ex.: `["npm run typecheck", "npm test"]`; vazio em research/review                                                    |
| `runId`        | `$(date +%Y%m%d-%H%M)-<slug de 3-4 palavras>`                                                                                                           |
| `runDir`       | caminho **absoluto** `<raiz-do-repo>/.graph-runs/<runId>`                                                                                               |
| `runsRoot`     | `<raiz-do-repo>/.graph-runs`, a memória entre runs (`INDEX.md`)                                                                                         |
| `context`      | o resultado da etapa 2                                                                                                                                  |

Prepare o diretório. O `.git/info/exclude` ignora a pasta localmente, sem tocar no `.gitignore` versionado:

```bash
ROOT=$(git rev-parse --show-toplevel) && mkdir -p "$ROOT/.graph-runs/<runId>" \
  && EX=$(git rev-parse --git-path info/exclude) \
  && (grep -qxF '.graph-runs/' "$EX" || echo '.graph-runs/' >> "$EX")
```

Fora de um repo git, use `~/.claude/graph-runs/<nome-da-pasta>/<runId>`.

Ajuste fino opcional: `width`, `maxNodes`, `maxRounds`, `maxRepairs` e `workerModel` (`null` põe o
executor no modelo da sessão). `width` e `maxNodes` derivam do alvo (etapa 3); só force um valor próprio
se o usuário pedir explicitamente.

## 5. Plan gate (1 agente)

Ligue com `--plan-gate`, quando `planGate` da config vier `true`, e por conta própria quando a tarefa
tocar em auth, dinheiro, dados/migrations, config de produção ou API pública:

1. `Workflow({name: 'graph-eng:graph-eng', args: {...args, planOnly: true}})` devolve `plan` (goal, doneWhen,
   premissas, nós, `effort` com nível e justificativa quando `auto`), `questions`, `estimate` (`target`,
   `ceiling`, agentes no caminho feliz em `happyPath`), `rails` (as correções dos trilhos: nó injetado,
   dependência ganha ou retirada, corte por máximo de nós e, no `auto`, a subida de nível quando o plano não
   coube no nível escolhido) e `graph` (mermaid).
2. Mostre o plano **desenhado**: rode
   `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf da run planOnly> --economy <preset> --mode <mode> --effort <effort> --ceiling <ceiling> --no-color`
   e cole num bloco de código. Se o graph-watch falhar, use o `graph` (mermaid). Liste em
   seguida as **premissas**, o **esforço** (nível, fonte e por quê, se `auto`) e a **estimativa** (alvo
   e teto). Depois decida **só com AskUserQuestion**, nunca em texto corrido:
   - uma pergunta "Aprova o plano?" com as opções `Aprovar e rodar` · `Editar nós` ·
     `Cancelar`. A edição chega pelo campo Other ou pelas notas;
   - uma pergunta "As premissas estão certas?" com as opções `Todas certas` · `Corrigir alguma`;
   - uma pergunta por item de `questions` do plano, com 2-4 opções concretas;
   - se quiser trocar o nível de esforço aqui, é outra pergunta, com as opções `low`/`medium`/`high`/`max`.
3. Reinvoque com `args.plan = <plano aprovado>` e as respostas embutidas na `task`; se o nível de esforço
   mudou no gate, também `args.effort = <novo nível>`. O planner não roda de novo.

## 6. Executar

**Antes de cada `Workflow(...)`** (o disparo inicial ou o de uma retomada/refazer da seção "Ações sobre
uma run"), grave `args` com a ferramenta Write em `<runDir>/args.json`: é dali que
`bin/graph-resume.mjs` monta a retomada quando nenhum `resume/<rs>.json` ainda existe (D2 §5.1).

```js
Workflow({ name: 'graph-eng:graph-eng', args: { task, mode, effort, ceiling, economy, spec, doneWhen, runDir, runsRoot, runId, context, checks } })
```

Passe `args` como objeto JSON, não como string. O workflow roda em **background**: o retorno da
chamada **não** é o fim da run.

O retorno da chamada traz o id da run (`wf_…`, na linha antes de `Script file:`) **e o id da task** em
background que o executa. Guarde os dois junto do `<wf>`: **todo** comando de `graph-watch` abaixo leva
`--run <wf>`, e o id da task é o que "Ações sobre uma run" usa no `TaskStop` de um `parar` ou de um
`retomar`/`refazer` disparado nesta mesma sessão. Se o retorno não trouxer o id do wf, use
`--run-id <runId>` no lugar de `--run <wf>`. Nunca rode o graph-watch sem um dos dois.
`<preset>` e `<mode>` são os mesmos `args.economy` e `args.mode` passados ao Workflow; passe também
`--effort <effort> --ceiling <ceiling>` nos comandos do graph-watch abaixo para o cabeçalho e a
estimativa mostrarem o alvo certo.

0. Suba o painel web desacoplado da sessão, **idempotente** (uma instância só por máquina; se já houver
   uma no ar na porta padrão, o comando sai na hora reaproveitando ela em vez de abrir outra). Rode
   **sem** `run_in_background`: o `--detach` solta o servidor num processo próprio e sai na hora, e é
   isso que faz o painel seguir no ar quando a tarefa ou a sessão fecha:
   ```
   Bash({ command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" ui --detach --no-open' })
   ```
   Leia a porta real na linha `graph-eng: painel: http://127.0.0.1:<porta>` da saída — **nunca
   chute a porta**: o padrão é 4477, mas o usuário pode ter trocado com `GRAPH_ENG_PORT` (o comando
   já respeita a variável). Se a saída disser que a porta está ocupada por outro programa, avise o
   usuário em uma linha que dá para fixar outra com `"env": {"GRAPH_ENG_PORT": "<N>"}` no
   `~/.claude/settings.json` e siga sem painel. Essa é a
   base da URL que entra em todo marco `⏳ RODANDO`/`✅ TERMINADO` a seguir. Se o comando falhar
   ou não imprimir a linha, siga sem painel e sem o trecho "· veja ao vivo em ..." nos marcos: a
   run continua normalmente, o painel é só conveniência.
1. Responda em até 4 linhas, começando por
   `⏳ RODANDO — graph-eng <runId> · k/N prontos · veja ao vivo em http://127.0.0.1:<porta>/?run=<wf>`
   (troque `<porta>` e `<wf>` pelos valores reais; omita o trecho "· veja ao vivo..." só se o
   painel não subiu no item 0): estimativa, teto, paper trail e, se preferir o grafo em texto
   **num terminal à parte** (aba ou split na CLI; "Terminal: Split" no VSCode), o comando
   `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" live --run <wf> --economy <preset> --mode <mode> --effort <effort> --ceiling <ceiling>`
   (`live --svg` é um alias que garante o painel subindo e imprime o mesmo link).
2. Arme o Monitor com este comando literal:
   ```
   Monitor({ description: "graph-eng <runId>", timeout_ms: 1800000,
             command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" events --run <wf> --economy <preset> --mode <mode> --effort <effort> --ceiling <ceiling>' })
   ```
   Se ele expirar antes de `TERMINADO`, rearme com o **mesmo** comando.
3. **Enquanto não chegar `TERMINADO` ou a notificação de conclusão do workflow, toda resposta
   começa com
   `⏳ RODANDO — graph-eng <runId> · k/N prontos · veja ao vivo em http://127.0.0.1:<porta>/?run=<wf>`
   (omita o trecho do painel se ele não subiu).** Não escreva "pronto", "terminei"
   nem "concluído" sobre a tarefa, e não resuma resultado de nó como se fosse final. Um
   `erro: nenhuma run do graph-eng` do Monitor **não** é fim da run: siga como no item 6.
4. "Como está?": rode via Bash
   `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf> --economy <preset> --mode <mode> --effort <effort> --ceiling <ceiling> --no-color`
   e cole a saída num bloco de código. Sobre um nó, rode
   `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" agent <id> --run <wf> --no-color`
   e cole a saída. Não faça polling por conta própria: o Monitor e a notificação final bastam.
5. Onde abrir cada agente: no terminal, `/workflows` → run → fase → agente (prompt, tool calls
   recentes e resultado). No VSCode, o agent map (contador de agentes no prompt ou `/tasks`). Em
   qualquer lugar, o comando `agent` do item 4.
6. Se o graph-watch sair com `erro` (formato não reconhecido, run não achada), siga sem ele:
   só a notificação de conclusão do Workflow e o `/workflows`. Continue com ⏳ RODANDO até essa
   notificação chegar.

## 7. Entregar (gate humano)

1. Leia `<runDir>/REPORT.md`.
2. Abra a resposta com
   `✅ TERMINADO — graph-eng <runId> · <status> · veja ao vivo em http://127.0.0.1:<porta>/?run=<wf>`
   (omita o trecho do painel se ele não subiu no item 0). Siga curto: o que mudou ou
   o que achou · decisões · o que falhou ou ficou aberto (`openGaps` e nós `failed` com os
   `blocking`) · custo (`stats.agents` contra a estimativa) · o grafo final (a saída de
   `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf> --economy <preset> --mode <mode> --effort <effort> --ceiling <ceiling> --no-color`
   num bloco de código, ou o mermaid do REPORT como reserva).
3. **Premissas e gate humano vão por AskUserQuestion, não em prosa:**
   - uma pergunta "Confirma as premissas?", listando as premissas que mudam comportamento, com
     as opções `Confirmo` · `Alguma está errada`;
   - uma pergunta por item de `humanGate` que exige ação (commit, deploy, migration, publicar),
     com as opções `Aprovo` · `Ainda não` · `Quero ver o diff`;
   - se voltar `partial` ou houver `openGaps`: "Rodar mais um round focado nos gaps?", com as
     opções `Sim` · `Não`.
4. Em implement, mostre o `git diff --stat` contra o baseline da etapa 2.
5. **Nunca** faça commit, push, deploy ou migration remota por conta própria. Isso é o gate, e é do usuário.
6. **Depois do TERMINADO, a sessão segue ouvindo o painel por até 2 h**, para atender um `resume` ou
   `rerun-node` desta run sem o usuário precisar colar nada: rearme o `events` da etapa 6.2 até 4 vezes,
   em silêncio (sem avisar o usuário a cada rearme). Depois do 4º, ou se o Monitor sumir por mais de
   2 min sem rearme (por qualquer motivo, não só o timeout), o painel passa a mostrar "nenhuma sessão
   ouvindo" para esta run, e só o "Copiar comando" (seção "Ações sobre uma run") continua valendo.

## Recuperação

- **Interrompido:** use `bin/graph-resume.mjs` (a mesma trava e o mesmo `Workflow(...)` da seção "Ações
  sobre uma run", passo 3-4), **em qualquer sessão** — inclusive uma nova. É o caminho recomendado: ele
  não refaz nó pronto. `Workflow({scriptPath, resumeFromRunId})` com os mesmos args **só** continua
  valendo na mesma sessão, com o mesmo script, e antes do primeiro fan-out paralelo: o cache é por
  prefixo das chamadas, não por nó, e depois do fan-out a ordem muda na retomada, refazendo boa parte do
  que já rodou (não pare uma run paralela só para mudar args por essa via; deixe seguir e corrija depois).
- **Esc no turno principal derruba a run em background.** Mandar mensagem sem Esc não interrompe.
- **Resultado estranho:** rode
  `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf> --economy <preset> --mode <mode> --effort <effort> --ceiling <ceiling> --no-color`
  e `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" agent <id> --run <wf> --no-color` antes de
  diagnosticar. Leia o `journal.jsonl` cru só se o graph-watch não reconhecer o formato.
- **Nó pulado ou `blocked` por orçamento:** rode de novo com `effort` maior ou `ceiling` maior. `economy`
  não muda o orçamento, só o modelo.
- **Não ligue ultracode junto.** Ele desliga o aviso de workflow grande e troca de propósito o teto pelo
  máximo de tokens.
