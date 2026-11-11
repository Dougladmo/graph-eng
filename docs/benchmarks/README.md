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

## Power Mode (1.4): Minecraft, 5 rodadas de cada variante

Feito em 11/11/2026, alternando as três variantes a cada rodada e ajustando o graph-eng entre rodadas (rodadas 1 e 2 no código `3c54042`/`f8cf6be`, com os bugs de `Write` negado; rodadas 3 a 5 no `fe2f95a`, com as correções). Evidência em [`runs/minecraft-20261111-power/`](runs/minecraft-20261111-power/): o JSON de cada run, o `.tap` dos testes ocultos e o [`qualidade.md`](runs/minecraft-20261111-power/qualidade.md) com o tamanho, a maior função, os comentários e a cobertura da spec de interface de cada entrega. "Divisão dos executores" é o `GRAPHENG_POWER_SPLIT` da run (o desenho da 1.4 é o forte nos `high`, o médio nos `medium`, o barato nos `low`).

| Rodada | Variante | Divisão dos executores | Ocultos | Entregou | Custo | Tempo | Sessões perdidas / conserto |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | padrão | — | 55/55 | sim | US$ 1,49 | 473 s | 1 / 1 (`Write` negado) |
| 1 | `--power` | forte nos `high` | 55/55 | sim | US$ 9,62 | 1617 s | 3 / 1 (`Write` negado) |
| 1 | `--power max` | forte nos `high` | 55/55 | **não** (sem tela) | US$ 6,78 | 1020 s | 2 / 0 (`blocked`) |
| 2 | padrão | — | 55/55 | sim | US$ 1,83 | 637 s | 1 / 1 (symlink) |
| 2 | `--power` | forte nos `high` | 55/55 | sim | US$ 7,70 | 1196 s | 1 / 1 (symlink) |
| 2 | `--power max` | forte nos `high` | 55/55 | **não** (jogo não abre) | US$ 11,15 | 1598 s | 1 / 1 (symlink) |
| 3 | padrão | — | 55/55 | sim | US$ 1,66 | 572 s | 0 / 0 |
| 3 | `--power` | forte nos `high` e `medium` | 55/55 | sim | US$ 12,95 | 2079 s | 1 / 1 |
| 3 | `--power max` | forte nos `high` e `medium` | 55/55 | sim | US$ 10,79 | 1852 s | 0 / 0 |
| 4 | padrão | — | 55/55 | sim | US$ 1,75 | 585 s | 0 / 0 |
| 4 | `--power` | médio nos `high` e `medium` | 55/55 | sim | US$ 6,14 | 1175 s | 1 / 1 (raia sem rodar o gate) |
| 4 | `--power max` | médio nos `high` e `medium` | 55/55 | sim | US$ 2,75 | 618 s | 0 / 0 |
| 5 | padrão | — | 55/55 | sim | US$ 1,34 | 477 s | 0 / 0 |
| 5 | `--power` | médio nos `high` e `medium` | 55/55 | sim | US$ 3,75 | 741 s | 0 / 1 (raia DONE com stub) |
| 5 | `--power max` | médio nos `high` e `medium` | 55/55 | sim | US$ 3,15 | 740 s | 0 / 0 |

**O que os números dizem.**

- **Nota e funcionalidade:** as 15 runs passaram nos 55 testes ocultos e no build. Das 13 que entregaram um jogo jogável, todas cobrem 27 a 30 dos 30 itens da spec de interface. O Power Mode não fez nenhuma feature que o padrão não fez.
- **Custo e tempo:** o padrão ficou entre US$ 1,34 e 1,83 e entre 473 e 637 s nas 5 rodadas. O Power Mode como foi desenhado (forte nos `high`) custou de 4 a 7 vezes mais e levou 2 a 3 vezes mais tempo (rodadas 1 e 2); com o forte também nos `medium` (rodada 3), de 6 a 8 vezes mais. A única configuração que chegou ao tempo do padrão foi o `--power max` com o médio em todos os executores (rodadas 4 e 5): US$ 2,75 e 3,15, 618 e 740 s, ou seja, 1,6 a 2,3 vezes o custo do padrão pela mesma nota.
- **Onde o dinheiro vai:** no Power Mode, o Fable 5.2 (revisão, advisor e, no `max`, o plano) custou de US$ 1,08 a 6,52 por run, e o forte nos executores de US$ 2,29 a 6,42. No padrão, o forte custa US$ 0,18 a 0,24 (só a revisão do plano).
- **Qualidade do código** ([`qualidade.md`](runs/minecraft-20261111-power/qualidade.md)): com o forte nos executores, o código sai 1,3 a 2,2 vezes maior e com 3 a 5 vezes mais comentários para a mesma spec, sem função menor nem módulo melhor separado que justifique. Com o médio nos executores, o código do Power Mode fica do tamanho e da forma do padrão.
- **Robustez:** as 2 runs que não entregaram foram as duas de `--power max` com o forte nos executores (rodadas 1 e 2): uma parou sem tela (`blocked`) e a outra fechou `done` com 55/55 e um jogo que não abre (`function save()` sobrescrevendo o parâmetro `save`). Nada no fluxo roda a tela; só o smoke manual pegou. Os bugs do graph-eng achados nas rodadas 1 e 2 (`Write` negado, cwd por symlink) foram corrigidos antes da rodada 3; os achados nas rodadas 4 e 5 (raia que devolve `BLOCKED` sem rodar o gate; raia que devolve `DONE` com um arquivo da pegada no stub) estão em `melhorias-futuras.md` (itens 34 e 35).

**Recomendação.** Para uma tarefa como esta, o padrão continua sendo a configuração certa: mesma nota, mesmas features, código menor, 1,6 a 8 vezes mais barato e nunca mais lento. Se for usar o Power Mode, use `--power max` com o médio em todos os executores (`GRAPHENG_POWER_SPLIT=sonnet/sonnet`): é a única configuração que entregou nas duas vezes sem conserto, no tempo do padrão, e o custo extra é o plano e a revisão pelo Fable 5.2. Colocar o forte nos executores não melhorou nada que o benchmark meça e multiplicou o custo. A hipótese de que o paralelismo das ondas reduziria o tempo não se confirmou: as ondas rodam em série e a maioria tem uma raia só, então o tempo é a soma das sessões mais o plano e a revisão.

