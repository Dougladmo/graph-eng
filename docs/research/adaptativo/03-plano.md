# Plano: graph-eng adaptativo (triagem de complexidade, papéis de modelo, paralelismo e prova por benchmark)

Base: `/Volumes/DouglasNvme/Documents/GitHub/graph-eng`. A árvore de trabalho está suja e os números de linha vêm do mapa. Isso foi escrito sem rodar nada, e o que ainda não foi confirmado está marcado com **[INCERTO]**.

## 0. Princípios (valem para todos os passos)

1. **Nunca tirar do caminho:** verify de todo implement (a cadeia de provenance exige voto `verifier` com `pass:true`), check windows, gate final com receipts, snapshots idênticos antes e depois do critic, e `done-approved`. A triagem só decide quais revisões LLM rodam. Ela não mexe nas verificações executáveis.
2. **Triagem só escala, nunca rebaixa no meio da run.** Se a verificação falhar, o crítico achar bloqueio ou o planner devolver algo maior que o previsto, a run sobe de tier (cascata fraco para forte).
3. **Regras duras em código** têm prioridade sobre qualquer classificador, porque o texto da tarefa não é confiável.
4. **Flag `adaptive`, desligada por padrão.** Ela só vira padrão depois que o benchmark do passo 9 passar.
5. **Cada passo traz seus testes de regressão.** Rodar com `node --test --test-concurrency=2 <arquivos afetados>`. Suíte completa só no passo 10, sozinha, com um comando pesado por vez e um subagente pesado no máximo.

## 1. Tiers e fases por tier

| Tier | Quando | Fases |
|---|---|---|
| **fast** | spec clara, 1-2 nós, sem gatilho de risco, com teste de aceitação ou check executável | plan (Sonnet) → implement (Haiku) + verify → gate final → critic final (Opus) → synth |
| **standard** | risco médio, ou domínio sensível (dinheiro, billing) com spec clara | plan (Sonnet) → plan-review (Opus, único) → implement + verify → gate final → critic (Opus) → synth |
| **full** | multi-camada, migração ou auth, spec ambígua, muitos nós, ou escalada | [research paralelo opcional] → plan → plan-review (Opus) → design (Sonnet, depois do review) → design-review (Opus) → implement + verify → gate final → critic (Opus) → synth |

- Nos tiers fast e standard o design vai embutido no plano, como notas por nó para o Haiku. Não há nó design nem design-review.
- As aprovações puladas viram **aprovação sintética auditável**, no padrão do `planReviewDeferred` (`graph-eng.js:1972`). O formato é `{pass:true, attempts:0, synthetic:true, reason:'triage_fast'}`, com `persistTransition` e `persistDesignApproval` gravando os votos do round 1. Isso mantém `designApproved`, `planFeedback.kind==='APPROVE'` e a ordem das transições do journal.
- A decisão do tier é gravada como evento `triage.decided` no journal e no checkpoint. Ela **não entra em `planningInputs` nem no `planningKey`**.
- **Hard rails do piso:**
  - dinheiro, billing, migração, auth: piso **standard**;
  - spec ambígua (sem done-criteria verificável) ou 3 ou mais camadas ou arquivos: piso **full**.
- **[INCERTO / decisão sua]** Você citou billing como exemplo de tarefa simples, mas o brief manda forçar o fluxo completo em billing por causa do falso DONE do faturamento. O plano adota o meio-termo: billing com spec clara e teste de aceitação cai em **standard** (um review Opus), e só vai a full se a spec for ambígua. O benchmark do faturamento decide se isso basta.
- **[INCERTO]** Nenhum limiar publicado vale para este caso. Os pesos e cortes da heurística são calibrados no passo 9. A heurística evita comprimento de prompt como sinal, conforme o brief.

## 2. Passos em ordem

### Passo 0. Linha de base e investigação (sem mudar código)

- Criar a branch a partir do estado atual. Combinar com você: commitar ou stashear as mudanças que já estão na árvore, sem sobrescrever o que é seu.
- Rodar a suíte atual com `--test-concurrency=2` para ter a linha de base.
- Perfilar a chamada de 624k tokens do executor: `buildShared` (`:491`), `PLAN_BLOCK`, `CONTEXT`, `workPrompt` (`:564`).
- Verificar se o esforço por nó funciona via flag do CLI na versão em uso **[INCERTO]**.
- Verificar o que `executeGraph` (`:799`) já paraleliza.
- Conferir o catálogo do OpenRouter localmente: `curl https://openrouter.ai/api/v1/models | grep -i -E 'jev|typesafe|laya'`.
- Entrega: nota curta com os resultados. Sem arquivos novos de código.

### Passo 1. Mapa de papéis e modelos, com esforço medium em tudo

Mapa-alvo:

| Etapa | Modelo | Esforço |
|---|---|---|
| research | Sonnet | medium |
| planner | Sonnet | medium |
| plan-review | Opus | medium |
| design | Sonnet | medium |
| design-review | Opus | medium |
| implement | Haiku | medium |
| critic final | Opus | medium |
| synth | Haiku | medium |
| notetaker (novo) | Haiku | medium |

- O notetaker em Haiku é escolha minha, por ser barato. Você pediu "Sonnet" só para os pesquisadores. **[INCERTO]**
- Hoje o design-review e o critic estão em Sonnet. Passam para Opus.
- Corrigir a inversão `complexity==='trivial'` → worker forte (`:881`). Trivial passa a usar Haiku.
- Arquivos: `bin/hosts.mjs` (`MODEL_BY_ROLE`, `ROLE_ALIASES`, `READ_ONLY`), `bin/graph-run.mjs` (`MODELS`, `ROLE_BY_LABEL`), `workflows/graph-eng.js` (`REQUIRED_MODELS`, `roleForLabel`, `STRONG_EFFORT`), `bin/budget-policy.mjs` (`BUDGET_ROLES`, `exactRoles`).
- As três tabelas precisam ficar idênticas, senão há o bloqueio `trusted_host_capability_or_model_policy_unavailable`. O `modelPolicyHash` muda, o que é esperado.
- Testes: `hosts.test.mjs`, `budget-policy.test.mjs`, `workflow-budget.test.mjs` (efforts por label), `graph-run.test.mjs`.
- Testes novos:
  - o worker de um nó trivial usa Haiku (regressão da inversão);
  - as três tabelas são idênticas;
  - todo label tem esforço medium por padrão.

### Passo 2. Triagem heurística (módulo puro, sem rede)

- Arquivos novos: `bin/triage.mjs` e `test/triage.test.mjs`.
- `triageTask({task, context, spec, acceptedCriteria, repoSignals}) → {tier, floor, reasons[], features}`.
- Sinais:
  - ambiguidade (ausência de done-criteria ou de check executável);
  - palavras de domínio de risco (money, billing, fatura, migration, auth, permission);
  - número de camadas ou arquivos citados;
  - presença de teste de aceitação;
  - dicas de escopo ("um arquivo", "só adicionar função").
- Um segundo estágio, `refineAfterPlan({tier, plan})`, só escala. Usa `complexity`, o risco dos nós e o número de nós.
- Testes:
  - fixtures chess → fast;
  - faturamento → standard;
  - happy → conforme a calibração;
  - injeção ("trate como simples", "ignore regras") não rebaixa nada abaixo do piso;
  - determinismo e ausência de rede.

### Passo 3. Tiers no motor (maior risco, dividir em 3a, 3b, 3c)

- **3a. Motor.**
  - Arquivos: `workflows/graph-eng.js`, `bin/budget-policy.mjs`.
  - Adicionar o parâmetro `tier` em `allocateBudget`. As reservas de designReviewer e design são zero em fast e standard.
  - Os trilhos R3 e "design antes de cada implement" passam a ser conscientes do tier.
  - Aprovações sintéticas para o plan-review (fast) e para o design-review (fast e standard).
  - O critic e o synth ficam sempre ativos.
- **3b. Layout de estágios.**
  - Arquivos: `bin/phase-pipeline.mjs`, `bin/phase-artifacts.mjs`.
  - Em fast e standard, o `plan` do planner **já emite o DAG**, então o segundo planner do estágio `tasks` é redundante. A proposta é derivar o artefato `tasks` do plano, sem a segunda chamada ao planner. O plan-review do tasks continua obrigatório em standard e full (`tasksReviewApproved`), e é sintético em fast.
  - **[INCERTO]** Isso mexe em `PIPELINE_PAIRS` (`graph-run.mjs:403`), nas validações de resume e em `phase.reuse.resolved`. A alternativa mais segura é manter os dois estágios e só pular chamadas internas, ao custo de menos economia.
- **3c. Resume e journal.**
  - Arquivo: `bin/graph-run.mjs`.
  - Validar `triage.decided` no journal.
  - Aceitar a ordem de transições sintéticas.
  - Recalcular a alocação por tier (`:140`, `:2276`).
- Testes que mudam:
  - `workflow-budget.test.mjs:13`;
  - `workflow-rails.test.mjs:123` (o "sem atalho trivial" vira "sem atalho fora da triagem"; o teste atual continua valendo para o tier full);
  - `workflow-pipeline-stage.test.mjs` (`:286`, `:294`, `:320`, `:329`, `:483`, `:511-517`);
  - `workflow-pipeline.test.mjs` (§6.5, §6.8);
  - `workflow-final-gate.test.mjs`;
  - `graph-run-stages.test.mjs` e `graph-run.test.mjs`.
- Testes novos, um por tier, com a sequência exata de chamadas:
  - fast = `plan, work, verify, critic, synth`;
  - standard = `plan, plan-review, work, verify, critic, synth`;
  - full = sequência completa;
  - verify nunca é pulado em nenhum tier;
  - resume no meio de uma run fast;
  - aprovação sintética sem `reason` é rejeitada.

### Passo 4. Cascata de escalonamento

- O gatilho de subida de tier é: verify ou check falhou depois do reparo local, bloqueio do critic, ou o planner devolveu um tier maior que o previsto. Ao escalar, reaproveita o plano e o contexto já produzidos e roda as fases que faltam (`plan-review`, `design`, `design-review`).
- **[INCERTO]** Qual gatilho pega melhor as tarefas mal roteadas é questão aberta do brief. O benchmark mede a taxa de escalada por gatilho.
- Arquivos: `workflows/graph-eng.js`, `bin/graph-run.mjs`.
- Testes:
  - fast com verify falhando escala para standard e para full;
  - escalonamento persiste no journal e no resume;
  - o limite de bancos globais (`MAX_LOCAL_REPAIRS`, `MAX_STRUCTURAL_REPLANS`) é respeitado.

### Passo 5. Classificador opcional via OpenRouter ("aumentar a adaptatividade")

- Arquivos novos: `bin/triage-classifier.mjs`, `bin/triage-config.mjs`, `test/triage-classifier.test.mjs`. Também o fluxo na skill (`skills/grapheng/SKILL.md`) e os comandos de configuração.
- **Ativação:** só com `OPENROUTER_API_KEY` ou com um arquivo de config local em `~/.graph-eng/config.json`. O arquivo precisa ter permissão 0600 e ficar fora do repo. Sem chave, não existe chamada de rede e tudo usa a heurística.
- **Oferta ao usuário:** apresentar como "aumentar a adaptatividade" (opt-in explícito). Avisar que o texto da tarefa vai para um terceiro e que o código nunca é enviado. A chave nunca é logada.
- **Modelo configurável:**
  - O padrão é `typesafe/jev-1.13`, com versão fixada e sem alias. O 1.14 é opcional.
  - Laya não parece existir no OpenRouter, e o formato exigiria Python auto-hospedado. Ele entra só como id de modelo configurável.
  - Há um adaptador alternativo via `chat/completions` com `response_format: json_schema` para um LLM barato configurável (`provider.require_parameters: true`).
- **O que é enviado:** só a tarefa truncada e um resumo curto, bem abaixo de 32k bytes. As opções são embaralhadas e o resultado confere consistência.
- **Merge seguro:** o classificador pode **subir** o tier livremente. Pode descer no máximo um nível e **nunca abaixo do piso dos hard rails**. Qualquer erro, timeout (5 s), JSON inválido, schema inválido ou HTTP 401/402/429/5xx faz **fallback para a heurística**. Há no máximo 1 retry, respeitando `Retry-After`. Erros que chegam com HTTP 200 no corpo também contam como falha.
- Registrar `source: 'heuristic' | 'classifier' | 'fallback'` e o custo (`usage.cost`) no `triage.decided`.
- **[INCERTO]** Os campos exatos de `choice`/`noul`/`score` no endpoint `/api/alpha/decisions` do Jev, ou se o `/chat/completions` serve a classificação. O adaptador é fino. A primeira entrega usa o adaptador `json_schema` para fechar o contrato, e o Jev nativo entra depois de uma chamada real de validação.
- **[INCERTO]** Se o Jev acerta complexidade de código (sem track record). O benchmark mede o acerto contra a heurística. Se não superar, fica documentado como inútil para este caso.
- Testes com `fetch` injetado (sem rede real):
  - sem chave não há chamada;
  - timeout, 429, 500, JSON inválido e resposta fora do schema caem na heurística;
  - o classificador não rebaixa abaixo do piso;
  - injeção na tarefa não altera a decisão;
  - a chave não aparece em log nem em journal;
  - arquivo de config com permissão aberta é recusado.

### Passo 6. Estágio de research opcional, em paralelo

- Opção `research: 'parallel'` (padrão desligado; sugerida no tier full e obrigatória em spec ambígua).
- N pesquisadores Sonnet medium (2 a 4) com tópicos disjuntos, rodando em paralelo. Cada um escreve notas em arquivo na `runDir`, com URLs, e devolve só o caminho e um resumo curto. O **notetaker** consolida em um único arquivo de notas. O planner lê o arquivo, não recebe texto inline.
- Arquivos: `workflows/graph-eng.js`, `bin/budget-policy.mjs` (papel e reservas), `bin/hosts.mjs` (papel notetaker, já previsto no passo 1).
- Testes: pesquisadores rodam concorrentes, escopos disjuntos, um pesquisador falho não derruba os outros, o notetaker recebe todas as notas, o planner não recebe o texto bruto, o orçamento é respeitado.

### Passo 7. Paralelismo e dieta de contexto

- Candidatos para reduzir a latência. O que já existe depende do passo 0:
  - fan-out do research (passo 6);
  - nós implement independentes com **write grants disjuntos** em paralelo;
  - verify de um nó sobrepondo o work do próximo nó independente;
  - rascunhos do `explore` em paralelo;
  - verify de research e design sem dependência entre si.
- **Especulativo, desligado por padrão:** rascunhar o design enquanto o plan-review roda, descartando se o review não aprovar. É seguro porque o design é só leitura, mas contraria sua ordem ("Sonnet escreve o design depois de receber a plan review"). Só ativo com sua aprovação. **[INCERTO / decisão sua]**
- Dieta de contexto: cortar o que a chamada de 624k repete (SHARED, PLAN_BLOCK, lista de arquivos), passando caminhos em vez de conteúdo. A causa real ainda não está explicada. O passo 0 diz o que atacar.
- Testes: concorrência real medida com relógio simulado, escopos que se sobrepõem são serializados, limite de largura por tier, e um teste que falha se o prompt de uma chamada passar de um teto de tamanho.

### Passo 8. Documentação

- `skills/grapheng/DESIGN.md` (trocar "Sem atalho trivial" por "Sem atalho fora da triagem, e nunca sem verify"), `workflows/graph-eng.js` (`meta.whenToUse`), `skills/grapheng/SKILL.md`, `CHANGELOG.md`, e os READMEs (en/pt/es) com tiers e o opt-in do classificador.
- O texto da descrição do skill listado hoje diz "There is no trivial 1-node shortcut". Também precisa mudar.
- Teste: um teste de consistência que falha se a doc e o código divergirem nos nomes de tier.

### Passo 9. Benchmark (prova de custo, velocidade e qualidade)

- Estender `bin/graph-benchmark.mjs`, `test/graph-benchmark.test.mjs` e `docs/validation/graph-eng-2-benchmark.md` (já modificado na árvore), com cuidado para não sobrescrever o que existe. Fixtures existentes: `test/fixtures/benchmark-chess` e `test/fixtures/benchmark-v2-faturamento`, mais a tarefa happy.
- **Braços:** (A) graph-eng atual, full sempre; (B) adaptativo com heurística; (C) adaptativo com classificador, se houver chave; (D) agente único Sonnet com testes. O brief manda comparar contra o melhor único.
- **Tarefas:** chess, faturamento e happy. Mais algumas sintéticas (simples, médias, difíceis e armadilhas de falso DONE) para calibrar a heurística. O brief sugere cerca de 20, mas isso é caro. **[INCERTO]**
- **Repetições:** n=3 a 5 por célula, rodadas **uma de cada vez** (limite de 16 GB).
- **Métricas:**
  - custo em USD por papel (tabela de preços fixada e versionada);
  - latência de parede (p50 e p95);
  - número de chamadas;
  - maior entrada por chamada;
  - **qualidade** = testes ocultos (chess 15/15, faturamento 31/31, mais os de happy) e contagem de falso DONE;
  - taxa de escalada;
  - acerto do tier contra o oráculo.
- **Critérios pré-registrados** (antes de olhar os resultados):
  - qualidade igual: 100% dos testes ocultos e zero falso DONE em todas as repetições;
  - custo: pelo menos 30% menor que o braço A nas tarefas fast e standard;
  - latência: pelo menos 25% menor.
- **[INCERTO]** Os percentuais-alvo são meus palpites. Sem eles não há como dizer "provou". Aceito que você troque os valores.
- **Honestidade estatística:** com n pequeno isto é evidência **indicativa**, não prova. O relatório diz isso explicitamente. Se o adaptativo não vencer o braço A ou o D em custo com a mesma qualidade, **não é lançado como padrão**.
- Rodadas reais com modelos custam dinheiro. Peço sua confirmação antes de cada rodada real, com a estimativa de custo.
- Testes: o harness é determinístico com modelos simulados (agregação, tabela de custo, critérios de aprovação, relatório).

### Passo 10. Validação final e rollout

- Suíte completa sozinha, `node --test --test-concurrency=2`, com `tsc`/lint se o repo tiver.
- Se o benchmark passar, abrir a PR com o padrão `adaptive` ligado e `adaptive: off` como saída de emergência. Se não passar, a PR sai com a flag desligada.
- Sem co-autor Claude nos commits. Não faço push sozinho.

## 3. Invariantes e testes que mudam (resumo)

- **Mudam:** a asserção "sem atalho trivial" (`workflow-rails.test.mjs:123`, `DESIGN.md:64-65`, `:231-233`, `meta.whenToUse`), as sequências de chamadas dos testes listados no passo 3, `hosts.test.mjs` (novo mapa), `budget-policy.test.mjs` (novo papel e reservas por tier), e os testes de journal e resume.
- **Não mudam:** verify obrigatório, check windows, gate final, snapshots, `done-approved`, `planningKey` sem tier, `plan.effort.level` ecoando o esforço pedido (o planner não rebaixa).
- **Efeitos colaterais esperados:**
  - `workflowSourceHash` e `modelPolicyHash` mudam, então planos e tasks já publicados são invalidados (uma migração, esperada);
  - os testes que calculam hash a partir do arquivo real não devem quebrar.

## 4. Pontos de incerteza para confirmar com você

1. Billing/faturamento em standard (e não em fast) contraria seu exemplo. Concorda?
2. Notetaker em Haiku, em vez de Sonnet?
3. Design especulativo em paralelo com o plan-review fica desligado?
4. Fusão plan→tasks (passo 3b) mexe em contrato de resume. Aceita o risco, ou prefere a opção mais segura e menos econômica?
5. Metas numéricas do benchmark (30% e 25%) e o número de tarefas e repetições.
6. Jev (campos exatos da API e acerto em código) e Laya (provavelmente fora do OpenRouter).
7. Se o esforço por nó realmente funciona via flag do CLI (passo 0).