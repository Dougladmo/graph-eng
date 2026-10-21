# Smoke real dos adaptadores GraphEng 2

O smoke verifica, em sequência, um `worker` barato e um `planReviewer` forte pelo CLI escolhido. Cada chamada recebe um nonce novo e um schema estruturado com campo opcional e enum. O supervisor grava o resultado do worker em `fixture/worker-result.json`; o plan reviewer deve ler esse arquivo e devolver o nonce e o status encontrados. O script confere ambos os nonces, status e enum de verificação, além de gravar evidência JSON por papel.

Depois das chamadas de modelo, uma etapa local inicia um processo e um neto que ignoram `SIGTERM`. O adaptador precisa cancelar o processo próprio, escalar para `SIGKILL` e confirmar que o grupo encerrou. Essa etapa não chama outro modelo. O status final só é `PASS` se worker, reviewer e cancelamento passarem.

Execute a partir da raiz do repositório, em uma sessão sem outro comando pesado ativo:

```sh
node bin/graph-smoke.mjs --host codex
node bin/graph-smoke.mjs --host claude
```

Para escolher outra pasta de saída, use `--out`; o caminho precisa ficar dentro de `.graph-runs`:

```sh
node bin/graph-smoke.mjs --host codex --out .graph-runs/benchmarks
```

Cada execução cria uma pasta própria com `fixture/worker-result.json`, `runtime/`, `worker.json`, `planReviewer.json`, `writeProbe.json`, `cancellation.json` e `run.json`. O `fixture/` é o cwd temporário das chamadas; o script não usa o diretório do produto como alvo de trabalho. O `worker` e o reviewer rodam só com leitura; a escrita é provada à parte pelo `writeProbe`, que roda o executor com escrita presa ao cwd (`fixture/`) e confere no disco o `write-probe.txt` gravado. A versão é obtida pelo `--version` do CLI e apenas o identificador de versão é registrado. Nenhuma chave, variável de ambiente, stderr ou prompt é gravado como evidência.

O teste do transporte usa um CLI simulado; a prova de cancelamento desse mesmo teste executa processos Node reais.

Escrita do executor: o smoke de 20/10 não cobria escrita, porque o worker e o reviewer rodam com `readOnly: true` e deram PASS sem provar que o executor consegue gravar. Agora o `writeProbe` pede ao executor (sem `readOnly`) que crie `fixture/write-probe.txt` com um nonce novo. O PASS depende do arquivo lido pelo próprio harness, não da resposta do modelo; arquivo ausente ou diferente gera `BLOCK` com `WRITE_PROBE_FAILED`, e esse BLOCK derruba o status geral.

`PASS` exige CLI disponível, worker com nonce e status corretos, reviewer que confirma nonce/status lidos da fixture, e encerramento confirmado do grupo de processos após cancelamento. Ausência de CLI, falha de autenticação, modelo indisponível, falha de capacidade ou resposta inválida gera `BLOCK` e exit code 2. O script não troca modelo nem usa API alternativa. `requestedModel` registra a política passada ao CLI; `effectiveModel` só é preenchido quando o próprio CLI informa um identificador. Uso fica em `usage` quando disponível.

## Execuções reais

- Codex: `codex-2026-10-18T02-40-25.941Z-78a26aca`, CLI `0.163.0-alpha.10.2`. Worker `gpt-6-luna` e plan reviewer `gpt-6.1-sol` passaram; o reviewer leu e confirmou a fixture do worker. A etapa de cancelamento também passou. O CLI não informou o identificador efetivo de modelo, então `effectiveModel` ficou nulo.
- Claude: `claude-2026-10-18T02-40-48.873Z-188668ee`, CLI `2.1.296`. O smoke retornou `BLOCK`; a execução do CLI informou que a organização desabilitou acesso à assinatura. O registro JSON dessa tentativa contém `SMOKE_FAILED` genérico porque o adaptador classificava exit não zero antes de examinar o envelope de erro. O classificador agora preserva `AUTH_FAILED` para esse caso; a chamada real não foi repetida.

Os testes com CLIs simulados verificam o harness e não contam como evidência de uso real dos modelos.
- Claude, 20/10: `claude-2026-10-20T00-19-30.160Z-3f27e5cf`, CLI `2.1.296`. `BLOCK` com `AUTH_FAILED` no worker (`haiku`). `claude auth status` informa `loggedIn: false`, `authMethod: none`, e não há chave de API no ambiente. O plan reviewer não foi chamado, porque o smoke para no primeiro bloqueio. O cancelamento passou. Nenhum fallback para API foi usado. Para destravar, o Douglas precisa autenticar o CLI (`claude auth login`) com uma conta que tenha acesso liberado pela organização.
- Claude, 20/10, depois do login: `claude-2026-10-20T05-01-38.370Z-da5e28e3`, CLI `2.1.304`. **PASS**.
  - Worker: `haiku` → efetivo `claude-haiku-5-5`, 10,4 s.
  - Plan reviewer: `opus` → efetivo `claude-opus-5-5`, 22,5 s. Leu a fixture do worker e confirmou nonce e status.
  - Cancelamento (SIGTERM e depois SIGKILL, grupo encerrado): PASS.
  - Sem fallback para API. A prova roda no código com a 3C fechada.

## Smoke real Claude com writeProbe (20/10/2026, 17:22 UTC)
- Run: `.graph-runs/smoke/claude-2026-10-20T17-21-43.791Z-bfebb8fb`, overall **PASS**.
- worker: PASS. planReviewer: PASS. writeProbe: PASS (`responseNonceMatched: true`, `fileMatched: true`; o `fixture/write-probe.txt` gravado pelo executor Haiku contém o nonce). Cancelamento: PASS (grupo de processos encerrado).
- É a primeira prova real de que o executor Claude grava, depois da correção do `--allowedTools` em `bin/hosts.mjs` (G-W).
