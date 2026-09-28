# graph-eng: por que o desenho é este

Graph engineering é modelar o trabalho como **jobs (nós) ligados por setas (arestas)**, com um
**estado** compartilhado. A LangChain resume assim: o que mudou em 2026 não foi o grafo, mas o que cabe
dentro de um nó, que agora é um agente inteiro com o próprio loop. O risco é o oposto: grafo grande.
Sistema multiagente gasta **~15x os tokens de um chat**, e o volume de tokens explica 80% da
variância de qualidade ([Anthropic][ma]). A meta, portanto, é o **menor grafo que melhora o
resultado** (Greg Eisenberg), não o maior.

O `deep-research` embutido do Claude Code usa 1 + 5 + 25 + 75 + 1 = **108 agentes**, com 3 votos por
afirmação. O `graph-eng` faz planejamento, execução, verificação, reparo e loop com **2 agentes
(trivial) a ~20 (complexo, 2 rounds)**. Os números saíram do harness de teste.

## Decisão → evidência

| Decisão no script                                                   | Evidência                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planner dimensiona pela complexidade (trivial=1, moderada=2-3, complexa≤6) | A Anthropic embute a regra no prompt: fato simples = 1 agente; comparação = 2-4. Falha típica observada: "spawn 50 subagents for simple queries" ([ma]). Alocar compute pela dificuldade rende >4x de eficiência ([Snell 2024][snell]).                                     |
| Tarefa trivial vira 1 nó, sem critic nem synth                      | Começar simples e só adicionar complexidade quando ela provar ganho ([Building effective agents][bea]). O pipeline fixo e simples do Agentless bateu agentes complexos no SWE-bench a $0,70/issue ([Xia 2024][agentless]).                                              |
| **Leitura em paralelo, escrita em raia única**                      | "Writes stay single-threaded; additional agents contribute intelligence rather than actions" ([Cognition 2026][cog2]). Multiagente perde de 39% a 70% em tarefa sequencial e ganha 81% em tarefa decomponível ([Google/DeepMind 2026][gdm]). "Actions carry implicit decisions" ([Cognition 2025][cog1]). |
| Largura 2-3 simultâneos                                             | A Anthropic dispara 3-5 por vez. O Claude Code recomenda 3-5 teammates: "three focused teammates often outperform five scattered ones" ([agent teams][team]).                                                                                                              |
| Scheduler DAG dinâmico (sem barreira por onda)                      | O líder esperar todos os subagentes de forma síncrona "creates bottlenecks" ([ma]). No script, cada nó dispara assim que as deps terminam.                                                                                                                                  |
| Orquestrador central (script + critic), sem swarm                   | Erro amplificado 17,2x em agentes independentes contra 4,4x com orquestrador central ([gdm]). Swarm não estruturado é "mostly a distraction" ([cog2]).                                                                                                                    |
| **Worker ≠ checker**                                                | O mesmo modelo que escreve e se avalia tem viés de self-preference ([Panickssery 2024][selfpref]). Autocorreção sem feedback externo não ajuda e às vezes piora ([Huang 2023][huang]).                                                                                      |
| **Executor barato, revisor forte** (worker Sonnet; verify/critic/planner na sessão) | Revisor mais fraco que o gerador **piora** o resultado: Codex revisando Claude caiu de 91,4% para 82,8% em 116 tarefas ([Xiang 2026][xiang]). Sonnet executando com Opus de advisor subiu de 72,1% para 74,8% no SWE-bench Multilingual, custando 11,9% menos ([advisor][advisor]). Cascatas cortam de 85% a 98% do custo ([FrugalGPT][frugal], [RouteLLM][routellm]). Verificar é mais barato que gerar ([Cobbe 2021][cobbe]). Na comunidade, é o padrão dominante: "big models plan and review, small models implement" ([HN][hn-tier]). |
| Tarefa trivial fica toda no modelo da sessão                        | Em tarefa pequena, "just have the smart agent do it"; o tiering só compensa em plano grande ([HN][hn-small]).                                                                                                                                                              |
| Gate determinístico antes do juiz LLM (check vermelho → reparo direto) | Spotify: verificadores determinísticos antes do judge; o judge veta ~25% das sessões ([Honk p.3][spotify3]). Stripe: blueprints misturam nós determinísticos e agênticos, com no máximo 2 rodadas de CI ([Minions][stripe]).                                              |
| Editar fora do escopo, ou apagar/afrouxar teste, é blocking         | Sair do escopo é a causa mais comum de veto no Spotify ([spotify3]). Kent Beck interrompe quando vê teste apagado ([beck]). Um harness "passou" 3 semanas quebrado ([HN][hn-oracle]).                                                                                    |
| `doneWhen` travado pela spec; premissas explícitas; perguntas só no plan gate | Deixar o agente perguntar recupera até 74% da perda em tarefa subespecificada, mas o modelo não pergunta se não for instruído, e só perguntas de comportamento ajudam ([Ambig-SWE][ambig]). Contrato de pronto antes de cada sprint ([Anthropic harness][harness]). |
| Estimativa de agentes antes do fan-out                              | Relatos de 46 agentes Opus queimando ~3M tokens em 18 min, com a saída descartada. O pedido recorrente é "dry-run: N agents, ~X tokens" ([issue #66023][i66023]). |
| Sem teste que prove o aceite, o nó escreve o teste antes            | Consenso nos fóruns: "o grafo vale o que vale o oráculo"; sem teste, um swarm entrega demo ([HN][hn-oracle]).                                                                                                                                                             |
| 2º voto só em dúvida, não 3 votos fixos                             | Parada adaptativa economiza até 7,9x as amostras com <0,1% de perda ([Adaptive-Consistency][adacons]) e de −34% a −84% ([ESC][esc]). O ganho de votar vem da maioria, não do debate ([Debate or Vote][dov]). Debate multiagente não bate CoT/self-consistency pelo mesmo compute ([Smit 2024][mad], [2502.08788][mad2]). |
| Nó read-only de baixo risco tem verificação adiada para o critic    | Gastar verificação onde o erro custa caro (Greg Eisenberg). O critic confere essas afirmações por amostragem, em lote.                                                                                                                                                     |
| Verificador devolve `where` + `fix` para cada blocking              | O LLM falha em achar o erro, mas corrige quando recebe a localização ([Tyen 2023][tyen]).                                                                                                                                                                                  |
| Só **blocking** conta, nits à parte; o critic não inventa gap       | "A reviewer asked to find gaps will usually report some, even when the work is sound" ([best practices][bp]). O worker filtra achados fora do escopo, o que evita scope creep ([cog2]).                                                                                    |
| Reparo ≤2, para sem progresso, e o último reparo escala de modelo   | 2-3 rounds concentram o ganho ([CRITIC][critic], [Self-Refine][selfrefine]). "Abort if two consecutive turns show no improvement" ([Osmani][osmani]). Em problema difícil, modelo mais forte > mais tentativas do fraco ([snell]).                                        |
| Checks executáveis (typecheck/test) como sinal do loop              | Feedback com ferramenta vale ~+7,7 F1 contra ~0 da autocrítica ([CRITIC][critic]). Reflexion chegou a 91% no HumanEval com sinal de teste ([reflexion]).                                                                                                                  |
| Critic com `doneWhen` explícito, teto de rounds e dedup de gaps     | Os 3 maiores modos de falha do MAST são step repetition (15,7%), reasoning-action mismatch (13,2%) e **unaware of termination** (12,4%). Verificação ausente ou errada soma mais 17% ([Cemri 2025][mast]).                                                                |
| Estado em disco + resumo ≤120 palavras entre nós                    | O subagente grava o artefato e devolve uma "lightweight reference", evitando o "game of telephone" ([ma]). O subagente devolve 1-2k tokens condensados ([context engineering][ce]). Topologia esparsa corta de 28% a 87% dos tokens ([AgentPrune][agentprune]).        |
| Prefixo `SHARED` idêntico em todos os prompts                       | Leitura de cache custa 0,1x o input (0,05x no Opus 5.5). Com 5 workers: 1,65P contra 5P (−67%). O runtime escalona o fan-out por 5s para o cache aquecer ([prompt caching][cache]).                                                                                        |
| Planner consulta `INDEX.md`/`REPORT.md` de runs anteriores          | "A graph produces the work *and* the memory that makes the next graph smarter" (Greg Eisenberg). Salvar o plano e os resultados em memória externa ([ma]).                                                                                                               |
| `explore`: 2 rascunhos opostos + 1 juiz, só na decisão central      | Judge panel mínimo. Posturas diferentes trazem diversidade real, e heterogeneidade é o "universal antidote" do debate ([mad2]).                                                                                                                                            |
| Plan gate opcional + gate humano no fim                             | O grafo não decide por você; ele produz evidência. Gate mais rígido para deploy, dados de produção e texto público (Greg Eisenberg).                                                                                                                                      |
| Nó de risco alto sempre no modelo da sessão                         | O teto de qualidade é o do nó principal ([cog2], "smart friend"). Opus como líder com Sonnet nos workers deu +90,2% sobre Opus sozinho em pesquisa ([ma]).                                                                                                               |

## Esqueleto de fases, esforço/teto, revisão do design, síntese — por quê

Rodada de 2026-09-28 (spec `docs/specs/2026-09-28-esforco-e-teto-de-agentes.md`), decidida com plan gate do
próprio graph-eng (run `20260928-0213-fases-esforco-teto`, `DR.md` na pasta da run). Cada subseção é uma
decisão do código, com o porquê.

### Esqueleto de fases obrigatório por modo, fim do atalho trivial

O planner escolhia livremente quantos nós usar, inclusive 1 nó para tarefa trivial. Isso deixava a
qualidade do grafo do tamanho do julgamento do planner naquela chamada — a mesma falha que a DESIGN.md já
registra em outro contexto ("unaware of termination", MAST). A correção é um **trilho no código**: cada
modo tem uma sequência de fases fixa (`implement`: Plano → Pesquisa → Design → Revisão do design →
Implementação → Revisão da implementação (verify por nó + crítica) → Síntese; `architecture` para antes da
Implementação; `research`/`review`: Plano → Pesquisa → Crítica → Síntese), e o motor normaliza o plano para
essa forma antes de rodar — não é uma sugestão que o planner pode ignorar. O piso de agentes por modo (ver
abaixo) é 1 agente por fase desse esqueleto, então mesmo o teto mais baixo aceito ainda cobre a sequência
inteira. Isso também fecha o atalho de 1 nó: não existe mais tarefa pequena o bastante para pular fase.

### `effort` × `ceiling`: fórmula, piso e por que arredondar

A pergunta "quantos agentes usar" tinha duas respostas incompatíveis: um preset fixo (`lean`/`balanced`/
`max`) e o julgamento do planner. Nenhuma delas dava ao usuário um dial simples. A fórmula
`alvo = max(piso(modo), round(pct(esforço) × teto))`, com `pct` 20/40/70/100% para `low/medium/high/max`,
dá um controle direto: o teto (`ceiling`, padrão de fábrica 24) é o gasto máximo aceitável, e o esforço é
"quanto desse máximo eu quero para esta run". O arredondamento é `Math.floor((pct·ceiling + 50) / 100)`
(inteiro, não `Math.round` de ponto flutuante) porque `0.7 × 24` em IEEE 754 dá `16.799999...`, e
`Math.round` nesse caso ainda funciona, mas a soma de meio ponto antes do `floor` deixa o comportamento
explícito e testável sem depender de arredondamento bancário do runtime. O piso por modo (`implement` 8,
`architecture` 6, `research`/`review` 4) é o mínimo do esqueleto de fases da seção anterior — um teto
menor que o piso do modo é inválido, não "vira o piso silenciosamente": a validação recusa (ver `validateCeiling`
abaixo), porque aceitar em silêncio esconderia do usuário que o teto pedido não cobre nem uma run vazia.
`economy` continua existindo, mas muda só o **modelo** de cada papel (Sonnet vs. sessão) — o teto de
agentes é assunto do `ceiling`, não do preset, para não haver dois controles competindo pelo mesmo efeito.

### `effort: 'manual'` sem humano → `auto`, com registro

A spec pede que o manual pergunte o nível a cada disparo. Mas a skill também pode ser chamada por outro
agente (subagente, workflow orquestrador), sem ninguém para responder um `AskUserQuestion`. Bloquear o
workflow esperando entrada que nunca chega é pior que decidir: a skill trata `manual` sem humano como
`auto` e grava `effortSource: 'manual-fallback'`, e o relatório final diz explicitamente que foi o Claude
quem decidiu o nível sozinho. Isso é decisão de skill (que sabe se há humano do outro lado), não do motor.

### `auto`: o planner escolhe e justifica, visível no plan gate

`effort: 'auto'` não é "usa o padrão calado": o planner recebe o alvo calculado a partir do teto e da
dificuldade percebida da tarefa, e grava a justificativa no plano (`plan.effort.why`). O plan gate
mostra essa linha antes do usuário aprovar — decisão de dimensionamento também é decisão que se aprova, não
só a lista de nós.

### Plano acima do máximo de nós: no `auto` o nível sobe, com nível fixo o corte preserva o esqueleto

O schema do planner usa o máximo de nós do pior caso (`max`) quando o esforço é `auto`, porque o nível só
existe depois do plano. Então o plano pode vir maior que o máximo do nível que o próprio planner escolheu.
Cortar aí tira quase sempre implementação, que é folha do grafo: a run pesquisaria, desenharia e não
entregaria. No `auto`, quem dimensiona é o planner, e um plano grande diz que a tarefa é maior do que o
nível declarado. Por isso o motor sobe o nível até o plano caber, nunca acima do teto, e registra a subida
no trilho `effort` e na justificativa. O corte fica para quando o usuário fixou o nível (a escolha dele
manda) ou quando nem o `max` comporta o plano. Nesse caso, ele nunca esvazia um tipo obrigatório do
esqueleto (pesquisa sempre, design em `implement`/`architecture`, implementação em `implement`) e reaplica
os trilhos depois de cortar.

### `maxAgents` como sinônimo de `ceiling`, `economy` só de modelo

Dois nomes para o mesmo campo (`ceiling`/`maxAgents`) evitam que quem já conhecia a API antiga (`maxAgents`)
precise migrar; o CLI (`bin/graph-config.mjs`) resolve o conflito com `--ceiling` vencendo se os dois vierem
juntos, e avisa em `warnings`. `economy` perde o papel de teto que tinha nos presets antigos e passa a
escolher só o modelo de cada papel — dois campos, uma responsabilidade cada.

### Config em arquivo, CLI separado do graph-watch, PUT que substitui

A config mora em `~/.claude/graph-eng/config.json` porque é preferência de máquina, não de run: sobrevive
entre invocações da skill e entre plugins. `bin/config.mjs` faz leitura tolerante (arquivo ilegível ou
campo inválido nunca derruba a skill nem o painel — vira aviso e o campo volta ao padrão) e gravação atômica
(`tmp` com `wx`+`0o600`, depois `rename`, para que uma leitura concorrente nunca veja um arquivo pela
metade). A skill lê a config por um binário próprio, `bin/graph-config.mjs --json`, e não por
`bin/graph-watch.mjs`, porque o workflow não tem acesso a disco (não importa Node API) — é a skill, do lado
de fora, que resolve a config e passa os valores como argumentos. Manter isso fora de `graph-watch.mjs` evita
que o CLI de visualização (que já cresce a cada fase nova) dispute responsabilidade com o de config. O
`PUT /api/config` **substitui** o arquivo inteiro (chave ausente no corpo volta ao padrão) em vez de fazer
merge parcial, porque um merge implícito escondida do usuário do modal qual campo realmente mudou depois de
uma edição anterior malformada.

### `Origin` obrigatório na escrita, sem CORS

A única rota de escrita do painel (`PUT /api/config`) exige `Origin: http://<Host>` e recusa `Origin`
ausente ou `null`. Não há cabeçalho `Access-Control-Allow-*`: o painel é servido e consumido do mesmo
`127.0.0.1:<porta>`, então CORS cross-origin não é um caso de uso, e adicioná-lo só abriria a rota de
escrita a outra origem sem necessidade. Sem CORS, um `PUT` cross-origin com `application/json` dispara
preflight `OPTIONS`, que o servidor responde 405 — a exigência de `Origin` é a segunda barreira, para o caso
de o cliente não seguir o preflight.

### Teto abaixo do piso do modo: recusado com "mínimo N", sem salvar

Resposta do plan gate desta run: pedir um `ceiling` menor que o piso é erro de validação, não "arredonda
para o piso". `validateCeiling` devolve `{ ok: false, error: 'mínimo N' }`, o modal mostra a mensagem no
campo e **não grava**. Silenciosamente subir o valor escondia do usuário que o número que ele digitou não
fazia sentido para aquele modo; recusar com a mensagem exata deixa claro por quê. O N depende de onde se
valida: o CLI com `--mode` e o motor usam o piso do modo; o modal e o arquivo, que não sabem o modo da
próxima run, usam 8 (ver "Piso global 8" abaixo).

### Revisão do design como fase do motor, não nó do planner

O planner podia, em tese, decidir não revisar o design. A spec pede o oposto: revisão do design é
obrigatória antes de implementar, e design reprovado bloqueia a implementação. Por isso a revisão do
design é uma **fase do motor** (como o plan gate e o critic), com reparo (até `maxRepairs`, escalando de
modelo no último) e reprovação que marca os nós de implementação como `skipped`/`blocked` — o motor decide
isso, o planner só fornece os nós de design a revisar. Tratar como fase, e não como nó comum do DAG,
também é o que permite ao motor reservar `canSpend` para a revisão e o reparo antes do fan-out de
implementação (senão um nó `work` concorrente podia gastar o orçamento que a revisão precisava).

### Ids reservados (`research-base`, `design-base`, `design-review:rN`, `polish:<k>`) em vez de `kind` novo

Nó injetado pelo motor (pesquisa de base que faltou, polidor da síntese) não é um `kind` novo no vocabulário
do planner: é um id com prefixo reservado, marcado com `injected: true` e o motivo (`reason`) gravado no
plano. Isso mantém o conjunto de `kind`s pequeno (research/design/implement) e deixa o graph-watch
reconhecer o nó pela forma do id, sem precisar de outro caminho de renderização por `kind`.

### Verificação cruzada + lente de boas práticas

Toda implementação é verificada por **outro** agente — nunca quem escreveu, pela mesma razão de
self-preference bias já documentada na tabela acima (Panickssery 2024). A novidade desta rodada é a
**lente de boas práticas**, aplicada tanto no verify quanto na crítica do round: além de "resolve o
`doneWhen`?", o revisor também confere padrões do repo (convenções, testes não apagados, escopo). Isso
absorve parte do que antes só o critic pegava no fim do round, encurtando o ciclo de reparo.

### Implementação em paralelo por arquivos disjuntos

Nós `implement` cujos arquivos não se sobrepõem (`n.files` do plano, ou o escopo que a revisão do design
autorizar) rodam em paralelo — a regra "escrita em raia única" da tabela de evidências continua valendo
por arquivo, não por run inteira: dois agentes escrevendo arquivos diferentes não competem por lock de
verify, e o motor reserva o slot de verify de cada um antes de liberar o `work` concorrente (para o
orçamento de um não roubar o do outro).

Arquivos disjuntos não bastam: a árvore é uma só e nada da run está commitado. Por isso todo agente
recebe no prefixo a proibição de `stash`, `reset`, `checkout`, `restore` e `clean`, e a linha de base
se mede num `git worktree add --detach <tmp> HEAD`. A pilha de stash também é uma só, compartilhada por
todos os worktrees do repo, então usar stash dentro do worktree descartável também não é seguro. Foi
o que aconteceu na run `20260928-1146-acoes-no-painel`. Um executor fez stash e pop no repo para medir
a linha de base, e o verificador de outro nó fez o mesmo no worktree dele. Os dois pops trocaram as
entradas da pilha: o trabalho de 3 nós foi parar no worktree do verificador, e o repo ficou só com
os 3 arquivos do outro nó.

### Síntese: `ceil(2/3 × implement)` polidores + 1 consolidador

Vários nós `implement` em paralelo podem gerar inconsistência de estilo/interface entre arquivos que não
se viam uns aos outros durante a escrita. Em vez de 1 polidor por implementação (caro) ou nenhum (risco de costura visível), o
número de polidores é proporcional — dois terços do número de implementações, arredondado para cima, mínimo
1 — e cada polidor cobre uma **área** (grupo de arquivos por proximidade, via union-find, não 1 arquivo por
polidor). O consolidador é sempre 1, mesmo com 1 só implementação ou em `research`/`review` (que não têm
polidor, porque não há código para polir): alguém precisa fechar o `REPORT.md` e decidir se reverter uma
mudança de um polidor que quebrou um check.

### Piso global 8 no config e no modal, sem depender do modo

`bin/config.mjs` valida `ceiling` contra um piso fixo de 8 (`ceiling: { min: floorOf() }`, sem argumento),
não contra o piso do modo daquela run (`floorOf('implement')` = 8, `floorOf('architecture')` = 6,
`floorOf('research'|'review')` = 4). O arquivo de config e o modal são de máquina, não de run: eles não
sabem em que modo a próxima invocação vai rodar, e `implement` é o maior piso dos quatro — validar contra
o menor piso possível deixaria passar um `ceiling` que travaria de cara numa run `implement`. Quem valida
contra o piso exato do modo é o CLI (`bin/graph-config.mjs --mode <mode>`) e o motor, no momento em que o
modo já é conhecido; o config genérico só recusa o que seria inválido em qualquer modo.

### `polish-<k>` na API e na URL, com hífen em vez de `:`

O polidor da síntese é `polish:<k>` no vocabulário interno do motor (mesmo padrão de `design-review:rN`),
mas a API do painel (`/agent/<id>` e a URL do link do nó) usa `polish-<k>`, com hífen. O motivo é
`NODE_RE`/o roteamento de path do `ui-server.mjs`, que não aceita `:` num segmento de path sem escapar —
manter `:` na API forçaria URL-encoding em todo lugar que monta o link. `POLISH_API_RE` (`bin/ui-server.mjs`)
faz a tradução hífen→`:` só na borda HTTP; o resto do motor e do journal continua usando `:`.

### `graph-watch` reaplica os trilhos, não confia só no plano gravado

`bin/graph-watch.mjs` roda `applyRails()` (cópia pura das mesmas regras R1-R6 do motor) sobre os nós que lê
do journal, em vez de desenhar as fases só a partir do que o plano gravou. Isso importa porque o
`graph-watch` também precisa renderizar runs em progresso, cujo journal ainda não tem todos os nós
injetados (revisão do design, polidores) que o motor só grava conforme o round avança — sem reaplicar os
trilhos, o painel mostraria uma run parcial como se o esqueleto de fases dela fosse diferente do que vai
ser no final. Reaplicar é também o que deixa o `graph-watch` continuar funcionando como ferramenta só de
leitura: ele nunca precisa reabrir o plano bruto para saber em que fase um nó está.

### `architecture` sem implementação

A spec e a `DR.md` corrigiram um bug de fronteira: um nó `implement` do planner, em modo `architecture`,
rodaria de qualquer forma, porque o motor só convertia `implement→design` em modo `research`/`review`
(`READ_ONLY`). A correção calcula o modo real (`RMODE`) sobre o plano cru, antes de normalizar, e o
`normalize` converte `implement→design` sempre que `RMODE !== 'implement'` — architecture produz decisão
(ADR), nunca código.

## Painel com ações sobre a run (0.5.0)

Até a 0.4.0 o painel (`bin/ui-server.mjs` + `bin/ui/`) só lia arquivo, com a única exceção do
`PUT /api/config`. A 0.5.0 (spec `docs/specs/2026-09-28-acoes-no-painel.md`) deixa o painel retomar
uma run parada, parar uma run, refazer um nó, copiar o comando pronto e ver os artefatos — e organiza
a lista lateral como no Claude Code. As decisões abaixo resumem o porquê; o detalhe contratual (formato
de cada arquivo, máquina de estados, regex) está na spec.

### Canal por fila em arquivo, nunca chamada direta

O Workflow roda dentro da sessão do Claude Code, sem filesystem nem API do Node, e `resumeFromRunId` só
vale na mesma sessão (doc da tool Workflow). O painel é outro processo e não tem como controlar o
workflow. Por isso o painel **pede** — grava um pedido (`resume`, `stop` ou `rerun-node`) numa fila em
arquivo, gravação atômica, com o mesmo padrão tmp+rename de `bin/config.mjs` — e a sessão **executa**,
lendo a fila pelo `graph-watch events` que a skill já deixa rodando no Monitor
(`skills/graph-eng/SKILL.md:219-226`). Cada linha do `events` vira um evento para o Claude (doc da tool
Monitor), e é por isso que o pedido chega sem polling do lado da sessão.

### Quem atende cada pedido: por projeto, exceto `stop`

`resume` e `rerun-node` vão para a primeira sessão ouvindo **no mesmo projeto** (slug do cwd) que aceitar
o pedido — o motor retomável (abaixo) dispensa `resumeFromRunId`, então qualquer sessão do projeto serve
igual. `stop` só vai para a **sessão dona** da run, porque só ela pode chamar `TaskStop(task_id)` sobre a
própria task (doc da tool Monitor: `TaskStop` só alcança task da própria sessão). Exceção de segurança: se
a run está `parada` mas o motivo não é "interrompida" e a dona ainda está ouvindo, `resume`/`rerun-node`
também vão só para a dona — porque "parada" pode ser falso positivo (ver abaixo) e disparar um 2º
Workflow sobre um 1º ainda vivo duplicaria a execução; só a dona sabe parar o 1º antes de disparar o novo.

### Detecção de parada com motivo, não só um `idleSec`

O `"parada?"` de hoje mede o mtime do journal (`idleSec>600` em `graph-watch.mjs:584`), que só muda
quando um agente começa ou termina — uma run saudável pode ficar 700s+ entre duas linhas sem estar morta.
`computeStop()` passa a decidir por N minutos sem escrita no histórico do agente **em execução** (padrão
5, configurável), ou sessão encerrada, ou orçamento esgotado, e devolve o motivo junto ("sem atividade há
X min", "sessão encerrada", "orçamento esgotado") — o painel mostra o motivo, não só o selo. A linha
"agora" (`buildNowBlock`) passou a contar também os pseudo-agentes `critic` e `synth`, que antes
desapareciam da run corrente por não terem `kind` de nó comum.

### Motor retomável por args, não por `resumeFromRunId`

`workflows/graph-eng.js` passa a aceitar, pelos args, os nós já prontos (`args.resume.done`) e os que
devem ser refeitos (com a opção de arrastar os dependentes). Um nó pronto que não está na lista de refazer
não gera agente nenhum — o motor popula `RESULTS` com o resultado gravado, sem chamar `agent()`. É o que
faz a retomada por outra sessão funcionar (P1 acima): o estado necessário vem nos args, não de um
`resumeFromRunId` amarrado à sessão original. Os trilhos, o esforço e o teto continuam valendo, e o teto
conta só os agentes que ainda vão rodar — sem isso, uma retomada de uma run de 42 nós com 35 prontos
cortaria nós já prontos do plano em vez de ignorá-los (ver "Trilho `maxNodes` na retomada" abaixo).

### Trilho `maxNodes` na retomada: nó pronto não conta contra o teto

A classificação de nós prontos passa a rodar **antes** do corte pelo teto de nós, e o corte ganha uma
lista de ids protegidos que nunca é cortada e não conta contra o teto — o teto vale só sobre os nós
pendentes. Sem essa ordem, uma retomada com muitos nós prontos e poucos pendentes podia estourar o teto
por causa de nós que já não iam gerar agente nenhum, cortando exatamente o nó que faltava refazer.

### Artefatos da run, só leitura, sem sair do diretório da run

A gaveta do painel lê o `REPORT.md`, o plano e a saída de cada nó direto de `.graph-runs/<run>/`. Cada
caminho pedido é resolvido e conferido contra o diretório da run antes de servir (mesma lógica de
contenção que `bin/organize.mjs` usa para apagar), porque o runId e o id do nó vêm de fora, validados só
pela regex — sem essa checagem, um id malicioso poderia ler qualquer arquivo do disco que o processo
enxergasse.

### Organização da lista como no Claude Code: um lugar só por run

Fixar, agrupar, arquivar e apagar seguem o mesmo padrão do sidebar do Claude Code: fixadas no topo,
grupos do usuário, depois as seções por estado. Uma run fica **num lugar só** — fixada vence grupo, e
grupo vence as seções de estado — porque múltiplos lugares tornariam a lista ambígua sobre onde clicar
para agir sobre aquela run. Apagar um grupo devolve as runs dele para a seção do estado delas, em vez de
apagar as runs junto: o grupo é só organização, nunca dono do ciclo de vida da run.

A chave de organização é o **runId**, não o `wf`, porque uma run retomada nasce com outro `wf` e a
organização (fixada, grupo, arquivada) precisa sobreviver à retomada — do contrário, retomar uma run
fixada a "perderia" da seção Fixadas.

### Finalizadas recolhida por padrão, e toda seção é accordion

Finalizadas normalmente é a seção mais longa e a menos acionável — por isso começa fechada, com a
contagem no cabeçalho, como o "Ungrouped" fechado do sidebar de referência do Claude Code (item 12 do
pedido). A mesma mecânica de accordion (seta `⌄`/`›`, `aria-expanded`, estado lembrado no navegador) vale
para todas as seções — Fixadas, cada grupo, Em andamento, Paradas e Finalizadas —, não só Finalizadas,
porque um usuário com muitos grupos precisa poder fechar qualquer um deles, não só o balde de
finalizadas.

### Paradas fora de "Em andamento", numa seção própria

Uma run com o selo "parada?" listada dentro de "Em andamento" mistura o que está progredindo com o que
morreu — e o selo de hoje é falso positivo com frequência (seção anterior), então misturar as duas
esconde tanto runs saudáveis quanto runs mortas dentro do mesmo grupo. Runs paradas (pelo `computeStop`
com motivo) saem de "Em andamento" e ganham seção própria entre "Em andamento" e "Finalizadas". Uma run
`planOnly` — só o planner rodou e nunca vai rodar mais nada — não conta como parada: ou é o plano de uma
run real de mesmo runId (soma nela), ou conta como terminada, nunca como "parada" à espera de continuar.

### Apagar exige o nome digitado, e nunca toca `~/.claude/projects`

Apagar uma run remove só `.graph-runs/<run>/` — nunca os históricos de agente em `~/.claude/projects`,
que pertencem à sessão do Claude Code, não ao plugin. A confirmação pede o nome da run digitado (padrão
já usado em ações destrutivas de outros produtos), porque um clique duplo acidental num botão de lista
apaga trabalho que não tem desfazer.

### Motivo de cada nó, tirado só dos arquivos da run

Um nó que não terminou verificado (`pulado`, `falhou`, `falhou (check)`, `bloqueado`, `sem
reverificação`) ganha um motivo — mas o motivo nunca é inventado nem resumido por heurística: sai direto
do journal, do veredito do verificador ou da revisão do design daquela run, na mesma ordem que o motor
decide `closed(id)`. Estados saudáveis ou esperados (rodando, verificando, reparando, aguardando) ficam
sem motivo, porque motivo é para quando algo não fechou como devia, não para narrar o fluxo normal. O
motivo aparece em quatro lugares — `title`/`aria-label` da bolinha no grafo, a gaveta de detalhe do nó, a
linha de marco final do `graph-watch events` e o bloco `motivos:` do `graph-watch snapshot` — porque são
as quatro formas de olhar a run (painel, terminal ao vivo, terminal em foto) e nenhuma delas devia exigir
abrir o journal a mão para saber por que um nó não passou.

### Favicon com PNG, porque SVG não roda em todo navegador

O painel tinha só `favicon.svg`, e o Safari (desktop e iOS) não renderiza favicon SVG — a aba fica sem
ícone. `/favicon.ico` também respondia 204 vazio, então nem o fallback padrão do navegador achava nada.
A correção é gerar, uma vez e versionar, `favicon-32.png` (32×32, o tamanho que a maioria dos navegadores
pede) e `apple-touch-icon.png` (ícone ao adicionar a página à tela de início), a partir do mesmo SVG do
logo do cabeçalho (`bin/ui/index.html:15`) — sem depender de biblioteca de conversão em runtime, já que o
plugin não tem `npm install` na instalação. `/favicon.ico` passa a devolver o PNG de 32px em vez do 204:
não existe um `.ico` de verdade, mas todo navegador que bate nesse caminho aceita um PNG na resposta.

### Resumo compacto das bolinhas na lista, acima de X nós

A linha de cada run na lateral mostrava uma bolinha por nó do grafo, igual ao grafo grande — e numa run
com muitos nós (o teto de hoje chega a 50) a fileira quebrava em 2 ou 3 linhas, desalinhando a lista
inteira (print `ref-bolinhas-lista.png`, no run dir desta run). Acima de `STRIP_MAX` nós (`bin/ui/
sidebar.mjs`, hoje 10 — escolhido por ser a maior contagem que ainda cabe numa linha sem quebrar nas
larguras testadas), a linha troca a fileira de bolinhas por um resumo por estado: uma bolinha com a
contagem de nós com erro, rodando e concluídos. O texto por extenso continua indo para `title` e
`aria-label`, porque o resumo visual comprime a informação, não a esconde de quem usa leitor de tela ou
passa o mouse.

## Spec: quanto escrever antes do grafo

A pergunta é sobre quem é dono do quê, e não "spec ou não spec". **O humano é dono do "o quê"** (objetivo,
aceite, limites) e **o grafo é dono do "como"** (decomposição, pesquisa, implementação).

- **Contra spec pesada:** Spec Kit contra iterativo deu 33 min de agente + 3,5 h de review + 1 bug, contra
  8 min + 15 min + 0 bugs ([Scott Logic][scottlogic]). O Kiro transformou um bug em 16 critérios de aceite
  ([Böckeler/Thoughtworks][bockeler]). O Radar da Thoughtworks mantém SDD em *Assess*.
- **A favor de definir bem o "o quê":** a clarificação é medida ([ambig]). Em run autônomo longo, o
  planner+generator+evaluator funcionou onde o solo falhou ([harness]). "Uma linha ruim de plano vira
  centenas de linhas ruins" ([HumanLayer][humanlayer]).
- **Ponto de equilíbrio:** spec leve de 10-40 linhas, revisão humana de ~1 página de plano e não de mil
  linhas ([QRSPI][qrspi]), com a verificação executável como verdade ("the test suite passes or it
  doesn't"). Nenhum estudo controlado compara uma rodada com duas; a regra da SKILL.md vem da convergência
  entre os relatos.

## Quando NÃO usar

- **Tarefa de um passo:** o grafo só adiciona custo.
- **Trabalho fortemente sequencial com muito contexto compartilhado,** como debugar um fluxo:
  "most coding tasks involve fewer truly parallelizable tasks than research" ([ma]). Faça direto na
  sessão, ou use `economy: 'lean'`, que o planner vai montar uma cadeia curta.

## Fontes

[ma]: https://www.anthropic.com/engineering/multi-agent-research-system
[bea]: https://www.anthropic.com/engineering/building-effective-agents
[ce]: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
[bp]: https://code.claude.com/docs/en/best-practices
[team]: https://code.claude.com/docs/en/agent-teams
[cache]: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
[cog1]: https://cognition.com/blog/dont-build-multi-agents
[cog2]: https://cognition.com/blog/multi-agents-working
[gdm]: https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/
[mast]: https://arxiv.org/abs/2503.13657
[agentless]: https://arxiv.org/abs/2407.01489
[snell]: https://arxiv.org/abs/2408.03314
[adacons]: https://arxiv.org/abs/2305.11860
[esc]: https://arxiv.org/abs/2401.10480
[dov]: https://arxiv.org/abs/2508.17536
[mad]: https://arxiv.org/abs/2311.17371
[mad2]: https://arxiv.org/abs/2502.08788
[frugal]: https://arxiv.org/abs/2305.05176
[routellm]: https://arxiv.org/abs/2406.18665
[toe]: https://arxiv.org/abs/2407.18370
[cobbe]: https://arxiv.org/abs/2110.14168
[selfpref]: https://arxiv.org/abs/2404.13076
[huang]: https://arxiv.org/abs/2310.01798
[tyen]: https://arxiv.org/abs/2311.08516
[critic]: https://arxiv.org/abs/2305.11738
[selfrefine]: https://arxiv.org/abs/2303.17651
[reflexion]: https://arxiv.org/abs/2303.11366
[agentprune]: https://arxiv.org/abs/2410.02506
[osmani]: https://addyosmani.com/blog/practical-loop-engineering/
[xiang]: https://arxiv.org/abs/2607.21656
[advisor]: https://claude.com/blog/the-advisor-strategy
[spotify3]: https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3
[stripe]: https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2
[beck]: https://newsletter.kentbeck.com/p/augmented-coding-beyond-the-vibes
[ambig]: https://arxiv.org/abs/2502.13069
[harness]: https://www.anthropic.com/engineering/harness-design-long-running-apps
[i66023]: https://github.com/anthropics/claude-code/issues/66023
[hn-tier]: https://news.ycombinator.com/item?id=47462539
[hn-small]: https://news.ycombinator.com/item?id=48990505
[hn-oracle]: https://news.ycombinator.com/item?id=48312316
[scottlogic]: https://blog.scottlogic.com/2025/11/26/putting-spec-kit-through-its-paces-radical-idea-or-reinvented-waterfall.html
[bockeler]: https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html
[humanlayer]: https://www.humanlayer.dev/blog/advanced-context-engineering
[qrspi]: https://alexlavaee.me/blog/from-rpi-to-qrspi/

- LangChain, *3 Years of Graph Engineering with LangGraph* (jul/2026): https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph
- Transcrições de origem: *Graph Engineering explained in 8min* e *Why Graph Engineering will 10x your Claude/Codex* (Greg Eisenberg).
