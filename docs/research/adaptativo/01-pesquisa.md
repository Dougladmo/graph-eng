# Brief de pesquisa: graph-eng adaptativo

Escopo: redesenhar o graph-eng para escolher o caminho conforme a complexidade da tarefa. Cada achado traz a confiança da fonte (alta, média ou baixa). Dados de n=1 e os benchmarks internos (chess 15/15, faturamento 31/31, 18-20 chamadas contra 1-2, uma chamada do executor com 624k tokens de entrada) são indicativos, não conclusivos.

## 1) Principais achados com fonte

**Orientação de primeira mão (confiança alta)**
- Comece pela solução mais simples e só adicione complexidade quando ela melhorar o resultado de forma demonstrável. Roteamento, paralelização e evaluator-optimizer são os primitivos recomendados. Agentes de código devem receber verdade do ambiente (testes e execução). https://www.anthropic.com/engineering/building-effective-agents
- Multi-agente custa cerca de 15x os tokens de um chat, e um agente cerca de 4x. O uso de tokens explicou 80% da variância no BrowseComp. A Anthropic embutiu regras de escala de esforço no prompt do líder: 1 agente com 3-10 chamadas para fatos simples, 2-4 subagentes para comparações e 10+ para pesquisa complexa. As primeiras versões criavam 50 subagentes para consultas simples. Código é citado como caso ruim para multi-agente. https://www.anthropic.com/engineering/multi-agent-research-system
- Cognition: ações carregam decisões implícitas, então subagentes paralelos tomam premissas conflitantes. A recomendação é um agente linear único. É opinião, sem benchmark (confiança média a alta). https://cognition.com/blog/dont-build-multi-agents
- Documentação do Claude Code:
  - Subagentes servem para isolar saída volumosa. Um subagente novo precisa reler o contexto, então tarefas pequenas ficam no agente principal. https://code.claude.com/docs/en/sub-agents
  - O plan mode é opcional, e a regra prática é pular o plano se o diff cabe em uma frase. Verificação executável vem antes de planejar. O revisor independente deve sinalizar só lacunas de correção ou de requisito, porque um revisor pedido para achar lacunas sempre acha. https://code.claude.com/docs/en/best-practices
  - Há mapeamento de modelo e esforço por tarefa, e o `opusplan` é plano forte com execução barata. https://code.claude.com/docs/en/model-config
- Esforço (confiança alta):
  - É um sinal comportamental, não um orçamento rígido. Haiku 5.5 em esforço baixo tende a pular busca ou verificação. https://platform.claude.com/docs/en/build-with-claude/effort
  - Mudar o esforço entre requisições invalida o cache. Pedir no prompt "pense menos" não é confiável. https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost

**Roteamento e cascata**
- RouteLLM: um roteador prediz a probabilidade de o modelo forte vencer e escala se ela for >= alfa. O melhor roteador chega a 95% da qualidade do GPT-4 com cerca de 13,4% de chamadas ao modelo forte no MT-Bench. A economia varia muito: 3,66x no MT-Bench, 1,41x no MMLU e 1,49x no GSM8K. O overhead do roteador é <=0,4%. https://arxiv.org/html/2406.18665v4 (ICLR 2025: https://proceedings.iclr.cc/paper_files/paper/2025/hash/5503a7c69d48a2f86fc00b3dc09de686-Abstract-Conference.html)
- FrugalGPT: a cascata fraco para forte pode igualar o GPT-4 com até 98% menos custo. Esse é o melhor caso, em QA fácil. Os detalhes do scorer não foram extraídos (confiança média). https://arxiv.org/abs/2305.05176
- AutoMix: autoverificação do modelo pequeno mais roteador POMDP, com mais de 50% de redução de custo. Só o abstract foi lido (confiança média). https://arxiv.org/abs/2310.12963
- SWE-Router: roteadores que olham só o texto da tarefa ficam perto do acaso, e os baseados em trajetória parcial (K=1-4 turnos baratos) ficam melhores (Route-AUC no §3). https://arxiv.org/html/2607.00053 (abstract: https://arxiv.org/abs/2607.00053)
- Scrouting: um explorador barato de 7B escreve um handoff estruturado. A cobertura foi 159/266 contra 158/266 do melhor modelo único, por cerca de um quinto do custo. O handoff, e não o roteador, explica a maior parte do ganho (N=99 de calibração, confiança média). https://arxiv.org/abs/2608.04804 (PDF: https://arxiv.org/pdf/2608.04804)
- Applied Compute: um roteador treinado fica em cerca de 0,76, contra 0,834 do Opus sempre e 0,890 do oráculo. É blog de fornecedor (confiança média). https://www.appliedcompute.com/research/agentic-model-router
- LiteLLM: roteamento por fase em 12 tarefas do SWE-bench Verified, com 46% de economia nas 9 resolvidas por ambos (n pequeno). A exploração ficou com 73% dos turnos e US$0,14 de custo. A implementação ficou com 14% dos turnos e US$2,56. https://docs.litellm.ai/blog/subtask-type-routing
- LLMRouterBench: vários roteadores, incluindo o comercial OpenRouter, não superam o melhor modelo único. https://arxiv.org/html/2601.07206 ; https://arxiv.org/html/2403.12031v2 (RouterBench, só por snippet)

**Custo de cerimônia e multi-agente**
- Estudo de custo de agentes de código: controle de esforço sozinho cortou 74,7% do custo com sucesso 15/15. Prompts de múltiplas abordagens elevaram os tokens de raciocínio em 2,4-7,4x sem benefício. Verificação redundante custou 1,48x a 18,25x sem gradiente de sucesso. Um prompt de "parar cedo" falhou em 3/5 testes ocultos com spec ambígua (confiança média). https://arxiv.org/html/2608.01347
- Escala de sistemas de agentes (Google/DeepMind/MIT): todas as variantes multi-agente perderam 39-70% na planificação sequencial (PlanCraft). Há ponto de virada perto de 45% de acurácia do agente único. Overhead de coordenação de 58% a 515%, e amplificação de erro de 17,2x (independente) contra 4,4x (centralizado). Os limiares são do estudo, não universais (confiança média a alta). https://arxiv.org/html/2512.08296v1 ; https://arxiv.org/abs/2512.08296 ; https://huggingface.co/papers/2512.08296 ; https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/
- MAST: 14 modos de falha em 3 categorias. Verificação e terminação somam cerca de 24%, e design de sistema cerca de 44%. Um verificador raso não ajuda, e adicionar verificação de objetivo de alto nível no ChatDev deu +15,6% (confiança média a alta). https://arxiv.org/abs/2503.13657 ; https://arxiv.org/html/2503.13657 ; https://arxiv.org/html/2503.13657v3 ; https://arxiv.org/abs/2503.13657v2 ; https://arxiv.org/html/2503.13657v1
- Agentless: pipeline fixo de localização, reparo e validação, com 32,00% no SWE-bench Lite. Uma fonte diz US$0,70 por issue e outra não confirma a unidade do custo, então trate-o como não confirmado. https://arxiv.org/abs/2407.01489
- Autocorreção intrínseca sem feedback externo não melhora e pode piorar (confiança média). https://arxiv.org/abs/2310.01798
- LLM-as-judge tem viés de posição, verbosidade e autopreferência, em dados de chat com modelos antigos (confiança média). https://arxiv.org/abs/2306.05685
- Amostragem repetida só rende com verificador confiável (confiança baixa). https://scalingintelligence.stanford.edu/blogs/monkeys
- Outros trabalhos lidos só pelo abstract:
  - SWE-agent: https://arxiv.org/abs/2405.15793
  - OpenHands: https://arxiv.org/abs/2407.16741 (confiança baixa)
  - MetaGPT: https://arxiv.org/abs/2308.00352
  - ChatDev: https://arxiv.org/abs/2307.07924

**Grafo adaptativo (formato do DAG por tarefa)**
- MaAS: usa 6% a 45% do custo de sistemas multi-agente existentes, com +0,54% a +11,82% de desempenho (confiança média). https://arxiv.org/abs/2502.04180
- AgentPrune: 28,1% a 72,8% menos tokens (confiança média). https://arxiv.org/abs/2410.02506
- G-Designer, ARG-Designer e AgentConductor (snippets, confiança média): https://icml.cc/virtual/2025/poster/45567 ; https://arxiv.org/html/2507.18224v4 ; https://www.alphaxiv.org/abs/2602.17100
- AFlow: busca de workflow offline por família de tarefas, e o abstract não diz se é por consulta (confiança média). https://arxiv.org/abs/2410.10762 ; https://proceedings.iclr.cc/paper_files/paper/2025/hash/5492ecbce4439401798dcd2c90be94cd-Abstract-Conference.html
- GPTSwarm: https://arxiv.org/html/2402.16823v3 ; https://proceedings.mlr.press/v235/zhuge24a.html
- Graph of Thoughts (ganho em tarefa sintética de ordenação): https://arxiv.org/pdf/2308.09687
- Aider (arquiteto/editor): o ganho foi de 79,7% para 85,0% com o2-preview em 2024. O ganho encolheu com modelos mais fortes, e a segunda fonte foi vista só em snippet. https://aider.chat/2024/09/26/architect.html ; https://aider.chat/2025/01/24/r1-sonnet.html
- Cursor, VS Code e Devin convergem em plano opcional e gatilhado por incerteza:
  - Cursor: https://cursor.com/blog/agent-best-practices
  - VS Code: https://code.visualstudio.com/docs/agents/planning
  - Devin: https://cognition.com/blog/devin-2 ; https://docs.devin.ai/essential-guidelines/instructing-devin-effectively
- GPT-5-Codex: 93,7% menos tokens nos 10% de turnos mais baratos e cerca de 2x de tempo nos 10% mais caros. O dado é de segunda mão (InfoQ), porque a página da OpenAI deu 403. https://www.infoq.com/news/2025/09/gpt-5-codex ; https://learn.chatgpt.com/docs/models
- Anthropic, Opus 4.5: com esforço médio iguala o Sonnet 4.5 com 76% menos tokens de saída (dados de SWE-bench Verified de geração antiga, direcionais). https://www.anthropic.com/news/claude-opus-4-5
- Fonte secundária sobre a Anthropic, só para contexto (confiança baixa): https://medium.com/accredian/building-effective-ai-agents-a-guide-from-anthropic-e66b533ff091
- Blog de terceiros sobre FrugalGPT e DistilBERT, não verificado: https://mohakchugh.is-a.dev/blog/llm-routing-cascade-inference-cost-quality-optimization

## 2) O que a evidência diz sobre fast path e pular etapas

**O que a evidência sustenta**
- A prática da indústria é plano opcional, ativado por incerteza, multi-arquivo ou código desconhecido. A heurística comum é "o diff cabe em uma frase". (Claude Code, Cursor, VS Code, Devin: URLs no §1.)
- Cerimônia extra (ramificação, revisão redundante, esforço máximo) costuma somar custo sem ganho de sucesso em tarefas bem especificadas. (https://arxiv.org/html/2608.01347)
- Com baseline de agente único forte, agentes extras deixam de compensar, especialmente em tarefas sequenciais e com muitas ferramentas, como edição de código. (https://arxiv.org/html/2512.08296v1)
- O que vale manter é verificação executável e objetiva, não mais revisores LLM. Testes são o principal fecho de ciclo. Um crítico independente com filtro de severidade é o complemento. (https://code.claude.com/docs/en/best-practices ; https://arxiv.org/html/2503.13657)
- O modelo forte rende mais onde há edição. Exploração e verificação são baratas. (https://docs.litellm.ai/blog/subtask-type-routing)
- Um scout barato com handoff estruturado é provavelmente a etapa de maior valor a manter. Ele eleva executores baratos. (https://arxiv.org/abs/2608.04804)

**O que a evidência NÃO sustenta**
- Nenhuma fonte mede o ganho marginal de revisão de plano ou de design em pipelines de código. A evidência é toda indireta.
- Não existe estudo controlado de quanto se economiza pulando planejamento em tarefas simples. Os números públicos são de esforço, tokens e multi-agente em geral, não de planejamento em agentes de código. Outras páginas de terceiros (claudelog, mindstudio, tenten) deram orçamentos de thinking conflitantes e foram descartadas.
- Pular etapas não é seguro sem verificação. Com "parar cedo" em spec ambígua houve 3/5 falhas de teste oculto. Isso é o análogo direto do falso DONE do faturamento.

**Consequências para o design:** pular plan-review e design-review só na fast path. Manter sempre uma checagem executável e um crítico enxuto. Tratar spec ambígua como sinal de escalonamento obrigatório. Fast path primeiro e escalar para o fluxo completo quando a checagem falha (padrão de cascata e de "reverter e replanejar" do Cursor).

## 3) Roteamento por complexidade (sinais, thresholds, taxa de erro)

**Não existe threshold validado publicado para "tarefa simples o bastante para pular planejamento".** Tudo abaixo precisa ser calibrado nos benchmarks do próprio graph-eng.

**Sinais com algum respaldo**
- Multi-arquivo ou multicamada: símbolo referenciado em mais de 2 arquivos, regra consumida em 2 ou mais camadas. Regras só entraram se superaram a taxa marginal do melhor modelo em 15 pontos percentuais ou mais (IC de Wilson) e passaram o corte ajustado por custo. (https://www.appliedcompute.com/research/agentic-model-router)
- Comportamento após um probe curto (K=1-4 turnos baratos): Route-AUC 0,69-0,78 contra 0,47-0,57 para texto apenas (chance 0,5). Exemplo: K=0 texto 0,627 contra K=2 0,780 (+15,3 pp). Quem escala paga os K turnos e reinicia o modelo forte do zero, então convém reaproveitar o contexto do probe. (https://arxiv.org/html/2607.00053)
- Ambiguidade de spec como gatilho duro. (https://arxiv.org/html/2608.01347)
- O que foi descartado como preditor: stack traces, enunciado longo, tarefas de doc ou build. Evitar heurísticas de comprimento de prompt. (Applied Compute, URL acima.)
- Candidatos sem fonte que os valide: número de arquivos tocados, presença de teste de aceitação ou oculto, domínio de risco (dinheiro, billing, migração, auth).

**Mecanismos de gate**
- Limiar sobre a probabilidade prevista (RouteLLM), exposto como knob calibrável. A economia depende do tipo de tarefa: 3,66x em chat fácil e cerca de 1,4x em raciocínio. (https://arxiv.org/html/2406.18665v4)
- Um classificador genérico sem dados do domínio fica perto do acaso: CPT(50%) de 45,0% no MMLU e 53,6% no GSM8K, contra cerca de 50% aleatório. Rótulos de domínio ajudam, e cerca de 1.500 rótulos de ouro já bastam no MMLU. Então usar o histórico de runs do próprio graph-eng como rótulo, ou regras estruturais primeiro.
- Escada de esforço por tier com teto de chamadas (precedente da Anthropic). (https://www.anthropic.com/engineering/multi-agent-research-system)
- Tiers como triplas (conjunto de fases, modelo, esforço). (https://code.claude.com/docs/en/model-config)

**Taxa de erro**
- Nenhuma taxa geral de roteamento errado é publicada para agentes de código. As proxies disponíveis são:
  - Lacuna para o oráculo: 0,76 do roteador treinado contra 0,890.
  - Em consultas com no máximo 3 modelos corretos (11,9% do teste), os roteadores acertam um modelo correto só 24,6% e 23,2% das vezes (Avengers e EmbedLLM). (https://arxiv.org/html/2601.07206)
  - Vários roteadores recentes, incluindo o OpenRouter comercial, não superam o melhor modelo único (PerfGain de -24,7% do OpenRouter).
- Conclusão de design: erros concentram-se nos casos difíceis raros, então é preciso detecção barata de falha depois (verificação e escalonamento), não previsão perfeita antes.
- Benchmarkar sempre contra o "melhor único" e contra o oráculo, não contra o graph-eng completo. Se o adaptativo não vence o agente único em custo com qualidade igual, não vale lançar.

## 4) Jev/Laya no OpenRouter

**Confirmado (confiança alta, salvo indicação)**
- Jev existe no OpenRouter e é da TypeSafe. É o primeiro modelo "System One": modelo de decisão estruturada, não LLM de chat. Recebe um estado e perguntas tipadas e devolve respostas tipadas com probabilidades, sem texto, raciocínio ou código. https://openrouter.ai/docs/guides/community/jev ; https://docs.typesafe.ai/concepts/system-one ; https://openrouter.ai/typesafe/jev-1.13
- IDs encontrados: `typesafe/jev-1.13`, `typesafe/jev-1.14`, `typesafe/jev-router` e o alias `~typesafe/jev-latest`. Não usar outros IDs. https://openrouter.ai/typesafe ; https://openrouter.ai/docs/guides/community/jev
- Preço do 1.13: US$0,042 por 1M tokens de entrada e US$0 de saída. A TypeSafe informa o mesmo para o 1.14. Não foi possível extrair o preço do 1.14 no OpenRouter (página 404 ou vazia). Uma classificação de cerca de 2k tokens custa cerca de US$0,00008. https://openrouter.ai/typesafe/jev-1.13/providers ; https://docs.typesafe.ai/models.md
- Contexto: o OpenRouter lista 262K. A TypeSafe diz 64k por requisição e 32k por pergunta por padrão. 262k exige o header `TypeSafe-Danger-Zone-Long-Context: true` e fica mais lento e menos preciso. Acima de cerca de 32.000 bytes cai no modo longo. Para gate, enviar só a tarefa e um resumo curto. https://openrouter.ai/typesafe/jev-1.13/providers ; https://docs.typesafe.ai/models.md ; https://openrouter.ai/docs/guides/community/jev
- Primitivos próprios, sem `response_format`/`json_schema` estilo OpenAI: `choice`, `noul` (probabilidade de sim), `score` (até 10 níveis) e `box` (imagens, só no 1.14). https://openrouter.ai/docs/guides/community/jev ; https://docs.typesafe.ai/api/system-one.md
- Endpoints no OpenRouter: `POST https://openrouter.ai/api/alpha/decisions` e `POST https://openrouter.ai/api/v1/systemone`, autenticados com a chave do OpenRouter (confiança média, caminho "alpha" pode mudar). Direto na TypeSafe: `POST https://api.typesafe.ai/v1/systemone`, com Bearer. IDs diretos: `jev-1.13.0`, `jev-1.14.0`, `jev-latest` (=1.13.0) e `jev-preview` (=1.14.0). https://docs.typesafe.ai/api/system-one.md ; https://docs.typesafe.ai/models.md
- Limitações do 1.13: lê instruções ao pé da letra, tende à primeira opção listada, perde acurácia com estado irrelevante, é fraco em contar, matemática, números e datas, e texto de direcionamento pode alterar respostas. https://docs.typesafe.ai/model-jaggedness/jev-1.13.md
- Datas: o 1.13 foi lançado em 17-18/set/2026 (as páginas divergem em um dia, confiança média). O 1.14 está disponível desde 14/out/2026 segundo a TypeSafe. https://openrouter.ai/typesafe/jev-1.13/providers ; https://docs.typesafe.ai/models.md
- Jev só classifica. Não planeja, não revisa e não codifica. Serve no máximo como gate de complexidade ou risco.

**Não confirmado**
- Latência e vazão: não há número de primeira mão. O único valor, 236-276 ms por pergunta, vem do artigo do criador do Laya (concorrente, confiança baixa). Precisa ser medido. https://mer.vin/news/laya-the-33ms-open-source-decision-model-beating-jev/
- Benchmarks: não há da TypeSafe. Os números de terceiros (0,727 em typed-decisions, 0,910 no AG News, 0,480 no DAIR Emotion, 0,870 no Banking77, erro de calibração 0,246) vêm do criador do Laya e são "direcionais" (confiança baixa). Não valem para o domínio de código.
- Os campos exatos de requisição de `choice`/`noul`/`score` no OpenRouter são inferidos da API direta da TypeSafe, porque o guia só mostra exemplo de `box`. Validar com uma chamada real.
- O que o `typesafe/jev-router` retorna por `/api/v1/chat/completions` e se serve a classificação: sem esquema encontrado.
- Taxa de acerto do Jev para complexidade de tarefa de código: desconhecida, sem track record.
- O catálogo ao vivo do OpenRouter não pôde ser consultado. Duas chamadas a `https://openrouter.ai/api/v1/models` retornaram uma lista de 10 itens, sem preços e com IDs estranhos, que não parece o catálogo real, então nada foi concluído a partir dela. Conferir localmente com `curl https://openrouter.ai/api/v1/models` e `grep` por jev, typesafe e laya.

**Laya: não parece existir no OpenRouter (confiança média)**
- Nenhuma página ou ID de Laya foi encontrada no OpenRouter. A busca só trouxe um produto diferente, o Layla. A ausência vem das listagens vistas, não de consulta ao catálogo completo.
- O Laya existe fora do OpenRouter: modelo de decisão de pesos abertos (Apache 2.0) da Convai Innovations, anunciado por volta de 20/set/2026, auto-hospedado via `pip install laya`, com pesos em Hugging Face. Números autodeclarados: cerca de 33 ms por pergunta em GPU T4 (p50 de 32,8 ms), 193-464 ms em CPU e erro de calibração de 0,081. https://mer.vin/news/laya-the-33ms-open-source-decision-model-beating-jev/ ; https://huggingface.co/app2610/laya ; https://openrouter.ai/docs/guides/community/jev ; https://benchlm.ai/hosts/openrouter
- Usá-lo exigiria auto-hospedar Python, o que combina mal com o engine Node sem dependências. Tratar como não disponível para este fim.

**Outros modelos de decisão** que o guia do Jev lista como usando a mesma Decisions API (mudando só o campo `model`). Confiança média, porque as páginas de `openai/gpt-6-luna-decisions` e `cloudflare/clef-flash` deram 404 e nenhum preço foi verificado. Não usar sem checar: `openai/gpt-6-luna-decisions`, `microsoft/microsoft-decision-1`, `perplexity/pplx-decider-v1.2`, `perplexity/pplx-decider-flash-v1.2`, `cloudflare/clef`, `cloudflare/clef-flash`, `cloudflare/clef-omni`, `inception/mercury-decide`, `liquid/d1`, `liquid/d1-ultra`, `upstage/solar-decide`, `upstage/solar-decide-flash`. https://openrouter.ai/docs/guides/community/jev

**Alternativa: LLM barato com `json_schema`.** Preços por 1M de tokens (entrada/saída) de um único agregador, datado de out/2026 (confiança média, e outro resultado divergiu no DeepSeek V4.1 Flash). Reverificar nas páginas do OpenRouter. https://benchlm.ai/hosts/openrouter
- mistralai/mistral-nemo: $0,029/$0,03
- google/gemma-3-4b-it: $0,04/$0,05
- inclusionai/ling-3.0-flash: $0,021/$0,063
- meta-llama/llama-3.1-8b-instruct: $0,05/$0,08
- openai/gpt-oss-20b: $0,018/$0,09
- openai/gpt-5-nano: $0,05/$0,40
- openai/gpt-4.1-nano: $0,10/$0,40
- google/gemini-2.5-flash-lite: $0,10/$0,40
- anthropic/claude-haiku-5.5: $0,10/$0,50
- google/gemini-3.1-flash-lite: $0,25/$1,50
- google/gemini-3.5-flash-lite: $0,30/$2,50

Latência só para DeepSeek V4 Flash (mediana 0,76 s, p95 2,59 s) e GLM-5.2 (mediana 1,20 s, p95 3,69 s). A chamada custaria bem menos de US$0,001 por tarefa. O suporte a structured output é por endpoint de provedor, e não foi verificado por modelo.

**API de chat do OpenRouter (Node, sem dependências, `fetch` basta; confiança alta)**
- `POST https://openrouter.ai/api/v1/chat/completions`, com `Authorization: Bearer <OPENROUTER_API_KEY>`. A resposta traz `usage.cost` em USD. https://openrouter.ai/docs/api-reference/chat-completion ; https://openrouter.ai/docs/api-reference/authentication
- `response_format` aceita `text`, `json_object`, `json_schema`, `grammar` e `python`. O suporte é por endpoint, e `provider: {require_parameters: true}` força endpoints compatíveis. Com `strict: true`, o schema exige `additionalProperties: false` e todas as propriedades obrigatórias. https://openrouter.ai/docs/guides/features/structured-outputs
- Erros: 400, 401, 402, 403, 408, 429, 502 e 503. Erros podem chegar com HTTP 200 no corpo. Não há parâmetro de timeout, então o cliente define o seu com `AbortSignal.timeout`. Fazer retry de 429 e 503 respeitando `Retry-After`. https://openrouter.ai/docs/api-reference/errors

## 5) Paralelismo e latência

- Ganho de tempo em pesquisa: até 90% em consultas complexas com 3-5 subagentes e 3+ ferramentas em paralelo. Subagentes escrevem em armazenamento externo e devolvem referências leves. O contexto limita a síntese, e o plano é salvo em memória antes do truncamento. https://www.anthropic.com/engineering/multi-agent-research-system
- Paralelismo serve a tarefas decomponíveis e leitura independente. Em código sequencial e acoplado, multi-agente perde (-39% a -70%), e coordenação custa 263% a 515% a mais. https://arxiv.org/html/2512.08296v1
- Fan-out do LangGraph (super-steps estilo Pregel):
  - Um nó com várias arestas, ou uma aresta condicional que devolve uma lista, roda os alvos em paralelo.
  - `Send` faz fan-out dinâmico, e escritas paralelas na mesma chave exigem reducers.
  - Há limite de recursão e `RemainingSteps` para rota de fallback.
  - https://docs.langchain.com/oss/python/langgraph/graph-api
- Execução especulativa lossless: cerca de 19,5% de tempo economizado no xadrez e cerca de 20% de speedup de ponta a ponta, com teto teórico perto de 50%. Só é seguro com efeitos reversíveis ou isolados. Exige worktree ou scratch para a implementação e gasta tokens extras quando erra. https://arxiv.org/html/2510.04371v1
- Trabalhos recentes só por snippet (confiança baixa): Dynamic Speculative Planning, PASTE, Speculative Macro Commit e um artigo de busca que alerta sobre degradação sob alta concorrência. Verificar se as páginas existem e dizem o que o snippet diz antes de citar. https://arxiv.org/pdf/2509.01920v2 ; https://arxiv.org/html/2603.18897 ; https://arxiv.org/pdf/2609.03236 ; https://arxiv.org/pdf/2511.20048
- Subagentes: o teto padrão é 20 concorrentes e 3 níveis de aninhamento. Dá para retomar um subagente com histórico em vez de criar um novo. Cada relatório devolvido entra no contexto principal, então limitar o tamanho. https://code.claude.com/docs/en/sub-agents
- Efeito dos turnos: o roteamento por fase da LiteLLM dobrou os turnos (205 contra 112 na comparação), o que pode elevar a latência apesar do custo menor. https://docs.litellm.ai/blog/subtask-type-routing
- Não há benchmark direto de revisão paralela contra cadeia de revisão sequencial em agentes de código. A recomendação de trocar plan-review mais design-review em série por revisão paralela (seccionamento ou voto) se apoia na orientação da Anthropic e na semântica do LangGraph, e deve ser medida no próprio benchmark.
- Padrão arquivo-de-notas: pesquisadores escrevem notas com URLs em arquivo e devolvem só caminho e resumo curto. Isso também pode conter o contexto inline que parece estar inflando a chamada de 624k tokens do executor. A causa real dessa chamada não está explicada por nenhuma fonte.

## 6) Riscos

1. **Falso DONE ao pular etapas.** "Parar cedo" com spec ambígua falhou em 3/5 testes ocultos, e verificação e terminação são cerca de 24% das falhas do MAST. Mitigação: nunca remover a checagem executável, tratar ambiguidade como escalonamento obrigatório e manter regras duras em código (forçar o fluxo completo se a tarefa envolver dinheiro, billing, migração, auth ou testes de aceitação).
2. **Roteador mal calibrado.** Classificadores genéricos ficam perto do acaso sem rótulos de domínio, e o Jev não tem track record. Sem taxa de erro publicada para roteamento de código, a lacuna para o oráculo é grande (0,76 contra 0,89) e erros se concentram nos casos difíceis raros. Mitigação: regras estruturais conservadoras primeiro, registrar features e decisões de tier para contar erros, escalonar por falha de verificação e exigir lift de pelo menos 15 pp antes de adicionar uma regra.
3. **Injeção de prompt no gate.** O texto da tarefa é não confiável e pode tentar se rebaixar para "simples". O Jev é sensível a texto de direcionamento e à ordem das opções. Mitigação: randomizar ou reordenar opções, checar consistência, manter o estado curto e deixar rails em código.
4. **Evidência fraca para a decisão central.** Não há estudo controlado de ablação de plan-review ou design-review em código, e os benchmarks internos são n=1. A economia de 98% (FrugalGPT), 15x (Anthropic, pesquisa web) e 93,7% (Codex, raciocínio interno) não se transfere para o graph-eng. Mitigação: suíte de cerca de 20 tarefas (simples, médias, difíceis e armadilhas de falso DONE) com execuções repetidas, medindo custo, latência e taxa de acerto em teste oculto por tier.
5. **Efort baixo no Haiku.** Em esforço baixo ele tende a pular busca ou verificação. Mitigação: esforço médio no verify, ou checagem determinística fora do modelo (rodar testes e ler o exit code).
6. **Dependência externa instável.** O endpoint `/api/alpha/decisions` pode mudar, a probabilidade varia entre versões do Jev e os limiares exigem recalibração por modelo. Há risco de outage e de timeout. Mitigação: adaptador fino, versão fixada (1.13 ou 1.14, não o alias), timeout curto (5-10 s), no máximo um retry, e fallback determinístico para o fluxo completo. Validar o JSON no código e cair no fluxo completo em qualquer falha de parse ou schema.
7. **Crítico que infla o trabalho.** Um revisor pedido para achar lacunas sempre acha e gera over-engineering. Mitigação: filtro de severidade que só aceita lacunas de correção ou de requisito.
8. **Perda de contexto na passagem plano para executor.** O contexto precisa viajar na íntegra, com decisões comprimidas e não só um resumo. Evitar executores paralelos com escopos de arquivo não disjuntos. A chamada de 624k tokens indica um problema de gestão de contexto, não de forma do grafo.
9. **Custo e efeitos colaterais da especulação.** Speculative execution gasta tokens quando erra e só é segura em worktree isolado. Mitigação: limitar a uma etapa à frente e ativar só por classe de complexidade.
10. **Fontes parciais ou só por snippet.** Vários artigos de 2026 (2607.00053, 2608.04804, 2608.01347, 2606.22902, 2602.16873) e os papers de especulação foram lidos parcialmente ou só em snippet. Os dados de OpenHands, SWE-agent, MetaGPT e ChatDev vêm de abstracts. Agent-as-a-Router (2606.22902) e AdaptOrch (2602.16873) apareceram na busca e não foram abertos. Confirmar antes de citar em documentação.
11. **Questões abertas a testar no repo:**
    - Se o esforço por nó via flag do CLI funciona na versão em uso.
    - Se uma heurística de código pura (número de arquivos, palavras-chave, presença de testes de aceitação) classifica as duas tarefas de benchmark tão bem quanto um gate de ML, sem dependência nem risco de injeção.
    - Qual gatilho de escalonamento (teste falho, achado do crítico, contagem de retries) pega melhor as tarefas mal roteadas sem pagar o fluxo completo toda vez.