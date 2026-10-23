Mapa do fluxo atual do graph-eng, com linhas, invariantes e pontos de ramificação para a triagem. Só li o código. Não rodei nada nem alterei arquivos.

## 0. Contexto de execução (o que roda na prática)
- `implemente <tarefa>` sem artefatos usa `pipeline.from='auto'`. O resultado é `stages=['plan','tasks'], pipelineTo='implement'` (`bin/phase-artifacts.mjs:365-372`). Não existe um estágio `implement` separado nesse caso. O estágio `tasks` com `pipelineTo:'implement'` roda design, execução, critic e synth na mesma invocação do motor (`bin/phase-pipeline.mjs:354`, `:386-388`). O estágio `implement` só roda com artefatos reutilizados (`:366`).
- O motor é invocado uma vez por estágio. O carry de ledger, contadores e `planVersion` passa de um estágio para o outro (`phase-pipeline.mjs:356-360`; `workflows/graph-eng.js:131`, `:1917-1920`).

## 1. Fases em ordem, com file:line

**Pré-voo (sem agente)**
- `graph-eng.js:26-60`: validação de args, `effort` ∈ {low, medium, max} (`:46`) e `REQUIRED_MODELS` (`:47-56`).
  - `REQUIRED_MODELS` é igual ao `MODEL_BY_ROLE` de `hosts.mjs:9-18` e ao `MODELS` de `graph-run.mjs:477-480`.
  - Se `RUNTIME.models` divergir dele, o bloqueio é `trusted_host_capability_or_model_policy_unavailable` (`:54`).
- `graph-eng.js:102-111`: `LEVEL = effort || 'medium'`.
  - `EFFORT_POLICY` (`:67`): low = largura 1 e teto de 3 nós; medium = 2 e 6; max = 2 e 10.
  - `STRONG_EFFORT` (`:110`) é `high` só no effort max.
- Em `bin/phase-pipeline.mjs:50`, `preparePipeline` calcula `modelPolicyHash = sha256(canonical(models))` e `workflowSourceHash = sha256(bytes de graph-eng.js)`. A chave é `planningKey` (`:52`).

**Estágio 1 `plan` (leitura, só nós research; `STAGE='plan'`, `MODE='research'`, `:76`)**
1. **Planner**, label `plan`, Sonnet, `graph-eng.js:1927-1952`. O schema é `PLAN_OUT` (`:375`).
   - Gera goal, doneWhen, nós, risco por nó e `complexity` (enum trivial|moderate|complex, `:352`).
   - Esse `complexity` hoje só é usado em `workerModel()` (`:881`: trivial vira modelo forte no worker). Há também uma cópia no checkpoint (`:2334`).
2. **Plan-review**: no estágio `plan` seguido de `tasks` ele é adiado (`planReviewDeferred`, `phase-pipeline.mjs:388`; `graph-eng.js:1972-1980`).
   - O adiamento grava `approvals.planReview` com um APPROVE sintético (`'plan_review_deferred_to_tasks_stage'`) e persiste `plan-approved` (`:1976`).
3. **Normalização e trilhos** (`:2066`, `budget-policy.mjs:38-100`).
   - R1 injeta `research-base` se faltar pesquisa.
   - R3 injeta `design-base` em implement/architecture.
   - Os trilhos R2, R5 e R6 reescrevem dependências.
   - Há também uma regra que garante um design antes de cada implement (`:83`).
4. **Alocação de orçamento** `applyBudgetAllocation('initial')` (`:2267`, `:156`) e `persistTransition('budget-policy-approved')` (`:2274`).
5. **Nós research** (`executeGraph` `:2503`, `:799`; `runNode` `:1307`). O verify do round 1 de research/design é adiado em low/medium (`:1382`).
6. **Critic do estágio plan** (`:2551-2593`).
   - Os critérios são `PLAN_STAGE_CRITERIA` (`:2040`), travados no schema (`:2047`).
   - Corre `runPolish` (retorna `[]` fora do `max`, `:1588`), `takeSnapshot`, `runTrustedChecks` (`:2570`) e então o critic `critic:r1` (`:2583`, Sonnet).
7. **Publicação do plano** (`:2615-2663`): `preparePhaseArtifact` seguido de `emitStageDecision('plan-artifact-approved')`. Não passa pelo synth.

**Estágio 2 `tasks` → implement (mesma run, `pipelineTo:'implement'`)**
1. **Task decomposer**, label `plan`, Sonnet, `:1922-1926`. O plano importado entra como dado e `doneWhen` fica travado.
2. **Plan-review forte**, `plan-review:r1`, **Opus**, `:1981-1983`. Aprova o DAG completo.
   - APPROVE grava `persistTransition('plan-approved', { approvals:{planReview} })` (`:2002-2006`).
   - FIX_LOCAL e REPLAN passam por `plan` + novo review (`:2020`) e consomem os bancos globais (`MAX_LOCAL_REPAIRS=2`, `MAX_STRUCTURAL_REPLANS=2`, `:68-69`).
3. **Aprovação do tasks** (`:2252-2258`): `preparePhaseArtifact(kind 'tasks')` e `emitStageDecision('tasks-approved')`.
   - O runner exige `tasksReviewApproved` (`phase-pipeline.mjs:339-345`): o último voto de `planReviewer` depois da fronteira do tasks precisa ser APPROVE. Sem plan-review não publica, bloqueia com `tasks_review_missing` (`:285`).
4. **Normalize/rails, teto de nós** `toRun > C.maxNodes` bloqueia (`:2248`), seguido de `applyBudgetAllocation`.
5. **Provenance root** (`:2350-2368`), se `CHECK_SELECTION_MODE`: `initializeProvenanceFrontier` e `persistTransition('provenance-root')`.
6. **approveCheckNodes** (`:2473-2478`): concede a cada implement os arquivos que ele pode escrever.
7. **Nós design/research** (`:2503`). `explore` custa 3 chamadas por nó: 2 rascunhos + 1 juiz (`:1289-1306`).
8. **Design review**, `design-review:r{n}`, Sonnet, `:2531`/`runDesignReview` `:1511-1572`.
   - Só roda se `RMODE` for implement ou architecture.
   - Depois vem `persistDesignApproval` (`:1157`), que grava o `workOutputRef` verificado de cada nó research/design round 1.
   - Em seguida `persistTransition('design-approved', {approvals:{planReview, designReview}})` (`:2533`).
   - Reprovado: os implements viram `skipped`, `skipCritic=true` (`:2542`) e o resultado final é `blocked`.
9. **Execute** (`executeGraph(impl1)`, `:2549`): `runNode` por implement (`:1307-1443`).
   - `doWork` (Haiku, `:1253`), depois `checkNodeEvidence` (check window do supervisor) e `verifyAudited` (`verify:*`, Haiku, `:1267`).
   - Verify tem 2º voto `escalate:*` se `confidence:'low'` (`:1283`). Reparo local: até 2 no total, via `repair:*` + novo verify (`:1393-1426`).
   - Cada implement gera `nodeRecord` + transição de provenance + checkpoint `node-record-ready` (`buildNodeRecord` `:986`).
10. **Polish** (`runPolish`, `:1585`): `return []` se `LEVEL !== 'max'` (`:1588`). Em medium/low não gasta chamada. As reservas de executor/verifier para polish ainda entram no orçamento (`budget-policy.mjs:238-245`).
11. **Gate final** (`:2564-2575`): `takeSnapshot` + `runTrustedChecks('final')` com receipts. Exige `finalReceipts.length === CHECKS.length` (`:2576`); sem isso o critic nem roda.
12. **Critic**, `critic:r1`, Sonnet, `:2583`. Valida:
    - um item por critério (schema travado);
    - evidência `receipt:*` ou `snapshot:*` válida;
    - identidade do snapshot antes e depois do critic igual.
    - `REPLAN` e `FIX_LOCAL` voltam ao loop (`while(!cycleComplete)`, `:2497`) via `installReplacement` (`:2067`) e `applyCriticFix` (`:2376`). Fim: `persistTransition('critic-reviewed')` (`:2606`).
13. **Synth**, `synth`, Haiku, `:2666-2691`, read-only, depende dos snapshots.
14. **Decisão de DONE** (`:2705-2724`): `eligibleForDone` é a conjunção de todos os gates e depois `persistTransition('done-approved')` (`:2722`).

**Contagem do caminho feliz (medium, 1 estágio-tasks)** ≈ plan + N nós research (work) + critic(plan) + plan(tasks) + plan-review + design(s) + design-review + work + verify (por implement) + critic + synth. O log `:2470` mostra a estimativa `estimate` (`:2322`).

## 2. O que é obrigatório (invariantes de código e testes)

| Fase | Obrigatória por | Evidência |
|---|---|---|
| plan-review com APPROVE antes de qualquer nó | `planFeedback` é setado só por APPROVE ou pelo adiamento (`:1964`, `:1981`); sem ele `eligibleForDone` é false (`:2721`, usa `planFeedback.kind === 'APPROVE'`) | `test/workflow-budget.test.mjs:13`; `test/workflow-pipeline-stage.test.mjs:483` (`calls == ['plan','plan-review:r1']`) |
| plan-review do estágio tasks | `tasksReviewApproved` (`phase-pipeline.mjs:339`) | `workflow-pipeline.test.mjs:229` §6.5 ("faz uma plan-review de vínculo"); `workflow-pipeline-stage.test.mjs:511-517` M9 (`calls[0]==='plan-review:r1'`, exatamente 1) |
| design-review (implement/architecture) | `designApproved` (`:2711`) e `ledger.reservedByRole.designReviewer` (`budget-policy.mjs:253`) | `test/workflow-rails.test.mjs:123` "sem atalho trivial: 1 nó implement ainda passa por design-review, critic e synth" (`:128-130`) |
| critic + synth | `criticApproved`, `!!synth` | mesmo teste; `workflow-final-gate.test.mjs:394`, `:342-371` |
| verify de cada implement | `allRequiredComplete` exige `verified` (`:2710`) | `workflow-budget.test.mjs:15`, `:42`, `:77-81` |
| trilhos R1..R6 (research-base, design-base, deps) | `applyRails` (`budget-policy.mjs:38`) | `test/workflow-rails.test.mjs` |
| research/design do round 1 verificados só no design-review | adiamento `defer` (`:1382`) | `workflow-budget.test.mjs`; `workflow-final-gate.test.mjs:432` |
| Polish só em max | `:1588` | `workflow-budget.test.mjs:97-101` |
| Efforts de raciocínio por label | `STRONG_EFFORT` | `workflow-budget.test.mjs:114-116` |
| Papéis e modelos por host | `MODEL_BY_ROLE` / `REQUIRED_MODELS` / `MODELS` | `test/hosts.test.mjs`; `test/graph-run.test.mjs` |

DESIGN.md afirma explicitamente "Sem atalho trivial" (`DESIGN.md:64-65`, `:231-233`) e no frontmatter do workflow (`graph-eng.js:4`, `meta.whenToUse`). O texto precisará mudar.

## 3. Invariantes que quebram se uma fase for pulada

**Provenance**
- `persistDesignApproval` (`:1157`) grava `approvalEvidence` de cada nó research/design round 1. Hoje isso só acontece quando o design-review passa (`:2532`).
  - Sem design-review, nada o grava. Os `nodeRecord` desses nós ficam sem aprovação e `validateNodeRecordForReuse` (`:1038`) só aceita aprovação com `ignoreApproval` falso.
  - Com `persistOutput`/`verifyOutput` ausentes e host real, `persistDesignApproval` retorna false (`:1163`).
- `eligibleForDone` exige `designApproved` (`:2711`), que só é true se `designReview.pass`. Para um fast path com `RMODE==='implement'` pulando design-review, `designReview` ficaria `null` e `designApproved` seria false, então nunca daria `done`. Seria preciso criar um `designReview` sintético auditável (como o adiamento do plan-review faz em `:1973`).
- Resume: `resumeReviewInherited` (`:2518-2524`) herda `approvals.designReview.pass===true`; `requiredResumeGates` exige designReviewer (`:2281-2283`).
- A cadeia `provenance.transitions` e os selos (`verifyProvenanceChain`, `:1087`; `restoreProvenanceFrontier`, `graph-run.mjs:1240-1265`) validam que cada transição do tipo `implement`/`polish` tem voto `verifier` com `pass:true` (`graph-run.mjs:1257`). **Implement nunca pode pular o verify**: `buildNodeRecord`/`recordBoundToSeal` falham, e `provenance_transition_unavailable` bloqueia (`:859`, `:1765`). Esse é o caminho que a triagem não pode tocar.
- `approveCheckNodes` (`:2473`) e `checkNodeEvidence` (check windows) são requisitos para `verified` em `CHECK_SELECTION_MODE` (`:859`).

**planningKey / modelPolicyHash**
- `planningKey = hash(task, context, spec, acceptedCriteria, host, modelPolicyHash, workflowSourceHash)` (`bin/phase-artifacts.mjs:50-70`; testes `phase-artifacts.test.mjs:102-120`). Ele ignora `effort`.
  - Qualquer mudança em `workflows/graph-eng.js` muda `workflowSourceHash` e invalida todos os slots de plano e tasks já publicados (resolveReuse `task_changed`, `phase-artifacts.mjs:354`). Isso é esperado, mas vira nova migração.
  - Mudar o mapa de modelos (hosts.mjs, graph-run.mjs MODELS, REQUIRED_MODELS) muda `modelPolicyHash`. As três tabelas precisam continuar idênticas (`:54`), senão o bloqueio é imediato. Se a triagem for escolher modelo por tarefa (por exemplo um planner Opus no caminho curto), ela precisa de um **novo papel** em `MODEL_BY_ROLE` (`hosts.mjs:9`), `ROLE_ALIASES`/`READ_ONLY` (`:15-24`), `ROLE_BY_LABEL` (`graph-run.mjs:476`), `roleForLabel` (`graph-eng.js:148`), `BUDGET_ROLES` (`budget-policy.mjs:7`, e `exactRoles` valida chaves exatas, `:233`). Mexer em qualquer um quebra `budget-policy.test.mjs`, `hosts.test.mjs` e resume/ledger.
- Uma decisão de triagem que mude o conjunto de estágios não pode vazar para o `planningKey`. Triagem deve ser derivada **depois** do plano e gravada no artefato/checkpoint. Se for incluída em `planningInputs` ela mexe em `planningKeyOf` e `validateArtifact` (`:135-138`). Hoje `planningInputsOf` falha com chaves extras.

**Aprovações persistidas** (`approvals.planReview` e `approvals.designReview`, `controlCheckpoint` `:176-199`)
- `persistedApprovals` só guarda `planReview` e `designReview` (`:135-137`). Um fast path que pule o plan-review precisa gravar um APPROVE sintético, como o adiamento já faz, ou `planFeedback` fica null e o laço `while (!planFeedback)` (`:1981`) chama o reviewer.
- O validador de resume (`graph-run.mjs:94-148`, `validateResumeJournal`, `:168-262`) confere o journal: `control.transition` com estágios fixos (`DECISION_BOUNDARY`, `:233-234`) e `plan-approved` precedendo `budget-policy-approved`. Pular transições quebra a ordem esperada e gera `resume_stage_*` bloqueios.
- `budgetPolicy.allocation` recalculada na resume (`graph-run.mjs:140`, `allocateBudget`); `:2276` bloqueia se `planVersion/mode/effort` divergirem. Um novo `effort` interno (ex.: `fast`) precisa passar por `EFFORT_NODE_CAP`, `EFFORT_POLICY`, `validEffort` (`:46`, `:2059`, `budget-policy.mjs:9`).

**Testes que assertam sequência de chamadas** (os que vão exigir mudança ou novo caso)
- `workflow-budget.test.mjs:13-26`: sequência plan-review → design-review → verify → critic → synth e `usedByRole`.
- `workflow-rails.test.mjs:123-130`: sem atalho trivial.
- `workflow-pipeline-stage.test.mjs`: `:483` (`['plan','plan-review:r1']`), `:511-517`, `:320`/`:329` (plan-review adiado vs. presente), `:286`/`:294` (contagem de `plan`).
- `workflow-pipeline.test.mjs:270-283` §6.8 (ordem plan → research → critic → plan → design-review → work) e `:229` §6.5.
- `workflow-final-gate.test.mjs`: 394, 432, 342-371 etc.
- `graph-run-stages.test.mjs` e `graph-run.test.mjs` assertam journal e transições.
- Benchmarks (`test/graph-benchmark.test.mjs`) comparam `v1-normalized` e `adaptive`. Isso não impede, mas o relatório `docs/validation/graph-eng-2-benchmark.md` já está modificado na árvore.

## 4. Onde uma triagem de complexidade pode ramificar

Candidatos, do mais seguro ao mais invasivo:

1. **Entre o estágio plan e o tasks (`phase-pipeline.mjs:354-388`, `decidePipelineStages` `phase-artifacts.mjs:365`)**. Hoje o `plan` gasta planner + nós research + critic(plan) só para depois o tasks gastar mais um planner e um plan-review Opus. Para tarefa pequena e de baixo risco, ramificar para um **estágio único** (`stages=['tasks']` sem plano importado) geraria um plano de implementação direto.
   - Risco: `decision.stages` e `reuse.decided` entram no journal (`phase.reuse.resolved`, `graph-run.mjs:178-184`), e o resume só aceita pares conhecidos (`PIPELINE_PAIRS`, `:403`).
   - O estágio `tasks` exige `importedPlan` (`graph-eng.js:1924` e `phase-pipeline.mjs:384`), então esse ramo é o que mais mexe em contrato.
2. **No `plan` do estágio plan (`graph-eng.js:1927`)**. O planner já devolve `complexity`. É o ponto natural para decidir: se `trivial` (e todos os nós `risk:low/medium`, sem arquivos de risco alto), o engine pode:
   - colapsar a pesquisa em 1 nó (já existe a R1 `research-base`);
   - **pular o critic do estágio plan** (`:2551`). Ele usa `PLAN_STAGE_CRITERIA` e custa 1 Sonnet. Só publica o plano se `planApproved` (`:2616`), então precisaria de uma aprovação sintética rastreável; o schema de `critic` no artefato é `{kind:'APPROVE', evidenceIds}` e `validateArtifact(plan)` cobra `evidenceIds` não vazios.
3. **No plan-review do estágio tasks (`:1981`)**. Hoje é Opus e obrigatório por `tasksReviewApproved`. Alternativa de baixo custo: trocar o modelo do reviewer por Sonnet para triagem baixa. Isso exigiria papel novo (ver §3). O adiamento do review do `plan` para o `tasks` (`:1972`) é o padrão a copiar: gravar APPROVE sintético com `reason` explícito e persistir `plan-approved`.
4. **Design-review (`:2531`)**. O fast path poderia pular a chamada e gravar `designReview = {pass:true, attempts:0, blocking:[], synthetic:true}`. Precisa ainda de `persistDesignApproval` (`:2532`) para os nós research/design, e `designApproved` em `:2711`. O teste `workflow-rails.test.mjs:123` (sem atalho trivial) e a nota em DESIGN.md precisarão ser trocados por um teste do novo contrato.
5. **Custo do executor no 2º caso (624k tokens de input)**. Não é fase. É o `SHARED` (`buildShared`, `:491`) + `PLAN_BLOCK` + `CONTEXT` repetidos em cada chamada do agente, mais o `runDir` e a lista de arquivos do write grant (`workPrompt`, `:564`).
   - Um `work:I*` com muitos arquivos grandes e `explore` (3 chamadas, `:1289`) multiplica input. Vale triagem por `explore` e por número de arquivos por nó (o planner agrupa "2-4 implement nodes", `:1944`).
6. **Largura/effort automático**: hoje `effort` é escolha do usuário (`:102-105`), e `plan.effort.level` precisa ecoar `REQUESTED_EFFORT` (schema `:355`, validação `:2060`, `:2081`, `:2102`). **O planner não pode rebaixar** (`plan_effort_mismatch`). Uma triagem automática não pode reutilizar esse campo, e precisa de um campo novo (ex.: `plan.fastPath`) ou ser decidida em código determinístico após o plano.

## 5. Pontos de atenção para o redesign

- Não encontrei nenhum ramo hoje que pule plan-review, design-review, critic ou synth. O único atalho é `planReviewDeferred` (`:1972`), que troca review por APPROVE sintético e o review passa para o tasks.
- Polish já é opcional por `LEVEL !== 'max'` (`:1588`), e o verify de research/design round 1 é diferido (`:1382`, `:2262`). Os dois já foram "triagem por effort" e têm testes (`workflow-budget.test.mjs:97-101`).
- `complexity==='trivial'` hoje troca o modelo do worker por forte (`:881`), ou seja, **a triagem de complexidade vai na direção oposta do que o benchmark pede** e precisará ser revisada.
- O que não pode ser dispensado sem quebrar DONE: verify de implement e seus votos (provenance), check windows (`approveCheckNodes`), gate final com receipts, critic com evidência por critério, snapshots idênticos antes e depois do critic e do synth, e `persistTransition('done-approved')`.
- Qualquer edição em `workflows/graph-eng.js` invalida `workflowSourceHash` e portanto os artefatos de plan e tasks existentes. A mudança do número de papéis ou modelos invalida `modelPolicyHash`. Os dois são aceitáveis, mas os testes que usam hashes fixos (`phase-artifacts.test.mjs`, `graph-run-stages.test.mjs:35`) calculam a partir do arquivo real, então não deveriam quebrar.
- Estado da árvore: há mudanças não commitadas nos mesmos arquivos (`bin/hosts.mjs`, `bin/graph-run.mjs`, `bin/phase-pipeline.mjs`, `workflows/graph-eng.js`, `DESIGN.md` e vários testes). Os números de linha acima são da árvore de trabalho atual, não do HEAD (`37859ff`).

Arquivos relevantes (todos em `/Volumes/DouglasNvme/Documents/GitHub/graph-eng`): `workflows/graph-eng.js`, `bin/hosts.mjs`, `bin/graph-run.mjs`, `bin/phase-pipeline.mjs`, `bin/phase-artifacts.mjs`, `bin/budget-policy.mjs`, `skills/grapheng/DESIGN.md`, `skills/grapheng/SKILL.md`.