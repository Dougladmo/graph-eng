# graph-eng

Plugin do Claude Code que roda uma tarefa complexa como um **grafo pequeno de agentes**, com um
**esqueleto de fases obrigatório por modo** (implement passa por Design → Revisão do design →
Implementação → Síntese; architecture não chega a implementar; research/review vão a Plano →
Pesquisa → Crítica → Síntese):

```
PLAN ─▶ PESQUISA ─▶ DESIGN ─▶ REVISÃO DO DESIGN ─▶ [ DAG: work ─▶ gate de checks ─▶ verify ⇄ repair ] ─▶ CRITIC ─┬─ done ──▶ SÍNTESE (polidores + consolidador) ─▶ gate humano
                                    ▲                                                                            │
                                    └─────────────────────────── gaps = novos nós ─────────────────────────────┘   (até maxRounds, ou sem gap novo)
```

A regra é **executor barato, revisor forte**: workers em Sonnet; planner, verificador e critic no modelo da
sessão. Leitura roda em paralelo. Escrita roda em paralelo só quando os nós declaram arquivos disjuntos;
se os arquivos se sobrepõem, fica em raia única.
Toda implementação é verificada por outro agente, com uma lente de boas práticas no verify e na crítica. O
2º voto só entra quando o verificador fica em dúvida. O design é revisado antes de implementar — reprovado,
não implementa. O quanto o grafo gasta é o **esforço** (`manual`/`auto`/`low`/`medium`/`high`/`max`) contra
um **teto** de agentes (padrão de fábrica: `ceiling` 24 e `effort` auto, vale sem nenhuma configuração). A
fundamentação de cada decisão, com fontes, está em [skills/graph-eng/DESIGN.md](skills/graph-eng/DESIGN.md).

## Instalação

```
/plugin marketplace add Dougladmo/graph-eng
/plugin install graph-eng@graph-eng
```

Pela linha de comando:

```bash
claude plugin marketplace add Dougladmo/graph-eng
claude plugin install graph-eng@graph-eng
```

Para receber versões novas: `/plugin marketplace update graph-eng`.

## Uso

```
/graph-eng:graph-eng [--lean|--max] [--effort <manual|auto|low|medium|high|max>] [--ceiling <N>]
  [--plan-gate] [--spec <arquivo>] [research|architecture|implement|review] <tarefa>
```

A skill também dispara sozinha quando você pede "grafo", "graph eng" ou "roda em loop até ficar pronto" para
uma tarefa complexa. Ela faz um scout barato, lê a config efetiva com
`node "${CLAUDE_PLUGIN_ROOT}/bin/graph-config.mjs" --json`, monta o `context` e chama o workflow
`graph-eng:graph-eng`. O paper trail de cada run fica em `<repo>/.graph-runs/<runId>/` (plano, artefatos por
nó, `REPORT.md`), e o `INDEX.md` guarda a memória entre runs.

| Preset     | Modelos                    | Quando                                    |
| ---------- | -------------------------- | ------------------------------------------ |
| `lean`     | Sonnet também no design    | tarefa média, custo mínimo                 |
| `balanced` | Sonnet nos workers         | padrão                                     |
| `max`      | tudo no modelo da sessão   | tarefa crítica                             |

O teto e a largura não vêm do preset — ver [Esforço e teto de agentes](#esforço-e-teto-de-agentes).

O workflow nunca faz commit, push, deploy nem migration remota. Isso fica no gate humano.

## Esforço e teto de agentes

O planner não escolhe o tamanho do grafo à toa: ele dimensiona para um **alvo de agentes**, derivado de
duas coisas — o **esforço** (`manual`, `auto`, `low`, `medium`, `high`, `max`) e o **teto** (`ceiling`,
padrão de fábrica **24**, com `effort: 'auto'` — vale assim que o plugin é instalado, sem tocar em
config nenhuma). A largura do DAG e o número máximo de nós saem do alvo, não o contrário.

```
alvo = max(piso do modo, round(pct(esforço) × teto))   pct: low 20% · medium 40% · high 70% · max 100%
```

O piso é **1 agente por fase obrigatória do esqueleto** daquele modo — quem fixa o mínimo que o esqueleto
por si só já consome, mesmo num teto baixo:

| Modo           | Piso (agentes) | Esqueleto de fases                                                                |
| -------------- | -------------- | ----------------------------------------------------------------------------------- |
| `implement`    | 8              | Plano → Pesquisa → Design → Revisão do design → Implementação → Revisão da implementação → Síntese |
| `architecture` | 6              | Plano → Pesquisa → Design → Revisão do design → Crítica → Síntese (sem implementação) |
| `research`     | 4              | Plano → Pesquisa → Crítica → Síntese                                              |
| `review`       | 4              | Plano → Pesquisa → Crítica → Síntese                                              |

Com `effort: 'manual'`, a skill pergunta o nível a cada disparo (`AskUserQuestion`). Sem humano para
responder — por exemplo, quando outro agente chama a skill —, ela usa `auto` e registra no relatório que
foi o Claude quem decidiu. Com `effort: 'auto'`, o planner escolhe o nível e justifica a escolha, visível
no plan gate. `maxAgents` é sinônimo de `ceiling`; `economy` (`lean`/`balanced`/`max`) segue existindo, mas
hoje só escolhe modelo, não teto.

### Papéis e quantidades

| Papel                              | Quantos                                                          |
| ----------------------------------- | ----------------------------------------------------------------- |
| planner                             | 1                                                                   |
| worker `research`                   | 1 por nó de pesquisa                                                |
| worker `design`                     | 1 por nó de design                                                  |
| **revisor do design**               | **1** (mais 1 re-revisão por rodada de reparo do design, até `maxRepairs`) |
| worker `implement`                  | 1 por nó, em paralelo quando os arquivos são disjuntos              |
| verificador (implementação)         | 1 por nó de implementação — **outro agente**, nunca quem escreveu   |
| 2º voto                             | só se o verificador ficar em dúvida                                  |
| reparo (design ou implementação)    | ≤ `maxRepairs`; o último sobe de modelo                              |
| critic                              | 1 por round                                                          |
| **polidor da síntese**              | `ceil(2/3 × nº de nós implement)`, mínimo 1                          |
| **consolidador da síntese**         | 1 (sempre, mesmo em research/review, que não têm polidor)            |

Em research/review, a síntese fica só com o consolidador, porque não há implementação para polir.

## Config

A config mora em `~/.claude/graph-eng/config.json` (`effort`, `ceiling`, `economy`, `planGate`,
`maxRounds`, `maxRepairs`), com precedência **flag > arquivo > padrão**. A skill lê pela CLI; o painel
lê e grava pela API e pelo modal:

- **CLI** (só leitura), para a skill ler antes de disparar o workflow (que não acessa disco):
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/bin/graph-config.mjs" --json
  ```
  Imprime a config efetiva, a origem de cada campo, a tabela de alvos por nível e o piso do modo.
- **HTTP**, pelo painel: `GET /api/config` (sempre 200, campo ausente ou inválido volta ao padrão com
  aviso) e `PUT /api/config` (grava por cima, tmp + rename; qualquer erro de validação volta em
  `fields.<campo>`, ex.: `"ceiling": "mínimo 8"`).
- **Modal de engrenagem** no painel web (botão Configurações, no rodapé da lateral), com seções
  Agentes/Modelos/Execução/Aparência (o tema também vive aqui agora) e prévia ao vivo do alvo. Um teto
  abaixo de 8 é recusado no campo, com o aviso `mínimo 8`, e o modal não salva. O piso é fixo porque o
  arquivo vale para qualquer modo, e 8 é o piso do `implement`, o maior; o piso exato do modo quem
  aplica é a CLI (`--mode`) e o motor.

## Acompanhar uma run

A skill sempre sobe o painel web e imprime o id da run (`wf_…`) e o link ao vivo, mas dá para
chamar o `graph-watch` (`bin/graph-watch.mjs`, só leitura) na mão a qualquer momento:

```bash
# painel web: todas as runs da máquina e o grafo ao vivo de cada uma (instância única, só localhost)
node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" ui
# imprime "graph-eng: painel: http://127.0.0.1:<porta>"; abra "<url>/?run=<wf>" para uma run

# grafo ao vivo em texto, redesenhado sozinho, num terminal à parte
node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" live --run <wf>

# uma foto do estado atual, para colar na conversa
node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf> --no-color

# prompt, tool calls recentes e resultado de um nó específico
node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" agent <id> --run <wf> --no-color
```

O `ui` roda em `127.0.0.1`, é só leitura (clicar num nó abre o detalhe) e mantém **uma instância
por máquina**: se a porta já tem um `graph-watch ui` no ar, o comando novo sai na hora
reaproveitando ele.

A porta padrão é 4477. Se ela estiver ocupada por outro programa, troque com `--port <N>` ou com a
variável `GRAPH_ENG_PORT` (a flag vence a variável). Para a skill usar outra porta sempre, fixe no
`~/.claude/settings.json`:

```json
{ "env": { "GRAPH_ENG_PORT": "5177" } }
```

Cada nó mostra uma bolinha — piscando quando está rodando agora,
preenchida quando já rodou (vermelha se falhou) e vazia quando ainda não rodou. `live --svg` é um
alias que garante o painel subindo e imprime o mesmo link.

## Estrutura

```
.claude-plugin/
  plugin.json          manifesto do plugin
  marketplace.json     o repo também é o marketplace (source "./")
skills/graph-eng/
  SKILL.md             triagem, spec, scout, parâmetros, esforço/teto, plan gate, entrega
  DESIGN.md            decisão → evidência, com fontes
workflows/
  graph-eng.js         o grafo: plan → esqueleto de fases → DAG → verify/repair → critic → synth
bin/
  graph-watch.mjs      CLI só leitura: live, snapshot, agent, events, ui
  ui-server.mjs        servidor do painel web (Node puro, 0 deps) + GET/PUT /api/config
  graph-config.mjs     CLI da config efetiva para a skill: node graph-config.mjs [flags] --json
  config.mjs           leitura/validação/gravação atômica de ~/.claude/graph-eng/config.json
  ui/
    agent-target.mjs   fórmula esforço × teto → alvo (espelho de workflows/graph-eng.js, mesmo teste)
    config-modal.mjs   modal de engrenagem (Agentes/Modelos/Execução/Aparência)
    graph-layout.mjs   modelo → layout, puro e testado (coluna "Revisão do design" etc.)
    app.js             DOM ao vivo · theme.js (tema, hoje só usado pelo modal) · index.html
    src/style.css       fonte, Tailwind → style.css (gerado, versionado)
    fonts/              Geist e Geist Mono, SIL OFL
```

## Desenvolvimento

Para testar uma mudança local sem publicar:

```bash
claude --plugin-dir /caminho/para/graph-eng
```

O painel é estilizado com Tailwind CSS v4, só em desenvolvimento: quem instala o plugin recebe o
`bin/ui/style.css` já gerado e não precisa de `npm install`. Para mexer no visual:

```bash
npm install            # só o Tailwind (devDependencies)
npm run css:watch      # regera bin/ui/style.css a cada mudança em bin/ui/src/style.css, index.html ou app.js
npm test               # inclui a checagem de que o style.css versionado está em dia com a fonte
```

Os tokens do painel viram utilitários (`bg-surface`, `text-fg3`, `border-line`, `text-accent`,
`font-mono`…) e `dark:` segue o switch de tema. Edite `bin/ui/src/style.css`, nunca o gerado, e versione
os dois.

Suba a `version` do `plugin.json` a cada release, senão o `/plugin marketplace update` não enxerga a mudança.

## Licença

[MIT](LICENSE)
