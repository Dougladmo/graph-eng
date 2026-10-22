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

## Baseline de agente único (21/10)

Pergunta: no mesmo cenário, um agente único no modelo forte faz a tarefa mais rápido ou mais barato que o graph-eng? Até aqui não havia baseline. O custo "tudo no modelo forte" (cerca de US$ 1,99) era só estimativa, feita repreçando os tokens da f366.

**Variante `single-agent`** (`bin/graph-benchmark.mjs`, `runSingleAgent`). Um único agente, Opus em todos os papéis (`singleAgentPolicy`), recebe o `task.md` inteiro e trabalha no mesmo workspace limpo. Usa o transporte do executor: sem shell, escrita só no cwd. Depois da chamada, o supervisor roda o `npm test` do workspace. Se falhar, a saída volta para uma nova chamada do mesmo modelo, até 3 rodadas. Escrita fora de `src/` dá BLOCK `grant_violation`. A avaliação externa (`eval`) e o formato de `calls.jsonl` e `run.json` são os mesmos das outras variantes. `summarizeCalls` passou a registrar `costUSD` (soma do `costUSD` do Claude, preço de tabela) e `maxCallInputTokens` (maior entrada de uma chamada, cache incluso). Testes: 4 novos em `test/graph-benchmark.test.mjs`, com transporte fake. São 51 no arquivo, todos verdes.

**Run real** `bench-claude-happy-20261021141749-2efe`: `prepare`, `run --variant single-agent`, `eval` e `report`, autorizados pelo Douglas.

| métrica | single-agent (2efe) | graph-eng adaptive (f366) | v1-normalized (f366) |
|---|---|---|---|
| chamadas | 1 (Opus) | 21 (Opus 7, Haiku 14) | 10 |
| custo (costUSD) | **US$ 0,15** | US$ 0,80 | US$ 0,55 |
| tempo de motor | **30 s** | 292 s | 261 s |
| maior contexto numa chamada | 36k tokens | 50k tokens | 99k tokens |
| entrada / saída total | 36k / 2,7k | 605k / 36k | 519k / 41k |
| rodadas do supervisor | 1 (`npm test` 3/3 nos testes que o próprio agente escreveu em `src/`) | — | — |
| `reportedStatus` | DONE | DONE | PARTIAL |
| aceite externo | PASS 10/10 | PASS 10/10 | PASS 10/10 |
| falso DONE | não | não | não |

**Leitura honesta.** Neste cenário o agente único ganhou em tudo o que foi medido. Saiu **5,2x mais barato** (US$ 0,80 / 0,15) e **9,6x mais rápido** (292 s / 30 s) que o graph-eng adaptive, com a mesma nota externa (10/10) e sem falso DONE. O maior contexto também foi menor (36k contra 50k). A divisão em modelo forte e modelo barato não compensa aqui: o graph-eng gasta 21 chamadas, cada uma relendo contexto, numa tarefa que o Opus resolve em uma.

Sobre a estimativa de US$ 1,99: ela mede o graph-eng com todos os papéis no Opus, não um agente único. O agente único real custou US$ 0,15. A frase "o graph-eng economiza em relação a usar só o modelo forte" vale contra o graph-eng todo no Opus, não contra um agente único.

**Limites.** Uma run de cada lado (n=1), sem variância medida. O cenário `happy` é pequeno: três funções puras e um contrato simples, que cabem numa chamada só. Os ganhos que o graph-eng promete (plano revisado, verificação separada, recusa de falso DONE, contexto que não cresce com o tamanho da tarefa) não aparecem num cenário deste porte. Aqui o agente único também não deu falso DONE. Para sustentar "Nx mais rápido" ou "Nx mais barato" a favor do graph-eng, é preciso um cenário em que um agente único estoure o contexto, erre o aceite ou declare DONE falso. Sem isso, README e post não podem dizer que o graph-eng é mais rápido ou mais barato que um agente único. Os dados deste cenário dizem o contrário.

## Cenário `faturamento` (21/10): onde a divisão pode mostrar valor

Pergunta: existe tarefa em que um agente único erra o aceite, declara DONE falso ou estoura o contexto, e o graph-eng (plano revisado, verificação separada, critic) não? O `happy` não responde, porque cabe numa chamada. O `faturamento` foi desenhado para isso. Até aqui ele só rodou com transporte fake: **nenhuma run real foi feita**, e o resultado do confronto ainda não existe.

**Fixture** `test/fixtures/benchmark-v2-faturamento/`, ao lado de `benchmark-v2`:

| pasta | conteúdo |
|---|---|
| `workspace/src/` | 9 módulos em estado inicial (stubs): `dinheiro`, `datas`, `dados`, `cambio`, `impostos`, `descontos`, `validacao`, `fatura`, `relatorio` |
| `workspace/docs/contratos/` | 10 contratos, um por módulo mais `00-convencoes.md`. As regras se cruzam: o arredondamento de `impostos` vem de `dinheiro`, o rateio de `fatura` vem de `descontos` e assim por diante |
| `workspace/docs/historico/` | regras de 2024, substituídas. O `task.md` manda ignorar; quem ler sem cuidado aplica regra velha |
| `workspace/data/` | feriados, câmbio diário (USD desde 02/01, EUR só desde 12/01, sem fim de semana nem feriado), impostos por UF, cupons e 120 pedidos de exemplo (cerca de 60 KB no total) |
| `workspace/test/` | `caminho-feliz.test.mjs.txt`, 5 testes visíveis só do caminho feliz. `prepareWorkspace` tira o `.txt` na cópia, porque no repo o arquivo não pode entrar no `node --test` do graph-eng |
| `acceptance/` | 31 aceites em 9 arquivos, fora do workspace. Inclui uma integração ponta a ponta: os 120 pedidos viram um CSV com SHA-256 fixo |
| `reference/src/` | solução que passa 31/31 |
| `ingenua/src/` | solução plausível sem conferência dos casos de borda, sobreposta à referência em 6 módulos |

**O que ele mede.** Os mesmos campos das outras variantes (`calls.jsonl`, `run.json`, `costUSD`, `maxCallInputTokens`, `reportedStatus`, `externalStatus`, `falseDone`). Neste cenário, três resultados interessam:

1. **Falso DONE.** A solução ingênua passa nos 5 testes visíveis (o `npm test` que o supervisor do `single-agent` roda) e falha em 17 dos 31 aceites. Um agente que só confia no `npm test` declara DONE e o avaliador externo marca `falseDone: true`. Isso está coberto por teste com transporte fake.
2. **Aceite difícil de acertar sem verificação.** Cada armadilha está escrita no contrato, mas só aparece num caso de borda:

| armadilha | contrato | erro típico (o da `ingenua`) |
|---|---|---|
| meio-para-par em todo arredondamento, exato até 9×10^15 | `dinheiro.md` | `Math.round` |
| dia útil com feriados; a data inicial nunca conta | `datas.md` | ignorar `feriados.json` |
| câmbio de fim de semana usa a taxa anterior; EUR começa depois | `cambio.md` | exigir a data exata e dar `SEM_TAXA` em 24 dos 120 pedidos |
| alíquota reduzida com um único arredondamento | `impostos.md` | arredondar a alíquota efetiva antes |
| rateio por maior resto, empate no menor índice | `descontos.md` | sobra de centavos no último item |
| CSV ordenado por vencimento e id em ponto de código, id com `;` ou `"` entre aspas, entrada intacta | `relatorio.md` | `localeCompare`, sem aspas, `sort` que altera a entrada |

3. **Contexto.** Para fazer tudo numa chamada, o agente único precisa ler 10 contratos, 5 tabelas e 9 módulos e escrever os 9. O `maxCallInputTokens` diz se isso pesou. Estourar o contexto é hipótese, não garantia: o workspace tem cerca de 80 KB, e um modelo forte com janela grande pode caber. Se couber, o cenário ainda mede os itens 1 e 2.

**Suporte no harness** (`bin/graph-benchmark.mjs`): `--scenario faturamento` em `prepare`; `fixtureDirFor(scenario)` escolhe a fixture, e `buildManifest` usa esse padrão; `contract-v2` virou pasta opcional no manifesto (ausente vale árvore vazia, e criá-la depois diverge no `verify`); `prepareWorkspace` renomeia `*.mjs.txt` do workspace para `.mjs`; `applyFixtureReference` aceita `folder` (`reference` ou `ingenua`). O `happy` não mudou.

**Testes** (5 novos em `test/graph-benchmark.test.mjs`, transporte fake, 56 no arquivo, todos verdes com `--test-concurrency=2`):

- a fixture: o estado inicial reprova o teste visível e o aceite; a referência passa 31/31; a ingênua passa no teste visível e falha em 10 ou mais aceites;
- o manifesto aponta para a fixture própria, sem `contract-v2`, com 31 aceites esperados e `verify` ok;
- `single-agent` com a solução ingênua: 1 chamada, `npm test` verde, DONE, externo FAIL, `falseDone: true`;
- `single-agent` com a referência: PASS, sem falso DONE;
- a CLI aceita `--scenario faturamento`.

**Como rodar de verdade** (gasta dinheiro; só com autorização do Douglas):

```
node bin/graph-benchmark.mjs prepare --host claude --scenario faturamento
node bin/graph-benchmark.mjs run --manifest <manifest> --variant single-agent
node bin/graph-benchmark.mjs run --manifest <manifest> --variant adaptive
node bin/graph-benchmark.mjs eval --manifest <manifest>
node bin/graph-benchmark.mjs report --manifest <manifest>
```

**Limites.** As armadilhas foram escritas por quem conhece a referência, o que dá viés: um cenário desenhado para o graph-eng ganhar não prova ganho geral. Os valores esperados dos aceites unitários foram calculados à mão e batem com a referência. O SHA-256 da integração saiu da referência, então só vale porque os 30 aceites unitários passam junto com ele. Para sustentar qualquer frase de README ou post, são precisas várias runs de cada variante (n>1). Se o agente único passar aqui também, o resultado tem de ser publicado do mesmo jeito.

## Cenário `chess` (21/10): agente único contra adaptive

Gerador de lances de xadrez em 4 módulos (`fen`, `movegen`, `game`, `perft`): roque, en passant, promoção, xeque, mate e afogamento. Os aceites externos (15) conferem as contagens perft das 6 posições da [Chess Programming Wiki](https://www.chessprogramming.org/Perft_Results), da posição inicial até a posição 6, com profundidade de até 4. Um erro numa regra muda a contagem. A fixture fica em `test/fixtures/benchmark-chess/`. O esqueleto passa 2 de 15 aceites (as duas recusas) e a referência passa 15/15.

Run `bench-claude-chess-20261021143235-733f`, host Claude, mesmo manifesto e mesmo workspace limpo para as duas variantes. Evidência em `docs/benchmarks/runs/`.

| variante | status | reportedStatus | externo | falso DONE | chamadas | custo | motor | maior contexto | entrada / saída |
|---|---|---|---|---|---|---|---|---|---|
| single-agent (opus) | PASS | DONE | PASS 15/15 | não | 2 (2 rodadas) | US$ 0,80 | 261 s | 80k | 146k / 24k |
| adaptive (haiku executa, opus revisa) | PASS | DONE | PASS 15/15 | não | 34 | US$ 1,83 | 1.315 s | 143k | 1.858k / 220k |

Na adaptive, o custo por papel ficou assim. Opus: planner 2 chamadas e US$ 0,39; planReviewer 2 e US$ 0,33; critic 2 e US$ 0,65; designReviewer 1 e US$ 0,26. Haiku: executor 12 chamadas e US$ 0,09; verifier 14 e US$ 0,10; synth 1 e US$ 0,01. Nenhuma chamada falhou.

**Leitura honesta.**

1. **Os dois acertaram.** O xadrez foi escolhido para ser difícil, mas não separou as variantes no que importa: nenhuma deu DONE falso, e as duas passaram 15/15.
2. **O agente único saiu 2,3x mais barato e 5x mais rápido.** No `happy` a diferença foi de 5,2x no custo e 9,6x no tempo; a distância diminuiu com a tarefa maior, mas não virou.
3. **O modelo barato não baixou a conta.** Só as 7 chamadas de Opus da adaptive (US$ 1,63) custaram o dobro do agente único inteiro. As 27 de Haiku custaram US$ 0,19. O custo do graph-eng está na revisão do modelo forte, não na execução.
4. **A divisão não segurou o contexto.** O maior contexto de uma chamada foi 143k na adaptive e 80k no agente único.
5. **O que o agente único precisou foi do `npm test`.** Na 1ª rodada ele deu 4/5 no teste visível. A 2ª rodada, com a saída do teste no prompt, corrigiu. O laço de checagem fez o papel que o graph-eng atribui ao verifier, por uma fração do custo.

**Limites.** n=1 por variante. Uma tarefa que o Opus resolve em 2 chamadas não estoura uma chamada só, então ainda não testa a hipótese central (tarefa grande demais para um agente). O teste mais próximo disso é o `faturamento`, que ainda não tem run real. "Com tarefa mais pesada, o graph-eng mostra valor" continua sendo hipótese. A literatura reunida em `docs/benchmarks/pesquisa-jogos-e-3d.md` (Vals.ai e outros) mostra times que muitas vezes empatam e custam mais. Para publicar uma afirmação, são precisas várias runs por variante e pelo menos um cenário em que o agente único falhe.

**Como registrar as próximas.** Depois de `eval` e `report`, `node bin/graph-benchmark.mjs archive --manifest <manifest>` copia a evidência para `docs/benchmarks/runs/<id>/` e regera `docs/benchmarks/RESULTADOS.md`. Hoje estão arquivadas as 15 runs reais do Claude (13 do `happy` de 20 e 21/10, a single-agent 2efe e a de xadrez).

## Rodada 2 (21/10): fluxo enxuto contra agente único

Depois do xadrez, o fluxo mudou (ver `CHANGELOG.md`, seção Unreleased):

- O Opus ficou só na revisão do plano. Planner, design review e critic foram para o Sonnet; executor, verifier e synth continuam no Haiku.
- Todo papel roda em effort `medium`, que agora chega de fato ao CLI.
- O estágio `plan` do `implemente` não revisa mais o próprio plano.
- O polish roda só com `--effort max`.
- Os planners preferem 2 a 4 nós de implementação.
- O critic final tem orçamento de leitura.

A 1ª tentativa desta rodada, no xadrez, bloqueou com `local_plan_correction_changed_structure`. O plan reviewer pediu ajuste no N1 no texto, mas listou só o N2 em `affectedNodes`. A correção agora pode mexer em todo nó citado (regressão em `test/feedback.test.mjs`). Na run válida abaixo, o reviewer voltou a pedir FIX_LOCAL, e a correção passou na 2ª revisão.

Runs `bench-claude-chess-20261021163158-152b` e `bench-claude-faturamento-20261021163158-7b6f`. Evidência em `docs/benchmarks/runs/`.

| cenário | variante | externo | falso DONE | chamadas | custo | motor | maior contexto |
|---|---|---|---|---|---|---|---|
| chess | adaptive (antes) | PASS 15/15 | não | 34 | US$ 1,83 | 1.315 s | 143k |
| chess | adaptive (agora) | PASS 15/15 | não | 20 | US$ 0,68 | 575 s | 113k |
| chess | single-agent | PASS 15/15 | não | 2 | US$ 0,70 | 180 s | 111k |
| faturamento | adaptive | PASS 31/31 | não | 18 | US$ 0,73 | 856 s | 624k |
| faturamento | single-agent | PASS 31/31 | não | 1 | US$ 0,51 | 105 s | 144k |

Custo da adaptive por papel:

- **Xadrez:**
  - planReviewer (Opus): 2 chamadas, US$ 0,25.
  - planner (Sonnet): 3 chamadas, US$ 0,20.
  - critic (Sonnet): 2 chamadas, US$ 0,11.
  - designReviewer (Sonnet): 1 chamada, US$ 0,06.
  - Haiku: 12 chamadas, US$ 0,07.
- **Faturamento:**
  - planReviewer (Opus): 1 chamada, US$ 0,21.
  - critic (Sonnet): 2 chamadas, US$ 0,15.
  - planner (Sonnet): 2 chamadas, US$ 0,14.
  - designReviewer (Sonnet): 1 chamada, US$ 0,05.
  - Haiku: 12 chamadas, US$ 0,18.

**Leitura honesta.**

1. **O ajuste funcionou no que mirava.** No xadrez, o custo caiu 63% (de US$ 1,83 para US$ 0,68) e o tempo, 56% (de 1.315 s para 575 s), com a mesma qualidade: 15/15. A adaptive empatou em custo com o agente único.
2. **A velocidade continua perdendo.**
   - O agente único foi 3,2x mais rápido no xadrez e 8x no faturamento.
   - A cadeia plan → review → design → implement → verify → critic é sequencial por desenho, e cada etapa paga a latência de uma chamada.
3. **O faturamento também não separou as variantes.** O cenário foi feito para pegar falso DONE (a solução ingênua passa no teste visível e falha 17/31), mas o Opus sozinho acertou 31/31 numa chamada. Nesse tamanho de tarefa, a hipótese de que o agente único se perde não se confirmou.
4. **O contexto não foi contido.** Uma chamada de executor no faturamento chegou a 624k tokens de entrada, contra 144k do agente único. Pelo preço do Haiku com cache, isso pesou pouco no custo, mas contradiz a ideia de que a divisão segura o contexto. Vale investigar na próxima rodada.

**Limites.** n=1 por variante e por cenário, sem variância. Ainda falta um cenário em que o agente único falhe.

## Rodada 3 (21/10): fluxo adaptativo por tier

Mudanças desta rodada (ver `CHANGELOG.md`, seção Unreleased):

- O runner faz uma triagem antes do plano e escolhe o tier: `fast`, `standard` ou `full`.
  - `fast` pula a pesquisa, a revisão do plano e o design.
  - `standard` mantém a revisão do plano.
  - `full` roda tudo.
  - O motor só sobe o tier, nunca desce.
- O Opus só revisa: o plano e o design. O Sonnet planeja, pesquisa, desenha e faz o critic final. O Haiku implementa, verifica, anota a pesquisa e sintetiza.
- Classificador opcional (Jev 1.13 via OpenRouter), desligado nesta rodada: valeu só a heurística.

Runs `bench-claude-chess-20261021195304-0a58`, `bench-claude-faturamento-20261021201806-6fac` (single-agent e a adaptive que bloqueou) e `bench-claude-faturamento-20261021204352-5407` (adaptive final). Evidência em `docs/benchmarks/runs/`.

| cenário | variante | tier | externo | falso DONE | chamadas | custo | motor | maior contexto |
|---|---|---|---|---|---|---|---|---|
| chess | adaptive (rodada 2) | — | PASS 15/15 | não | 20 | US$ 0,68 | 575 s | 113k |
| chess | adaptive (agora) | fast → standard | PASS 15/15 | não | 9 | US$ 0,39 | 322 s | 125k |
| chess | single-agent | — | PASS 15/15 (BLOCK no teste visível) | não | 3 | US$ 0,86 | 218 s | 106k |
| faturamento | adaptive (rodada 2) | — | PASS 31/31 | não | 18 | US$ 0,73 | 856 s | 624k |
| faturamento | adaptive (agora) | standard → full | PASS 31/31 | não | 21 | US$ 0,96 | 618 s | 277k |
| faturamento | single-agent | — | PASS 31/31 | não | 1 | US$ 0,49 | 109 s | 107k |

No xadrez, o single-agent acertou 15/15 no aceite externo, mas deu 5/6 no `npm test` visível nas 3 rodadas e terminou em `single_agent_checks_failed`. Não é DONE falso: ele não afirmou ter terminado.

Custo da adaptive por papel:

- **Xadrez** (tier `fast`, subiu para `standard` com uma revisão real do plano):
  - planner (Sonnet): 2 chamadas, US$ 0,13.
  - planReviewer (Opus): 1 chamada, US$ 0,12.
  - critic (Sonnet): 1 chamada, US$ 0,10.
  - Haiku: 5 chamadas, US$ 0,05.
- **Faturamento** (tier `standard`; o planner pediu pesquisa e o tier subiu para `full`):
  - planReviewer (Opus): 2 chamadas, US$ 0,22.
  - designReviewer (Opus): 1 chamada, US$ 0,18.
  - planner (Sonnet): 3 chamadas, US$ 0,17.
  - researcher (Sonnet): 1 chamada, US$ 0,12.
  - critic (Sonnet): 2 chamadas, US$ 0,11.
  - designer (Sonnet): 1 chamada, US$ 0,05.
  - Haiku: 11 chamadas, US$ 0,10.

**Bugs achados nas runs e corrigidos** (cada um com teste de regressão):

1. **Xadrez:** no estágio `plan` enxuto, o planner esboçou nós de implementação e a run bloqueou com `plan_stage_non_research_node`. Os esboços agora viram achados para o estágio `tasks`.
2. **Faturamento:** a revisão de design deu FIX_LOCAL com dois bloqueios no mesmo nó, e o gate falhou fechado com `feedback_scope_invalid` sem tentar o reparo. Agora repara o nó uma vez.
3. **Faturamento:** sem critérios do usuário, o planner do estágio `plan` escreveu `doneWhen` sobre a pesquisa ("cada contrato com file:line"). Esse critério fica travado até o critic final, que cobrou um registro que nenhum nó de implementação podia gravar. A run bloqueou com `critic_fix_incomplete`, com 31/31 no aceite externo. O prompt agora diz que `doneWhen` descreve a tarefa pronta.
4. **Faturamento:** o decompositor do estágio `tasks` pôs o diretório `data/` em `inputs` e a run bloqueou com `invalid_dag`. O prompt dele não tinha a regra de manifesto do planner completo; agora tem.
5. **Toda run bloqueada no critic final:** o `run.finished` gravava `feedback: null`, e o benchmark só via `engine_blocked`. O motivo agora sobe para o resultado.

**Leitura honesta.**

1. **No xadrez, o tier enxuto funcionou.** A adaptive caiu de US$ 0,68 para US$ 0,39 (−43%) e de 575 s para 322 s, com 15/15. Ficou mais barata que o agente único (US$ 0,86), que gastou 3 chamadas de Opus sem conseguir passar o teste visível. Ainda é 1,5x mais lenta.
2. **No faturamento, a adaptive ficou mais cara que na rodada 2.** Foram US$ 0,96 contra US$ 0,73. A triagem deu `standard`, mas o planner pediu pesquisa e a tarefa foi para `full`, com duas revisões de Opus (plano e design), que custaram US$ 0,40. O ganho veio no tempo (856 s para 618 s) e no contexto (624k para 277k), não no custo.
3. **O agente único continua ganhando no faturamento.** Ele custou metade e foi 5,7x mais rápido, com o mesmo 31/31. Nesse tamanho de tarefa, a divisão ainda não se paga.
4. **Quatro dos cinco bugs só apareceram com modelos mais baratos no planejamento.** O Opus seguia regras implícitas (manifesto, critério de pronto) que o Sonnet não seguiu. Trocar o modelo de um papel pede rodar os benchmarks de novo, não só os testes.
5. **Para chegar ao DONE do faturamento, foram 3 tentativas.** Cada correção revelou o bloqueio seguinte. A run final é a primeira sem nenhum bloqueio, e n=1 não diz quantas vezes ela falha.

**Limites.** n=1 por variante e por cenário, sem variância. O classificador Jev não rodou nesta rodada. A triagem errou para baixo no faturamento (`standard`, quando a tarefa precisava de `full`); o motor corrigiu subindo o tier, como previsto.

## Cenário `minecraft` (21 e 22/10): clone MVP em React

A tarefa: um clone de Minecraft jogável no navegador, em React e three.js, com o máximo de funcionalidades. A spec completa fica em `test/fixtures/benchmark-minecraft/workspace/task.md`. As duas variantes receberam o mesmo prompt e o mesmo esqueleto (`setup.sh`), cada uma num repositório local separado:

- **Agente único:** `claude -p` com Opus 5.5, esforço `medium`, sem subagentes e com teto de US$ 40.
- **graph-eng adaptive:** `runAdaptive` no host Claude, com triagem por heurística e o classificador Jev desligado.

**Como foi avaliado:**

1. Aceite oculto: 55 testes do motor (`acceptance/engine.acceptance.test.mjs.txt`). Cobrem mundo, mesher, raycast, física, inventário, crafting, mineração e ciclo dia/noite, e nenhum agente os viu.
2. Os 11 testes visíveis do esqueleto.
3. `npm run build`.
4. Smoke visual no preview. O pointer lock não funciona no painel, então mineração e inventário não foram testados na tela, para nenhuma das variantes.

Evidência em `docs/benchmarks/runs/minecraft-20261021/`.

| variante | run | resultado | aceite oculto | visível | jogo na tela | chamadas | custo | motor | maior contexto |
|---|---|---|---|---|---|---|---|---|---|
| agente único | 1 | DONE | 55/55 | 11/11 | sim | 76 turnos | US$ 5,97 | 1375 s | — |
| graph-eng | 1 | BLOCK `local_plan_correction_changed_structure` | — | — | não | 8 | US$ 0,96 | 190 s | 117k |
| graph-eng | 2 | BLOCK `provenance_unsealed_window:R (sem nota registrada)` | — | — | não | 19 | US$ 1,92 | 1423 s | 1141k |
| graph-eng | 3 | BLOCK `provenance_unsealed_window:N2`, reparos esgotados (2/2) | — | — | não | 17 | US$ 1,45 | 888 s | 417k |
| graph-eng | 4 | BLOCK `local_repair_budget_exhausted` no estágio `plan` | — | — | não | 9 | US$ 1,02 | 261 s | 82k |
| graph-eng | 5 | BLOCK `provenance_unsealed_window:R3`, reparo sem progresso | 55/55 | 11/11 | não | 21 | US$ 2,23 | 2305 s | 1013k |

**O que cada variante entregou.**

- **Agente único:** jogo completo, com cerca de 3.500 linhas em 30 arquivos.
  - Tela: menu com seed e distância de render, mundo com árvores, água e nuvens, mão, hotbar e debug F3 (100 FPS, 69 malhas, 23k triângulos).
  - Console sem erro. Só o build avisou do tamanho do chunk.
  - Custo: tudo em Opus. Ele disse ter feito um playtest headless por CDP, o que não foi conferido.
- **graph-eng run 5:** só o motor está completo, com o mesmo 55/55 do agente único e mais dois arquivos de teste que ele mesmo escreveu.
  - O render (`src/render/`) está escrito mas não ligado a nada, e `src/main.jsx` continua o esqueleto ("em construção").
  - O nó de UI nunca rodou: a run parou no R3.
  - O verify (Haiku) achou um bug real: o drop minerado se perde quando o inventário está cheio. Conferido no código: `src/render/game.js` remove o bloco e descarta a sobra de `addItem`. O reparo, também feito pelo Haiku, não reduziu os bloqueios. A janela de proveniência do R3 ficou sem selo, e a run inteira bloqueou.

**Bugs achados nas runs e corrigidos** (cada um com teste de regressão):

1. **Run 1:** a correção local do plano mudava as `deps` de um nó citado pelo revisor (ex.: "N2 depende do N1") e era recusada como mudança de estrutura. Agora um nó editável que ainda não rodou pode ganhar ou perder `deps`.
2. **Run 1:** no estágio `plan`, o `goal`/`doneWhen` voltou a descrever a pesquisa ("contrato mapeado para cada stub"). O prompt do estágio agora diz, com exemplo bom e ruim, que eles descrevem a tarefa inteira.
3. **Run 2:** um nó reprovado no verify voltava sem nota, e o bloqueio dizia "sem nota registrada". A nota agora traz os problemas do verify e por que o reparo parou.
4. **Runs 2 e 3:** o pool de 2 reparos locais era da run inteira. A revisão do plano e a do design o gastavam antes de qualquer nó de código falhar, e o código parava sem reparo. Agora cada nó de implementação tem o próprio reparo, até o limite por nó, e o orçamento reserva 1 executor e 2 verifier por nó de código pendente.
5. **Run 4:** o pool passava de estágio para estágio, e a crítica da pesquisa mais duas revisões do plano esgotaram tudo no estágio `plan`. Agora cada estágio tem o próprio pool de 2, e a retomada aceita o contador recomeçando na fronteira.

**Leitura honesta.**

1. **No Minecraft, o agente único ganhou com folga.** Entregou um jogo funcionando de primeira, por US$ 5,97 em 23 min. O graph-eng precisou de 5 tentativas, somou US$ 7,58 e não entregou jogo em nenhuma delas.
2. **Quatro das cinco tentativas pararam no próprio graph-eng, não na tarefa.** As runs 1 a 4 foram regras de controle apertadas demais para uma tarefa grande. Cada correção revelou a próxima trava.
3. **A run 5 parou em limite de modelo, com o motor do graph-eng funcionando.** O verifier (Haiku) apontou um bug real e o executor (Haiku) não conseguiu consertar. Quando um nó de código falha, a regra de proveniência barra o nó seguinte, então um bug no meio do grafo derruba a entrega inteira. O agente único, com Opus escrevendo, não teve esse problema.
4. **No motor puro, os dois empataram** (55/55). O custo da run 5 até ali (US$ 2,23) foi 37% do agente único, mas sem render, sem UI e sem jogo. A comparação de custo só vale com entrega igual.
5. **Com contexto grande, o graph-eng chegou a 1M de tokens numa só chamada** (runs 2 e 5), contra a ideia de que dividir o trabalho mantém o contexto pequeno.

**Limites.** O agente único é n=1. O graph-eng teve 5 runs, mas com código diferente em cada uma, já que cada run veio depois de uma correção. Nenhuma das duas variantes teve a mineração e o inventário testados na tela. O classificador Jev não rodou.
