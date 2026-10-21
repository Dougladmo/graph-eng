# graph-eng 2.0: atualizações pendentes para o Linear (P-PGR-3)

O Linear não está disponível nesta sessão. Este arquivo junta as atualizações e as evidências que precisam ir para o projeto e as issues quando houver acesso. Nenhuma issue está pronta para Done: smoke real e benchmark ainda faltam.

## Proveniência sobreposta: fechada (critic APPROVE)
- Selo por janela, `recordBoundToSeal` e os motivos `provenance_*` são terminais.
- Testes focados: 151/151.
- Registro: `.superpowers/sdd/2026-10-17-graph-eng-2/provenance-reconciliation.md`.

## 3D: comandos plan, clarify, tasks, implemente e init (PGR-136)
- Arquitetura M0: os estágios são invocações do mesmo motor dentro da mesma run, e os contadores passam de um estágio ao outro pelo carry.
- Retomada de run com pipeline nos casos A, B e C. Os limites 2/2 valem para a run inteira, e a retomada não concede crédito.
- Os estágios plan, clarify e tasks funcionam só como leitura e não recebem checks.
- O `implemente` sem artefatos reutilizáveis faz plan → research → critic → tasks → implement → critic → finish na mesma run.
- Bugs achados e corrigidos, cada um com teste de regressão:
  - aprovação de estágio gravada com checkpoint;
  - correção da research sem conferir orçamento;
  - `questionSetId` nulo;
  - `clarifications` gravado como objeto em vez de lista;
  - tasks reaproveitado sobre plano com origem adulterada;
  - exit code de `needs_clarification`.
- Testes: suíte inteira 951/951 (20/10, sozinha, concorrência 2), após corrigir 3 regressões do caminho legado planOnly e atualizar fixtures obsoletos (effort high, ceiling) ao contrato PGR-136.
- Pendente: smoke real ponta a ponta (plan → clarify → tasks → implemente) nos dois hosts.

## Smoke real (PGR-135 / PGR-47)
- Codex (18/10): PASS (worker gpt-6-luna, reviewer gpt-6.1-sol, cancelamento).
- Claude (18/10 e 20/10): BLOCK `AUTH_FAILED`. O CLI 2.1.296 não está autenticado (`loggedIn: false`), e não foi usado fallback para API. Ver `docs/validation/graph-eng-2-smoke.md`.

## Pendências do projeto
- 3C: auditoria e exclusão do workspace.
- 3E: memória, registry e painel.
- Benchmark real nos dois hosts.
- Validação final.
- Decisão do Douglas: o caminho feliz do reparo de design com 2 ou mais dependentes é inalcançável com a reserva atual. Manter ou ampliar a reserva?

## 20/10/2026 — decisões D-C1 e D-C2 (aprovadas pelo Douglas)
- D-C1: o lock de workspace com dono morto bloqueia com `workspace_lock_owner_dead`. A remoção é manual.
- D-C2: implement sem política de checks bloqueia com `write_audit_unavailable`.

## 20/10/2026: 3C fechada e smoke real do Claude
- 3C (auditoria e exclusão do workspace): C0–C15 feitos, com o critic de fechamento aprovado.
  - A suíte inteira, rodando sozinha, deu 1080/1080. Uma rodada anterior deu 1073/1074, e o teste que falhou não foi identificado: possível flake sob load alto, a investigar na validação final.
- Smoke real do Claude (PGR-135/PGR-53): **PASS**, `claude-2026-10-20T05-01-38.370Z-da5e28e3`, com Haiku no worker e Opus no reviewer, modelos efetivos informados pelo CLI.
- O smoke Codex de 18/10 é anterior ao C14 e precisa ser refeito: fora desta sessão.

## 20/10/2026: G-W, escrita do executor Claude (bug de produto corrigido)
- Sonda real, com claude-haiku-5-5 num diretório temporário fora do repo, usando os args do produto (`--permission-mode dontAsk --tools Read,Glob,Grep,Edit,Write`): o Write foi negado e saiu em `permission_denials`, sem arquivo gravado. Sem regra de permissão, o executor Claude nunca gravava. O smoke de 20/10 não pegou isso porque roda o worker com `readOnly: true`.
- Correção em `bin/hosts.mjs`: os papéis de escrita ganham `--allowedTools Read,Glob,Grep,Edit(./**)`, e os de leitura ganham `--allowedTools Read,Glob,Grep`.
- Sonda real depois da correção: `hello.txt` e `sub/a.txt` foram gravados, e `../fora2.txt` foi negado (fora do cwd).
- Regressão: `test/hosts.test.mjs`, teste "Claude libera escrita do executor só dentro do cwd…", vermelho antes e verde depois. `hosts.test`: 23/23.
- Pendente: o smoke real precisa de uma checagem de escrita do executor, para não repetir o falso PASS.

## 20/10/2026: R6 real Claude (bench-claude-happy-20261020172233-a14f), BLOCK nas duas variantes
- v1-normalized: BLOCK `engine_blocked`, 9 chamadas, US$ 64,96. Avaliação externa: FAIL (1/10). O motivo do motor se perdeu porque `runV1` não devolvia o `result`. Corrigido com regressão em `test/graph-benchmark.test.mjs` ("bloqueio preserva o motivo do motor").
- adaptive: BLOCK `plan_review_failed_or_invalid`, 2 chamadas, US$ 22,84. O planReviewer (Opus) deu APPROVE, mas listou os nós revisados em `affectedNodes`; `readFeedback` descarta APPROVE com nós afetados, e nada no schema dizia essa regra ao modelo. Correção: descrição da regra no schema FEEDBACK (`workflows/graph-eng.js`), com regressão em `test/feedback.test.mjs`. O motor continua estrito.
- Custo: cada `claude -p` herdava MCPs, plugins, skills e settings do usuário. Eram cerca de 75k tokens de contexto por turno e cerca de 1M por chamada. Correção em `bin/hosts.mjs`: `--strict-mcp-config --mcp-config {"mcpServers":{}} --disable-slash-commands --setting-sources project,local`. Medido: 74.806 tokens viraram cerca de 6.500 por turno. A regressão está em `test/hosts.test.mjs`. O smoke real isolado deu PASS (`claude-2026-10-20T17-47-27.006Z-82f01582`), e o writeProbe custou US$ 0,002 contra US$ 0,094 antes.
- Este R6 fica como evidência; nada foi apagado. O próximo R6 precisa de um novo prepare, porque o hash do motor mudou.

## 20/10/2026: R6 real Claude isolado (bench-claude-happy-20261020180329-e669)
- Custo total US$ 0,97 (v1: US$ 0,55 em 10 chamadas; adaptive: US$ 0,42 em 5). O R6 anterior custou US$ 88, então o isolamento do `claude -p` reduziu o custo em cerca de 90x.
- adaptive: o plan review aprovou (correção do schema validada no real) e o critic deu DONE, mas a run deu BLOCK `plan_stage_research_incomplete`. Os nós de pesquisa voltaram `partial` porque queriam executar `node`/`npm test`, e o executor Claude não tem shell.
- v1: BLOCK, ainda com motivo genérico. O nó implement terminou "completed" sem alterar `src/`.
- Diagnóstico com o Opus em andamento. Nada foi apagado.

## 20/10/2026: correções do diagnóstico do R6 (executor Haiku)
- A1: `capabilities().agentShell` é `true` só no Codex; chega ao motor como `RUNTIME.capabilities.transport.agentShell`.
- A2: sem shell de agente, o baseline por `git worktree` sai do prompt, a checagem rápida do implement vira "leave checks empty", o planner não pode exigir comandos e o critic do estágio plan ganha o critério de pesquisa com status done. A guarda de `plan_stage_research_incomplete` continua no gate.
- B1: o workspace das tentativas sai de `os.tmpdir()/graph-eng-benchmarks` (ou `GRAPH_ENG_BENCH_WORKSPACES`), e caminho com `.claude` dá BLOCK `workspace_under_protected_dir` antes de gastar chamada.
- B2: o `reason` do v1 é derivado da estrutura do motor (`v1_node_<status>:<id>`, `v1_critic_not_done`, `v1_open_gaps`, `v1_synth_<status>`), sem texto do modelo.
- B3: escrita do Claude sob `.claude` dá `CWD_PROTECTED_PATH` antes do spawn; `permission_denials` vai para `permissionDenials` e para o `calls.jsonl`.
- C: `normalizeUsage` soma o cache do `modelUsage` do Claude na entrada e expõe `cacheInputTokens` à parte.
- Testes: hosts 27/27, graph-benchmark 46/46, workflow-pipeline-stage 45/45, feedback 16/16, grupo de 4 arquivos 278/278.
- Próximo passo: um R6 novo, com o hash do motor atualizado.

## 20/10/2026: R6 real Claude (bench-claude-happy-20261020184133-7197), depois das correções A/B/C
- **v1-normalized: PASS.** Avaliação externa PASS, falseDone false, 10 chamadas, US$ 0,46. É o primeiro ponta a ponta real verde do benchmark.
- adaptive: BLOCK `provenance_unsealed_window:I1`, 10 chamadas, US$ 0,68.
  - O estágio plan foi aprovado e publicado, e as pesquisas terminaram `done` (a correção A foi validada no real).
  - No estágio tasks, o plano e o design foram aprovados, e o I1 gravou `src/a.mjs` e `src/a.test.mjs`. A janela de escrita foi encerrada sem verificação, e o próximo nó bloqueou por janela pendente.
  - O motivo original do I1 ficou mascarado. O diagnóstico com o Opus está em andamento.

## 20/10/2026: manifestos e proveniência (executor Haiku)
Causa do R6 com o Opus: o planner pôs prosa nos manifestos (`inputs: ["R1 findings: src/a.mjs:2-4"]`), o gate aceitou, o I1 rodou sem fingerprint dos inputs externos e a janela ficou pendente. O I2 então morreu com `provenance_unsealed_window:I1` sem o motivo do I1.
- Gate: `validateBudgetDag` rejeita todo item de `files`, `inputs` e `outputs` que não seja caminho relativo canônico (espaço, vírgula, `:` seguido de dígito, absoluto, `..`, `./`). O motivo cita nó e campo: `manifesto inválido em I1.inputs: "…"`. Bloqueia no gate com `invalid_dag`, sem `work:I1`.
- `approveCheckNodes`: input externo (fora de `files` do nó e de `files`/`outputs` das dependências transitivas) precisa existir, senão `input_externo_ausente`. Output precisa estar em `files` do próprio nó, senão `output fora de files do nó`. Os dois call sites passam `graph` com `deps`, `files` e `outputs` de todos os nós.
- `runNode`: input externo sem fingerprint bloqueia com `external_inputs_unfingerprintable` antes do `beginCheckNode` e do work. Depois do work, falha de fingerprint vira a mesma nota, e "mudou durante o work" fica só para mudança real.
- `provenance_unsealed_window:<id> (causa: <nota do nó>)`, com `affectedNodes: [id]`. O prefixo `provenance_` não mudou, e `graph-run` aceita o sufixo de causa.
- Prompt do planner, descrição de `files`, `inputs` e `outputs` no schema e linha no plan reviewer dizem que o manifesto é caminho relativo puro.
- Fixture corrigida: 8.3 usava `./src/a.js`, que agora é recusado no gate. Passou a usar `src/a.js`.
- Limite conhecido: preflight nulo sem input externo não bloqueia. Nó que cria arquivo novo tem o próprio input inexistente, então o fingerprint é nulo de forma legítima.

## 21/10/2026: rodadas R6 8c6c, b343, 0d8d, 7df4 e 0e5c (Claude real)
v1-normalized PASS em todas (externo PASS, falseDone false, cerca de US$ 1 por rodada). A adaptativa bloqueou em cada uma por um motivo novo, e cada um virou correção com teste de regressão (vermelho antes, verde depois):
- 8c6c `CLI_FAILED`: `is_error` do Claude sem `result` perdia motivo e uso. `claudeEnvelopeError` guarda subtype, errors, uso, modelo e negações; o benchmark registra no `calls.jsonl`.
- b343 `provenance_frontier_changed_before_window` (externo PASS): no polish, a área 2 mascarava a reprovação sem selo da área 1. As áreas seguintes agora param com `polish não iniciado: polish:<k> reprovado sem selo (<motivo>)`.
- 0d8d `plan_effort_mismatch`: o schema do planner só aceita o esforço pedido.
- 7df4 `no_progress_feedback_loop`: o aceite de pesquisa pedia URL sem web, e o reparo do critic não recebia o motivo. Nova capability `agentWeb` (false nos dois hosts) tira a exigência de fonte externa; o nó refeito recebe `## REPAIR (critic)`.
- 0e5c `original_plan_criteria_changed`: a correção do plano reescreveu o `doneWhen`. Agora ele é travado no prompt e no schema (enum, min e max) na correção do plan-review e nos três caminhos do replan do critic, e a mesma lista em outra ordem volta à ordem travada.
- Testes afetados: 261/261.
- 99b1 `critic_done_evidence_invalid` (v1 PASS de novo): o critic do estágio plan deu DONE devolvendo só 1 dos 4 critérios. O schema do critic agora exige exatamente um item por critério, com o texto em enum. Regressão em workflow-final-gate; afetados do motor 375/375.
- 6ab6 `provenance_frontier_changed_before_window` (v1 PASS; adaptativa com externo PASS): causa real confirmada. O verificador do I3 reprovou duas vezes por falta de `npm test`, que só roda no gate final; o I3 ficou sem selo e o polish das outras áreas acusou a fronteira. Correções: o prompt do verificador diz que a suíte inteira é do gate final, e o polish não roda com implement não concluído, mostrando o nó e o motivo. Duas regressões em workflow-final-gate; motor 377/377.
- 45db `engine_blocked` (v1 PASS; adaptativa com externo PASS): plano, design, I1 a I3 e o polish rodaram; a revalidação do polish da área {I2, I3} falhou com "diff auditado inclui arquivo fora do grant aprovado para o nó", porque cada nó era conferido contra o diff da área inteira. Correção em `bin/graph-run.mjs`: a janela de polish é conferida contra o grant da área, e cada nó só pelos arquivos dele. Regressão com três implements (fixture `withC`); motor e runner 450/450.
- 144b `node_record_stale_at_completion` (v1 PASS; adaptativa com externo PASS): pipeline inteiro e critic DONE; o dependente fora da área revalidado no polish herdava o `transitionRef` da janela antiga, então o selo não cobria a janela nova. Correção em `sealPolishWindow`: a revalidação descarta o selo herdado e o `buildNodeRecord` sela a janela nova. Regressão em workflow-final-gate.
- Teste antigo de workflow-resume ajustado: com B sem grant, `src/b.txt` é input externo; removido, o motor bloqueia B com `external_inputs_unfingerprintable` antes do work (regra 2.0), em vez de refazê-lo. Afetados 258/258.
- **f366: PASS nas duas variantes.** A adaptativa fechou `DONE` com externo 10/10 e `falseDone=false` (21 chamadas, 605k/36k tokens, 292 s); a v1 deu externo PASS com `reportedStatus` PARTIAL (10 chamadas, 519k/41k, 261 s). Codex real segue não validado.
- Fechamento 21/10: suíte inteira sozinha (`node --test --test-concurrency=2`) 1095/1095. Critic Opus da branch inteira não foi rodado nesta etapa.
