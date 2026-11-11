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
bash test/fixtures/benchmark-minecraft/bench.sh /tmp/mc-power-max --power max
```

Para o experimento das divisões de executor do Power Mode, `GRAPHENG_POWER_SPLIT=<medium>/<high>` (com `sonnet` ou `opus`) troca o modelo dos passos medium e high; por exemplo `GRAPHENG_POWER_SPLIT=opus/opus bash test/fixtures/benchmark-minecraft/bench.sh /tmp/mc-power --power`. Sem a variável vale o padrão (Sonnet nos medium, Opus nos high). A run grava a divisão em `powerSplit` e o resumo do `bench.sh` mostra `split medium=… high=…`.

Com `BENCH_SKIP_RUN=1`, o script só dá a nota do que já estiver no destino (serve para conferir o próprio corretor com o motor de referência). O smoke visual continua manual: `npm run dev` no destino e o roteiro de `acceptance.md`.

Para guardar a evidência, copie o `.graph-runs/<runId>/advisor-run.json` e o `bench-acceptance.tap` para uma pasta nova em `runs/`.

## Cenário 2: souls-like (ASHEN GATE)

Um MVP de souls-like em TypeScript estrito, React, three.js e motion, a partir do esqueleto em
[`test/fixtures/benchmark-soulslike/`](../../test/fixtures/benchmark-soulslike/): pátio com fogueira, três hollows,
porta de névoa e sala de chefe com duas fases; estamina, esquiva com i-frames, combo leve, pesado, ataque em salto,
guarda com contra-ataque, poise, riposte, frasco, lock-on, morte com rastro de runas. O motor é puro
(`src/engine/`) e testado com `node --test` em `.ts`; o `task.md` fixa o contrato de cada módulo com constantes e
regras exatas. A nota vem de:

1. 66 testes de aceite ocultos (`acceptance/`) sobre o motor, mais os 8 visíveis do esqueleto.
2. `npx tsc --noEmit` estrito e `npm run build` no repositório entregue.
3. Smoke visual no navegador: começar, andar, esquivar, atacar um hollow (leve, combo, pesado, salto), guardar, frasco,
   lock-on, descansar na fogueira, atravessar a névoa e lutar com o chefe.
4. Qualidade do código entregue (tamanho, maior função, comentários, `any`/casts, cobertura da spec de interface).

O corretor foi conferido com o motor de referência (`reference/engine/`): 74/74, `tsc` e build limpos; com os stubs,
64 dos 66 ocultos falham (os 2 restantes só conferem tabelas de constantes que o esqueleto já traz).

```bash
bash test/fixtures/benchmark-soulslike/bench.sh /tmp/souls-padrao
bash test/fixtures/benchmark-soulslike/bench.sh /tmp/souls-power --power
bash test/fixtures/benchmark-soulslike/bench.sh /tmp/souls-power-max --power max
```

## Power Mode (1.4)

As runs com `--power` e `--power max` ainda não foram feitas: esperam o reset semanal de uso da conta (12/11/2026 às 12h, horário de Belém; a tentativa de 10/11 bloqueou com `USAGE_LIMIT`). O plano são 5 rodadas de cada variante (padrão, `--power`, `--power max`), alternando as três a cada rodada e ajustando o graph-eng entre rodadas. As variantes, o que medir e as hipóteses estão em [docs/power-mode.md](../power-mode.md).
