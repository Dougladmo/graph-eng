# Benchmark graph-eng 2.0 (PGR-47): parte (a), sem host real

Status: parte (a) implementada e testada com transporte fake, com os 8 FIX_LOCAL do critic B11 (20/10) e os FIX F1 a F4 do critic B12 aplicados. Nenhuma chamada de CLI real (`claude` ou `codex`) foi feita. Codex e Claude ficam NOT_RUN aqui. A parte (b) (R0 a R6) é para o Douglas rodar com o host logado. A revisão forte de B11 foi feita pelo critic (Opus, só leitura); a reexecução dos itens corrigidos fica para o coordenador antes de qualquer CLI.

Este documento é o relatório da parte (a). Não é evidência de desempenho, qualidade de modelo, economia de franquia ou benchmark dual-host.

## Artefatos

| Arquivo | Estado | Conteúdo |
|---|---|---|
| `bin/graph-benchmark.mjs` | novo | harness: baseline por `git show`, bridge v1, variante adaptativa com rastreio por hostFactory, teto de relógio e de chamadas, avaliador externo, métricas, relatório, manifesto e CLI |
| `test/graph-benchmark.test.mjs` | novo | 37 testes com transporte fake (`simulated=true`), nenhum chama CLI |
| `test/fixtures/benchmark-v2/` | novo | workspace (A, B, C, `task.md`, `acceptance.md`), aceites fora do workspace, referência, contrato v2 de A |
| `bin/hosts.mjs` | alteração aditiva (parte anterior) | `createHost({ experimentalPolicy })`, default `null`; caminho de produto inalterado. Não foi tocado nesta rodada |
| `<GRAPH_ENG_STATE_DIR>/benchmarks/<id>/<variante>-<tentativa>/workspace` | evidência de execução (fora do repo) | workspace de cada tentativa, com repositório git próprio (commit inicial) |
| `.graph-runs/benchmarks/<id>/` | evidência (fora do git) | manifesto, `variant-<v>/run.json`, `calls.jsonl`, `external-eval.json` (da run), `external-eval-<ts>.json` (cada eval, novo), `report.json` |

A fixture guarda aceites, referência e contrato v2 como `*.mjs.txt`. O `npm test` do repo é `node --test` puro, que varre `**/test/**/*.mjs` por padrão. Com a extensão `.txt`, esses arquivos não são executados pelo suite do repo. O avaliador copia e renomeia para `.mjs` numa pasta temporária.

## Comandos

Suite da parte (a):

```
node --test --test-concurrency=2 test/graph-benchmark.test.mjs
node --test --test-concurrency=2 test/hosts.test.mjs
node --test --test-concurrency=2 test/packaging.test.mjs
node --check bin/graph-benchmark.mjs
```

CLI (`prepare`, `verify`, `run`, `eval`, `report`). `run` e `eval` verificam o manifesto antes de qualquer coisa. `eval` grava `external-eval-<ts>.json` novo e recusa destino existente (`evidence_exists`); nunca sobrescreve a evidência da run. O avaliador usa um diretório temporário em `GRAPH_ENG_STATE_DIR`, nunca dentro do repo nem da tentativa. `run` chama CLI real quando não há transporte injetado; nesta sessão não foi executado.

```
node bin/graph-benchmark.mjs prepare --host codex --scenario happy --out .graph-runs/benchmarks
node bin/graph-benchmark.mjs verify --manifest .graph-runs/benchmarks/<id>/manifest.json
node bin/graph-benchmark.mjs run --manifest .graph-runs/benchmarks/<id>/manifest.json --variant v1-normalized [--max-wall-ms 5400000]
node bin/graph-benchmark.mjs run --manifest .graph-runs/benchmarks/<id>/manifest.json --variant adaptive [--max-wall-ms 5400000]
node bin/graph-benchmark.mjs eval --manifest .graph-runs/benchmarks/<id>/manifest.json
node bin/graph-benchmark.mjs report --manifest .graph-runs/benchmarks/<id>/manifest.json
```

- `--out` precisa estar dentro de `.graph-runs/benchmarks`; `--manifest` também (recusado com exit 2 caso contrário).
- Uma tentativa é uma pasta `variant-<v>` do manifesto. `run` recusa se ela já existe (`attempt_exists`) e não apaga nada.
- O workspace fica em `GRAPH_ENG_STATE_DIR` (padrão `~/.claude/graph-eng`), nunca dentro do repo.

## Matriz (estado após a parte (a))

| host | variante | cenário | status | attempted | motivo |
|---|---|---|---|---|---|
| claude | HISTÓRICO CLAUDE (sonnet/sessão) | happy | BLOCK / NOT_RUN | false | organização bloqueia assinatura; sem remapeamento (smoke 18/10) |
| claude | lógica v1 com política Opus/Haiku normalizada | happy | NOT_RUN | false | autorizada pelo ruling de 20/10; sem CLI nesta sessão |
| claude | adaptive | happy | NOT_RUN | false | sem CLI nesta sessão |
| codex | lógica v1 com política Sol/Luna normalizada | happy | NOT_RUN | false | sem CLI nesta sessão |
| codex | adaptive | happy | NOT_RUN | false | sem CLI nesta sessão |
| codex | adaptive | contract-change | BLOCK (`scenario_not_implemented`) | false | retomada com A v2 não implementada; BLOCK antes de qualquer spawn |
| codex e claude | cancelamento/retomada real e modelo indisponível (R5) | — | NOT_RUN | false | condições reais não declaradas nem injetadas |
| codex e claude | planner barato histórico | — | fora de escopo | — | não entra no produto nem no benchmark |

Esta matriz é a saída de `report` para o manifesto preparado (linhas NOT_RUN sem métrica). Nenhum percentual de sucesso foi calculado.

## Correções do critic B11 (20/10)

Cada item tem teste de controle escrito antes da correção. O vermelho foi visto pelo motivo indicado; depois a correção ficou verde.

1. **Tarefa no adaptativo.** `runAdaptive` chama `executeGrapheng` com `['implemente', <task.md>, '--effort', 'medium']`. Teste: `args.task` igual aos bytes do `task.md`. Vermelho antes: `args.task` ausente.
2. **Grants.** O grant `product` cobre `src/` e `.benchmark-run/`. O kind sai do cabeçalho `## Your node: <id> - … [<kind>, risk …]` do próprio prompt; se faltar (ou tiver outro id), BLOCK `node_kind_missing` antes do spawn. Non-implement vira `artifacts`. Testes: gap `r2-x` implement gravando `src/` e `.benchmark-run/` passa; `research-base` passa; design gravando em `src/` bloqueia com `grant_violation`; sem cabeçalho bloqueia. Vermelho antes: `label_unmapped_node` e grant de `.benchmark-run/` recusado.
3. **Workspace fora do repo.** Cada tentativa usa `<GRAPH_ENG_STATE_DIR>/benchmarks/<id>/<variante>-<tentativa>/workspace` com `git init` e commit inicial. `.git` fica fora do hash da árvore. Teste: o caminho não começa com o do repo; `workspaceResourceOf` difere do repo; `benchmarkStateDir` respeita a env e cai em `~/.claude/graph-eng`. Vermelho antes: workspace dentro de `outDir`.
4. **Manifesto.** Inclui hash de `workflows/graph-eng.js`, de `package.json` e da política (JSON e hash). `verifyManifest` recalcula os três. Teste: 1 byte no motor, 1 byte no `package.json` e política adulterada geram, respectivamente, `workflow`, `package` e `policy`. Vermelho antes: nenhum mismatch.
5. **Nunca apagar tentativa.** `run.json` nasce `inflight` antes do motor e recebe status final ao terminar. `run` recusa `variant-<v>` existente (`attempt_exists`) e não toca nos arquivos. SIGINT/SIGTERM marcam `BLOCK cancelled` no `run.json` (escrita síncrona), cancelam os handles em voo e não apagam nada; um segundo sinal usa o comportamento padrão. `--manifest` é restrito a `.graph-runs/benchmarks`. Testes: segunda run preserva o `run.json`; `run.json` é `inflight` no primeiro spawn; `process.emit('SIGINT')` encerra a tentativa como cancelled sem deixar handler; manifesto fora da pasta é recusado.
6. **Métricas do adaptativo.** O `hostFactory` passado a `runGraph` embrulha o host (`createCallTracker`) e conta papel, requested, effective, usage, status e exit. Falha de métrica entra em `metricErrors` sem derrubar a chamada. Exceção do motor vira `exception` (BLOCK `engine_exception` no `run.json`), com as chamadas já registradas. Testes: byRole e requested/usage de duas chamadas; `usage` que lança não derruba a chamada; `runAdaptive` com motor que lança devolve a exceção.
7. **Teto de relógio e cap de chamadas no adaptativo e no v1.** `--max-wall-ms` (padrão 90 min) aciona `withWallCap`: BLOCK `wall_cap`, cancela e aguarda cada handle, nenhum spawn depois. O cap de chamadas (60) vale também no adaptativo (`operational_cap`, antes do spawn). Testes: engine que nunca termina vira `wall_cap` sem handle pendente; 2ª chamada com cap 1 vira `operational_cap` sem spawn.
8. **readOnly e avaliador.** `assertPolicyKeys` recusa política cujas chaves de `readOnly` e `models` não são exatamente os papéis (`policy_keys_mismatch`), antes de criar o host. O avaliador exige exit 0, `# fail 0` e `# pass` igual ao esperado (`expectedPass`, gravado no manifesto como `acceptance.expectedPass` = 10, contando os `test(` dos aceites). Testes: política sem `executor` em `readOnly` lança; `process.exit(0)` sem TAP reprova; contagem diferente da esperada reprova.

## Correções do critic B12 (20/10)

- **F1 (capabilities).** `tracker.wrap` passou a repassar todos os membros do host (`...host`) e instrumenta só spawn, wait e cancel. Sem isso, o `runGraph` real lê `host.capabilities()`, não existe e o motor dá BLOCK `trusted_host_capability_or_model_policy_unavailable` antes de qualquer spawn. Teste: `runAdaptive` com transporte fake e **runGraph real** (sem `runGraphImpl`) chega a pelo menos 1 spawn contado. O teste exige workspace git, como o `runVariant`.
- **F2 (BLOCKED).** Motor que responde `BLOCKED` grava `BLOCK` com `feedback.reason` (ou `engine_blocked` sem razão), e não mais `FAIL`. Teste: `runGraphImpl` devolve `blocked` com razão `razao_teste`; o `run.json` grava `BLOCK`/`razao_teste`.
- **F3 (eval).** `eval` grava `external-eval-<ts>.json` novo com `writeNewEvidence` (flag `wx`). Destino existente recusa com `evidence_exists`. Teste: duas avaliações deixam o `external-eval.json` da run intacto e geram dois arquivos novos; regravar um deles é recusado sem alterar o conteúdo.
- **F4 (doc e tmp).** O avaliador usa `GRAPH_ENG_STATE_DIR/benchmarks/_eval/...`, fora do repo e fora da tentativa. Teste: a tentativa não tem `_eval`. O R2 do doc roda num workspace fora do repo com `git init`. O desvio 2 e as limitações foram completados (synth, judge, Claude sem Bash, falha transitória, `.git` fora da auditoria).

Mutações B12 (revertidas com `cmp`): F1 removendo `...host` → vermelho (F1); F2 removendo `engineBlocked` → vermelho (F2); F3a regravação sem `wx` → vermelho (F3); F3b destino fixo `external-eval.json` → vermelho (F3).

### Mutações (cada uma aplicada, rodada e revertida com `cmp`)

| Item | Mutação | Resultado |
|---|---|---|
| 2 | grant `product` voltou a `['src/']` | vermelho em 2 testes (grants; grant pelo cabeçalho) |
| 5 | restaurado o `rm` da tentativa existente | vermelho (`não é apagada`) |
| 7 | teto de relógio desligado | vermelho por `test timed out after 10000ms` (teto ausente) |
| 8a | validação de chaves de `readOnly` desligada | vermelho (política com `readOnly` parcial) |
| 8b | contagem `# pass` ignorada | vermelho (avaliador: contagem errada) |

Os arquivos de produto (`bin/graph-benchmark.mjs`) e de teste foram restaurados depois de cada mutação, com conferência por `cmp`.

## Contagens

- `test/graph-benchmark.test.mjs`: 40/40 (eram 23; 14 novos ou ajustados na rodada B11, 3 novos na rodada B12).
- `test/hosts.test.mjs`: 22/22 (sem alterar assert). `test/packaging.test.mjs`: 5/5. Rodados sozinhos, depois da suíte do benchmark. `node --check bin/graph-benchmark.mjs` ok.

## Desvios e decisões

1. Os itens do B11 foram aplicados só em `bin/graph-benchmark.mjs`, nos testes e nos docs. `bin/hosts.mjs`, `bin/graph-run.mjs`, `bin/run-integrity.mjs` e `workflows/graph-eng.js` não foram alterados. A checagem de `readOnly` ficou no benchmark (`assertPolicyKeys`) porque `validateExperimentalPolicy` em `hosts.mjs` não compara as chaves. Se o critic exigir a checagem no próprio `hosts.mjs`, é preciso ownership do coordenador.
2. O adaptativo usa o `createHost` padrão do produto, sem `experimentalPolicy`. Os modelos por papel coincidem com o mapa normalizado, mas o `readOnly` não: no produto o planner é read-only; na política v1 não. Declarado, não alinhado (ruling de 18/10 e critic B12, item (d)). Diferenças que a comparação precisa carregar:
   - **Synth**: no v1 é gravável (escreve `REPORT.md` e `INDEX.md`, v1 `:1411,:1416`); no produto é read-only (`hosts.mjs:23` × `:45`).
   - **Judge**: no v1 precisa gravar `<id>.md` (v1 `:909`), mas está mapeado como read-only com grant `none`. Isso prejudica o v1 quando há nós `explore`.
   - **Claude, verifier e polish**: no v1 não têm Bash (`hosts.mjs:242`); o adaptativo roda os checks pelo próprio motor. É a maior assimetria contra o v1 no Claude.
   - **Planner**: no v1 grava `plan.md` (v1 `:1109`), autorizado pelo ruling de 18/10. A escrita é auditada em `.benchmark-run/` e não afeta o aceite, que só olha `src/`.
   A auditoria de escrita cobre a árvore do workspace, exceto o interior de `.git`.
3. Qualquer falha de transporte (`spawn`/`wait`) no adaptativo grava `block` no tracker e gera BLOCK. Escolha conservadora: o motor pode tentar de novo, mas a tentativa fica marcada como incompleta.
4. O avaliador usa contagem exata de `# pass` (decisão do brief), e não "N > 0" como estava na lista de itens.
5. Manifesto agora é `schemaVersion: 2`. Um manifesto v1 em `.graph-runs/benchmarks/` (ex.: `bench-codex-happy-20261020160150`, preparado antes desta rodada) não tem os campos novos; `verify` sobre ele falha com erro de campo ausente. Ele é evidência de preparo antigo, não foi apagado e deve ser substituído por um `prepare` novo.
6. A serialização continua sendo FIFO (`Promise.all` no bridge v1, fila única no adaptativo). A duração do motor não é comparável entre as variantes. A ordem do `Promise.race` do v1 histórico não é reproduzida.
7. O workspace de cada tentativa tem `git init` + commit inicial. Ele foi criado para o lock e para a auditoria; não é um repo do produto.
8. Um segundo SIGINT remove o handler e deixa o processo morrer pelo comportamento padrão. O run.json já fica como `BLOCK cancelled`, mas uma tentativa interrompida à força não tem `calls.jsonl` nem `external-eval.json`.

## Matriz de limitações (a manter na matriz da entrega)

- Auditoria de escrita é posterior à escrita. Sem enforcement por arquivo no CLI, a garantia é de detecção: qualquer escrita fora do grant bloqueia o experimento.
- Fake transport prova controle, não consumo, economia ou qualidade de modelo.
- Uma amostra descreve a execução, sem significância nem ganho generalizado.
- Serialização FIFO e duração não comparável (ver desvio 6).
- Claude sem Bash nos checks do v1 (o histórico rodava checks autonomamente).
- Contract-change não está implementado: `run --scenario contract-change` vira BLOCK `scenario_not_implemented`, sem spawn.
- Cancelamento e retomada reais, e modelo indisponível, são NOT_RUN (R5) até haver condição real declarada no manifesto.
- Synth gravável no v1 e read-only no produto; judge read-only no v1 com grant `none`, apesar de gravar `<id>.md` (desvio 2).
- Claude sem Bash no verify e no polish do v1; o adaptativo roda os checks pelo motor. Assimetria a declarar no R6.
- Falha transitória de transporte no adaptativo encerra a tentativa como BLOCK (simétrico ao v1). O `externalStatus` continua gravado.
- O interior de `.git` do workspace não é auditado; a árvore fora dele é.
- Decisão: estas limitações são declaradas, não corrigidas nesta rodada.

## Comandos da parte (b) para Claude (não executados aqui)

Só o Douglas roda, um comando por vez, sem outro comando pesado ativo. Antes de cada bloco: `ps -Ao pid,command | grep -E "node --test|graph-(run|smoke|benchmark)|codex|claude -p"` vazio, `uptime` com load até 4, e `git status --porcelain > .graph-runs/benchmarks/preflight-$(date +%s).txt`.

- R0 (autenticação): `codex --version`; `codex login status`; `claude auth status` (exige `loggedIn:true`). Se não estiver logado: `claude auth login`, interativo, com a conta liberada pela organização.
- R1 (smoke de transporte): `node bin/graph-smoke.mjs --host codex --out .graph-runs/smoke` e `node bin/graph-smoke.mjs --host claude --out .graph-runs/smoke`. Registrar uma linha em `docs/validation/graph-eng-2-smoke.md`.
- R2 (fluxo de produto, PGR-135/136), por host, fora do repo: `E2E="${GRAPH_ENG_STATE_DIR:-$HOME/.claude/graph-eng}/e2e-<host>" && mkdir -p "$E2E" && cp -R test/fixtures/benchmark-v2/workspace/. "$E2E"/ && git -C "$E2E" init -q && git -C "$E2E" add -A && git -C "$E2E" -c user.name=e2e -c user.email=e2e@graph-eng.invalid commit -qm "estado inicial"`, depois `cd "$E2E"` e um `inv.json` por passo com `{"host":"<host>","argv":["plan","<texto de task.md>"]}`, depois `["tasks"]` e `["implemente"]`. Comando: `node <repo>/bin/grapheng.mjs --invocation inv.json`. Registrar em `docs/validation/graph-eng-2-e2e.md`. Assim o lock e o `git diff` são os do workspace, não os do graph-eng.
- R3 (happy-path, codex): `prepare` novo (manifesto v2), depois `verify`, `run --variant v1-normalized`, `verify`, `run --variant adaptive`, `eval` e `report`, todos com `--manifest .graph-runs/benchmarks/<id>/manifest.json`. A execução real chama codex, então é preciso aprovação do Douglas.
- R4 (contract-change, adaptativo): não executável ainda (BLOCK `scenario_not_implemented`). Antes, implementar o passo de retomada e o supervisor.
- R5 (cancelamento e retomada, modelo indisponível): NOT_RUN. Precisa de condição real declarada no manifesto (`injectionKind` e momento) antes do gasto.
- R6 (Claude): depois de R0 passar, repetir R1 e R3 com `--host claude`, com `--variant v1-normalized` (lógica v1 com política Opus/Haiku normalizada, autorizada em 20/10). A coluna HISTÓRICO CLAUDE continua BLOCK/NOT_RUN.

Registro geral: cada tentativa, inclusive falha, vira uma linha em `docs/validation/graph-eng-2-benchmark.md`, com link para `.graph-runs/benchmarks/<id>/` e hashes. Nada é apagado nem repetido até dar PASS.

## Referências

- Brief: `.superpowers/sdd/2026-10-17-graph-eng-2/task-benchmark-brief.md` (rulings de 18/10 e 20/10, critic B11).
- Progresso: `.superpowers/sdd/2026-10-17-graph-eng-2/progress.md`.
- Smoke: `docs/validation/graph-eng-2-smoke.md`.
- Baseline: `git show 91bf1dc:workflows/graph-eng.js`, 77172 bytes, SHA-256 `099335e3cf21fa05aea179d75f6cc01deceba81c142e1fceeefcc7f32b0604f2`.

## Parte (b): rodadas reais com Claude (20 e 21/10)

Cenário `happy`, host Claude (Opus nos papéis fortes, Haiku nos operacionais), avaliador externo com os aceites fora do workspace. Cada rodada custa cerca de US$ 1 depois do isolamento do host (antes eram cerca de US$ 88, por vazamento de contexto do ambiente do usuário).

| run | v1-normalized | adaptive | externo (adaptive) | causa na adaptive | correção aplicada |
|---|---|---|---|---|---|
| a14f | BLOCK | BLOCK `plan_review_failed_or_invalid` | FAIL | `APPROVE` com `affectedNodes` rejeitado | regra declarada no schema |
| e669 | BLOCK | BLOCK `plan_stage_research_incomplete` | FAIL | aceite de pesquisa exigia rodar comando, sem shell | aceite de pesquisa não exige comando |
| 7197 | PASS | BLOCK `provenance_unsealed_window:I1` | FAIL | texto livre no manifesto virava "input mudou" | manifesto só com caminhos do repo |
| 8c6c | PASS | BLOCK `CLI_FAILED` | FAIL | `is_error` do Claude sem `result` perdia o motivo | erro guarda subtype, uso e modelo |
| b343 | PASS | BLOCK `provenance_frontier_changed_before_window` | **PASS** | polish: área 2 mascarava a reprovação da área 1 | áreas seguintes param com o motivo real |
| 0d8d | PASS | BLOCK `plan_effort_mismatch` | FAIL | planner devolveu `low` para pedido `medium` | schema só aceita o esforço pedido |
| 7df4 | PASS | BLOCK `no_progress_feedback_loop` | FAIL | aceite pedia URL sem web; reparo sem o motivo do critic | `agentWeb` e nota do critic no reparo |
| 0e5c | PASS | BLOCK `original_plan_criteria_changed` | FAIL | correção do plano reescreveu o `doneWhen` | `doneWhen` travado no prompt e no schema |
| 99b1 | PASS | BLOCK `critic_done_evidence_invalid` | FAIL | critic do estágio plan deu DONE com 1 de 4 critérios | schema do critic exige um item por critério |
| 6ab6 | PASS | BLOCK `provenance_frontier_changed_before_window` | **PASS** | verificador do I3 exigiu `npm test` no nível do nó; o polish mascarou a reprovação | verificador sabe que a suíte é do gate final; polish não roda com implement não concluído |
| 45db | PASS | BLOCK `engine_blocked` (polish) | **PASS** | área de polish com 2 nós: cada nó conferido contra o diff da área inteira | janela conferida pelo grant da área; nó só pelos arquivos dele |
| 144b | PASS | BLOCK `node_record_stale_at_completion` | **PASS** | pipeline inteiro e critic DONE; o dependente revalidado no polish herdava o selo da janela antiga | revalidação descarta o selo herdado e sela a janela nova |
| **f366** | **PASS** | **PASS (DONE)** | **PASS (10/10)** | — | — |

Leitura: a v1-normalized passou no aceite externo em todas as rodadas a partir da 7197 (11/11), sempre com `reportedStatus` PARTIAL. Na f366 a adaptativa fechou `DONE` com aceite externo 10/10 e `falseDone=false`: 21 chamadas (planner 2, planReviewer 2, executor 8, verifier 5, critic 2, designReviewer 1, synth 1), 605k tokens de entrada, 36k de saída e 292 s de motor. A v1 na mesma rodada: 10 chamadas, 519k de entrada, 41k de saída, 261 s, e `reportedStatus` PARTIAL (não sabe se terminou). A adaptativa nunca deu falso DONE (`falseDone=false` em todas). Cada BLOCK dela foi um ponto de comportamento do modelo que o motor recusou com motivo legível, e cada um virou correção estrutural com teste de regressão. Em b343, 6ab6, 45db e 144b a adaptativa produziu código correto (externo PASS) e bloqueou só na janela de proveniência do polish; a 6ab6 mostrou a causa real, que a b343 não deixou ver.

Codex real: NOT_RUN. Nenhuma rodada real com Codex foi feita.
