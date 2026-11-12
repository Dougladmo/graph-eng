# Souls-like (ASHEN GATE): qualidade do que cada variante entregou

Uma run de cada variante em 11/11/2026, uma por vez, no código `2159493` do graph-eng (as duas do Power Mode com
`GRAPHENG_POWER_SPLIT=sonnet/sonnet`, a melhor divisão achada no Minecraft). Nota pelos 66 testes ocultos,
`tsc --noEmit` estrito, `npm run build`, smoke no navegador e as métricas de código abaixo (`metrics.mjs`
conta linhas, funções e comentários em `src/`; `features-souls.mjs` procura 30 itens da spec de interface fora de
`src/engine/`).

## Resultado

| Run | Status | Ocultos (66) | Ocultos fora dos 4 ambíguos (62) | tsc / build | Custo | Tempo | Sessões |
| --- | --- | --- | --- | --- | --- | --- | --- |
| padrão | done | 66/66 | 62/62 | ok / ok | US$ 1,57 | 501 s | 2 (barato 45 s, médio 400 s), gate 1 verde |
| `--power` | done | 62/66 | 61/62 (investida do salto) | ok / ok | US$ 7,12 | 1241 s | 4 raias (2 BLOCKED), conserto forte 824 s, gate 2 verde |
| `--power max` | done | 61/66 | 61/62 (investida do chefe) | ok / ok | US$ 3,56 | 702 s | 4 raias DONE, sem conserto, gate 1 verde |

**Os 4 testes ambíguos.** Os ocultos 1, 2 e 47 cobram o FNV-1a sem mistura final e o mulberry32 canônico, com os
valores exatos da referência, e o 33 cobra `maxStamina: 0` no inimigo. O `task.md` dizia só "inteiro de 32 bits",
"um passo de mulberry32" e "vitais do perfil": a padrão passou por ter escolhido a mesma variante da referência; as
duas runs do Power Mode escolheram um hash com mistura final e, na `--power max`, estamina 100 no inimigo. Isso é
falha do benchmark, não da variante. O `task.md` agora fixa os dois algoritmos e a estamina do inimigo; as runs
acima rodaram com o texto antigo, então a coluna "fora dos 4 ambíguos" é a comparação justa. Sobram uma falha real
em cada run do Power Mode: na `--power`, o ataque em salto desce um passo depois do que o contrato diz; na
`--power max`, a investida do chefe não acerta o alvo a 1,4 m.

**Custo por modelo.** Padrão: médio US$ 1,34, forte US$ 0,22 (revisão do plano), barato US$ 0,02. `--power`: forte
US$ 3,15 (só o conserto), Fable 5.2 US$ 2,76 (revisão, advisor, 1 chamada), médio US$ 1,20. `--power max`: médio
US$ 1,93, Fable 5.2 US$ 1,64 (plano e revisão), advisor 0.

**O que aconteceu na `--power`.** A raia da onda 1 (passos 1–5) fez `cd src/engine` no Bash; a partir daí a regra
`Write(./**)` só cobria essa pasta, o `Write` de `src/render/textures.ts` foi negado e a raia devolveu `BLOCKED` em
63 s com só o passo 1 feito. A raia da onda 4 (ligar tudo) achou as pastas vazias e devolveu `BLOCKED` em 11 s. O
conserto no forte (824 s, US$ 3,15) escreveu os 8 arquivos que faltavam e, por conta própria, reescreveu o rng e o
ataque em salto do motor que as raias já tinham certo. Registrado como item 36 em `melhorias-futuras.md`.

## Código

| Run | Arquivos | Linhas | engine / render / game / ui | Maior função | Comentários | any / cast / `!` | Testes próprios | Spec UI |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| padrão | 20 | 2313 | 1001 / 624 / 202 / 472 | 185 linhas (`game.ts` `playingStep`) | 55 | 0 / 0 / 0 | 0 | 27/30 |
| `--power` | 22 | 2845 | 960 / 928 / 513 / 411 | 335 linhas (`environment.ts` `createEnvironment`) | 107 | 0 / 0 / 0 | 0 | 27/30 |
| `--power max` | 21 | 2738 | 1008 / 1000 / 0 / 672 | 308 linhas (`characters.ts`) | 62 | 0 / 0 / 0 | 0 | 28/30 |

Funções acima de 80 linhas: padrão 5 (`playingStep` 185, `createWorld` 180, `Hud` 156, `subStep` 129,
`createInputController` 128); `--power` 5, maiores (`createEnvironment` 335, `createEnemyRig` 255, `substep` 233,
`GameCanvas` 218, `createPlayerRig` 175). Nenhuma run usou `any`, cast `as`, `!`, `@ts-ignore` ou `eslint-disable`;
nenhuma escreveu teste além dos 8 visíveis do esqueleto. A `--power` tem o dobro de comentários pelo mesmo motor,
quase todos cabeçalho de arquivo e explicação do óbvio; a `--power max` fica entre as duas.

**Leitura honesta.** O motor (`src/engine/`) tem o mesmo tamanho nas três (960 a 1008 linhas) porque o contrato
fixa quase tudo. A diferença está na tela: o Power Mode gastou 50 a 60 % mais linhas em `render/` (928 e 1000
contra 624) para cobrir o mesmo número de itens da spec (27, 27 e 28 de 30). Não há módulo melhor separado nem
função menor que justifique: as funções mais longas são do Power Mode. Não dá para dizer que o código do Power Mode
é mais refatorado ou mais fácil de manter; é maior.

## Smoke no navegador

As três abrem, começam com uma tecla, mostram pátio com pilares, fogueira com espada em brasas e partículas, hollows,
porta de névoa ao fundo, HUD (HP, estamina com rastro, frascos, runas), lock-on com retículo e barra de poise do
alvo, guarda, frasco, fogueira (Descansar / Levantar), pausa (Continuar / Voltar ao título), morte (VOCÊ MORREU) e
respawn. Na padrão cheguei à névoa e à sala do chefe (círculo, tochas, barra "Sentinela da Névoa", chefe com
martelo); nas duas do Power Mode o jogador morreu no pátio nas tentativas do roteiro automático antes da porta, e
uma simulação no motor das duas (`walk-sim.mjs`, corrida reta por 7 s) mostra o mesmo comportamento da padrão,
então não é bug da tela: os testes ocultos da porta e do chefe passam nas três. Falha comum às três: a câmera não
desvia de muro nem pilar e a tela fica cinza quando o jogador encosta (a spec não pede colisão de câmera). Na
`--power max` o título quebra em duas linhas encostado à esquerda.
