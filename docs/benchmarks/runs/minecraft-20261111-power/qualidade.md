# Qualidade e complexidade das entregas (rodadas 1 a 3)

Medido em 11/11/2026 sobre o `src/` de cada run, com script de contagem (linhas sem branco, arquivos, funções,
desvios por mil linhas, maior função, comentários) e busca por cada item da seção "Interface e jogabilidade" do
`task.md`.

## Resultado por run

| run | entregou | ocultos | custo | tempo | features da UI | arquivos | linhas | maior arquivo | maior função | desvios/kloc | comentários |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r1 padrão | sim | 55/55 | US$ 1,49 | 473 s | 30/30 | 26 | 1775 | `render/game.js` 360 | 74 linhas | 209 | 40 |
| r1 `--power` | sim | 55/55 | US$ 9,62 | 1617 s | 30/30 | 29 | 3831 | `game/Game.js` 753 | 124 linhas | 153 | 223 |
| r1 `--power max` | não | 55/55 | US$ 6,78 | 1020 s | 12/30 | 16 | 1871 | `engine/world.js` 283 | 106 linhas | 183 | 187 |
| r2 padrão | sim | 55/55 | US$ 1,83 | 637 s | 29/30 | 24 | 2265 | `render/game.js` 396 | 81 linhas | 157 | 69 |
| r2 `--power` | sim | 55/55 | US$ 7,70 | 1196 s | 30/30 | 26 | 3020 | `game/Game.js` 600 | 126 linhas | 157 | 202 |
| r2 `--power max` | **não** | 55/55 | US$ 11,15 | 1598 s | 30/30 | 29 | 3728 | `game/Game.js` 478 | 228 linhas | 162 | 165 |
| r3 padrão | sim | 55/55 | US$ 1,66 | 572 s | 30/30 | 28 | 2257 | `game/GameController.js` 392 | 85 linhas | 171 | 63 |
| r3 `--power` (opus/opus) | sim | 55/55 | US$ 12,95 | 2079 s | 28/30 | 28 | 4287 | `render/atlas.js` 642 | 58 linhas | 130 | 348 |
| r3 `--power max` (opus/opus) | sim | 55/55 | US$ 10,79 | 1852 s | 27/30 | 29 | 4386 | `ui/styles.css` 478 | 96 linhas | 144 | 272 |
| r4 padrão | sim | 55/55 | US$ 1,75 | 585 s | 27/30 | 29 | 2431 | `ui/gameRuntime.js` 378 | 85 linhas | 154 | 80 |
| r4 `--power` (sonnet/sonnet) | sim | 55/55 | US$ 6,14 | 1175 s | 27/30 | 27 | 2489 | `__tests__/engine-contract.test.js` 454 | 95 linhas | 149 | 121 |
| r4 `--power max` (sonnet/sonnet) | sim | 55/55 | US$ 2,75 | 618 s | 28/30 | 30 | 2264 | `render/atlas.js` 212 | 70 linhas | 151 | 81 |
| r5 padrão | sim | 55/55 | US$ 1,34 | 477 s | 29/30 | 28 | 2206 | `game/controller.js` 479 | 82 linhas | 185 | 62 |
| r5 `--power` (sonnet/sonnet) | sim | 55/55 | US$ 3,75 | 741 s | 28/30 | 26 | 2524 | `game/Game.jsx` 346 | 165 linhas | 160 | 97 |
| r5 `--power max` (sonnet/sonnet) | sim | 55/55 | US$ 3,15 | 740 s | 30/30 | 29 | 2718 | `render/textures.js` 307 | 92 linhas | 164 | 169 |

- "features da UI" são os 30 itens da spec de interface achados no código (menu, slider, descarga de chunks, atlas,
  céu, controles, mineração com rachadura, construção, hotbar, inventário, pausa, F3, HUD, save). O único item sem
  confirmação no r2 padrão é a água semitransparente (o r1 padrão faz pela alpha da textura no atlas).
- O r1 `--power max` só entregou o motor: `main.jsx` ficou o do esqueleto ("em construção"). Os 12/30 são itens
  que o `render/` dele já tinha, sem tela que os use.
- O r2 `--power max` tem todas as features no código, mas o jogo não abre: em `src/game/Game.js`, `function save()`
  tem o mesmo nome do parâmetro `save` de `createGame` e o sobrescreve, então `if (save)` é sempre verdadeiro e
  "Novo mundo" cai em "save inválido". Gate verde (11/11 visíveis, build) e 55/55 ocultos não cobrem a tela; o
  executor do último passo e o conserto escreveram "I never ran the game".
- Testes próprios além dos visíveis: r1 `--power` (`src/engine/contract.test.js`, 15) e r3 padrão (9, no `test/`).
- O r3 padrão (código com a correção do symlink) fechou em uma sessão só do Sonnet, sem raia perdida.
- O r3 `--power` (Opus nos passos medium e high, `GRAPHENG_POWER_SPLIT=opus/opus`) fechou sem raia perdida, em
  duas sessões, mas foi a run mais cara e mais lenta de todas: a hipótese de que o custo extra vinha só das raias
  perdidas não se confirmou. Funções menores (58 linhas na maior) e 348 comentários (um a cada 12 linhas).
- O r3 `--power max` (opus/opus) é o primeiro `--power max` que abre e joga: 5 ondas, uma sessão Opus por onda, sem
  raia perdida e sem conserto. Ainda assim custou 6,5 vezes o padrão da mesma rodada.
- O r4 `--power` (Sonnet nos medium e high, `GRAPHENG_POWER_SPLIT=sonnet/sonnet`) é o Power Mode mais barato até
  aqui, e o código saiu do tamanho do padrão (2489 linhas, 454 delas num teste de contrato próprio). Uma raia do
  Sonnet devolveu BLOCKED sem rodar o gate depois de ter um `cat > arquivo` negado no Bash; o conserto no Opus
  (US$ 2,29) foi um terço do custo da run.
- O r4 `--power max` (sonnet/sonnet) é a melhor run do Power Mode: 5 ondas sem raia perdida, sem advisor e sem
  conserto, US$ 2,75 em 618 s, com código do tamanho e da forma do padrão (2264 linhas, 81 comentários, maior
  função 70 linhas). O custo extra sobre o padrão (US$ 1,00) é o plano do Fable e a revisão.
- O r5 `--power` (sonnet/sonnet) perdeu o gate 1 porque a raia da onda 2 devolveu DONE com `world.js` ainda no
  stub (escreveu os outros dois passos da raia e não rodou `npm test`); o conserto no Opus custou US$ 0,95.

## Leitura

**Funcionalidade.** Nas runs que entregaram, padrão e `--power` cobrem a spec inteira. O `--power max` não entregou jogo jogável em nenhuma das duas rodadas (r1 sem UI; r2 com UI que não abre). Não há feature que o
Power Mode tenha feito e o padrão não.

**Tamanho.** O `--power` escreve de 1,3 a 2,2 vezes mais linhas para a mesma spec. A diferença está na camada de
jogo (`game/Game.js` com 600 a 750 linhas, contra 360 a 400 do padrão) e em comentários (200+ contra 40 a 70):
o Opus documenta cada método e cria mais camadas (controls, save, input, tiles). O motor também fica maior (1100 a
1500 linhas contra 650 a 800) sem ganhar teste oculto.

**Complexidade.** O padrão tem funções menores (maior função com 74 a 81 linhas, contra 124 a 126 no power) e
arquivos menores. O power tem menos desvios por mil linhas, mas em boa parte porque dilui em comentários e
código de infraestrutura. Nenhuma run deixou TODO ou `console.log` de depuração (o r1 power tem 3 `console.*`).

**Organização.** As quatro runs entregues têm a mesma arquitetura: motor puro, `render/` com three.js,
`ui/` em React e uma classe `Game` que liga tudo. O power separa mais arquivos (`game/controls.js`,
`game/save.js`, `render/BlockHighlight.js`); o padrão concentra na classe `Game` e no `chunkManager`.
Limpeza de recursos (`dispose`) existe em todas.

**Conclusão até aqui.** Com a mesma nota de aceite e a mesma cobertura de features, o Power Mode custou 4 a 7
vezes mais e levou 2 a 3 vezes mais tempo, e o código saiu maior e mais comentado, não mais simples. O custo extra
das rodadas 1 e 2 veio de raias perdidas por bugs do graph-eng (Write negado), já corrigidos antes da rodada 3.
A rodada 3 em diante é que diz se, sem esses bugs, o Power Mode fica mais perto do padrão em custo.
