FIX

1. **Os papéis de modelo exigidos não saem do passo 1 como está escrito.** Hoje os nós research e design rodam no papel `executor`. O `roleForLabel` (`graph-eng.js:148`) e o `ROLE_BY_LABEL` (`graph-run.mjs:476`) mandam `work:*` para `executor`, que está em Haiku nas tabelas. O `workerModel` (`:881`) só troca para `MDL.designer`/`MDL.worker`, que hoje valem `null`. Para cumprir "research e design em Sonnet", o plano precisa criar papéis explícitos (`researcher`, `designer`, `notetaker`) em todos estes pontos:
   - `MODEL_BY_ROLE`, `READ_ONLY` e `ROLE_ALIASES` (`hosts.mjs`);
   - `MODELS` e `ROLE_BY_LABEL` (`graph-run.mjs`);
   - `REQUIRED_MODELS` e `roleForLabel` (`graph-eng.js`);
   - `BUDGET_ROLES`, porque `exactRoles` (`budget-policy.mjs:231`) recusa chave nova, e o objeto inicial do ledger (`graph-eng.js:140-142`).

   A troca de label só por modelo, sem papel próprio, não basta: o custo Sonnet ficaria contado como executor, e a métrica de custo por papel do passo 9 sairia errada. Faltam também a migração de ledger e checkpoint antigos no resume (ledger sem as chaves novas) e o teste de regressão disso.

2. **As tabelas `codex` também precisam ser atualizadas.** O passo 1 só fala do Claude. As tabelas do host codex em `hosts.mjs:14` e `graph-run.mjs:479` precisam dos mesmos papéis novos, senão o host codex cai em `trusted_host_capability_or_model_policy_unavailable`. O teste "as três tabelas idênticas" tem que cobrir os dois hosts.

3. **Esforço: "medium em tudo" não pode apagar o modo max.** `STRONG_EFFORT` é `'high'` quando `effort=max` (`:110`), e o escalate do verify (`:1283`) e o juiz usam esse valor. Os dois pontos a acertar:
   - O requisito é medium **por padrão**. O teste deve ser "sem `effort` explícito, todo label sai medium" e manter o caso max, em vez de assertar medium incondicional.
   - O passo 0 deve confirmar que a flag `--effort` do CLI já funciona por chamada: `REASONING_EFFORTS` existe em `hosts.mjs:23`. Hoje esse ponto está marcado como incerto sem motivo.

4. **A sequência do tier fast contradiz o motor atual.** O teste prometido `plan, work, verify, critic, synth` não sai enquanto três coisas continuarem como estão:
   - (a) o trilho R1 (`research-base`) injeta um nó research, o que dá um `work` a mais, e o R3/"design antes de implement" injeta `design-base`. Os dois precisam ser tier-aware, e o plano só cita o R3.
   - (b) o pipeline `auto` roda os estágios `plan` + `tasks`, com o critic do estágio plan (`:2551`) e um segundo planner.
   - (c) a decisão do passo 3b está marcada como incerta.

   O 3b deixa de ser incerto: o plano escolhe uma opção e fixa a sequência esperada de cada tier com base nela. A opção segura é manter os dois estágios, pular as chamadas internas com aprovação sintética (o critic do estágio plan inclusive, com `evidenceIds` válidos para `validateArtifact`) e manter `PIPELINE_PAIRS` intacto. Os testes de sequência de chamadas devem refletir exatamente essa escolha.

5. **`tasksReviewApproved` no tier fast.** O runner exige o último voto real de `planReviewer` após a fronteira do tasks (`phase-pipeline.mjs:339-345`, bloqueio `tasks_review_missing`). O plano tem que dizer como a aprovação sintética satisfaz essa regra no runner, que é código separado do motor. Precisa de teste em `graph-run-stages.test.mjs` provando que o tier fast publica tasks e que uma aprovação sintética sem registro de `triage.decided` correspondente é recusada. Sem esse teste, o voto sintético vira um bypass forjável.

6. **A triagem tem que acontecer antes de gastar o que ela quer poupar.** Se o tier só sai depois do planner, a heurística do passo 2 recebe a tarefa crua. Se `refineAfterPlan` só escala, o fast precisa ser decidido antes. O plano deve definir que o tier inicial vem de `triageTask` antes do estágio plan, e que `refineAfterPlan` só sobe de tier.

   Billing: o requisito 1 cita billing como exemplo de tarefa simples, e o meio-termo do plano (standard) contraria isso. A decisão do usuário já foi dada ("pode começar"). O plano deve registrar a escolha como hipótese a validar no benchmark, com critério objetivo: o faturamento cai em fast se fast der 31/31 e zero falso DONE em n repetições, e em standard caso contrário.

7. **A cascata do passo 4 é um contrato de resume e precisa de testes.** Quando a run escala de fast para standard no meio, a transição `plan-approved` sintética já foi gravada. Um plan-review real depois dela quebra a ordem esperada pelo `validateResumeJournal` (`DECISION_BOUNDARY`). Faltam:
   - definir a transição nova (ex.: `triage.escalated`) e a ordem aceita;
   - teste de resume após escalada;
   - teste de que, depois do escalonamento, a aprovação sintética anterior é substituída e não satisfaz `designApproved`/`planFeedback`.

8. **Classificador (passo 5): dois ajustes.**
   - (a) Tirar o "pode descer no máximo um nível" do merge. A heurística já define o piso, e rebaixar abre a porta de injeção, que o brief aponta como risco 3 (o Jev é sensível a texto de direcionamento). O classificador só pode subir de tier, ou no máximo confirmar fast quando a heurística deu standard sem rail duro.
   - (b) O adaptador `json_schema` com LLM barato não é o que o usuário pediu, que é Jev/Laya. A ordem tem que ser invertida: o padrão é o Jev 1.13 via Decisions API, validado com uma chamada real antes de virar padrão, e o `json_schema` fica só como fallback configurável. Laya fica documentado como fora do OpenRouter, sem código.

9. **Research paralelo (passo 6): a regra "obrigatória em spec ambígua" conflita com o tier.** Spec ambígua já leva o piso a full. Deixar explícito que o research é opcional, salvo nesse caso, e testar que o researcher grava só na `runDir`, ou seja, o write grant de research é vazio fora da `runDir`. Também falta dizer se o notetaker é `READ_ONLY` e onde ele escreve.

10. **Paralelismo (passo 7): a especulação de design deve sair do plano.** Ela contraria a ordem exigida pelo requisito 3 (design depois do plan-review). Remover do escopo em vez de deixar atrás de uma flag. Também condicionar o "verify sobreposto ao work do próximo nó" a write grants disjuntos e a check windows sem interferência. O check window roda os testes do repo e pode ver o diff parcial de outro nó, o que gera recibo inválido. Isso precisa de teste.

11. **Benchmark (passo 9): os critérios precisam ser executáveis e honestos.**
    - (a) A comparação de custo e latência tem que usar o mesmo n e as mesmas tarefas contra o braço A **e** contra o braço D (agente único), com o critério de lançamento explícito para os dois.
    - (b) "Mesma qualidade" significa os testes ocultos fora do alcance do agente, e o plano tem que confirmar que as fixtures `benchmark-chess` e `benchmark-v2-faturamento` têm os testes ocultos separados do workspace da run.
    - (c) O preço por papel vem de uma tabela versionada no repo, com data.
    - (d) O `--test-concurrency=2` já está em `graph-benchmark.mjs:645`. O plano deve garantir que todos os comandos de teste novos (scripts, docs e o check confiável) também usem esse valor, e lembrar que `scripts.test` precisa continuar exatamente `node --test` (`graph-run.mjs:472`).

12. **Passo 0 e a árvore suja.** O passo 0 deve proibir stash ou commit sem confirmação do usuário e listar os 16 arquivos já modificados que os passos 1, 3 e 9 vão tocar. Os números de linha do mapa são da árvore suja e precisam ser revalidados antes de cada passo.

13. **Faltam três testes de regressão explícitos.**
    - (a) A inversão `complexity==='trivial'` hoje devolve `undefined`, que é o modelo da sessão, e não Opus, como o plano diz. O teste deve assertar que o modelo de um nó trivial é Haiku e que `risk:'high'` continua indo para o modelo forte, se essa regra for mantida. Se não for, o plano tem que dizer isso.
    - (b) Um teste de que `triage.decided` não muda o `planningKey`.
    - (c) Um teste de que `meta.whenToUse` e a descrição do skill não mencionam mais "no trivial 1-node shortcut" quando `adaptive` está ligado.