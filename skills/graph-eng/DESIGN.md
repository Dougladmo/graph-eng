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
