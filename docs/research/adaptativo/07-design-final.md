# Design final: graph-eng adaptativo

Este documento parte do `05-design.md` e resolve os 8 itens do `06-review-do-design.md` com a versão mais simples que atende os pedidos. Onde as duas versões divergem, vale esta.

## O que ficou de fora do 05 e por quê

- **`triageHash` e cadeia de hashes (itens 2 e 3).**
  - Quem decide e grava `triage.decided` é o runner, e o engine não consegue gravar eventos `triage.*`: o runner recusa esse tipo no `emit`.
  - O engine só pode **subir** o tier. Subir nunca gera aprovação sintética, só acrescenta revisão real.
  - Sem caminho para rebaixar, não há o que forjar, e o hash não protege nada.
- **Cascata em tempo de execução (fast→standard→full depois de falha no verify).**
  - Quando o verify, a check window ou o critic falham, o fluxo já tem reparo local, replan e bloqueio. Nenhum tier pula esses três, então falha nunca vira DONE falso.
  - A cascata custaria um caminho novo de aprovação no meio da run, que é onde vivem os itens 4 e 5. Fica como follow-up, medido pelo benchmark.
  - O que entra é o refinamento logo depois do plano. Se o próprio planner disser `complex`, mais nós que o teto do tier, ou nó `risk: high`, o tier sobe antes de qualquer revisão.
- **Renomear labels (item 6).**
  - Os nós de pesquisa e design ganham labels próprios (`research:<id>`, `design:<id>`). Isso muda o `workflowSourceHash`, e checkpoint antigo já é recusado por ele.
  - O resume de checkpoint anterior não é migrado. O CHANGELOG avisa.

## Tiers

| Fase | fast | standard | full |
|---|---|---|---|
| Estágio plan: planner (Sonnet) | sim | sim | sim |
| Estágio plan: nós research (Sonnet) + notetaker | não | não | sim |
| Estágio plan: critic | sintético* | sintético* | real |
| Estágio tasks: decomposer (Sonnet) | sim | sim | sim |
| plan-review (Opus) | sintético | real | real |
| Nós design (Sonnet) + design-review (Opus) | não | não | sim |
| implement (Haiku), check window, verify (Haiku) | sim | sim | sim |
| critic final (Sonnet) + gate com receipts | sim | sim | sim |
| synth (Haiku) | sim | sim | sim |

\* O critic sintético do estágio plan roda snapshot e checks confiáveis como hoje e só dispensa a chamada de LLM. O plano de pesquisa do tier fast/standard não tem nós research, então não há o que criticar.

- Teto de nós: fast 3, standard 4, full segue o effort. O teto efetivo é `min(tier, effort)` (item 7), e a largura segue o effort.
- **Sintético** = `{kind: 'APPROVE', synthetic: true, reason: 'triage_<tier>', tier}`, persistido como hoje e com `tier` gravado no artefato publicado.

## Papéis e modelos (Claude)

| Papel | Modelo | Effort padrão |
|---|---|---|
| planner | Sonnet | medium |
| researcher (novo, nós research, com web) | Sonnet | medium |
| notetaker (novo) | Haiku | medium |
| planReviewer | Opus | medium |
| designer (novo, nós design) | Sonnet | medium |
| designReviewer | **Opus** | medium |
| executor | Haiku | medium |
| verifier | Haiku | medium |
| critic | Sonnet | medium |
| synth | Haiku | medium |

- O Opus só revisa: plano e design. O critic final continua Sonnet, que mede o resultado contra receipts de testes reais e não precisa do carimbo caro.
- Os nós research e design deixam de rodar no Haiku do executor (hoje caem em `work:` e no papel `executor`).
- No Codex, researcher e designer usam o modelo do planner, notetaker o do executor e designReviewer o do planReviewer.

## Triagem (`bin/triage.mjs`, pura, sem rede)

`triageTask({ task, context, spec, doneWhen, checks }) -> { tier, floor, reasons: [code], features }`

Sinais (o tamanho do texto nunca conta):

| Sinal | Efeito |
|---|---|
| sem check executável e sem critério verificável | piso `full` (`ambiguous_spec`) |
| domínio de risco (dinheiro, fatura, pagamento, auth, senha, token, migração, permissão, produção, exclusão de dados) | piso `standard` (`risk_domain`) |
| contratos ou docs a ler (`docs/`, `contrato`, `spec`), ou aviso de que o teste visível não basta | piso `standard` (`external_contracts`) |
| muitos arquivos citados (>= 8) ou várias camadas (front, back, banco, infra) | piso `full` (`multi_layer` / `many_files`) |
| 5 a 7 arquivos | piso `standard` |
| texto pedindo para pular revisão ou tratar como simples | marca `injection_suspect` e piso `standard`; nunca rebaixa |

O tier base é `fast`, e o final é `max(base, piso)`. Calibração esperada:

- **chess:** 4 arquivos, check `npm test`, sem risco → fast.
- **faturamento:** 9 módulos, dinheiro, contratos → full por muitos arquivos? Os 9 módulos estão citados por nome e não por caminho. Contar só caminhos `src/x`. O texto cita `docs/contratos/`, então o piso é `standard`.
- **happy:** fast.

## Classificador opcional (Jev via OpenRouter)

- **API:** `POST https://openrouter.ai/api/v1/systemone`, `Authorization: Bearer <chave OpenRouter>`, modelo `jev-1.13`.
  - Corpo: `{ model, state, questions: { tier: { type: 'choice', instructions, criteria: { fast, standard, full } } } }`.
  - Resposta: `answers.tier.choice` e `answers.tier.probabilities`.
- **Ativação:** só com chave **e** opt-in.
  - Chave: `OPENROUTER_API_KEY` ou `~/.graph-eng/config.json`. O arquivo precisa estar em modo 0600 e fora de repo git.
  - Opt-in: `GRAPH_ENG_TRIAGE_CLASSIFIER=on` ou `classifier.enabled: true`.
  - O comando `node bin/graph-run.mjs triage-config` lê a chave pelo stdin.
- **Merge:** o classificador só sobe o tier. A única descida é de `standard` para `fast`, com confiança >= 0,8, quando o piso é `fast` e não há suspeita de injeção.
- **Consistência:** duas chamadas com as opções em ordem invertida. Se divergirem, vale a heurística.
- **Falhas:** timeout de 5 s, HTTP fora de 2xx, JSON inválido ou opção desconhecida fazem valer a heurística. Só o código do erro vai para o evento.
- **Segredo (item 1):** o spawn dos agentes recebe `env` sem `OPENROUTER_API_KEY` nem `GRAPH_ENG_*`. A chave nunca vai para argv, log, journal ou erro.
- **Laya:** não está no OpenRouter. É pesos abertos, auto-hospedado em Python. Fica documentado como alternativa, sem código.

## Fluxo de dados

1. O runner, antes de `decidePipelineStages`, chama `triageTask` e, se ativo, o classificador.
2. Grava `triage.decided { tier, floor, source, reasons, classifier }` no journal e passa `tier` como argumento interno a cada estágio. `tier` entra em `PIPELINE_INTERNAL_KEYS`, e o usuário não pode passá-lo.
3. No resume, vale o último `triage.decided` do journal. Ligar ou desligar o adaptive no meio da run bloqueia com `resume_adaptive_changed` (item 8).
4. Validação do runner:
   - `tasksReviewApproved` aceita plan-review sintético só se o `triage.decided` do journal diz `fast`.
   - O design-review sintético só vale com tier `fast` ou `standard` no journal.
5. Reuso de artefato (item 4): o artefato publicado grava `tier`. `resolveReuse` recusa um artefato com tier menor que o tier vigente (`reuse_tier_lower`) ou com o adaptive desligado.

## Adaptive ligado por padrão?

Sim, com `--adaptive off` ou `GRAPH_ENG_ADAPTIVE=off` para voltar ao fluxo completo. A rodada do benchmark decide se fica assim. Se a qualidade cair, o padrão volta para off antes do merge.
