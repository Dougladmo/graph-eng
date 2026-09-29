---
description: Sobe o painel ao vivo do graph-eng desacoplado da sessão — fechar o painel ou a sessão não derruba o localhost. Com "stop", para o painel.
argument-hint: "[stop]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" ui:*)
---

Se `$ARGUMENTS` for `stop`, rode com Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" ui --stop
```

Senão, rode com Bash, **sem** `run_in_background` (o comando solta o servidor num processo próprio e sai na hora):

```
node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" ui --detach --no-open
```

Responda em 1 linha com o que o comando imprimiu: o link `http://127.0.0.1:<porta>`, ou que o painel foi parado.
Se sair erro de porta ocupada, diga que dá para fixar outra com `"env": {"GRAPH_ENG_PORT": "<N>"}` no
`~/.claude/settings.json`.
