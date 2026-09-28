# Ações e organização no painel web (plugin 0.5.0)

**Objetivo.** Hoje o painel (`bin/ui-server.mjs` + `bin/ui/`) só lê arquivos. A exceção é o `PUT /api/config`.
Esta spec faz o painel agir sobre as runs: retomar, parar, refazer um nó, copiar o comando pronto e ver os
artefatos. Também organiza a lista lateral como no Claude Code, com fixadas, grupos, arquivadas, apagar,
seções em accordion e Finalizadas recolhida. Tudo isso roda sobre três peças novas:

- **uma fila de pedidos em arquivo**, que a sessão do Claude atende pelo `graph-watch events` que já roda
  no Monitor;
- **uma detecção de parada confiável**, com o motivo;
- **um motor que retoma pelos args**, sem refazer os nós prontos.

A spec consolida os designs D1 a D4 da run `20260928-1146-acoes-no-painel` (`.graph-runs/<run>/D1.md` a
`D4.md`). Onde esta spec e um design divergem, vale a spec. O que ela mudou em relação a eles está no
`DS.md` do mesmo run dir.

## Por que o desenho é este

- **O workflow roda dentro da sessão do Claude Code.** O script não tem disco nem API do Node, e o
  `resumeFromRunId` só vale na mesma sessão (doc da tool Workflow). O painel é outro processo e não controla
  o workflow. Por isso o painel **pede**, e a sessão **executa**.
- **O único canal de entrada na sessão é o stdout do Monitor**: cada linha vira um evento para o Claude, o
  timeout máximo é de 30 min, e depois disso é preciso rearmar (doc da tool Monitor). O `graph-watch events`
  já roda ali (`skills/graph-eng/SKILL.md:219-226`).
- **A retomada de hoje é por prefixo de chamadas.** Na run real `wf_ccaa155a-747`, a 1ª chamada divergente
  foi o `repair:R3` (linha 47 do journal), e dali em diante 10 agentes rodaram ao vivo sobre nós que já
  estavam prontos (R1 §6).
- **O "parada?" dá falso positivo.** Ele mede o mtime do journal, que só muda quando um agente começa ou
  termina (`bin/graph-watch.mjs:584`). Em 364 históricos reais, houve pausa saudável de até 736 s entre duas
  linhas (D1 §3.1). A linha "agora" ignora critic e synth (`buildNowBlock`, `graph-watch.mjs:1013-1031`).

## Decisões já tomadas com o usuário

- **Quem atende.** Resume e rerun-node vão para a 1ª sessão ouvindo **no mesmo projeto** que aceitar o
  pedido. Stop vai só para a **sessão dona** da run. A spec abre uma exceção, só por segurança (P1): numa run
  `parada` cuja dona ainda pode ter o Workflow vivo, resume e rerun-node vão só para a dona, que para a
  execução antiga antes de disparar a nova.
- **Depois do TERMINADO**, a sessão segue ouvindo o painel por **2 h**, com o Monitor rearmado até 4 vezes.
  Passado isso, o painel mostra "nenhuma sessão ouvindo", e sobra o copiar comando.
- **Na lista, uma run fica num lugar só.** Fixada vence grupo, e grupo vence as seções de estado (Em andamento,
  Paradas e Finalizadas). Apagar um grupo devolve as runs dele para a seção do estado delas. As paradas têm
  seção própria, e toda seção é um accordion.
- **O teto desta run é de 50 agentes.** O esforço é auto.

## Os cinco pontos de decisão

| # | Pergunta | Decisão | Por quê |
|---|---|---|---|
| P1 | Quem atende cada pedido | `resume` e `rerun-node`: qualquer watcher vivo cujo `project` (slug do caminho do wf) é igual ao da run (`route: 'project'`). O `claim` O_EXCL escolhe um só. **Exceção**: se a run está `parada`, o motivo não é `interrompida` e a dona está `ouvindo` (C3, `ownerPresence`), o pedido sai com `route: 'owner'` e só a sessão dona o atende. Ela faz `TaskStop` da task do wf antigo antes de disparar o novo. Se a dona está `rearmando`, a ação fica desabilitada por instantes (C12). `stop`: sempre `route: 'owner'`, ou seja, só o watcher cuja `session` é a `ownerSession` da execução atual | O motor novo retoma pelos args (P4 e P5) e dispensa o `resumeFromRunId`, que só vale na mesma sessão. Assim, qualquer sessão do projeto serve. O `TaskStop(task_id)` só alcança task da própria sessão (doc da tool). A sessão que retoma vira a dona do wf novo. **A exceção existe porque `parada` não prova que o Workflow morreu.** Com a dona ouvindo, a run fica parada depois de 3·N sem escrita (C6), por exemplo com um agente esperando permissão ou numa chamada longa. Uma retomada por outra sessão dispararia um 2º Workflow no mesmo run dir com o 1º vivo. Só a dona consegue parar o 1º. `interrompida` fica fora porque o marcador de Esc ou de Parar mostra que o turno, e com ele o Workflow, já caiu (memória "Esc derruba o Workflow") |
| P2 | A sessão ouve depois do TERMINADO? | Sim. O `events` imprime `TERMINADO` uma vez e entra em `listen` até `terminadoEm + 120 min` (`--listen-min`, padrão 120, e `0` volta ao comportamento de hoje). A skill rearma o Monitor até 4 vezes sem avisar o usuário e para quando lê `escuta do painel encerrada` | Decisão do usuário. Ouvir para sempre prenderia uma sessão abandonada, que aceitaria pedidos que ninguém vê acontecer, e cada rearme custa uma notificação (R2 §5). O copiar comando cobre o depois |
| P3 | Como a run retomada aparece no painel | A chave da run é o **`runId`** (quando casa com `RUN_ID_RE`), e a lista mostra **uma linha por chave**. O representante (a "execução atual") é o wf rodando mais novo; sem nenhum rodando, o mais novo que não é planOnly; e, se só houver planOnly, a planOnly mais nova. O wf retomado leva `Resume: <rs>` no prefixo dos prompts, e o `buildModel` abre `<runDir>/resume/<rs>.json` para desenhar o plano e os nós prontos (cheios no grafo; a gaveta do nó mostra o selo "retomado", C14). Um wf superado continua abrível por URL, com toda ação desabilitada e o botão "Abrir a execução mais nova" | O slug é o cwd da **sessão**, e a retomada pode nascer em outra sessão ou noutra pasta (itens 4 e 7-9). O `runId` é o que os args e o texto copiado carregam, então a organização (fixada, grupo, arquivada) passa para o wf novo. Amarrar toda ação à execução atual impede disparar dois workflows no mesmo run dir (D3 §3.6.0) |
| P4 | De onde saem os resultados prontos | **Híbrido, amarrado ao último wf da run (W).** O run dir guarda os args (`args.json`, gravado pela skill antes de cada disparo, e `resume/<rs>.json`) e os artefatos (`<nó>.md`). O `journal.jsonl` de W diz se cada nó passou (veredito, summary e revisão do design). O CLI `bin/graph-resume.mjs` cruza os dois | O `<nó>.md` sozinho não prova que o nó passou: o `I1.md` da run 0213 é um REPAIR (R1 §8). Veredito, summary e status só existem no journal. O journal não guarda os args, e o `<wf>.json` do host só existe depois que o wf termina (D2 §1). Amarrar args e estado ao mesmo W impede misturar o plano de uma execução com o estado de outra (D2 §5.3) |
| P5 | Como o motor sabe que a revisão do design passou | Por um campo explícito: `args.resume.designReview = { pass, attempts }`, que o CLI tira do último `design-review:r<n>` com resultado no journal de W, ou herda do `resume/<rs>.json` de W. O motor só pula a revisão se `pass === true` **e** nenhum nó de pesquisa ou design roda nesta execução | Inferir pela marca `verified` confunde "verificado pelo verify" com "aprovado pela revisão", e a marca da revisão só existe em memória no motor (`workflows/graph-eng.js:1177-1181`). Se um design roda de novo, a revisão precisa ver o design novo |

## Critérios de aceite

Os itens 1 a 12 seguem o PEDIDO.md. O item 13 é o 4º pedido novo (fileira de bolinhas), e o item 14 é o 5º (README).
Os contratos citados (C1 a C14) estão na seção seguinte.

### Item 1. Canal painel → sessão

Contratos: C1 a C5, C10 e C12.

- A fila fica em arquivo: um arquivo por pedido, gravado de forma atômica (tmp `wx` 0600 + rename).
  Existem só três tipos: `resume`, `stop` e `rerun-node`. O wf passa pela `WF_RE`, e o nó pela `NODE_RE`,
  as mesmas de hoje (`ui-server.mjs:101-102`), agora exportadas de `bin/requests.mjs`.
- Cada pedido tem um `id` próprio e passa por `pendente → aceito → feito | falhou`, com o motivo. A sessão
  grava o estado de volta pelo CLI `bin/requests.mjs`, e o painel mostra esse estado.
- O watcher grava um sinal de vida. O painel mostra `sessão ouvindo` ou `nenhuma sessão ouvindo`. Sem
  sessão, os botões de ação ficam desabilitados com o motivo à vista, e sobra o copiar.
- As rotas de escrita têm as travas do `PUT /api/config`, na mesma ordem: Host 403, método 405, Origin
  diferente de `http://<Host>` 403, Content-Type 415, 413 acima de 4096 bytes e 400 com o campo.
- A SKILL.md diz o que o Claude faz com cada tipo de pedido.
- **Aceite:** com uma sessão ouvindo, o POST vira arquivo `pendente`, a linha `graph-eng pedido …` sai no
  stdout do watcher, o `accept` e o `done` do CLI gravam os estados, e o `GET /api/requests/:id` mostra
  `feito`. Sem ouvinte, o POST dá 409, e o Modelo traz o botão desabilitado com o `why`. Os testes
  automáticos são do I5 e do I8, e o Playwright é do I7.

### Item 2. Detecção de parada confiável

Contratos: C6.

- Um agente aberto conta como parado se a última linha do histórico dele for **marcador** (erro de cota
  ou `[Request interrupted by user…]`) ou se o histórico estiver sem escrita há mais de **L**. L = N
  (`stallMinutes`, padrão 5, na config) quando a sessão dona não está ouvindo, e 3·N quando está. A run
  conta como parada quando todos os agentes abertos estão parados.
- O painel mostra o motivo: `sem atividade há X min`, `sessão encerrada`, `orçamento esgotado` ou
  `interrompida` (este é um extra).
- A lista do servidor e o `buildModel` usam a mesma função, `computeStop`. A janela fixa
  `ACTIVE_WINDOW_MS` sai.
- A linha "agora" conta os pseudo-agentes abertos: plan, critic, synth, design-review e polish.
- Uma run planOnly nunca fica parada: ela sai `terminado` com `planOnly: true`, e a lista a junta à run
  real do mesmo runId.
- **Aceite:** há fixture de run longa e saudável que não aparece parada, e de run morta que aparece com o
  motivo certo, além de cota, interrupção, fase paralela com um agente vivo, planOnly e a linha "agora"
  com critic e com synth.

### Item 3. Motor retomável

Contratos: C7.

- Com `args.plan`, o motor aceita `args.resume`. Nó pronto fora do fecho de `rerun` vai direto para
  `RESULTS` e não gera agente. Os trilhos, o esforço e o teto continuam valendo, e o `spent` começa em 0,
  então o orçamento conta só os agentes novos.
- A skill monta os args pelo CLI `bin/graph-resume.mjs`, a partir do run dir, com o journal de W como
  prova (P4).
- **Aceite:** no harness `test/helpers/run-workflow.mjs`, com 5 prontos e 1 para refazer (`I2`), rodam
  exatamente `work:I2, verify:I2, critic:r1, polish:1, synth`, ou seja, 5 agentes. Os casos com
  dependentes, com design refeito, sem nada para refazer, sem a marca da revisão e de erro estão no C7.

### Item 4. Copiar comando pronto

Contratos: C9.

- "Copiar para retomar", "Copiar para refazer `<nó>`" (com ou sem dependentes) e "Copiar para parar"
  põem no clipboard o texto literal do C9.
- Funcionam sem sessão ouvindo.
- **Aceite:** um teste compara o `commandText` com os literais. A SKILL.md trata o texto colado sem
  triagem, sem scout, sem plan gate e sem pergunta. O e2e do I8 prova que os args montados pelo CLI a
  partir do run dir fazem o motor gerar só os agentes esperados.

### Item 5. Artefatos da run na gaveta

Contratos: C10 A5/A6 e C14.

- A gaveta mostra o `REPORT.md`, o `plan.md`, o `PEDIDO.md` e a saída de cada nó (`<id>.md` e os rascunhos
  `<id>.a.md`/`<id>.b.md`), lidos de `.graph-runs/<run>/`, só em leitura, como texto puro.
- A lista de nomes é fechada, e a pasta passa pela contenção `resolveRunDir`.
- **Aceite:** os testes cobrem `../`, `%2e%2e`, caminho absoluto, symlink de arquivo e de pasta, subpasta,
  arquivo oculto, extensão errada e o `Run dir` da transcrição apontando para fora. Nada sai do run dir.

### Item 6. Arquivar e apagar

Contratos: C1 `organize.json`, C10 O7 a O9 e C13.

- Arquivar esconde a run. O filtro "Mostrar arquivadas", no ícone de filtro do cabeçalho, mostra a seção
  Arquivadas. Fica gravado no `organize.json`, ao lado da config.
- Apagar remove só `.graph-runs/<run>/`, depois da contenção. Nunca toca `~/.claude/projects` nem o
  `INDEX.md`. Exige o nome da run digitado, conferido de novo no servidor. Com a run rodando ou com pedido
  aberto, a resposta é 409.
- **Aceite:** num dir temporário, a pasta some, a listagem recursiva do `projectsDir` fica idêntica antes e
  depois, um nome errado é recusado e uma contenção ruim dá 409, sem remover nada.

### Itens 7, 8 e 9. Botões Retomar, Parar e Refazer nó

Contratos: C12 e C14.

- Usam o canal (item 1) e o motor (item 3).
- "Refazer nó…" abre um dialog com o checkbox "Refazer também os dependentes". "Parar…" também abre um
  dialog. Retomar não tem dialog, porque não perde nada e dá para cancelar enquanto está pendente.
- Depois do dialog, a sessão executa sem perguntar de novo no chat.
- **Nunca há dois Workflows vivos no mesmo run dir.** Numa run `parada` com a dona ainda ouvindo (e motivo
  diferente de `interrompida`), Retomar e Refazer vão só para a dona, que para a execução antiga antes (P1 e
  C12). O comando colado passa pela mesma trava, no `graph-resume.mjs` (C8).
- **Aceite:** o fluxo inteiro passa de ponta a ponta com fixture (`test/e2e-actions.test.mjs`, os três
  tipos, mais o resume com `route: 'owner'`) e no Playwright (claro e escuro, com sessão ouvindo e sem sessão).

### Item 10. Finalizadas recolhidas e apagar finalizadas

Contratos: C13.

- Finalizadas começa fechada, com a contagem ao lado do nome.
- A lixeira do cabeçalho abre "Apagar finalizadas", um dialog que lista cada run e exige `apagar N`
  digitado.
- O visual segue o print de referência: cabeçalho discreto de 12 px em cinza, com os ícones de busca e de
  filtro à direita; linha de 28 px com a bolinha à esquerda e o título truncado; selecionada com fundo
  leve e raio de 6 px; e "Mostrar mais N" no fim da seção longa.

### Item 11. Organização como no Claude Code

Contratos: C1, C10 O1 a O6 e C13.

- Dá para fixar e desafixar. Dá para criar, renomear, apagar e reordenar grupos. Uma run muda de grupo
  pelo menu ⋯, pelo clique direito ou arrastando.
- A precedência é arquivada > fixada > grupo > estado. A organização fica gravada no `organize.json`,
  pela chave `runId`, que sobrevive à retomada (P3).

### Item 12. Paradas e accordion

Contratos: C13.

- As runs paradas saem de Em andamento e vão para a seção **Paradas**, entre Em andamento e
  Finalizadas. "Pendentes" foi descartado: "pendente" já é o 1º estado de um pedido, e uma run parada não
  anda sozinha (D4 §4.1).
- Toda seção é um accordion, com um `<button aria-expanded>` no cabeçalho e a seta › fechada ou ⌄
  aberta ao lado do nome. O estado fica lembrado no `localStorage`.
- A planOnly fica fora das Paradas. A linha mostra um título legível (o runId sem o prefixo de data, ou o
  goal).

### Item 13. Fileira de bolinhas que não quebra

Contratos: C13 (`stripOf`).

- A fileira nunca quebra linha. Com até `STRIP_MAX = 10` nós, aparecem as bolinhas. Acima disso, entra um
  resumo com até 3 estados não zerados, na ordem com erro, rodando, concluídos, na fila e pulados.
- O texto por extenso vai no `title` e no `aria-label`. A regra vale em todas as seções.

### Item 14. README no estilo open source

Nó: I9.

Vale o 5º pedido do PEDIDO.md com o refinamento dele ("Refinamento do quinto pedido"), que manda sobre o
texto original onde os dois divergem.

- **Logo: é o da interface, não um novo.** O I9 não desenha logo. Ele exporta o SVG do cabeçalho do painel,
  `bin/ui/index.html:15` (`viewBox="0 0 64 64"`: quadrado arredondado, quatro bolinhas em losango ligadas por
  linhas retas, a de baixo é um anel e a da direita é azul), trocando as classes `.logo-*` de
  `bin/ui/src/style.css:367-389` pelas cores resolvidas de cada tema:
  - claro (`--fg #1d1d1f`, `--bg #ffffff`, `:root` em `style.css:89-92`): `.logo-bg` e `.logo-ring` (fill)
    `#1d1d1f`; `.logo-fg` e o stroke do anel `#ffffff`; `.logo-line` stroke `#ffffff` com opacidade 0.5;
    `.logo-accent` `#0a84ff`;
  - escuro (`--fg #f5f5f7`, `--bg #0a0a0b`, `style.css:150-155`): as mesmas trocas com essas duas cores, e a
    `.logo-line` com opacidade 0.45 (`style.css:378`); o azul fica `#0a84ff`.
  - Arquivos: `docs/assets/logo-light.svg` e `docs/assets/logo-dark.svg`, SVG puro, sem CSS externo nem
    `class`. Entram no topo do README por `<picture>` com `<source media="(prefers-color-scheme: dark)">`,
    como nos repositórios de referência. Nenhuma imagem hospedada fora. O `bin/ui/favicon.svg` não serve: é a
    versão simplificada, sem as linhas.
- **Topo centralizado**: logo, nome, frase curta e badges do shields.io só do que é verdade: versão 0.5.0,
  MIT, plugin do Claude Code, Node 22 e zero dependência em runtime. Uma linha em negrito com números
  verificáveis e uma fileira de links para as seções.
- **Instalação só do Claude Code.** Sem seção para Codex, Gemini ou outros agentes (o ponytail tem; aqui não).
- **Referências**: o I9 lê `<runDir>/ref-readmes.md`, que o orquestrador grava antes de o I9 rodar, com a
  pesquisa de como o ponytail, o rtk, o graphify e outros plugins e skills parecidos do Claude Code
  apresentam o README e a instalação. Se o arquivo não existir quando o I9 rodar, ele usa as duas referências
  locais do PEDIDO.md (ponytail e rtk) e registra a falta no retorno.
- Números só medidos, com a fonte. Seções: o que faz, como funciona, instalação, uso, painel (com prints
  claro e escuro de fixture), esforço e teto, config, comandos, FAQ, desenvolvimento e licença.
- Nada do conteúdo de hoje se perde. Os arquivos vão em `docs/assets/`, e os prints nunca mostram nome de
  projeto real (painel do repo com `GRAPH_ENG_PORT` ≥ 4490 e dirs temporários).
- Aceite: `docs/assets/logo-light.svg` e `logo-dark.svg` têm a mesma geometria de `bin/ui/index.html:15`
  (mesmo `viewBox`, `rect rx="15"`, o `path` `M17 32 32 19 47 32 32 45Z` e os quatro `circle`) e nenhum
  `class=`; o README usa `<picture>` com os dois; `grep -i 'codex\|gemini' README.md` não acha seção de
  instalação para eles.

### Regras gerais

- Sem dependência nova em runtime. O CSS sai de `npm run css:build`, e o `bin/ui/style.css` gerado é
  versionado.
- Todo texto de interface em pt-BR, com o visual atual: bolinhas e linhas retas, sem metáfora, e os
  tokens que já existem (nenhuma cor nova).
- `node --test` verde e a checagem de sintaxe do workflow (o arquivo sem `export const meta`, compilado
  como `AsyncFunction`, como no harness) passando depois de **cada** nó implement.
- O `plugin.json` vai para 0.5.0, e o README, a SKILL.md e o DESIGN.md explicam o porquê de cada decisão.

## Contratos

### C1. Estado em disco (`stateDir`)

```
<stateDir>/                        padrão ~/.claude/graph-eng (pasta 0700; arquivos 0600)
  config.json                      já existe; ganha stallMinutes (C6)
  organize.json                    organização da lista (C13, D4 §3.3)
  requests/<id>.json               o pedido; o estado vive dentro dele
  requests/<id>.claim              O_EXCL: existe ⇔ o pedido saiu de pendente; {"by","pid","at"}
  requests/<id>.final              O_EXCL: existe ⇔ alguém ganhou o direito de gravar feito/falhou
  requests/<id>.seen-<sessão>      O_EXCL: esta sessão já imprimiu a linha do pedido
  listeners/<sessão>.<pid>.json    sinal de vida de um watcher (C3)
```

- **Resolução do `stateDir`**: `defaultStateDir(env, home)` = `env.GRAPH_ENG_STATE_DIR` ou
  `path.dirname(defaultConfigPath(env, home))`, que já respeita o `GRAPH_ENG_CONFIG`. Ela fica em
  **`bin/config.mjs`**, ao lado do `defaultConfigPath` (`config.mjs:24-26`), e entra no **I2**, que já edita esse
  arquivo e vem antes do I3 e do I4. O `bin/requests.mjs` (I3) a importa e a reexporta; o servidor (I4) a
  importa de `config.mjs`. Assim o I4 não depende do I3, que roda em paralelo com ele.
  - O servidor: `createPanelServer({ …, configPath, stateDir, organizePath = path.join(stateDir, 'organize.json'), graphRunsHome = ~/.claude/graph-runs, now = () => Date.now() })`,
    com `stateDir = opts.stateDir ?? (opts.configPath ? path.dirname(opts.configPath) : defaultStateDir())`.
    O `ensurePanel` (`bin/ui-server.mjs:599-608`) repassa `stateDir`, `organizePath`, `graphRunsHome` e `now`,
    além do `configPath` que já repassa hoje.
  - O `graph-watch` e os CLIs aceitam `--state-dir <dir>`.
  - **Nenhum teste escreve em `~/.claude`.**
- **Isolamento dos testes que já existem (saída (a), feita no I4).** Hoje, 4 servidores de teste sobem sem
  `configPath`: `ensurePanel` em `test/ui-server.test.mjs:94`, `:481` e `:580` e em
  `test/ui-server-phases.test.mjs:52`. Além deles, o `spawnUi` (`test/ui-server.test.mjs:64`, que herda
  `process.env`, usado em `:535` e `:559`) sobe o CLI `ui` com o padrão. Com o `stateDir` novo, esses servidores
  passariam a ler e, a partir do I5, a gravar em `~/.claude/graph-eng` (pedido vencido vira `falhou` na leitura,
  e a limpeza apaga). Por isso o **I4**, que é o nó que cria o `stateDir` no servidor, edita esses dois arquivos
  **só para isolar**:
  - cada um desses `ensurePanel` ganha `configPath` num dir temporário (e, com ele, o `stateDir`);
  - o `spawnUi` e o `live --svg` da linha `:583` ganham `env: { ...process.env, GRAPH_ENG_CONFIG: <tmp>/config.json, GRAPH_ENG_STATE_DIR: <tmp> }`;
  - nenhum assert muda.

  A saída (b), o servidor só gravar quando o `stateDir` é explícito ou no CLI `ui`, foi descartada: o `spawnUi`
  sobe justamente o CLI `ui` e continuaria gravando no dir real.
- **Guarda contra regressão** (I4, em `test/ui-server-organize.test.mjs`): um teste lê o fonte de todo
  `test/**/*.mjs`, menos o próprio arquivo, e falha se achar uma chamada `ensurePanel({…})` ou
  `createPanelServer({…})` sem `configPath` nem `stateDir`, ou um `spawn` do `BIN` com `'ui'` ou `'live'` sem
  `GRAPH_ENG_STATE_DIR` no `env`. Um teste de unidade confere também a resolução: com `configPath` em tmp,
  `server.stateDir === path.dirname(configPath)`. Conferir o `~/.claude/graph-eng` real antes e depois não
  serve: um painel ou um watcher 0.5.0 instalado grava ali a cada 10 s, e o teste ficaria instável.
- **Escrita atômica**: sempre tmp `<arquivo>.tmp-<pid>-<seq>` com `{ flag: 'wx', mode: 0o600 }` + `renameSync`,
  com `unlink` do tmp no erro, como `bin/config.mjs:94-111`. A pasta é criada com 0700.
- **Leitura tolerante**, como `readConfig` (`config.mjs:71-88`): um arquivo ilegível ou fora das regexes é
  ignorado com aviso e nunca derruba o painel nem o watcher.

### C2. Pedido (`requests/<id>.json`) e máquina de estados

```json
{
  "v": 1, "id": "req-20260928T151203-3fa9c1", "type": "rerun-node",
  "wf": "wf_ccaa155a-747", "runKey": "20260928-1146-acoes-no-painel", "runId": "20260928-1146-acoes-no-painel",
  "project": "-Volumes-DouglasNvme-Documents-GitHub-postify-app-postify-backend",
  "ownerSession": "4a36e590-20bd-40d8-9ee9-df376cfffd16",
  "runDir": "/Volumes/DouglasNvme/Documents/GitHub/graph-eng/.graph-runs/20260928-1146-acoes-no-painel",
  "node": "D1", "dependents": true, "dependentsList": ["DS", "I1"], "route": "project",
  "state": "aceito", "reason": null,
  "createdAt": "2026-09-28T15:12:03.412Z", "updatedAt": "2026-09-28T15:12:05.020Z",
  "acceptedAt": "2026-09-28T15:12:05.020Z", "acceptedBy": "4a36e590-20bd-40d8-9ee9-df376cfffd16",
  "finishedAt": null, "newWf": null,
  "history": [ { "state": "pendente", "at": "…", "by": "painel" }, { "state": "aceito", "at": "…", "by": "4a36e590-…" } ]
}
```

- **Regexes** (exportadas de `bin/requests.mjs`): `REQ_RE = /^req-\d{8}T\d{6}-[0-9a-f]{6}$/`,
  `SESSION_RE` (uuid minúsculo), `WF_RE = /^wf_[A-Za-z0-9_-]+$/` e `NODE_RE = /^[A-Za-z0-9_-]{1,64}$/`
  (os literais de hoje), mais `REQUEST_TYPES = ['resume', 'stop', 'rerun-node']`.
- **O cliente manda só `{ type, wf, node?, dependents? }`.** `runKey`, `runId`, `project`, `ownerSession`,
  `runDir` (absoluto e já contido) e `dependentsList` (o fecho transitivo pelos `deps`) saem do índice e do
  Modelo **da execução atual**. O `wf` gravado é sempre o da execução atual (C12).
- **`route`** (`'project' | 'owner'`) também sai do servidor, copiado do `Pode.route` da ação na C12 no
  momento do POST, e não muda mais. `stop` sempre grava `owner`. Um pedido sem `route` (arquivo antigo ou
  corrompido) é lido como `owner`, o lado seguro.
- **Estados:**

```
pendente ──accept (.claim)──► aceito ──done (.final)──► feito
   │                            ├──fail (.final)──► falhou (reason)
   │                            └──expira 30 min / descartar ≥ 2 min no painel (.final)──► falhou (reason)
   └──expira 10 min / cancelar no painel (.claim "painel" + .final)──► falhou (reason)
```

- **Regra única de escrita.** Sair de `pendente` exige criar o `.claim` com `wx`. Gravar `feito` ou `falhou`
  exige criar o `.final` com `wx`. Quem recebe `EEXIST` perdeu a corrida e não grava nada. `feito` e
  `falhou` são finais.
- **Prazos** (todos com relógio injetável):
  - `PENDING_TTL_MS = 600000` (10 min), pela regra única `isPendingExpired(req, now)`. Um `createdAt`
    ilegível conta como vencido. Quem aplica a regra:
    - o servidor, na leitura: grava `falhou` com "nenhuma sessão aceitou em 10 min";
    - o watcher: não emite o pedido vencido, nem ao subir;
    - o `accept`: depois de ganhar o claim, grava `falhou` e sai com 3.

    Nada vencido chega a disparar um Workflow.
  - `ACCEPTED_TTL_MS = 1800000` (30 min): o servidor, na leitura, grava `falhou` com "a sessão aceitou e não
    confirmou em 30 min".
  - `ACCEPTED_GRACE_MS = 120000` (2 min): a partir daí, o painel pode **descartar** um `aceito` (A3). É isso
    que fecha o caso de Esc, de prompt de permissão negado ou de sessão que caiu entre o `accept` e o `done`.
- **Um pedido aberto por `runKey`.** Conta como aberto:
  - um `pendente` ou `aceito` não vencido;
  - um `resume` ou `rerun-node` `feito` há menos de 10 min cujo `wf` ainda é a execução atual (a janela
    até o wf novo aparecer, D3 §3.6.0).

  Um POST a mais dá 409.
- **Limpeza**, feita pelo servidor no máximo 1 vez por minuto: somem os pedidos finais com mais de 7 dias ou
  além dos 200 mais novos (com os arquivos `.json`, `.claim`, `.final` e `.seen-*`), e os `listeners/*.json`
  com `beatAt` de mais de 24 h.

### C3. Sinal de vida (`listeners/<sessão>.<pid>.json`)

```json
{ "v": 1, "session": "4a36e590-…", "project": "-Volumes-…-postify-backend", "cwd": "~/…", "pid": 48213,
  "wf": "wf_ccaa155a-747", "runId": "20260928-1146-acoes-no-painel", "mode": "run",
  "startedAt": "…", "beatAt": "…", "listenUntil": null, "exitedAt": null, "plugin": "0.5.0" }
```

- **Quem grava**: só o `graph-watch events`, e só quando o caminho do wf tem a forma
  `<projectsDir>/<slug>/<sessão>/subagents/workflows/<wf>`, com `<sessão>` casando com `SESSION_RE`. `session` e
  `project` saem desse caminho. Um watcher sobre um `--run-dir` solto (como nos testes de hoje) não grava sinal
  de vida **e não entra em `listen`**: ele sai depois do `TERMINADO` como hoje, e por isso os testes antigos
  seguem verdes.
- **Quando grava**: ao subir, a cada `HEARTBEAT_MS = 10000` (injetável) e ao sair por fim da escuta, SIGINT ou
  SIGTERM. Na saída, grava `exitedAt` e **não apaga** o arquivo: é essa marca que dá `sessão encerrada`.
- **Quando conta como vivo**: `live = !exitedAt && now − beatAt ≤ LISTEN_FRESH_MS (30000) && pidAlive(pid)`, com
  `process.kill(pid, 0)`: ESRCH conta como morto e EPERM como vivo.
- **Funções** (em `bin/requests.mjs`, I3; o servidor e o `graph-resume.mjs` as importam de lá):
  - `readListeners(stateDir, now)` → `[{ …hb, live }]`;
  - `projectListening(listeners, project)`;
  - `ownerPresence(listeners, session, now)` → `'ouvindo' | 'rearmando' | 'encerrada' | 'nunca'`:
    - `ouvindo`: há um sinal `live` da sessão;
    - `rearmando`: nenhum `live`, mas o marco mais novo da sessão (`exitedAt` ou, sem ele, `beatAt`) tem no
      máximo `REARM_GRACE_MS = 120000` (2 min, injetável);
    - `encerrada`: há arquivo da sessão, e o marco mais novo passou de 2 min;
    - `nunca`: nenhum arquivo da sessão (sessão de plugin antigo, ou watcher sobre `--run-dir` solto).
  - `ownerListening = presence === 'ouvindo'` e `ownerGone = presence === 'encerrada'`, os dois booleanos que o
    `computeStop` recebe (C6).
- **Por que o `rearmando` existe.** O `exitedAt` sai em toda saída por SIGTERM, e é assim que o Monitor encerra
  o watcher no timeout de 30 min, antes do rearme. Então o `exitedAt` sozinho não prova que a sessão acabou.
  Os 2 min cobrem o buraco do rearme, que é de segundos.
- **Buraco no rearme**: por alguns segundos, o painel mostra "nenhuma sessão ouvindo". Ao subir, o watcher
  novo emite os `pendente` ainda no prazo que essa sessão não viu.

### C4. Linha de evento (o que o Claude lê)

```
graph-eng pedido <id> · <type> · run <runId ou wf> (<wf>)[ · nó <node>[ + dependentes]] · confirmado no painel · aceite: node "<ROOT>/bin/requests.mjs" accept <id> --session <sessão>
```

- `<ROOT>` é a raiz real do plugin, por `import.meta.url`, e `<sessão>` é a do watcher.
- **Quando o watcher emite**: a cada 1 s no loop, emite cada pedido `pendente` **elegível** (P1), **no prazo**,
  e cujo `.seen-<sessão>` ele consiga criar. Elegível significa: com `route: 'project'`, a sessão do watcher
  tem o mesmo `project` do pedido; com `route: 'owner'` (e todo `stop`), a sessão do watcher é a
  `ownerSession`. A conferência do prazo vem antes de criar o `.seen`. Vale nos
  modos `run` e `listen` e ao subir. O watcher nunca grava no pedido.
- **Linhas novas de ciclo de vida**: `graph-eng <wf> · ouvindo o painel até HH:MM`,
  `graph-eng <wf> · escuta do painel encerrada`, `graph-eng <wf> · parada: <text> · k/N prontos · agentes X` (uma
  vez por episódio) e `graph-eng <wf> · voltou a rodar`. Num rearme com a run já terminada e dentro da janela,
  o watcher imprime `ouvindo…` e não repete o `TERMINADO`.
- **Flags novas** (em `FLAGS_WITH_VALUE`, `graph-watch.mjs:1405`): `--state-dir` e `--listen-min`.

### C5. CLI da sessão: `bin/requests.mjs`

| Comando | Efeito | Saída |
|---|---|---|
| `accept <id> --session <s>` | Ordem: (1) valida e lê; se não está `pendente`, sai com 3. (2) Com `route: 'owner'` (todo `stop` e o resume ou rerun da exceção do P1), confere `s === ownerSession` **sem** tomar o claim; se não bate, sai com 4, e o pedido segue `pendente` para a dona. (3) Cria o `.claim`; `EEXIST` sai com 3. (4) Relê; se não está `pendente`, sai com 3. (5) Se venceu, cria o `.final`, grava `falhou` e sai com 3. (6) Grava `aceito` | 0 ok · 1 E/S · 2 id inválido ou inexistente · 3 já aceito, encerrado ou vencido (ignore em silêncio) · 4 esta sessão não pode |
| `done <id> --session <s> [--wf <novo>] [--note <txt>]` | Confere `claim.by === s` (senão 4). Cria o `.final` (`EEXIST` → 5). Relê: tem de estar `aceito` (senão 5). Grava `feito` e `newWf` | 0 · 1 · 2 · 4 · 5 já encerrado ou transição inválida |
| `fail <id> --session <s> --reason <txt>` | Como o `done`, mas grava `falhou` | idem |
| `list [--json]` | Lista para diagnóstico | 0 |

- A saída é o pedido em JSON numa linha, no stdout. Os erros vão para o stderr como `requests: <motivo>`, em
  pt-BR.
- `--state-dir` vale em todo subcomando.
- `reason` tem até 300 caracteres, sem caractere de controle.

### C6. Parada: `computeStop`, motivos e status

- **Função exportada** de `bin/graph-watch.mjs`, usada pelo `buildModel` e pela lista do servidor:
  `computeStop({ runDir, openAgentIds, terminated, planOnly, now, stallMinutes = 5, ownerListening = false, ownerGone = false })`
  → `null | { reason, text, idleSec }`. O algoritmo está no D1 §3.3:
  1. terminada ou planOnly: não há parada;
  2. `L = N·60·(ownerListening ? 3 : 1)`;
  3. cada agente aberto é classificado por `classifyTail`, sobre a última linha JSON dos últimos 64 KB, e pelo
     mtime;
  4. a run fica parada quando todos os agentes abertos estão parados. Sem agente aberto, ela fica parada com
     o tail marcador e `idleSec > 60`, ou com `idleSec > L`.
- **Motivos**, em ordem de prioridade:

  | `reason` | `text` |
  |---|---|
  | `orcamento` | `orçamento esgotado` |
  | `interrompida` | `interrompida` |
  | `sessao-encerrada` | `sessão encerrada` (vale quando `!ownerListening && ownerGone`, isto é, `ownerPresence === 'encerrada'`: um watcher que só está rearmando não dá sessão encerrada, C3) |
  | `sem-atividade` | `sem atividade há X min` (`X = max(1, floor(idleSec/60))`) |

- **Status** passa a ser `rodando | parada | terminado`, sem o `?`, no Modelo e no RunResumo, junto com
  `stop` (o objeto acima, ou `null`). Na UI de hoje, o `parada?` vira `parada` (`app.js:368` e os seletores de
  `bin/ui/src/style.css`).
- **Nó parado**: `n.stop = { reason, text, idleSec }` num nó `running` cujo agente está parado.
- **planOnly** = há result de `plan`, nenhum `started` com outro label e nenhum agente aberto. A run sai
  `terminado`, com `planOnly: true` e `stop: null`.
- **`model.activePseudo`** = `[{ label, agentId }]` dos `started` abertos com rótulo `plan`, `critic:*`,
  `synth`, `design-review:*` ou `polish:*`. O `buildNowBlock` usa `[...nós rodando, ...activePseudo]`.
- **Config `stallMinutes`**: inteiro de 1 a 60, com a mensagem `de 1 a 60`.
  - Entra no fim de `CONFIG_KEYS`, com o padrão em `PANEL_DEFAULTS = { stallMinutes: 5 }` de
    `bin/config.mjs`. `resolveConfig` e `publicConfig` usam esse padrão, **não** o `DEFAULTS` de
    `bin/ui/agent-target.mjs`, que tem teste de paridade com o workflow.
  - O `graph-config --json` não o repassa ao Workflow: o `out.args` é uma lista explícita
    (`bin/graph-config.mjs:88-96`).
  - O watcher relê a config no máximo a cada 5 s.
- **Onde o `ownerListening` e o `ownerGone` entram**:
  - no I2, sempre `false` (então o I2 nunca dá `sessao-encerrada`);
  - no I3, o `events` passa a ler os listeners;
  - no I5, a lista e o Modelo do servidor passam a ler os listeners.

### C7. Args do motor (`workflows/graph-eng.js`)

```js
args.resume = {
  id: 'rs-20260928-153012',          // /^rs-\d{8}-\d{6}(-\d+)?$/, vem pronto do CLI (o motor não tem Date.now)
  from: ['wf_ccaa155a-747'],         // informativo
  done: { R1: { summary, artifact, verified, attempts, filesChanged? }, … },  // summary ≤ 1000; artifact dentro do runDir
  rerun: ['I2'],                     // ids do plano; padrão []
  dependents: false,                 // true = fecho de descendentes pelas deps NORMALIZADAS (depois dos trilhos)
  designReview: { pass: true, attempts: 1 } | null,
}
```

O algoritmo está no D2 §4.3, com um acréscimo no passo 9:

- **Validação sem gastar agente** (`{ error }`):
  - `resume` sem `plan`;
  - `resume` com `planOnly`;
  - `id` fora da regex;
  - `rerun` com nó desconhecido.

  Um id de `done` desconhecido, ou com `artifact` fora do run dir ou com `..`, é ignorado com log, e o nó roda.
- **Prontos**:
  - `READY = done ∩ NODES − RERUN`, e cada um vai direto para `RESULTS` com `resumed: true`;
  - um nó `failed`, `blocked`, `skipped` ou `partial` nunca está em `done`;
  - se a revisão do design for reprovada, só as implementações que não estão prontas viram `skipped`.
- **Revisão do design**: é pulada quando `designReview.pass === true` e nenhum nó não-implement do round 1
  roda agora.
- **Crítica e síntese**: a crítica r1 e a síntese sempre rodam. Os polidores só olham as áreas das
  implementações que rodaram nesta execução.
- **Prefixo**: o `SHARED` ganha, logo depois de `Run dir (paper trail)`, a linha
  `Resume: <id>`, ou `Resume: <id> · refazer: <ids do fecho RERUN, separados por vírgula>` quando o fecho não
  é vazio. **É o acréscimo desta spec**: o CLI lê o fecho normalizado dessa linha (C8, passo 5).
- **Retorno**: ganha `resume: { id, ready, rerun, ran, designReviewSkipped }`. `stats.agents` é o `spent`, que
  conta só os agentes novos.
- **O que não muda**: `targetFor`, `sizing`, `applyLevel`, `applyMaxNodes` e os trilhos. O script continua sem
  `import`, `fs`, `Date.now` e `Math.random`.

**Casos de teste** (`effort: 'high'` e `ceiling: 24`; o plano é `R1 → D1 → I1, I2, I4`, com `I3 ← I1`; `I1` e
`I3` em `src/a.js`, `I2` em `src/b.js` e `I4` em `src/c.js`):

| Caso | `resume` | Agentes exatos |
|---|---|---|
| **A** (aceite 5+1) | `done` = R1, D1, I1, I3, I4; `rerun` = [I2]; com a revisão | `work:I2, verify:I2, critic:r1, polish:1, synth` (5) |
| A′ | `done` = os 6; `rerun` = [I2] | igual ao A (5) |
| B | `done` = os 6; `rerun` = [I1]; `dependents` | `work:I1, verify:I1, work:I3, verify:I3, critic:r1, polish:1, synth` (7) |
| C | `done` = os 6; `rerun` = [D1] | `work:D1, verify:D1, design-review:r1, critic:r1, synth` (5) |
| D | `done` = R1, D1, I1, I2; sem `rerun` | `work:I3, verify:I3, work:I4, verify:I4, critic:r1, polish:1, polish:2, synth` (8) |
| E | igual ao A, sem `designReview` | A + `design-review:r1` (6) |
| F | erros | 0, com `result.error` |

Em todos: nenhum `plan`, `stats.agents` igual ao número de chamadas, `effort.target === 17`, nenhum
`dropped` e o prefixo com `Resume:` (e `refazer:` quando há fecho).

### C8. CLI de retomada: `bin/graph-resume.mjs`

```
node "${CLAUDE_PLUGIN_ROOT}/bin/graph-resume.mjs" --run-dir "<runDir>" [--rerun <id>] [--dependents] [--owner-ok] [--state-dir <dir>] [--projects-dir <dir>] [--graph-runs-home <dir>]
```

- **`--run-dir`** aceita caminho absoluto ou `~/…`, e o próprio CLI expande o `~`, porque o texto copiado usa a
  forma com `~` (C9). Depois disso, o caminho passa pela mesma `resolveRunDir` do servidor, importada de
  `bin/organize.mjs`, com `RUN_ID_RE` no basename.
- **Saída**: `{ ok, resumeId, argsFile, args, summary: { ready, rerun, pending, designReview: 'pula'|'roda', sources }, warnings }`
  no stdout. Em erro, sai com 1, e o stderr traz `graph-eng: <motivo>`. Com a trava contra dois Workflows
  (abaixo), sai com 4.
- **Grava** `<runDir>/resume/<rs>.json` de forma atômica. Exporta a função pura
  `buildResumeArgs({ runDir, projectsDir, rerun, dependents, now, cwd })`.
- **Algoritmo** (D2 §5.3):
  1. **Wfs da run**: são os que têm `Run dir (paper trail): <runDir>` no 1º `agent-*.jsonl`, fora os só
     planOnly. Eles são ordenados por `T0`, o menor `timestamp` da 1ª linha dos `agent-*.jsonl`. W é o último.
  2. **Base**:
     - se W tem `Resume: <rs>`, a base é `resume/<rs>.json`;
     - se W é disparo do zero, a base é o `args` de `<sessão>/workflows/<W>.json`. Sem esse arquivo, é o
       `args.json`, **só se** o `mtime` dele for ≤ `T0(W)` + 5 s; se for mais novo, o CLI sai com 1;
     - sem wf nenhum, a base é o `args.json`, com o estado vazio.
  3. **Plano**: `base.plan`. Sem ele, vale o result do `plan` no journal de W.
  4. **Estado herdado** (é a correção desta spec ao D2): quando W é retomada, o ponto de partida é
     `resume.done` de `resume/<rs(W)>.json` **menos o fecho de refazer de W**. Esse fecho é lido da linha
     `Resume: … · refazer: …` do prefixo de W. Numa linha sem `refazer:` (formato antigo), o fecho é
     calculado pelos `deps` do plano da base. Assim, um nó do fecho que não terminou em W nunca volta como
     pronto.
  5. **Por cima**, vale o journal de W, com o último resultado por label. Um nó com `work:` iniciado em W perde
     o estado herdado.
  6. **Regra de pronto**:
     - veredito `pass` sem `blocking`: pronto e `verified`;
     - implementação sem veredito: não está pronta;
     - pesquisa ou design com `work` feito e sem veredito: pronto, com `verified` igual a "a revisão passou";
     - o artefato precisa existir, estar no run dir e não estar vazio;
     - sem journal nenhum: pesquisa e design ficam prontos com `verified: false`, e toda implementação roda.
  7. **Revisão do design** (P5): o último `design-review:r<n>` de W, ou o herdado quando W não iniciou nenhum
     `work:` de pesquisa ou design.
  8. **Cwd fora da raiz do projeto**: os `checks` ganham o prefixo `cd "<raiz>" && `, e o `context` ganha uma
     nota.
- **Trava contra dois Workflows** (a mesma regra do P1, para o comando colado, que não passa pela C12). Depois
  de achar W, e antes de gravar qualquer coisa, o CLI sai com **4** e o stderr
  `graph-eng: a execução <W> ainda pode estar viva na sessão dona <8 chars>; pare a run nela (Copiar para parar) e retome de novo`
  quando W não terminou (sem result de `synth`), o `computeStop` de W (com `ownerListening` e `ownerGone` da
  presença abaixo) não dá `interrompida`, e vale uma destas:
  - `ownerPresence(readListeners(stateDir, now), ownerSession(W), now)` é `ouvindo` ou `rearmando`;
  - algum `agent-*.jsonl` ou o `journal.jsonl` de W foi escrito há menos de `ACTIVE_GUARD_MS = 60000`. Isso
    pega uma run `rodando` colada à mão, mesmo sem nenhum sinal de vida (dona de plugin antigo, `nunca`).

  A `ownerSession(W)` sai do caminho de W (`<projectsDir>/<slug>/<sessão>/subagents/workflows/<W>`).
  - **`--owner-ok`** desliga a trava. A skill só o passa quando esta sessão é a dona de W (tem a task de W no
    contexto) **e** já rodou o `TaskStop` dela (SKILL, "Ações sobre uma run").
  - **`--state-dir <dir>`** (padrão `defaultStateDir`) e `now` injetável na função pura, para os testes.
- **`loadResume(runDir, rs)`**: exportada de **`bin/graph-watch.mjs`**, para não criar ciclo de import. Ela lê
  `resume/<rs>.json` com contenção e leitura tolerante, e é usada pelo `buildModel` (P3) e pelo CLI.

### C9. Comandos copiáveis (`bin/ui/commands.mjs`, puro e sem DOM)

A função é `commandText({ type, runDir, wf, node, dependents })` → string. Ela devolve `null` se o `runDir` não
for absoluto nem `~/…`, se tiver `"` ou quebra de linha, se o `wf` falhar na `WF_RE` ou se o `node` falhar na
`NODE_RE`. O `runDir` é o do Modelo, com `~`.

| Botão | Texto exato |
|---|---|
| Copiar para retomar | `/graph-eng:graph-eng retomar --run-dir "<runDir>"` |
| Copiar para refazer `<nó>` | `/graph-eng:graph-eng refazer <nó> --run-dir "<runDir>"` |
| Copiar com dependentes | `/graph-eng:graph-eng refazer <nó> --dependentes --run-dir "<runDir>"` |
| Copiar para parar | `/graph-eng:graph-eng parar --run <wf>` |

- **Por que funciona sem pergunta**: a 1ª seção da SKILL.md desvia `retomar`, `refazer` e `parar` (e os aliases
  `resume`, `rerun` e `stop`) para "Ações sobre uma run", sem triagem, scout, plan gate nem AskUserQuestion,
  porque colar já é a confirmação. O run dir absoluto torna a sessão e o cwd irrelevantes.
- **O parar** funciona só colado na sessão dona. O `title` do botão diz isso.
- **Retomar e refazer colados** passam pela trava do C8. Se a dona de W ainda pode ter o Workflow vivo e esta
  sessão não é ela, a sessão recusa em 1 linha: `A sessão dona desta run ainda está ativa: pare a run nela
  (Copiar para parar) e cole este comando de novo.` Na sessão dona, ela mesma para a task antiga e segue.

### C10. Rotas HTTP

- **Travas comuns**: `readJsonBody(req, res, host)` → objeto ou `null` (quando é `null`, a resposta já saiu).
  - Ela sai de dentro do `putConfig`, no I4, e o `putConfig` passa a usá-la.
  - A ordem é Host 403 (em `handle()`) → método 405 com `Allow: POST` → Origin 403 (ausente, `"null"` ou
    diferente de `http://<Host>`) → 415 → 413 pelo tamanho declarado e 413 em chunks (`MAX_BODY` = 4096) →
    400 `JSON inválido` → 400 `o corpo deve ser um objeto`.
  - Cada rota valida depois com uma tabela `CHECK` estrita, no padrão do `validateConfig` (pares +
    `Object.fromEntries`). Campo a mais dá `campo desconhecido`, e o erro sai como
    `400 { error, fields: { <campo>: <motivo> } }`.
  - A tabela `WRITE` é conferida **antes** da regra GET-only (`ui-server.mjs:501`). `OPTIONS` continua 405.
- **Rotas de pedido e leitura (I5)**:

| # | Rota | Corpo | Sucesso | Erros, em ordem |
|---|---|---|---|---|
| A1 | `POST /api/requests` | `{ type, wf, node?, dependents? }` | 202 `{ request }` | travas · 400 `fields` (tabela do D3 §3.4) · 404 run · 409 execução superada · 404 nó (no Modelo da execução atual) · 409 da regra C12 (inclui `Já existe um pedido aberto para esta run.` e sem ouvinte) · 500 |
| A2 | `GET /api/requests/:id` | — | 200 `{ request }` | 400 `id de pedido inválido` · 404 |
| A3 | `POST /api/requests/:id/cancel` | `{}` | 200 `{ request }` em `falhou`, com `cancelado no painel` (pendente) ou `descartado no painel: a sessão não confirmou` (aceito há ≥ 2 min) | travas · 400 · 404 · 409 `a sessão acabou de aceitar; dá para descartar depois de 2 min` · 409 `o pedido já foi encerrado` |
| A4 | `GET /api/listeners` | — | 200 `{ sessions: [{ session: 8 chars, project, wf, beatAt, until }], staleMs: 30000 }` | — |
| A5 | `GET /api/runs/:wf/artifacts` | — | 200 `{ runId, runDir, files: [{ name, kind, node?, variant?, size, mtime }] }` | 400 · 404 run · 404 `essa run não tem pasta de artefatos` |
| A6 | `GET /api/runs/:wf/artifacts/:name` | — | 200 `{ name, kind, size, mtime, truncated, text }` (teto de 256 KB) | 400 `nome de artefato inválido` · 404 |

- **Artefatos**:
  - `ARTIFACT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\.[a-z])?\.md$/`, aplicado sobre o segmento cru, sem
    decodificar;
  - o nome precisa estar na listagem atual: entrada direta, arquivo regular pelo `lstat`, sem symlink e no
    máximo 200;
  - a abertura usa `O_RDONLY | O_NOFOLLOW`, e o `fstat` precisa dar arquivo regular;
  - o `kind` é `report`, `plan`, `pedido`, `node` (com `variant`) ou `outro`.

  A leitura vale para um wf superado.
- **Rotas de organização (I4)**: O1 a O9, com corpo, códigos e mensagens como no D4 §3.5, e sucesso em 200
  `{ org, … }`:
  - O1 `POST /api/org/pin`;
  - O2 `POST /api/org/groups`;
  - O3 `…/groups/:gid/rename`;
  - O4 `…/groups/:gid/move`;
  - O5 `…/groups/:gid/delete`;
  - O6 `POST /api/org/move` (mover sempre desafixa);
  - O7 `POST /api/org/archive`;
  - O8 `POST /api/org/delete` (`confirm` idêntico a `name`);
  - O9 `POST /api/org/delete-finished` (`{ wfs, confirm: 'apagar N' }`, e uma lista velha dá 409 sem apagar
    nada).

  O O8 e o O9 consultam o gancho `canDelete(key) → why | null`, que no I4 devolve sempre `null`. O I5 o liga à
  fila: um pedido aberto dá 409 `Espere o pedido em andamento terminar.`
- **`resolveRunDir(raw, runId, { projectsDir, graphRunsHome })`** fica em `bin/organize.mjs` (I4). São 5 passos
  (D4 §3.6), e a primeira falha devolve `{ ok: false, why }`:
  1. o caminho é absoluto e normalizado;
  2. o basename é igual ao `runId`, que casa com `RUN_ID_RE`;
  3. `lstat` dá diretório que não é symlink;
  4. o `realpath` fica fora do `projectsDir` e não é o home nem `/`;
  5. o pai se chama `.graph-runs`, ou o caminho fica dentro do `graphRunsHome`.

  `removeRunDir(real)` = `fs.rmSync(real, { recursive: true })`.
- **`RUN_ID_RE = /^\d{8}-\d{4}-[a-z0-9][a-z0-9-]{0,63}$/`** fica em `bin/organize.mjs` e é o formato da skill
  (`SKILL.md:143`). É a regex **única** da chave, da contenção e do CLI de retomada.
- **Módulos da UI**: `/^\/([a-z0-9-]+\.mjs)$/` serve um arquivo regular, sem symlink, direto em `bin/ui/`, com
  `text/javascript`. **As entradas `.mjs` que já estão no `STATIC` ficam**, porque o `test/ui-static.test.mjs:111`
  confere `'/config-modal.mjs'` no fonte do servidor. A regra entra como complemento.
- **`inferHeader`** (I4) passa a capturar também `runId` (`# Graph run …`) e `runDirRaw`
  (`Run dir (paper trail): …`), com as regexes tolerantes a `\n` escapado do D4 §3.1, no mesmo cache. O I8
  acrescenta `resume` (`Resume: <rs>`), e por isso o `bin/ui-server.mjs` está na lista do I8, só para o
  `inferHeader` (`bin/ui-server.mjs:187`).

### C11. Modelo e RunResumo

- **RunResumo** (`GET /api/runs` → `{ runs, org }`; o `event: runs` leva o mesmo corpo). Há uma entrada por
  `key`, e os campos de estado são os do representante:
  - I4: `key`, `runId`, `name` (o runId, ou o wf curto), `wfs` (do mais novo para o mais velho), `planOnly`,
    `pinned`, `group`, `archived` e `runDir` (com `~`, ou `null`);
  - I2: `status` (`rodando | parada | terminado`) e `stop`;
  - I5: `pending` (tipo do pedido aberto, ou `null`) e `listening`.

  `RUNS_LIMIT` (50) conta keys, e as fixadas ou em grupo nunca somem por idade. Uma key apagada fica fora até
  aparecer um wf com `mtime` maior que a data do apagar.
- **`OrgPublica`** = `{ groups: [{ id, name }], pinned: key[], warnings: string[] }`.
- **Modelo** (`GET /api/runs/:wf`). O I2 acrescenta `stop`, `planOnly`, `activePseudo` e `nodes[i].stop`. O I5
  acrescenta:

```
runId, runKey, current, supersededBy, runDir (com ~ | null),
requests: Pedido[5], actions: { listening: { project, owner, sessions }, open: Pedido|null,
  resume: Pode, stop: Pode, rerun: Pode, copy: { resume: Pode, stop: Pode, rerun: Pode } },
nodes[i].rerun: Pode, nodes[i].dependents: string[]          // Pode = { ok, why, route? }
```

  O I8 acrescenta `resume: { id, from } | null` e, nos nós prontos da retomada, `resumed: true`.
- **SSE**: nenhum evento novo.
  - O `sig` de cada run passa a incluir o estado e o `updatedAt` dos pedidos da key, `listening` e `current`.
  - O `listSig` passa a incluir `key`, `pinned`, `group`, `archived`, `planOnly`, `wfs`, `pending` e o JSON da
    `OrgPublica`.
  - A fila e os listeners são lidos uma vez por tick, com cache por `mtimeMs:size`.

### C12. Regra das ações (no servidor, testada em `node --test`)

A primeira condição que falha dá o `why`, e o mesmo texto volta como 409 na A1.

- **0. Execução atual** (vale para toda ação, `copy.*` inclusive):
  - se `wf ≠ current`, a resposta é `Essa execução foi retomada em <current>; use a mais nova.`;
  - o `current` é o representante da key (P3).
- **resume**:
  1. status terminado: `A run já terminou. Para rodar um nó de novo, use Refazer nó.`
  2. planOnly: `Só o plano rodou. Aprovar o plano pelo painel está fora do escopo: aprove no chat.`
  3. rodando: `A run está rodando. Pare antes de retomar.`
  4. sem `runDir`: `Essa run não tem pasta em .graph-runs; sem ela não há de onde retomar.`
  5. pedido aberto: `Espere o pedido aberto terminar, ou cancele.` Se o aberto for um `feito` na janela de
     10 min, o texto é `A retomada foi feita; esperando a execução nova aparecer.`
  5b. **dona talvez viva** (a exceção do P1). Vale quando o status é `parada`, o `stop.reason` não é
     `interrompida`, e a `ownerPresence` da `ownerSession` da execução atual é `ouvindo` ou `rearmando`:
     - `rearmando`: `A sessão dona está rearmando a escuta do painel; tente de novo em instantes.`;
     - `ouvindo`: **ok**, com `route: 'owner'`, e a condição 6 não se aplica. O `p#act-why` mostra a nota
       `Quem atende é a sessão dona: ela para a execução antiga e retoma.` (C14).

     Fora desse caso, `route: 'project'`.
  6. sem ouvinte no projeto: `Nenhuma sessão ouvindo este projeto. Use Copiar para retomar e cole numa sessão do Claude Code.`
- **stop**:
  1. terminada: `A run já terminou.`
  2. `stop.reason === 'sessao-encerrada'`: `A sessão que rodou a run acabou; não há o que parar. Use Retomar.`
  3. pedido aberto: o mesmo texto da condição 5 do resume.
  4. dona sem ouvinte: `A sessão que rodou esta run não está ouvindo. Use Copiar para parar e cole nela.`
- **rerun**:
  1. rodando: `A run está rodando. Pare antes de refazer um nó.`
  2. as condições 2, 4, 5 e **5b** do resume (com a 5b, o `route` e a nota valem igual, e a condição 3 não
     se aplica quando dá `route: 'owner'`);
  3. sem ouvinte: `Nenhuma sessão ouvindo este projeto. Use Copiar para refazer e cole numa sessão do Claude Code.`
- **Por que o `copy.*` não ganha a 5b**: o copiar existe para quando não há sessão, e o texto colado passa pela
  mesma trava no `graph-resume.mjs` (C8), que recusa na sessão errada com a instrução de parar na dona.
- **copy.resume**: condições 0 a 4 do resume. **copy.stop**: 0 a 2 do stop. **copy.rerun**: a condição 0, a 1
  do rerun (rodando) e as condições 2 e 4 do resume (planOnly e sem `runDir`). O copiar nunca depende de
  ouvinte nem de pedido aberto: com um pedido aberto e as outras condições boas, `copy.rerun.ok === true` (e
  `copy.resume.ok` e `copy.stop.ok` também), enquanto `rerun.ok === false` (teste do I5).
- **Nó** (`nodes[i].rerun`), pela variante do estado (`variantOf`, `bin/ui/graph-layout.mjs:48-63`), o que cobre
  todos os estados, `sem-reverificacao` inclusive:
  - `done` ou `fail`: ok;
  - `empty`: `Esse nó ainda não rodou.`;
  - `skipped`: `Esse nó foi pulado. Refaça o nó de que ele depende, com os dependentes.`;
  - `running` com a run `rodando`: `Esse nó está rodando.`;
  - **`running` com a run `parada`: ok**, porque o nó foi interrompido no meio (é a correção desta spec ao
    D3);
  - `round > 1`: `Nó da crítica: use Retomar, que a crítica decide de novo.` (o motor não carrega nó de gap).

  Pseudo-nó não se refaz, e a página mostra `Plano, revisão, crítica, polimento e síntese não se refazem sozinhos.`
- **Ouvinte**: `listening.project` vale quando há ouvinte vivo com o mesmo slug da execução atual, e
  `listening.owner`, quando há ouvinte vivo da `ownerSession` dela. `listening.ownerPresence` traz o valor
  de `ownerPresence` (C3), que a condição 5b usa.

### C13. Lista lateral (`bin/ui/sidebar.mjs`, pura)

- **Seções**, na ordem:

  | Seção | Padrão |
  |---|---|
  | `pinned` (Fixadas) | aberta |
  | grupos, na ordem de `org.groups` (aparecem mesmo vazios) | abertos |
  | `active` (Em andamento) | aberta |
  | `stopped` (Paradas) | aberta |
  | `done` (Finalizadas) | **fechada** |
  | `archived` (Arquivadas), só com o filtro | aberta |

  Uma seção vazia some, menos os grupos.
- **`sectionOf(run)`**, na ordem: arquivada → fixada → grupo existente → `status === 'rodando'` (**vence
  `planOnly`**) → `terminado` ou `planOnly` → o resto vai para Paradas. O servidor tem só
  `isInFinishedSection(run)`, com a mesma ordem, e um teste de paridade exaustivo protege a igualdade
  `isInFinishedSection(r) === (sectionOf(r) === 'done')`.
- **Accordion**:
  - `<button class="sec-toggle" aria-expanded aria-controls>`, com o nome, a contagem (só com a seção fechada)
    e o chevron em CSS: › fechado e ⌄ aberto, com giro de 150 ms que desliga com `prefers-reduced-motion`;
  - o estado fica no `localStorage['graph-eng-sections']`, em try/catch;
  - a seção que contém a run selecionada, ou um resultado de busca, abre nesta visita sem gravar.
- **Cabeçalho da lista**: o texto "Suas runs", mais a lupa (busca na página por título, projeto e goal, sem
  acento e sem caixa), o filtro (um menu com "Mostrar arquivadas (N)", gravado em
  `localStorage['graph-eng-show-archived']`) e o `+` (novo grupo, com edição inline).
- **Linha de 28 px**: `div.run-row[role=listitem][draggable=true][data-key]`, com dois botões irmãos.
  - `button.run-btn` traz a bolinha de estado: rodando pisca; parada fica cheia em `--frozen`; terminada fica
    cheia; planOnly fica vazia.
  - Depois vem `.run-title`, que é o `titleOf`: o runId sem `AAAAMMDD-HHMM-`, ou o goal cortado em 80, ou o wf
    curto.
  - À direita fica `.run-strip`, `.run-sum` ou `só plano`.
  - `button.run-more` (⋯) aparece no hover e no foco, e fica sempre visível com `hover: none`.
  - O tooltip traz `goal · project · runId` e o `metaOf`: o motivo da parada, `terminada há …` ou `só plano`.
  - O selo "parada?" e a meta de texto saem da linha.
- **`stripOf(nodes, max = STRIP_MAX)`**, com `STRIP_MAX = 10`. A conta é 262 − 20 − 10 − 16 − 24 − 88 = 104 px,
  e `floor((104+3)/(7+3)) = 10` (D4 §4.4.1).
  - Com `nodes.length <= max`, devolve `{ mode: 'dots', dots, label }`.
  - Acima disso, devolve `{ mode: 'sum', items (até 3), label }`. A ordem é fail, running, done, empty e
    skipped, sem os zerados.
  - O `label` é o texto por extenso com singular e plural: "2 com erro, 3 rodando, 12 concluídos, 4 na fila, 1
    pulado".
- **Menus**: um `#row-menu[role=menu]` só. Ele abre pelo ⋯, pelo clique direito ou por Shift+F10.
  - Itens da run: Fixar ou Desafixar · Mover para `<grupos>` · Sem grupo · Novo grupo… · Arquivar ou
    Desarquivar · Apagar….
  - Itens do grupo: Renomear · Mover para cima e para baixo · Apagar grupo….
  - Teclado: ↑/↓, Home/End, Enter/Espaço, Esc e Tab.
- **Arrastar**: HTML5 nativo, com `application/x-graph-eng-run` = `wf`. Os alvos são:
  - Fixadas (O1);
  - um grupo (O6);
  - as seções de estado, com O6 `group: null` e O1 `pinned: false`.

  Uma zona "Solte aqui para fixar" aparece durante o arrasto quando não há fixadas. Uma seção fechada abre
  depois de 600 ms com o cursor em cima.
- **Mostrar mais**: cada seção mostra 10 linhas, e o "Mostrar mais N" traz `min(20, restantes)`. A
  selecionada nunca fica escondida.
- **Dialogs** (`bin/ui/confirm.mjs`, I6):
  - `<dialog id="confirm">` genérico, no padrão do `config-modal.mjs:183-255`;
  - `openConfirm({ title, body, typed?, check?, confirmText, danger, focus, onConfirm })`. O `onConfirm`
    devolve `{ error, fields }` para mostrar no `p.field-err` sem fechar o dialog;
  - usos: Apagar run (nome digitado), Apagar finalizadas (lista + `apagar N`) e Apagar grupo (sem campo). O
    I7 o reaproveita para Parar e Refazer.
- **Estados vazios, textos e medidas**: D4 §4.9 a §4.11. Nenhum token novo de cor.

### C14. UI das ações (`bin/ui/actions.mjs`, I7)

Os detalhes estão no D3 §4. Os pontos que o I7 não pode errar:

- **Chips do cabeçalho da run**:
  - `.chip-status`;
  - `.chip-reason[data-reason]` com o `stop.text`;
  - `.chip-listen[data-on]`, com a bolinha cheia ou vazia e o texto `sessão ouvindo`, `nenhuma sessão ouvindo`
    ou `sessão ouvindo · não é a dona`. O `title` sem sessão é: `Nenhum graph-watch deste projeto deu sinal
    nos últimos 30 s. Os botões voltam quando uma sessão do Claude Code estiver ouvindo; enquanto isso, use
    Copiar.`
- **`#run-actions`**: `Retomar` (sem dialog), `Parar…` (dialog, com o foco inicial em Cancelar), `Artefatos`,
  `Copiar para retomar` e `Copiar para parar`.
  - Um botão desabilitado leva `disabled`, `title` e `aria-describedby="act-why"`, e o `p#act-why` mostra o
    `why` **à vista**.
  - Na execução superada, aparece `Abrir a execução mais nova`.
  - Com `actions.resume.route === 'owner'` (ou `rerun.route`), o botão fica habilitado, e o `p#act-why` mostra
    a nota `Quem atende é a sessão dona: ela para a execução antiga e retoma.`
- **`p#req-status[role=status]`**: o estado do pedido aberto ou do último, com a bolinha da variante do grafo.
  Os textos estão no D3 §4.3. Com pendente aparece `Cancelar pedido`, e com aceito há ≥ 2 min, `Descartar
  pedido`.
- **Gaveta, modo nó**:
  - `Refazer nó…`, que abre um dialog com `Refazer também os dependentes` e a linha `Também refaz: …`. O botão
    vira `Refazer N nós`;
  - `Copiar para refazer <id>` e, havendo dependentes, `Copiar com dependentes`;
  - `<details>` `Saída do nó`, que lê pela A6 num `<pre class="artifact">` com `textContent`;
  - **selo "retomado"** (P3): só quando `node.resumed === true`, um `span.chip-resumed` com o texto `retomado`
    ao lado do `#drawer-state`, com o `title` `Resultado herdado de uma execução anterior; nenhum agente rodou
    este nó nesta execução.` Sem o campo (o caso de todo Modelo antes do I8), nada aparece. No grafo, o nó
    segue cheio (variante `done`), sem marca nova. O campo vem do I8, que roda em paralelo com o I7, por isso o
    I7 lê o campo só se ele existir e testa o selo por grep no `test/ui-static.test.mjs` (`chip-resumed`,
    `retomado` e a condição `resumed === true`). A conferência visual do selo fica para a crítica final,
    depois do I8.
- **Gaveta, modo run**: a lista agrupada em Relatório, Plano, Pedido, Nós e Outros, com o `REPORT.md` (ou o
  `plan.md`) aberto por padrão. Traz também o histórico dos 5 últimos pedidos.
- **Clipboard**: `navigator.clipboard.writeText` dentro do handler de clique. Se falhar, vai por `<textarea>` +
  `execCommand('copy')`. Se isso também falhar, abre o dialog `Copie o comando`. O rótulo vira `Copiado` por
  1,5 s.
- **Modal de engrenagem, seção Execução**: `Considerar parada depois de` com `input#cfg-stall` (min e max de
  `limits.stallMinutes`, sufixo `min`). O hint é `Sem escrita no histórico do agente em execução por mais que
  isso, a run vai para Paradas. Com a sessão dona ouvindo, vale o triplo. De 1 a 60 min.`, e o erro 400 aparece
  inline.

## Extras (autorização do usuário: poucos, pequenos e justificados)

| Extra | Por quê | Fora do escopo? |
|---|---|---|
| E1 Cancelar pedido pendente e descartar aceito sem confirmação (A3) | Sem ele, um pedido feito sem ouvinte, ou aceito por uma sessão que caiu, trava os botões da run | Não. Só fecha o próprio pedido, sem mexer em agente nem em nó |
| E2 Histórico dos 5 últimos pedidos na gaveta | Sem ele, o `feito` ou `falhou` some no pedido seguinte | Não, é leitura |
| E3 Motivo `interrompida` | Depois de um Parar ou de um Esc, "sem atividade há 5 min" seria falso. Há 13 casos reais (D1 §3.1) | Não |
| E4 Linha "agora" também com plan, design-review e polish | Têm o mesmo defeito de critic e synth e não custam nada a mais | Não |
| E5 Busca na lista (lupa) | Está no print de referência, e a lista cresce com grupos e arquivadas | Não, é leitura |
| E6 "Novo grupo…" no menu da run, já com a run dentro | Evita dois passos e a corrida entre criar e mover | Não |
| E7 Mover grupo para cima e para baixo (O4) | Grupos "com nome e ordem" | Não |
| E8 Zona "Solte aqui para fixar" durante o arrasto | Sem ela, não dá para fixar arrastando quando ainda não há fixadas | Não |
| E9 "Abrir a execução mais nova" num wf superado | O wf antigo continua abrível por URL | Não |

## Fora do escopo

Aceitar ou pular um nó na mão, rodar de novo do zero com outro esforço, aprovar o plano pelo painel (e por
isso o Retomar fica desabilitado numa planOnly), mandar recado livre ao Claude, editar o plano, iniciar uma
run sem sessão aberta e destravar um agente preso (isso só dá pelo `/workflows`). Também ficam de fora: markdown
renderizado, arrastar em tela de toque (o menu cobre esse caso), poda de `deleted` no `organize.json` e acesso
remoto.

## Divisão por nó implement

Cada nó é uma etapa do tamanho de um commit e deixa `node --test` e a checagem de sintaxe verdes **sozinho**,
sem depender de trabalho de outro nó que ainda não terminou. Os arquivos de nós que podem rodar em paralelo
não se sobrepõem.

As janelas de paralelismo pelo grafo:

- depois do DS: {I1, I2};
- depois do I2: {I1, I3, I4};
- depois do I4: {I1, I3, I5 (quando o I3 fechar), I6};
- depois do I5: {I6, I7 (depois do I6), I8}.

Os arquivos que passam por mais de um nó passam sempre em série:

- `bin/graph-watch.mjs`: I2 → I3 → I8;
- `bin/ui-server.mjs`: I2 → I4 → I5 → I8 (o I8 só mexe no `inferHeader`);
- `bin/config.mjs`: só o I2;
- `bin/ui/app.js`, `index.html` e o CSS: I2 → I6 → I7 (o I2 só troca `parada?`);
- `test/ui-static.test.mjs`: I2 (só o assert da linha 132) → I6 → I7;
- `test/ui-server.test.mjs`: I2 → I4 (o I4 só isola o `stateDir`);
- `test/ui-server-phases.test.mjs`: só o I4;
- `test/events.test.mjs` e `test/errors.test.mjs`: I2 → I3.

| Nó | Arquivos (só estes) | Entrega | Testes |
|---|---|---|---|
| **I1** Motor retomável | `workflows/graph-eng.js`, `test/workflow-resume.test.mjs` (e `bin/ui/agent-target.mjs` só se a tabela de alvo mudar, o que não é esperado) | C7 inteiro, com a linha `Resume: … · refazer: …` | Casos A a F de C7, mais G (trilhos) e H (orçamento), escritos antes e vermelhos; `test/target.test.mjs` e `test/workflow-rails.test.mjs` seguem verdes |
| **I2** Parada e "agora" | `bin/graph-watch.mjs`, `bin/config.mjs`, `bin/ui-server.mjs` (só o status da lista: `computeStop`, `stop` e `planOnly` no RunResumo, fim do `ACTIVE_WINDOW_MS`), `bin/ui/app.js` e `bin/ui/src/style.css` + `bin/ui/style.css` (**só** a troca de `parada?` por `parada`), `test/model.test.mjs`, `test/config.test.mjs` (inclui `defaultStateDir`, C1), `test/events.test.mjs`, `test/errors.test.mjs`, `test/ui-server.test.mjs`, `test/ui-static.test.mjs` (**só** o assert da linha 132, que casa `#graph[data-status='parada\?']` no CSS) e as fixtures novas `test/fixtures/wf_long_healthy`, `wf_dead`, `wf_quota`, `wf_interrupted_marker`, `wf_parallel_one_alive`, `wf_planonly`, `wf_critic_running` e `wf_synth_running` | C6 e `defaultStateDir` em `bin/config.mjs` (C1) | As fixtures do D1 §5; `defaultStateDir` com `GRAPH_ENG_STATE_DIR`, com `GRAPH_ENG_CONFIG` e com nenhum dos dois (home injetado); config `stallMinutes` 0, 61 e `"5"` recusados, 5 aceito, PUT 400 com `fields.stallMinutes`; a lista e o `buildModel` dão o mesmo `status` e `stop.text`; os asserts de `parada?` passam a `parada`, inclusive o de `test/ui-static.test.mjs:132` (os testes com a fixture `interrupted` envelhecem também os `agent-*.jsonl`) |
| **I3** Fila e watcher | `bin/requests.mjs` (novo), `bin/ui/commands.mjs` (novo, C9), `bin/graph-watch.mjs` (modo `events`: `--state-dir`, `--listen-min`, sinal de vida, emissão, `ownerPresence`, com `ownerListening`/`ownerGone` no `computeStop` do `events`), `test/requests.test.mjs` (novo), `test/events.test.mjs` e `test/errors.test.mjs` | C1 a C5 e C9 | Os do D1 §5 (I3), mais o `.final`: um `done` depois de descartado sai com 5, e dois `done` concorrentes dão exatamente um 0; o `aceito` vencido em 30 min; `commandText` igual aos literais do C9 e `null` para entrada inválida; todo `events` em teste com `GRAPH_ENG_STATE_DIR` em tmp; `ownerPresence` nos quatro valores (vivo; `exitedAt` = now−30 s dá `rearmando`; now−121 s dá `encerrada`; sem arquivo dá `nunca`), e o `computeStop` do `events` não dá `sessao-encerrada` durante o `rearmando`; um `resume` com `route: 'owner'` sai só no `events` da dona, e não no de outra sessão do mesmo projeto; o `accept` dele por outra sessão sai com 4 e o pedido segue `pendente`; um pedido sem `route` é tratado como `owner` |
| **I4** Organização no servidor | `bin/organize.mjs` (novo), `bin/ui-server.mjs` (`readJsonBody`, `stateDir`/`organizePath`/`graphRunsHome`/`now` no `createPanelServer` e no `ensurePanel`, `inferHeader` com runId/runDir, agrupamento por key e representante exposto por wf, O1-O9, `canDelete`, regra `.mjs`, RunResumo do I4), `test/organize.test.mjs` e `test/ui-server-organize.test.mjs` (novos), e `test/ui-server.test.mjs` e `test/ui-server-phases.test.mjs` (**só** o isolamento do C1: `configPath` em tmp nos `ensurePanel` de `:94`, `:481`, `:580` e phases `:52`, e `GRAPH_ENG_CONFIG` + `GRAPH_ENG_STATE_DIR` em tmp no `env` do `spawnUi` e do `live --svg`) | C10 (O1-O9, `resolveRunDir`, `RUN_ID_RE`), C11 (parte do I4) | Os do D4 §8.1 e §8.2; a guarda de isolamento do C1 (nenhum painel de teste sem `configPath`/`stateDir`, nenhum `spawn` de `ui`/`live` sem `GRAPH_ENG_STATE_DIR`) e `server.stateDir === dirname(configPath)`; os asserts atuais de `test/ui-server.test.mjs`, `test/ui-server-phases.test.mjs` e `test/ui-static.test.mjs` seguem verdes **sem mudar nenhum assert** (o `ui-static` nem é editado, e as entradas `.mjs` do STATIC ficam) |
| **I5** Pedidos, ouvinte e artefatos | `bin/ui-server.mjs` (A1-A6, Modelo com `actions`/`current`/`requests`, C12, SSE, `canDelete` ligado, `WF_RE`/`NODE_RE` importadas de `bin/requests.mjs`, listeners e `ownerPresence` no `computeStop` da lista, condição 5b e `route` no pedido), `test/ui-server-actions.test.mjs` e `test/helpers/panel-fixture.mjs` (novos: `withRunDir`, `writeListener`, montagem do run dir) | C10 (A1-A6), C11 (parte do I5), C12 | Os do D3 §8.1, com duas correções: no caso 6c, o teste regrava o sinal de vida com `beatAt = now` injetado antes da leitura (senão ele passa dos 30 s); e o nó `running` numa run parada dá `ok`. Mais: A3 descarta um aceito com ≥ 2 min e recusa com menos; com um pedido aberto numa run parada, `rerun.ok === false` e `copy.rerun.ok === true` (e `copy.resume.ok`/`copy.stop.ok` também `true`). **Condição 5b**: run parada por `sem-atividade` com a dona ouvindo e outra sessão do projeto ouvindo → `resume.ok === true` e `route === 'owner'`, e o POST grava `route: 'owner'` (o mesmo para `rerun`); a dona com `exitedAt` = now−30 s e outra sessão ouvindo → `resume.ok === false` com o texto de `rearmando`; o mesmo em now−121 s → `stop.reason === 'sessao-encerrada'`, `resume.ok === true` e `route === 'project'`; `interrompida` com a dona ouvindo → `route === 'project'` |
| **I6** Lista lateral | `bin/ui/sidebar.mjs` e `bin/ui/confirm.mjs` (novos), `bin/ui/app.js`, `bin/ui/index.html`, `bin/ui/src/style.css` + `bin/ui/style.css`, `test/ui-sidebar.test.mjs` (novo) e `test/ui-static.test.mjs` | C13 | Os do D4 §8.3 e a paridade com `isInFinishedSection`; os greps do ui-static cobrem `sidebar.mjs` e `confirm.mjs`; Playwright do D4 §8.4 claro e escuro, com os prints no run dir |
| **I7** Ações na UI | `bin/ui/actions.mjs` (novo), `bin/ui/app.js`, `bin/ui/index.html`, `bin/ui/src/style.css` + `bin/ui/style.css`, `bin/ui/config-modal.mjs` e `test/ui-static.test.mjs` | C14 (importa `commands.mjs` e `confirm.mjs`), com o selo "retomado" da gaveta (P3) | Os do D3 §8.2 (textos, greps, `commandText`); grep do selo (`chip-resumed`, `retomado`, `resumed === true`); Playwright do D3 §8.3 claro e escuro, com sessão e sem sessão, e os prints no run dir |
| **I8** Skill, CLI e e2e | `bin/graph-resume.mjs` (novo), `bin/graph-watch.mjs` (só `loadResume` e o fallback do `buildModel` para `Resume:`), `bin/ui-server.mjs` (**só** o `inferHeader` com `Resume:`, C10), `skills/graph-eng/SKILL.md`, `test/graph-resume.test.mjs` e `test/e2e-actions.test.mjs` (novos), e fixtures novas em `test/fixtures/resume-*` (se preferir fixture versionada a montar em tmp) | C8, P3 (desenho do wf retomado), SKILL "Ações sobre uma run" | Os do D2 §9.2 e §9.3, **mais** o caso "refazer I1 + dependentes → parar durante verify:I1 → retomar", que espera `I1` e `I3` pendentes; um wf com `Resume: <rs>` no prefixo sai no `GET /api/runs/:wf` com `resume.id === <rs>` e `nodes[i].resumed === true` nos prontos; e2e para `resume`, `stop` e `rerun-node`: POST → arquivo → linha do `events` → `accept`/`done` → GET `feito`; args do CLI → `runWorkflow` → só os agentes esperados. **Trava contra dois Workflows** (C8), com `--state-dir` e `now` em tmp: W parada com sinal de vida da dona `ouvindo` → saída 4 e nada gravado em `resume/`; o mesmo com `--owner-ok` → ok; W `interrompida` com a dona ouvindo → ok; um `agent-*.jsonl` de W escrito há 10 s, sem sinal de vida nenhum → saída 4; W terminada → ok. **e2e do `route: 'owner'`**: dois `events` (dona e outra sessão do mesmo projeto) → a linha sai só na dona → o `accept` da outra sessão sai com 4 → o da dona sai com 0 → `graph-resume --owner-ok` → `done` |
| **I9** Docs e 0.5.0 | `skills/graph-eng/DESIGN.md`, `README.md`, `.claude-plugin/plugin.json` e `docs/assets/` (`logo-light.svg` e `logo-dark.svg`, exportados do logo do cabeçalho em `bin/ui/index.html:15`, sem logo novo, e prints claro e escuro do painel com fixture); lê `<runDir>/ref-readmes.md` (ponytail, rtk, graphify e parecidos) | Item 14 (com o refinamento do 5º pedido: logo da interface, instalação só do Claude Code) e as regras gerais de versão e docs | `plugin.json` em 0.5.0; `node --test` verde; nenhum nome de projeto real nos prints; os dois SVG com a geometria de `bin/ui/index.html:15` e sem `class=`; README com `<picture>` e sem instalação para Codex/Gemini |

**O que a SKILL.md ganha (I8)**:

- no topo, a seção "Ações sobre uma run (painel ou comando colado)". Ela cobre os gatilhos, que são a linha
  `graph-eng pedido …` e os args `retomar`, `refazer` e `parar`, e diz: sem pergunta, sem triagem e em até 3
  linhas;
- o passo a passo por tipo (D2 §7 e D1 §2.11):
  - saída 3 ou 4 do `accept`: silêncio;
  - `done --wf <novo>` logo depois de disparar;
  - erro: `fail --reason`;
  - `done` que sai com 5: 1 linha avisando que o painel já tinha encerrado o pedido;
- **antes de todo `resume` e `rerun-node`** (pedido da fila ou texto colado), a trava contra dois Workflows
  (P1 e C8):
  1. se esta sessão tem no contexto a task do Workflow de W (é a dona), roda `TaskStop(<task>)`. Uma resposta
     de que a task já terminou conta como ok. Depois chama `graph-resume.mjs … --owner-ok`;
  2. se o pedido tem `route: 'owner'` e esta sessão **não** acha a task de W no contexto, grava
     `fail --reason "esta sessão não achou a task do workflow <W>; pare pelo /workflows e retome de novo"`
     e não dispara nada;
  3. se esta sessão não é a dona, chama `graph-resume.mjs` sem `--owner-ok`. A saída 4 vira `fail` com a 1ª
     linha do stderr (pedido da fila) ou a recusa de 1 linha do C9 (texto colado), e nada é disparado;
  4. só com o `graph-resume.mjs` em 0 vem o `Workflow(...)`;
- nas etapas 5 e 6: gravar `args.json` antes de cada `Workflow(...)` e guardar o id da task do Workflow junto do
  `<wf>`;
- o Monitor depois do TERMINADO, com até 4 rearmes e sem mensagem ao usuário. Durante a run, a skill rearma o
  Monitor sempre que ele sair, por qualquer motivo, e não só no timeout: um watcher que some por mais de 2 min
  faz a dona contar como `encerrada` (C3), e a trava contra dois Workflows perde a camada da C12;
- a "Recuperação › Interrompido", que passa a usar `graph-resume.mjs` em qualquer sessão.

## Always / Ask first / Never

- **Always:**
  - zero dependência em runtime;
  - os modos `snapshot`, `agent`, `live` e `events` mantêm o contrato de hoje (o `events` sem sessão no
    caminho sai depois do TERMINADO como hoje);
  - as mesmas travas do `PUT /api/config` em toda escrita;
  - `textContent`, nunca `innerHTML`;
  - relógio injetável e dirs temporários nos testes;
  - o painel novo sobe do repo em `GRAPH_ENG_PORT` ≥ 4490, e quem o sobe o encerra.
- **Never:**
  - escrever em `~/.claude` num teste;
  - derrubar o painel da porta 4477 ou o `graph-watch events` desta run;
  - apagar fora de `.graph-runs/<run>/` ou do `graphRunsHome`;
  - aceitar `runDir`, `runId`, `session` ou `state` vindos do cliente;
  - executar um pedido vencido;
  - disparar um `Workflow(...)` de retomada com o `graph-resume.mjs` fora de 0, ou passar `--owner-ok` sem
    ter parado antes a task de W nesta sessão;
  - commit, push ou deploy dentro de um nó.

## Como verificar

- `node --test` verde e a checagem de sintaxe do workflow depois de cada nó.
- O teste 5+1 (C7, caso A) e o e2e dos três tipos (I8).
- Os Playwright do I6 e do I7, claro e escuro, um navegador de cada vez, com os prints no run dir.
- O `curl` com Origin errado em cada POST dá 403, e o arquivo da fila fica byte a byte igual.

## Riscos

- **O `TaskStop` sobre a task do Workflow não foi verificado.** Falta confirmar que o `Workflow` devolve o id
  da task e que o `TaskStop` o mata (o `wf.json` do host só tem `taskId` no fim). Se não der, o `stop` e o
  resume ou rerun com `route: 'owner'` saem com `fail`, com o motivo "esta sessão não achou a task do
  workflow; use /workflows", e o Copiar continua valendo. Nunca se dispara o Workflow novo sem o `TaskStop` ok
  nesse caso. O I8 confirma numa sessão real ou registra a limitação.
- **Dois Workflows no mesmo run dir** ficam barrados em três camadas: a condição 5b da C12 (a dona ouvindo
  atende e para a execução antiga), a trava do `graph-resume.mjs` (C8, que vale também para o texto colado) e
  o `TaskStop` na skill. Sobra um buraco: a dona com o Workflow vivo, **sem** watcher há mais de 2 min (o
  Monitor foi derrubado e não foi rearmado, ou a sessão é de plugin antigo) e **sem** escrita há mais de 60 s.
  Nesse caso, a run aparece como `sessão encerrada` ou sem dona, e outra sessão pode retomar. O rearme por
  qualquer motivo (SKILL) encolhe o buraco. Fechar de vez exigiria que o painel visse a task do Workflow, e
  ele não vê (é outro processo).
- **Morte silenciosa com a sessão viva** leva até 3·N = 15 min para aparecer. Cota, Esc e Parar deixam marca
  e aparecem na hora.
- **Sem ouvinte, o N = 5 ainda dá falso positivo curto** (1,6 % dos agentes medidos, por até ~7 min). A run
  volta sozinha, com a linha `voltou a rodar`.
- **O `args.json` é gravado pelo Claude.** Se ele faltar, o CLI cai no `wf.json`, que só existe com o wf
  terminado. O erro é claro, e nunca mistura planos.
- **Dois runIds iguais** (mesmo minuto e mesmo assunto) viram uma linha só, com aviso em `org.warnings`.
- **Dois painéis gravando o mesmo `organize.json`** podem perder uma escrita. É raro e custa pouco.
