# graph-eng

GraphEng2 planeja ou executa tarefas complexas como grafos pequenos, com papéis definidos pelo host, checks confiáveis e evidências por execução. O pacote mantém a identidade `graph-eng` e descobre `skills/` em local portátil.

Versão atual: **2.0.0**. Veja o [CHANGELOG](CHANGELOG.md).

## Como funciona (2.0)

A 2.0 troca o motor 1.x por uma **orquestração bidirecional adaptativa**:

1. O planner (papel forte) gera um plano como grafo de nós, com critérios de pronto (`doneWhen`) e o esforço pedido.
2. O plan reviewer aprova ou devolve feedback. Os executores rodam os nós, cada um com inputs, outputs e arquivos aprovados.
3. O feedback dos revisores volta pelo grafo com uma de quatro decisões, sempre com evidência:
   - `FIX_LOCAL`: refaz só o nó afetado, com o motivo do revisor no prompt.
   - `REPLAN`: plano novo, no máximo 2 por run. O `doneWhen` do usuário fica travado no prompt e no schema.
   - `BLOCK`: para com motivo legível (por exemplo `original_plan_criteria_changed`).
   - `DONE`: só com checks reais aprovados, critic aprovado e identidade de contrato atual.
4. O supervisor roda os checks (`node --test` afetado por nó; suíte inteira no gate final) e sela a janela de proveniência de cada nó.

O motor nunca dá crédito de orçamento na retomada, os contadores nunca diminuem, e um DONE sem evidência é negado.

## Benchmark

`bin/graph-benchmark.mjs` compara a lógica v1 normalizada com a adaptativa, num cenário fixo, com aceites externos que os agentes não veem. Rodadas reais com Claude (detalhe em [docs/validation/graph-eng-2-benchmark.md](docs/validation/graph-eng-2-benchmark.md)):

- **Custo:** cerca de US$ 1 por rodada (antes, US$ 88: o host vazava cerca de 75k tokens de contexto por chamada; isolado, cerca de 6,5k).
- **v1-normalized:** aceite externo PASS em 11 de 11 rodadas, mas sempre reporta PARTIAL: não sabe dizer se terminou.
- **Adaptativa:** na rodada f366 fechou `DONE` com aceite externo 10/10 (21 chamadas, cerca de 292 s). Nenhum falso DONE em nenhuma rodada. Cada BLOCK anterior virou correção com teste de regressão.
- **Codex real:** ainda não validado.

## Uso

| Host | Invocação nativa |
| --- | --- |
| Claude Code | `/graph-eng:plan <tarefa>`, `/graph-eng:clarify`, `/graph-eng:tasks`, `/graph-eng:implemente [<tarefa>]`, `/graph-eng:init` (ou `/graph-eng:grapheng <comando>`) |
| Codex | a skill `graph-eng:grapheng`, com os mesmos cinco comandos; use o nome que o cliente mostra. Não há slash global do plugin no Codex |

Comandos disponíveis (cinco, todos no mesmo runner):

- `plan <tarefa>` gera o plano e o publica no slot de plano, sem executar implementação ou checks. Se houver perguntas, a run termina com `needs_clarification`.
- `clarify` responde as perguntas pendentes do plano aprovado. Não recebe tarefa e não inventa respostas.
- `tasks` decompõe o plano aprovado em tarefas (DAG) e publica no slot de tarefas. Não recebe tarefa e não executa nada.
- `implemente [<tarefa>]` executa o fluxo e exige checks descobertos por mapeamento seguro. Sem tarefa, usa o plano da feature corrente.
- `init` inicia ou reutiliza o painel local desacoplado e informa a porta real.

Fluxo típico: `plan` → `clarify` (se houver perguntas) → `tasks` → `implemente`. Cada comando reutiliza o artefato anterior quando ele ainda vale; se algo mudou, o runner recusa o reuso e mostra o motivo (`workspace_changed`, `task_changed`, `tasks_plan_mismatch`, `source_unverified`, entre outros).

Há um slot de plano e um de tarefas por repositório, a **feature corrente**: um `plan` aprovado novo substitui o anterior.

O esforço aceita `low`, `medium` (padrão) ou `max`, na forma separada (`--effort max`); `--effort` substitui a configuração em `plan`, `clarify`, `tasks` e `implemente`. Papéis e modelos são fixos pelo adapter confiável de Claude ou Codex. Não há flags públicas para modelos, papéis, largura ou limites internos.

O adapter de execução implementado neste corte é somente Node native test runner em repositórios com `package.json` legível e `scripts.test` exatamente `node --test`. Vitest, Jest, scripts com flags extras e repositórios sem esse contrato produzem `BLOCK` para `implemente`; `plan` continua disponível. Cada nó recebe uma seleção local derivada de `inputs`, `outputs` e `files` aprovados pelo supervisor. Um mapping interno conhecido roda os testes afetados; sem mapping completo, a cobertura é marcada como limitada e só se executam `node --check` aplicáveis e a validação do contrato/grants. O gate final roda a suíte completa com concorrência 2 somente depois de todo polish. Os checks usam `process.execPath`, argv explícito e spawn sem shell. Cada run grava seleção e receipts em `.graph-runs/` no repositório.

O runner informa o estado e os bloqueios encontrados durante a execução. Quando não há mapeamento confiável de checks, `implemente` fica bloqueado; não invente comandos para contornar isso.

## Concorrência no mesmo repositório

Enquanto um `implemente` roda no mesmo repositório, `plan`, `clarify` e `tasks` podem ser bloqueados com `workspace_busy`. Isso é esperado: o lock do workspace é o mesmo para leitura e escrita, e só sai quando a run termina.

## CLI direto (`bin/graph-run.mjs`)

O uso direto do runner é para depuração. `node bin/graph-run.mjs --host <claude|codex> --args <arquivo.json>` bloqueia implementação sem `nodeCheckPolicy` com `write_audit_unavailable`, sem criar host nem runDir, e sai com código 2. Plano só de leitura (`planOnly`, `research`, `architecture`, `review`) passa sem política.

Retomar pelo CLI direto exige repetir `mode` e `nodeCheckPolicy` nos args. Um arquivo só com `{ "runId": "...", "resume": { ... } }` cai no mesmo bloqueio, mesmo que a run original tenha política.

## Limites de integridade da runDir

A run grava o estado em `.graph-runs/<runId>/` e confere a árvore com um guard de integridade. Esse guard tem dois limites conhecidos:

- **A violação não persiste depois que o processo sai.** Enquanto o processo que detectou a alteração está vivo, a run fica bloqueada com `run_integrity_violation` e não escreve REPORT. Quando a run é retomada depois, o baseline é recalculado a partir dos bytes atuais do disco, e o resume aceita o que estiver lá.
- **Durante o handle de um host, a saída de outro handle não é vigiada.** Um agente com escrita na runDir pode trocar o `.host-*.output.json` de outro handle sem que o guard perceba, porque a saída não tem hash. O schema tem hash e é conferido na limpeza.

Um erro de checagem que não é violação, como um diretório ilegível no inventário, bloqueia com `integrity_check_failed`, mesmo que a permissão volte antes do fim da run, e não grava REPORT.

Custo: a checagem da árvore inteira roda por agente e custa O(bytes da runDir). Com runDir de 1 a 10 MB, cada checagem leva de 10 a 25 ms; acima de 100 MB, esse custo deve ser reavaliado.

## Lock de workspace com dono morto

Cada workspace tem um lock de recurso no diretório de estado. Se a run encontra esse lock com dono morto, ela não o remove sozinha: a execução para com `workspace_lock_owner_dead`, e o detalhe traz o caminho do arquivo e o pid do dono. Um pid vivo com outra identidade de processo (pid reutilizado) conta como dono morto.

Remoção manual: confirme que o pid do detalhe não existe mais e só então apague o arquivo indicado. Um lock com JSON inválido (`workspace_lock_invalid`) ou com dono ambíguo (`workspace_lock_ambiguous`) também fica parado para inspeção e exige a mesma conferência antes de qualquer remoção.

## Memória entre runs

Ao fim de cada run sem violação de integridade e com lease confiável (sem falha de heartbeat), o supervisor registra na memória do repositório (`~/.claude/graph-eng/memory/<repoId>`, fora da runDir) os registros de design aprovado e de checks válidos. Falha de memória ou de registro vira diagnóstico no journal e nunca muda o status da run.

Uma run seguinte no mesmo repositório seleciona esses registros por nó e contrato. Cada worker recebe só os registros do próprio nó e com a mesma identidade de contrato pré-trabalho, num bloco `<memoryContext>` com o aviso de que o conteúdo são dados não confiáveis. Os registros vêm como JSON, com `<` escapado, então um resumo não consegue fechar a tag nem virar instrução. O evento `memory.selected` aparece no journal antes do agente.

Na retomada, a seleção fixada da run é reaproveitada só depois de conferida. O evento `memory.selected` sai de novo com `reused: true`, e o painel mostra essa marca. Se a conferência falhar, a run registra um diagnóstico `selection_reuse_rejected` e faz uma nova seleção.

Limitações desta versão (v2.0):

- **O planner não recebe seleção de memória.** Ele não tem nó nem caminho definidos no início da run, e a seleção exige um escopo que case com algum registro.
- **O critic não recebe seleção de memória.** O ramo que selecionava por caminho não tinha produtor de registro com caminhos; foi retirado e não é relaxado. Registros de memória não entram na revisão crítica.
- **Evidência da fase final fica fora.** Receipts de checks finais (depois do polish) não têm escopo por nó e não alimentam a memória. Só os receipts da fase de nó entram, com escopo `nodeId + contractIdentity`, e só o worker do mesmo nó e contrato os recebe.
- **Contract, failure e version ficam fora da v2.0.** Esses tipos existem no modelo de registro, mas nenhum produtor os grava e nenhum papel os seleciona. Nada é alimentado sem consumidor.

## Estado final no painel

O evento `run.finished` é o último do journal e carrega o status terminal. Ele sai depois do REPORT e antes da liberação do lease. Uma run planOnly bem-sucedida grava `plan_only` (plano concluído), não `blocked`.

Divergência conhecida: se a liberação do lease ou do workspace falha depois do `run.finished`, o journal continua com o status do resultado (por exemplo `done`), enquanto o retorno do CLI sai `blocked` com `lease_release_failed` ou `workspace_release_failed`. O painel só mostra o status do journal quando o lease já foi solto; com o lease preso, o status fica desconhecido.

## Desenvolvimento

O pacote não precisa de instalação global. Com Node.js e dependências de desenvolvimento já instaladas, execute os testes do driver e dos manifests:

```sh
node --test --test-concurrency=2 test/grapheng.test.mjs test/packaging.test.mjs
```

O projeto usa `node --test`; alterações de UI podem exigir `npm run css:build`. A justificativa histórica do desenho está em [DESIGN.md](skills/grapheng/DESIGN.md).
