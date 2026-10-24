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

Cada run real gasta dinheiro da conta do Claude: peça autorização antes.

```bash
bash test/fixtures/benchmark-minecraft/setup.sh /tmp/minecraft-bench
```

Depois, dentro de `/tmp/minecraft-bench`, rode `/graph-eng:implemente` com o conteúdo de `task.md` como tarefa e dê a nota como descrito em `acceptance.md`.
