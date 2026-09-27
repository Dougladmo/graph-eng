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

A skill sempre imprime o id da run (`wf_…`) e os comandos prontos, mas dá para chamar o
`graph-watch` (`bin/graph-watch.mjs`, só leitura) na mão a qualquer momento:

```bash
# grafo ao vivo, redesenhado sozinho, num terminal à parte
node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" live --run <wf>

# uma foto do estado atual, para colar na conversa
node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf> --no-color

# prompt, tool calls recentes e resultado de um nó específico
node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" agent <id> --run <wf> --no-color
```

Sem `d2` instalado, o `live` e o `snapshot` desenham caixas e setas com caracteres puros no
próprio terminal. Com `which d2` encontrando o binário, acrescente `--svg` no `live` para abrir a
mesma visão como SVG no browser.

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
```

## Desenvolvimento

Para testar uma mudança local sem publicar:

```bash
claude --plugin-dir /caminho/para/graph-eng
```

Suba a `version` do `plugin.json` a cada release, senão o `/plugin marketplace update` não enxerga a mudança.

## Licença

[MIT](LICENSE)
