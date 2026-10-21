# graph-eng 2.0: por que o desenho é este

Versão 2.0.0 (2026-10-20). Este documento explica as decisões de desenho da 2.0 e aponta a evidência de
cada uma. Comandos, bloqueios e uso do dia a dia estão no [README](../../README.md) e no [SKILL.md](SKILL.md).

Graph engineering é modelar o trabalho como **nós ligados por arestas**, com um estado compartilhado. O
risco de um grafo é ser grande demais: sistema multiagente gasta muito mais tokens que um chat, e o volume
de tokens explica boa parte da variância de qualidade ([ma]). A meta é o menor grafo que melhora o
resultado, e não o maior.

## 1. Ideia central: orquestração bidirecional adaptativa

O motor planeja, executa e verifica num grafo. O feedback dos revisores **volta pelo grafo**, em vez de
seguir sempre para frente. Cada revisão devolve uma decisão tipada, com evidência, gravidade, nós afetados
e motivo:

- `APPROVE`: a revisão aceita o que foi pedido. Não aponta nós.
- `FIX_LOCAL`: reparo dentro dos nós afetados, feito pelo executor. Há um banco de 2 reparos locais por
  run, compartilhado por todos os nós.
- `REPLAN`: o plano está errado (dependências, escopo ou critérios). Volta ao planner. No máximo 2 por run.
- `BLOCK`: para com um motivo legível. Não declara o projeto concluído.
- `DONE`: só com checks reais aprovados, critic aprovado e identidade de contrato atual (seção 5).

`APPROVE` e `DONE` exigem `affectedNodes` vazio. `FIX_LOCAL` e `REPLAN` exigem pelo menos um id que exista
no plano. O DAG continua acíclico: só o controle entre rodadas forma ciclo. Um ciclo, autorreferência ou
dependência desconhecida é recusado antes de qualquer agente rodar, e nenhuma aresta é removida em silêncio.

Por que bidirecional: quando um revisor reprova, o motor sabe para onde voltar e repete só a parte
afetada, preservando o trabalho que já está comprovadamente válido. Um critic que reprova sem apontar nó
não gera nenhum retorno útil, e por isso ele é rejeitado pelo schema.

Os riscos que ordenaram o desenho: falso DONE (checks reais numa etapa independente, falha de ferramenta
nunca vira aprovação); artefato obsoleto (fingerprints de entradas, contratos, dependências e saídas);
loop caro (limites internos, orçamento por papel, bloqueio explícito ao esgotar); concorrência (escrita com
dono por arquivo, caminho desconhecido serializa); aprovação desatualizada (checks finais sobre o conteúdo
entregue, edição posterior invalida a aprovação); diferença entre hosts (adapter explícito, sem fallback de
modelo); migração de runs antigas; e evidência simulada, que valida controle mas não substitui smoke real.

## 2. Pipeline por comandos

Cinco comandos num runner só. O fluxo típico é `plan` → `clarify` (se houver perguntas) → `tasks` →
`implemente`. `init` abre o painel e não entra no fluxo.

- `plan <tarefa>`: planeja, pesquisa e passa o plano pelo critic de pesquisa. Publica o plano aprovado no
  slot. Não altera código do produto. O plano traz no máximo 3 perguntas; se houver alguma, a run termina
  com `needs_clarification`.
- `clarify`: responde as perguntas pendentes do plano aprovado. As respostas entram como dado, e o plano
  volta à revisão forte. Não recebe tarefa e não inventa respostas.
- `tasks`: decompõe o plano aprovado em um DAG validado (ids, dependências, escopo de escrita e checks)
  e passa pela revisão forte. Não executa nada.
- `implemente [<tarefa>]`: executa as tarefas aprovadas compatíveis, roda os checks e o critic. O critic
  reprova com `FIX_LOCAL` (volta ao executor) ou `REPLAN` (volta ao plano). Sem artefato reutilizável, roda
  o fluxo inteiro na mesma run: plan → research → critic → tasks → implement → critic → finish.

Os estágios `plan`, `clarify` e `tasks` só leem o repositório e não recebem checks. Só `implemente` escreve.

**Slots de feature corrente.** Há um slot de plano e um de tarefas por repositório. Um `plan` aprovado
novo substitui o anterior. Antes de reutilizar um artefato, o runner confere a identidade da tarefa, a
origem verificada e a identidade do workspace. Se algo não bate, ele não reutiliza em silêncio: a decisão e
o motivo vão para o journal. Os motivos possíveis são `workspace_changed`, `task_changed`,
`tasks_plan_mismatch`, `source_unverified`, `artifact_tampered`, `needs_clarification` e
`clarification_stale`.

**Sem atalho trivial.** Cada modo roda o esqueleto inteiro de fases. O motor não tem um caminho de um nó
só para tarefa pequena: quem decide se a tarefa merece o grafo é o usuário (seção 11).

## 3. Papéis fixos por host

Não há flag pública de modelo, papel, largura ou limite. A tabela vem de `MODEL_BY_ROLE` em `bin/hosts.mjs`,
e o workflow confere a mesma tabela em `REQUIRED_MODELS` antes de rodar.

| Papel | Claude Code | Codex |
| --- | --- | --- |
| planner, planReviewer, designReviewer, critic (papéis fortes) | opus | gpt-6.1-sol |
| executor, verifier, synth (papéis operacionais) | haiku | gpt-6-luna |

Papéis fortes decidem o plano, revisam o design e julgam a entrega. Papéis operacionais executam, verificam
nós e sintetizam. Se o host não expõe o modelo exigido, a run bloqueia com
`trusted_host_capability_or_model_policy_unavailable`. Não há troca silenciosa de modelo nem API alternativa.

Quem escreve não verifica. Cada implementação é verificada por outro agente, pelo mesmo motivo de viés de
autoavaliação documentado em [selfpref]. Verificador e critic são somente leitura.

## 4. Esforço e orçamento

`--effort low|medium|max`, com padrão `medium`, na forma separada (`--effort max`). Não existe `--effort=max`.
O esforço controla profundidade e orçamento interno. Não escolhe modelos, não fixa número de agentes e não
enfraquece checks nem critic.

| effort | largura de execução | teto de nós do plano |
| --- | --- | --- |
| `low` | 1 | 3 |
| `medium` (padrão) | 2 | 6 |
| `max` | 2 | 10 |

O orçamento é contado **por papel**, em `bin/budget-policy.mjs`. Planner, planReviewer, designReviewer e
critic têm 5 chamadas cada, e synth tem 3. Executor e verifier não têm teto fixo: o motor calcula a demanda
do plano (nós pendentes, polidores e reserva para reparos) e reserva essa demanda antes do fan-out. Assim,
o orçamento de um nó não come o da revisão.

Knobs da 1.x (`ceiling`, `maxAgents`, `economy`, `width`, `maxNodes`, `maxRounds`, `maxRepairs`, `planGate`,
`roleModels` e variantes) são recusados com `removed_budget_override`. Eles não podem sobrescrever a política
nova por um argumento esquecido. Um `effort` fora de `low|medium|max` vira `invalid_effort`.

## 5. Contratos do motor

- **Retomada não dá crédito.** Os contadores de reparo e de replan vêm do checkpoint e continuam de onde
  estavam. Um nó pronto que volta na retomada é marcado `resumed` e não é recontado como trabalho novo.
- **Contadores nunca diminuem.** Reparos locais e replans só incrementam, e os limites valem para a run
  inteira, incluindo os estágios do pipeline.
- **Replan ≤ 2 por run.** Ao esgotar, o motor bloqueia com `structural_replan_budget_exhausted`.
- **Aprovação vale para uma identidade.** Uma revisão de design só vale para o `workOutputIdentity` e o
  `readyFingerprintIdentity` que ela revisou. Se o nó mudou depois, a aprovação é recusada.
- **Invalidação transitiva.** Mudar um nó invalida seus dependentes, e só eles. Caso de referência: se A
  muda, C (que depende de A) é revalidado, e B (independente) fica preservado apenas se seus fingerprints
  continuarem válidos.
- **DONE exige três coisas**: checks reais com receipts válidos sobre o snapshot atual; critic com
  `done: true`, sem lacunas, com evidência para todos os critérios e com o snapshot final igual ao que o
  critic viu. Sem uma delas, o motor troca o veredito por `BLOCK` com motivo (`critic_done_evidence_invalid`).

## 6. Checks confiáveis

- **Só `node --test`.** O adapter aceita apenas `scripts.test` exatamente igual a `node --test`. Vitest,
  Jest, scripts com flags extras e repositórios sem esse contrato geram `BLOCK` com
  `trusted_check_discovery_failed` em `implemente`. `plan` continua disponível.
- **Seleção por nó.** Cada nó recebe uma seleção local derivada de `inputs`, `outputs` e `files` aprovados.
  Os checks rodam com `process.execPath`, argv explícito e sem shell. Se o mapeamento estiver incompleto,
  a cobertura é marcada como limitada, com `limitation` no receipt, e só rodam `node --check` aplicáveis e
  a validação de contrato e grants.
- **Gate final.** A suíte completa roda com concorrência 2, depois de todo o polish, sobre o conteúdo que
  será entregue. Qualquer alteração de polish exige revalidação.
- **Manifestos com caminhos relativos ao repositório.** `files`, `inputs` e `outputs` não aceitam caminho
  absoluto, `..`, `./`, espaço, vírgula nem `:` seguido de dígito. A recusa acontece no gate, com
  `invalid_dag` e o nó e o campo citados, antes de qualquer agente rodar. Texto livre no manifesto não passa.
- **Input externo precisa existir e ter fingerprint.** Caso contrário o nó é bloqueado com
  `external_inputs_unfingerprintable` antes do trabalho, e um input externo ausente vira
  `input_externo_ausente`.
- **Output dentro de `files`.** Um output fora de `files` do próprio nó é recusado.
- **Janela de proveniência com causa.** Se um nó escreve e a janela não é selada, o nó seguinte é bloqueado
  com `provenance_unsealed_window:<id> (causa: …)`, e a causa vai junto. Sem a causa, o bloqueio ficaria
  mascarado, como aconteceu numa run real.
- **Limite conhecido.** Um nó sem input externo e com preflight nulo não bloqueia. Um nó que cria arquivo
  novo tem um input inexistente por natureza, então o fingerprint nulo é legítimo.

## 7. Host Claude isolado

No Claude Code, cada papel roda com `claude -p` isolado do ambiente do usuário:

- `--strict-mcp-config --mcp-config {"mcpServers":{}}`: nenhum MCP do usuário.
- `--disable-slash-commands`: nenhuma skill ou command herdado.
- `--setting-sources project,local`: nenhum settings global.
- `--permission-mode dontAsk`: o que não tem regra explícita é negado.
- Leitura: `--allowedTools Read,Glob,Grep`. Escrita: `Edit(./**)`, só dentro do cwd. As negações voltam no
  resultado, em `permissionDenials`.
- Um cwd com segmento `.claude` é recusado para papel de escrita, com `CWD_PROTECTED_PATH`, porque o
  `dontAsk` negaria o Write nesse caminho.

Motivo: antes do isolamento, cada turno carregava cerca de 75 mil tokens do ambiente do usuário. Com o
isolamento, cai para cerca de 6,5 mil. Na mesma troca, o benchmark com Claude passou de US$ 88 para US$ 0,97
numa run isolada de 20/10. A regressão está coberta em `test/hosts.test.mjs`.

Consequência de desenho: o Claude Code não tem shell de agente (`agentShell=false`). Por isso o aceite de
pesquisa e de design nunca exige rodar comando. Quem roda os checks é o supervisor, que grava os receipts.
Antes da correção, pesquisa que queria rodar `node` ou `npm test` ficava `partial` para sempre. No Codex,
`agentShell=true` e o prompt diz isso ao agente.

## 8. Integridade, locks e memória

- **Integridade da runDir.** A árvore de `.graph-runs/<runId>/` é conferida por um guard. Uma violação bloqueia
  a run com `run_integrity_violation` e não grava REPORT. Um erro de checagem que não é violação (um
  diretório ilegível, por exemplo) bloqueia com `integrity_check_failed`, mesmo que a permissão volte depois.
  Os limites conhecidos estão no README: a violação não persiste depois que o processo sai, e a saída de um
  handle não tem hash.
- **Lock de workspace com dono morto.** A run não remove o lock sozinha. Ela para com
  `workspace_lock_owner_dead` e indica o arquivo e o pid. A remoção é manual, depois de confirmar que o pid
  não existe. JSON inválido (`workspace_lock_invalid`) e dono ambíguo (`workspace_lock_ambiguous`) também
  exigem inspeção antes de qualquer remoção.
- **Memória entre runs.** Fica em `~/.claude/graph-eng/memory/<repoId>`, fora da runDir. Cada worker recebe só
  os registros do próprio nó e contrato, dentro de um bloco marcado como dado não confiável e com `<`
  escapado. As limitações da v2.0 (planner e critic não recebem memória) estão no README.

## 9. Painel: só visualização

`init` inicia ou reutiliza o painel local, desacoplado da sessão. Fechar a sessão não derruba o localhost. O
painel mostra as runs ao vivo, as fases, o feedback tipado de cada revisão e o motivo dos bloqueios.

A fila de ações da 1.x (pedidos `resume`, `stop` e `rerun-node` gravados em arquivo e atendidos por uma
sessão que ficava ouvindo, além do comando `/graph-eng:painel`) saiu do desenho da 2.0. O painel não controla
mais a execução.

Saíram também `bin/requests.mjs`, `bin/ui/actions.mjs`, `bin/ui/commands.mjs`, as rotas `POST /api/requests*`
e `GET /api/listeners`, e o consumo de pedidos no `graph-watch`. A regra de parada do watcher ficou só por
silêncio. A gaveta de artefatos continua, só leitura (`bin/ui/artifacts.mjs`, `GET /api/runs/:wf/artifacts`).

## 10. Benchmark e smoke: o que medem e o que falta

**Benchmark** (`bin/graph-benchmark.mjs`). Compara duas variantes, cada uma com uma cópia limpa do mesmo
workspace: `v1-normalized` (a lógica da 1.x com a política de modelos da 2.0) e `adaptive` (a 2.0). A
avaliação é externa, por testes de aceitação que ficam fora do workspace; o motor não avalia a si mesmo.
Mede chamadas, tokens e custo. Marca `falseDone` quando o motor declara DONE e a avaliação externa reprova.

**Resultados registrados** (tabela completa em `docs/validation/graph-eng-2-benchmark.md`, parte (b)):

- Claude, 20 e 21/10, treze rodadas reais. `v1-normalized` deu aceite externo PASS em 11 de 11 a partir da
  rodada 7197, com cerca de 10 chamadas e cerca de US$ 1 por rodada. `adaptive` nunca deu falso DONE. Cada
  BLOCK dela (`provenance_unsealed_window`, `CLI_FAILED`, `provenance_frontier_changed_before_window`,
  `plan_effort_mismatch`, `no_progress_feedback_loop`, `original_plan_criteria_changed`,
  `critic_done_evidence_invalid`, `engine_blocked`, `node_record_stale_at_completion`) virou correção
  estrutural com teste de regressão. Nas rodadas b343, 6ab6, 45db e 144b ela entregou código correto (externo PASS) e parou no selo. Na f366 fechou `DONE` com aceite externo 10/10, 21 chamadas e nenhum falso DONE.
- Codex: benchmark NOT_RUN.
- Smoke Claude, 20/10: PASS, com o worker Haiku, o reviewer Opus, o cancelamento e a prova de escrita do
  executor (`writeProbe`).
- Smoke Codex, 18/10: PASS para worker `gpt-6-luna`, reviewer `gpt-6.1-sol` e cancelamento. Mas é anterior ao
  C14 e não tem `writeProbe`, então precisa ser refeito.

Não há percentual de sucesso consolidado. Os testes com transporte simulado (`simulated=true`) validam
controle; não medem consumo de franquia nem qualidade de modelo. **O Codex real ainda não está validado**: não
há benchmark nem prova de escrita atuais para ele.

## 11. Quando NÃO usar

- **Tarefa de um passo ou pequena.** O grafo só adiciona custo, e o motor não tem atalho para isso. Faça direto
  na sessão.
- **Trabalho sequencial com contexto compartilhado denso**, como depurar um fluxo. A maioria das tarefas de
  código tem poucas partes paralelizáveis, e a escrita é de raia única. Faça direto na sessão.
- **Repositório sem o contrato de checks.** Sem `scripts.test` igual a `node --test`, `implemente` bloqueia.
  Use `plan` para ler o problema e decida os checks antes.
- **Quando o aceite só se verifica fora do repositório**, como um deploy ou um dado de produção. O grafo
  produz evidência, mas não substitui a decisão humana nesse ponto.

## Spec: quanto escrever antes do grafo

A pergunta é de quem é dono de quê. **O humano é dono do "o quê"** (objetivo, aceite e limites), na tarefa e
nas respostas do `clarify`. **O grafo é dono do "como"** (decomposição, pesquisa e implementação).

- Spec pesada tem custo. Num comparativo, Spec Kit deu 33 min de agente, 3,5 h de review e 1 bug; o fluxo
  iterativo deu 8 min, 15 min e nenhum bug ([scottlogic]).
- As perguntas do planner precisam mudar o plano e não podem ser resolvidas pelo repositório. Por isso o
  limite é de 3. Pergunta que o código responde é reprovada pelo critic de pesquisa.
- O ponto de partida é um objetivo e um aceite verificável, não uma spec longa. O teste passa ou não passa.

## Fontes

[ma]: https://www.anthropic.com/engineering/multi-agent-research-system
[selfpref]: https://arxiv.org/abs/2404.13076
[scottlogic]: https://blog.scottlogic.com/2025/11/26/putting-spec-kit-through-its-paces-radical-idea-or-reinvented-waterfall.html
[lc]: https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph

- LangChain, *3 Years of Graph Engineering with LangGraph* (jul/2026) [lc], base do conceito de graph
  engineering. Os números de tokens e de variância em [ma] vêm da fonte original e não foram reverificados
  nesta versão do documento.
