---
description: Inicia ou reutiliza o painel local do graph-eng e devolve sua URL.
argument-hint: ""
---

Crie um arquivo JSON temporário por ferramenta de arquivo com `{"host":"claude","argv":["init"]}` e execute `node "${CLAUDE_PLUGIN_ROOT}/bin/grapheng.mjs" --invocation <caminho-do-json>`. Passe o caminho como argumento separado, nunca concatene conteúdo variável no comando. Responda com a URL que o comando devolver.
