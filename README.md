# graph-eng

Plugin do Claude Code que roda uma tarefa complexa como um **grafo pequeno de agentes**:

```
PLAN ─▶ [ DAG: work ─▶ gate de checks ─▶ verify ⇄ repair ] ─▶ CRITIC ─┬─ done ──▶ SYNTH ─▶ gate humano
            ▲                                                         │
            └────────────────── gaps = novos nós ─────────────────────┘   (até maxRounds, ou sem gap novo)
```

A regra é **executor barato, revisor forte**: workers em Sonnet; planner, verificador e critic no modelo da
sessão. Leitura roda em paralelo e escrita em raia única. O 2º voto só entra quando o verificador fica em
dúvida. Gasta ~6-20 agentes, não 100+. A fundamentação de cada decisão, com fontes, está em
[skills/graph-eng/DESIGN.md](skills/graph-eng/DESIGN.md).

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
/graph-eng:graph-eng [--lean|--max] [--plan-gate] [--spec <arquivo>] [research|architecture|implement|review] <tarefa>
```

A skill também dispara sozinha quando você pede "grafo", "graph eng" ou "roda em loop até ficar pronto" para
uma tarefa complexa. Ela faz um scout barato, monta o `context` e chama o workflow `graph-eng:graph-eng`.
O paper trail de cada run fica em `<repo>/.graph-runs/<runId>/` (plano, artefatos por nó, `REPORT.md`), e
o `INDEX.md` guarda a memória entre runs.

| Preset     | Teto de agentes | Largura | Quando                                   |
| ---------- | --------------- | ------- | ---------------------------------------- |
| `lean`     | 12              | 2       | tarefa média, custo mínimo               |
| `balanced` | 24              | 3       | padrão                                   |
| `max`      | 48              | 5       | tudo no modelo da sessão, tarefa crítica |

O workflow nunca faz commit, push, deploy nem migration remota. Isso fica no gate humano.

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
  SKILL.md             triagem, spec, scout, parâmetros, plan gate, entrega
  DESIGN.md            decisão → evidência, com fontes
workflows/
  graph-eng.js         o grafo: plan → DAG → verify/repair → critic → synth
bin/
  graph-watch.mjs      CLI só leitura: live, snapshot, agent, events, ui
  ui-server.mjs        servidor do painel web (Node puro, 0 deps)
  ui/                  página do painel: graph-layout.mjs (modelo → layout, puro e testado),
                       app.js (DOM ao vivo), style.css (visual trocável), index.html
```

## Desenvolvimento

Para testar uma mudança local sem publicar:

```bash
claude --plugin-dir /caminho/para/graph-eng
```

Suba a `version` do `plugin.json` a cada release, senão o `/plugin marketplace update` não enxerga a mudança.

## Licença

[MIT](LICENSE)
