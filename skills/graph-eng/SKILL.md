---
name: graph-eng
description: Graph engineering enxuto. Orquestra uma tarefa complexa como um grafo pequeno de agentes, na sequência planner → workers (leitura em paralelo, escrita em raia única, executor barato) → verificador independente e forte → reparo → critic em loop até os critérios de pronto fecharem → relatório com gate humano. Gasta ~6-20 agentes, e não 100+. Use quando o usuário pedir explicitamente "grafo", "graph", "graph eng", "graph engineering", "graph-eng", "roda em loop até ficar pronto" ou "faz isso com agentes/workflow" para uma tarefa complexa (feature com várias partes, refactor amplo, arquitetura de sistema, investigação profunda, auditoria). NÃO use em tarefa de um passo (explicar um arquivo, mudar uma linha, renomear), onde o grafo só custa mais.
argument-hint: "[--lean|--max] [--plan-gate] [--spec <arquivo>] [research|architecture|implement|review] <tarefa>"
---

# graph-eng

Dispara o workflow `graph-eng:graph-eng`, que o plugin registra a partir de `workflows/graph-eng.js`.
Se o Workflow tool não reconhecer o nome, passe `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/graph-eng.js"`
no lugar de `name`. Invocar esta skill é o opt-in do usuário para rodar esse workflow. A fundamentação de
cada decisão, com fontes, está em [DESIGN.md](DESIGN.md).

```
PLAN ─▶ [ DAG: work ─▶ gate de checks ─▶ verify ⇄ repair ] ─▶ CRITIC ─┬─ done ──▶ SYNTH ─▶ gate humano (você)
            ▲                                                         │
            └────────────────── gaps = novos nós ─────────────────────┘   (até maxRounds, ou sem gap novo)
```

## Seleção de agentes

Quem escolhe os nós é o **planner**, a partir da tarefa. Quem escolhe o modelo de cada nó é o **script**,
por papel e risco. Nada é deixado ao acaso: sem pin explícito, o subagente herdaria o modelo caro da sessão.

| Papel                       | Quantos                                | Modelo (`balanced`)            | Esforço                     |
| --------------------------- | -------------------------------------- | ------------------------------ | --------------------------- |
| planner                     | 1                                      | sessão                         | high                        |
| worker `research`           | 1 por nó                               | Sonnet                         | medium                      |
| worker `implement`          | 1 por nó, **um de cada vez**           | Sonnet                         | medium                      |
| worker `design`             | 1 por nó                               | sessão                         | medium                      |
| `explore` (decisão central) | 2 rascunhos opostos + 1 juiz           | rascunhos por tipo, juiz sessão | medium / high              |
| verificador                 | 1 por nó arriscado                     | **sessão**                     | medium (high no risco alto) |
| 2º voto                     | só se o verificador ficar em dúvida    | sessão, outra lente            | high                        |
| reparo                      | ≤2 por nó; o último sobe para a sessão | Sonnet → sessão                | medium → high               |
| critic                      | 1 por round                            | sessão                         | high                        |
| synth                       | 1                                      | Sonnet                         | medium                      |

A regra é **executor barato, revisor forte**. O revisor precisa ser pelo menos tão forte quanto quem gerou,
porque revisor mais fraco piora o resultado. Três exceções sobem tudo para o modelo da sessão:

- nó de **risco alto** (auth, dinheiro, dados/migrations, API pública, config de produção);
- tarefa **trivial**, em que o modelo forte direto sai mais barato do que errar;
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

## 3. Parâmetros

| arg           | valor                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`        | a tarefa refinada, com as respostas da etapa 1 embutidas                                                                                                |
| `mode`        | `implement` (código) · `architecture` (decisão/ADR) · `research` · `review` (read-only) · `auto`                                                        |
| `economy`     | `balanced` (padrão, ≤24 agentes, largura 3) · `lean` (`--lean`, ≤12, largura 2) · `max` (`--max`, ≤48, tudo no modelo da sessão)                        |
| `spec`        | caminho absoluto da spec, se houver                                                                                                                     |
| `doneWhen`    | critérios de aceite da spec, literais (trava o critério de pronto)                                                                                      |
| `checks`      | comandos de check para implement, ex.: `["npm run typecheck", "npm test"]`; vazio em research/review                                                    |
| `runId`       | `$(date +%Y%m%d-%H%M)-<slug de 3-4 palavras>`                                                                                                           |
| `runDir`      | caminho **absoluto** `<raiz-do-repo>/.graph-runs/<runId>`                                                                                               |
| `runsRoot`    | `<raiz-do-repo>/.graph-runs`, a memória entre runs (`INDEX.md`)                                                                                         |
| `context`     | o resultado da etapa 2                                                                                                                                  |

Prepare o diretório. O `.git/info/exclude` ignora a pasta localmente, sem tocar no `.gitignore` versionado:

```bash
ROOT=$(git rev-parse --show-toplevel) && mkdir -p "$ROOT/.graph-runs/<runId>" \
  && EX=$(git rev-parse --git-path info/exclude) \
  && (grep -qxF '.graph-runs/' "$EX" || echo '.graph-runs/' >> "$EX")
```

Fora de um repo git, use `~/.claude/graph-runs/<nome-da-pasta>/<runId>`.

Ajuste fino opcional: `maxAgents`, `width`, `maxNodes`, `maxRounds`, `maxRepairs` e `workerModel`
(`null` põe o executor no modelo da sessão).

## 4. Plan gate (1 agente)

Ligue com `--plan-gate`, e por conta própria quando a tarefa tocar em auth, dinheiro, dados/migrations,
config de produção ou API pública:

1. `Workflow({name: 'graph-eng:graph-eng', args: {...args, planOnly: true}})` devolve `plan` (goal, doneWhen,
   premissas, nós), `questions`, `estimate` (agentes no caminho feliz e teto) e `graph` (mermaid).
2. Mostre o plano **desenhado**: rode
   `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf da run planOnly> --economy <preset> --mode <mode> --no-color`
   e cole num bloco de código. Se o graph-watch falhar, use o `graph` (mermaid). Liste em
   seguida as **premissas** e a **estimativa** (caminho feliz e teto). Depois decida **só com
   AskUserQuestion**, nunca em texto corrido:
   - uma pergunta "Aprova o plano?" com as opções `Aprovar e rodar` · `Editar nós` ·
     `Cancelar`. A edição chega pelo campo Other ou pelas notas;
   - uma pergunta "As premissas estão certas?" com as opções `Todas certas` · `Corrigir alguma`;
   - uma pergunta por item de `questions` do plano, com 2-4 opções concretas.
3. Reinvoque com `args.plan = <plano aprovado>` e as respostas embutidas na `task`. O planner não roda de novo.

## 5. Executar

```js
Workflow({ name: 'graph-eng:graph-eng', args: { task, mode, economy, spec, doneWhen, runDir, runsRoot, runId, context, checks } })
```

Passe `args` como objeto JSON, não como string. O workflow roda em **background**: o retorno da
chamada **não** é o fim da run.

O retorno da chamada traz o id da run (`wf_…`, na linha antes de `Script file:`). Guarde-o como
`<wf>`: **todo** comando abaixo leva `--run <wf>`. Se o retorno não trouxer o id, use
`--run-id <runId>` no lugar de `--run <wf>`. Nunca rode o graph-watch sem um dos dois.
`<preset>` e `<mode>` são os mesmos `args.economy` e `args.mode` passados ao Workflow.

1. Responda em até 4 linhas, começando por `⏳ RODANDO — graph-eng <runId>`: estimativa, teto,
   paper trail e o comando para ver o grafo ao vivo **num terminal à parte** (aba ou split na
   CLI; "Terminal: Split" no VSCode):
   `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" live --run <wf> --economy <preset> --mode <mode>`
   (acrescente `--svg` para a visão no browser, se o `d2` estiver instalado).
2. Arme o Monitor com este comando literal:
   ```
   Monitor({ description: "graph-eng <runId>", timeout_ms: 1800000,
             command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" events --run <wf> --economy <preset> --mode <mode>' })
   ```
   Se ele expirar antes de `TERMINADO`, rearme com o **mesmo** comando.
3. **Enquanto não chegar `TERMINADO` ou a notificação de conclusão do workflow, toda resposta
   começa com `⏳ RODANDO — graph-eng <runId> · k/N prontos`.** Não escreva "pronto", "terminei"
   nem "concluído" sobre a tarefa, e não resuma resultado de nó como se fosse final. Um
   `erro: nenhuma run do graph-eng` do Monitor **não** é fim da run: siga como no item 6.
4. "Como está?": rode via Bash
   `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf> --economy <preset> --mode <mode> --no-color`
   e cole a saída num bloco de código. Sobre um nó, rode
   `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" agent <id> --run <wf> --no-color`
   e cole a saída. Não faça polling por conta própria: o Monitor e a notificação final bastam.
5. Onde abrir cada agente: no terminal, `/workflows` → run → fase → agente (prompt, tool calls
   recentes e resultado). No VSCode, o agent map (contador de agentes no prompt ou `/tasks`). Em
   qualquer lugar, o comando `agent` do item 4.
6. Se o graph-watch sair com `erro` (formato não reconhecido, run não achada), siga sem ele:
   só a notificação de conclusão do Workflow e o `/workflows`. Continue com ⏳ RODANDO até essa
   notificação chegar.

## 6. Entregar (gate humano)

1. Leia `<runDir>/REPORT.md`.
2. Abra a resposta com `✅ TERMINADO — graph-eng <runId> · <status>`. Siga curto: o que mudou ou
   o que achou · decisões · o que falhou ou ficou aberto (`openGaps` e nós `failed` com os
   `blocking`) · custo (`stats.agents` contra a estimativa) · o grafo final (a saída de
   `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf> --economy <preset> --mode <mode> --no-color`
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

## Recuperação

- **Interrompido:** `Workflow({scriptPath, resumeFromRunId})`. Os agentes já concluídos voltam do cache.
- **Resultado estranho:** rode
  `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf> --economy <preset> --mode <mode> --no-color`
  e `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" agent <id> --run <wf> --no-color` antes de
  diagnosticar. Leia o `journal.jsonl` cru só se o graph-watch não reconhecer o formato.
- **Nó `blocked` por orçamento:** rode de novo com `economy: 'max'` ou com `maxAgents` maior.
- **Não ligue ultracode junto.** Ele desliga o aviso de workflow grande e troca de propósito o teto pelo
  máximo de tokens.
