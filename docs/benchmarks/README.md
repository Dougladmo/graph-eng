# Benchmarks do graph-eng

Evidência versionada das runs reais do benchmark Minecraft MVP. A pasta `.graph-runs/` é ignorada pelo git, então o que precisa ficar no repositório é copiado para cá.

## O cenário

Um clone jogável do Minecraft em React e three.js, a partir do esqueleto em [`test/fixtures/benchmark-minecraft/`](../../test/fixtures/benchmark-minecraft/). Os agentes recebem só `workspace/` (com `task.md`, que é o prompt). A nota vem de:

1. 55 testes de aceite ocultos (`acceptance/`), que os agentes nunca veem.
2. `npm run build` no repositório entregue.
3. Smoke visual no navegador: criar mundo, andar, minerar, colocar bloco, abrir inventário, F3 e pausar.

Como montar e dar a nota está em [`acceptance.md`](../../test/fixtures/benchmark-minecraft/acceptance.md).

## Resultados

| Variante | Pasta | Testes ocultos | Custo | Tempo |
| --- | --- | --- | --- | --- |
| Agente único no modelo forte, sem graph-eng | [`runs/minecraft-20261021/`](runs/minecraft-20261021/) | 55/55 | US$ 5,97 | 1375 s |
| Advisor, `--executor sonnet` | [`runs/minecraft-20261022-advisor/`](runs/minecraft-20261022-advisor/) | 55/55 | US$ 1,79 | 662 s |
| Advisor, `--executor haiku` | [`runs/minecraft-20261023-advisor-haiku/`](runs/minecraft-20261023-advisor-haiku/) | 54/55 | US$ 2,33 | 1222 s |
| Advisor, `--haiku-max medium` | [`runs/minecraft-20261023-advisor-route/`](runs/minecraft-20261023-advisor-route/) | 55/55 | US$ 1,66 | 752 s |
| Advisor, `--haiku-max low` (padrão) | [`runs/minecraft-20261023-advisor-route/`](runs/minecraft-20261023-advisor-route/) | 55/55 | US$ 1,59 | 617 s |

Cada pasta tem o JSON da run (no advisor: plano, revisão, roteamento, sessões, gate, chamadas e custo por modelo e por papel) e o `*-acceptance.tap` com a saída dos testes ocultos.

## Rodar de novo

Cada run real gasta uso da conta do Claude: peça autorização antes. O `bench.sh` faz tudo: cria o repositório, roda `implemente` com o `task.md` como tarefa e as flags que você passar, dá a nota com os 55 testes ocultos e o `npm run build`, e resume custo, tempo e sessões. Ele deixa `bench-result.json` (a run), `bench-acceptance.tap` (os testes ocultos) e `bench-build.log` no destino.

```bash
bash test/fixtures/benchmark-minecraft/bench.sh /tmp/mc-padrao
bash test/fixtures/benchmark-minecraft/bench.sh /tmp/mc-power --power
bash test/fixtures/benchmark-minecraft/bench.sh /tmp/mc-power-max --power --fable-min high
```

Com `BENCH_SKIP_RUN=1`, o script só dá a nota do que já estiver no destino (serve para conferir o próprio corretor com o motor de referência). O smoke visual continua manual: `npm run dev` no destino e o roteiro de `acceptance.md`.

Para guardar a evidência, copie o `.graph-runs/<runId>/advisor-run.json` e o `bench-acceptance.tap` para uma pasta nova em `runs/`.

## Power Mode (1.4)

As runs com `--power` ainda não foram feitas: esperam o reset semanal de uso da conta (12/11/2026). As variantes, o que medir e as hipóteses estão em [docs/power-mode.md](../power-mode.md).
