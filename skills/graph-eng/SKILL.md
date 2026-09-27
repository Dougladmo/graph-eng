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
2. Mostre tudo ao usuário, faça as `questions` com AskUserQuestion e deixe ele aprovar ou editar.
3. Reinvoque com `args.plan = <plano aprovado>` e as respostas embutidas na `task`. O planner não roda de novo.

## 5. Executar

```js
Workflow({ name: 'graph-eng:graph-eng', args: { task, mode, economy, spec, doneWhen, runDir, runsRoot, runId, context, checks } })
```

Passe `args` como objeto JSON, não como string. O workflow roda em background: avise em uma linha a
estimativa, o teto e onde fica o paper trail, e **não faça polling**, porque a notificação chega sozinha.

## 6. Entregar (gate humano)

1. Leia `<runDir>/REPORT.md`.
2. Responda curto: **status** · o que mudou ou o que achou · decisões · **premissas assumidas** (para o
   usuário confirmar) · o que falhou ou ficou aberto (`openGaps` e nós `failed` com os `blocking`) ·
   **gate humano** (`humanGate`) · custo (`stats.agents` contra a estimativa).
3. Em implement, mostre o `git diff --stat` contra o baseline da etapa 2.
4. **Nunca** faça commit, push, deploy ou migration remota por conta própria. Isso é o gate, e é do usuário.
5. Se voltar `partial` ou houver `openGaps`, ofereça mais uma rodada: nova run com a tarefa focada nos
   gaps e `context` apontando para o REPORT.md anterior.

## Recuperação

- **Interrompido:** `Workflow({scriptPath, resumeFromRunId})`. Os agentes já concluídos voltam do cache.
- **Resultado estranho:** leia `journal.jsonl` no diretório de transcript da run antes de diagnosticar.
- **Nó `blocked` por orçamento:** rode de novo com `economy: 'max'` ou com `maxAgents` maior.
- **Não ligue ultracode junto.** Ele desliga o aviso de workflow grande e troca de propósito o teto pelo
  máximo de tokens.
