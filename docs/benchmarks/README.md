# Benchmarks do graph-eng

Evidência versionada das runs reais do benchmark (`bin/graph-benchmark.mjs`). A pasta `.graph-runs/` é ignorada pelo git, então tudo o que precisa ficar no repositório é copiado para cá.

- [`RESULTADOS.md`](RESULTADOS.md): tabela de todas as runs arquivadas, gerada pelo comando `archive`. Não edite à mão.
- `runs/<id>/`: cópia da evidência de cada run (manifesto, `run.json`, `calls.jsonl` e avaliações externas de cada variante, relatório).
- [`pesquisa-jogos-e-3d.md`](pesquisa-jogos-e-3d.md): catálogo de cases (jogos, 3D, multiagente) para as próximas rodadas.
- Leitura e histórico das rodadas: [`docs/validation/graph-eng-2-benchmark.md`](../validation/graph-eng-2-benchmark.md).

## Rodar e arquivar uma run

Cada run real gasta dinheiro da conta do Claude ou do Codex: peça autorização antes.

```bash
node bin/graph-benchmark.mjs prepare --host claude --scenario chess --out .graph-runs/benchmarks
```

```bash
node bin/graph-benchmark.mjs run --manifest .graph-runs/benchmarks/<id>/manifest.json --variant single-agent
```

```bash
node bin/graph-benchmark.mjs run --manifest .graph-runs/benchmarks/<id>/manifest.json --variant adaptive
```

```bash
node bin/graph-benchmark.mjs eval --manifest .graph-runs/benchmarks/<id>/manifest.json
```

```bash
node bin/graph-benchmark.mjs report --manifest .graph-runs/benchmarks/<id>/manifest.json
```

```bash
node bin/graph-benchmark.mjs archive --manifest .graph-runs/benchmarks/<id>/manifest.json
```

`archive` copia a evidência para `runs/<id>/` e regera o `RESULTADOS.md`. Ele não copia o workspace da tentativa nem o baseline v1 (77 KB, recuperável por `git show 91bf1dc:workflows/graph-eng.js`).

Cenários: `happy` (3 funções), `faturamento` (9 módulos, contrato espalhado), `chess` (gerador de lances de xadrez, perft). Variantes: `v1-normalized`, `adaptive`, `single-agent`.
