# Changelog

## 1.0.0 — 2026-10-21

A 1.0 troca o motor 0.1 por uma **orquestração bidirecional adaptativa**. O plano é executado como grafo, e o feedback dos revisores volta por ele com quatro decisões, todas com evidência:

- `FIX_LOCAL`: reparo dentro do nó afetado.
- `REPLAN`: replanejamento, no máximo 2 por run.
- `BLOCK`: parada com motivo legível.
- `DONE`: só com checks reais aprovados, critic aprovado e identidade de contrato atual.

### Novo

- **Cinco comandos num runner só:** `plan`, `clarify`, `tasks`, `implemente` e `init`.
  - Cada repositório tem um slot de plano e um de tarefas (a feature corrente).
  - O reuso de artefato é conferido; quando é recusado, o motivo fica no journal.
- **Esforço só `--effort low|medium|max`.** O orçamento é contado por papel (`bin/budget-policy.mjs`).
- **Papéis e modelos fixos por host**, sem flag pública:
  - Claude: Opus para planner, plan/design reviewer e critic; Haiku para executor, verifier e synth.
  - Codex: `gpt-6.1-sol` nos papéis fortes, `gpt-6-luna` nos operacionais.
- **Contratos do motor:**
  - a retomada não dá crédito de orçamento;
  - os contadores nunca diminuem;
  - o replan tem teto 2;
  - o DONE é negado sem checks reais, critic e identidade atual.
- **Checks confiáveis:**
  - só `node --test`, com seleção por `inputs`, `outputs` e `files` aprovados;
  - a suíte completa roda no gate final, com concorrência 2.
- **Manifestos de nó validados:**
  - os caminhos precisam ser relativos ao repositório;
  - um input externo precisa existir e ter fingerprint (`external_inputs_unfingerprintable`);
  - um output precisa estar dentro de `files`.
- **Janela de proveniência com causa:** `provenance_unsealed_window:<id> (causa: …)`.
- **Integridade da runDir, lock de workspace e memória entre runs**, com seleção por nó e contrato.
- **Host Claude isolado:**
  - `--strict-mcp-config`, `--disable-slash-commands`, `--setting-sources project,local` e `--permission-mode dontAsk`;
  - escrita só no cwd (`Edit(./**)`);
  - cwd sob `.claude` é recusado com `CWD_PROTECTED_PATH`;
  - as negações de permissão voltam no resultado.
- **Smoke real com prova de escrita** (`write-probe.txt` com nonce). Ele detecta executor que não consegue gravar.
- **Benchmark real** (`bin/graph-benchmark.mjs`):
  - compara a lógica v1 normalizada com a adaptativa;
  - avalia com testes de aceitação externos;
  - mede custo e tokens por chamada.
- **Plugin portátil** para Claude Code (`.claude-plugin/`) e Codex (`.codex-plugin/`).

### Corrigido

- O executor Claude não gravava nada: o `dontAsk` sem `allowedTools` negava toda escrita.
- O smoke dava falso PASS com worker só de leitura.
- O contexto vazava do ambiente do usuário para cada chamada (cerca de 75k tokens por turno). Com o isolamento caiu para cerca de 6,5k, e o benchmark passou de US$ 88 para cerca de US$ 1.
- `APPROVE` com `affectedNodes` preenchido era rejeitado: o schema agora declara a regra.
- Pesquisa sem shell ficava `partial` para sempre: o aceite de pesquisa e de design não exige mais rodar comandos.
- Texto livre nos manifestos virava "input mudou" (`provenance_unsealed_window`).
- Erro do Claude sem `result` (`is_error`) perdia o motivo e o custo. Agora o erro guarda subtype, mensagens, uso e modelo, e o benchmark registra tudo.
- No polish, uma área reprovada sem selo deixava a próxima mascarar o motivo real. Agora as áreas seguintes param com o motivo da primeira.
- O planner podia devolver um esforço diferente do pedido (`plan_effort_mismatch`). O schema só aceita o esforço do usuário.
- O nó refeito por `FIX_LOCAL` do critic não recebia o motivo do critic. Agora recebe no prompt.
- Sem acesso à web, o aceite de pesquisa podia exigir URL externa e ficar `partial` para sempre. A capability `agentWeb` tira essa exigência do planner e do worker.
- A correção e o replan do plano podiam reescrever o `doneWhen` (`original_plan_criteria_changed`). O `doneWhen` agora é travado no prompt e no schema em todos os caminhos, e a mesma lista em outra ordem é aceita.
- O critic podia aprovar (`DONE`) respondendo só parte dos critérios (`critic_done_evidence_invalid`). O schema agora exige um item por critério, com o texto travado.
- O verificador do nó reprovava por falta de evidência de `npm test`, que só roda no gate final. Agora o prompt diz que a suíte inteira fica para o gate final e que o nó é julgado pelos checks locais.
- Um implement reprovado deixava a janela sem selo, e o polish das outras áreas mascarava o motivo com `provenance_frontier_changed_before_window`. Agora o polish não roda e mostra qual nó não concluiu.
- No polish de uma área com mais de um nó, cada nó era conferido contra o diff da área inteira, e o arquivo do vizinho contava como fora do grant. Agora a janela é conferida contra o grant da área, e cada nó só pelos arquivos dele.
- Um dependente fora da área, revalidado no polish, herdava o selo da janela antiga e o registro dele vencia no fim (`node_record_stale_at_completion`). Agora a revalidação descarta o selo herdado e sela a janela nova.

### Removido

- Fluxo 0.1 de `effort × ceiling`: `manual`, `auto`, `high`, `maxAgents` e `economy`.
- CLI `graph-config` e CLI `graph-resume`.
- Fila de ações do painel: pedidos, sessão ouvindo e as rotas `POST /api/requests*`. O painel agora é só visualização ao vivo.
  - Saíram `bin/requests.mjs`, `bin/ui/actions.mjs`, `bin/ui/commands.mjs`, `GET /api/listeners` e o consumo de pedidos no `graph-watch`. A parada da run passa a ser só por silêncio, e `events` sai logo depois do TERMINADO.
  - A gaveta de artefatos continua, só leitura (`bin/ui/artifacts.mjs`).
- Skill e comando antigos `graph-eng:graph-eng` e `/graph-eng:painel`. Use `init`.

### Benchmark

- Rodada real f366 (Claude): `DONE` com aceite externo 10/10 e sem falso DONE, em 21 chamadas, por US$ 0,80. O modelo forte responde por cerca de 95% do custo. Detalhe em `docs/validation/graph-eng-2-benchmark.md`.

### Limites conhecidos

- O host Codex real (smoke e benchmark) ainda não foi validado. Só o Claude tem evidência real.

## 0.1.0

Primeira versão: motor 0.1 com painel web.
