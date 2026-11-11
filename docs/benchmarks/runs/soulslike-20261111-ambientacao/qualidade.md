# Souls-like com ambientação (segunda rodada): qualidade do que cada variante entregou

Segunda rodada do souls-like em 11/11/2026, uma run de cada variante, uma por vez, no código `d6af277` do graph-eng,
depois de o `task.md` ganhar a seção visual nova (pátio com árvores de outono, folhas, pedras, grama e muros com
musgo; cavaleiro com armadura, capa, espada e escudo; chefe minotauro com machado; sala do chefe com raízes, ossos e
crânios) e de fixar o hash da seed, o mulberry32 e a estamina do inimigo que a primeira rodada mostrou ambíguos. O
motor e os 66 testes ocultos são os mesmos da primeira rodada. As duas runs do Power Mode usam
`GRAPHENG_POWER_SPLIT=sonnet/sonnet`.

## Resultado

| Run | Status | Ocultos (66) | tsc / build | Custo | Tempo | Sessões |
| --- | --- | --- | --- | --- | --- | --- |
| padrão | done | 65/66 (guarda sem estamina) | ok / ok | US$ 2,04 | 641 s | 1 (médio 583 s), gate 1 verde |
| `--power` | done | 66/66 | ok / ok | US$ 3,37 | 856 s | 4 raias DONE (441, 131, 109, 75 s), sem conserto |
| `--power max` | done | 66/66 | ok / ok | US$ 4,12 | 913 s | 4 raias DONE (185, 364, 176, 52 s), sem conserto |

**Custo por modelo.** Padrão: médio US$ 1,81, forte US$ 0,23 (revisão do plano). `--power`: médio US$ 2,50, Fable 5.2
US$ 0,55 (revisão), forte US$ 0,31 (plano). `--power max`: médio US$ 2,65, Fable 5.2 US$ 1,46 (plano e revisão).
Nenhuma run chamou o advisor.

**Desta vez o Power Mode entregou um pouco mais.** As duas runs do Power Mode passaram os 66 ocultos; a padrão perdeu
um (bloquear sem estamina não quebra a guarda, regra fixada no contrato). Na primeira rodada foi o contrário (padrão
66/66, Power Mode com uma falha real cada), então, com uma run por variante, essa diferença de um teste está dentro
da variação entre runs e não dá para atribuí-la ao modo. O que se repete nas duas rodadas é o custo: o Power Mode
custou 1,7 e 2,0 vezes o padrão e levou 1,3 e 1,4 vezes o tempo. O que mudou de uma rodada para a outra é a
robustez: com o contrato sem ambiguidade e sem o `cd` no Bash, as oito raias das duas runs devolveram `DONE` e
nenhuma precisou de conserto.

## Código

| Run | Arquivos | Linhas | engine / render / game / ui | Maior função | Comentários | any / cast / `!` | Testes próprios | Spec UI (37) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| padrão | 22 | 2767 | 981 / 1152 / 303 / 280 | 373 linhas (`scenery.ts`) | 69 | 0 / 0 / 0 | 0 | 33/37 |
| `--power` | 28 | 3621 | 1004 / 1710 / 0 / 684 | 273 linhas (`environment.ts`) | 161 | 0 / 0 / 0 | 0 | 35/37 |
| `--power max` | 26 | 3752 | 1022 / 2061 / 0 / 508 | 240 linhas (`game.ts`) | 161 | 0 / 0 / 0 | 0 | 36/37 |

O motor continua do mesmo tamanho nas três (981 a 1022 linhas). O Power Mode escreveu 30 a 36 % mais código, quase
todo em `render/` (1710 e 2061 linhas contra 1152): é cenário a mais, não abstração a mais. Cobriu 2 e 3 itens a
mais da spec de interface (o `--power max` é o único com os termos da armadura no código e com os três de luz,
sombra e névoa), e as funções mais longas são menores que a da padrão (273 e 240 linhas contra 373). Em troca,
tem 2,3 vezes mais comentários (161 contra 69), quase todos cabeçalho e explicação do óbvio. Nenhuma run usou
`any`, cast, `!` ou `@ts-ignore`; nenhuma escreveu teste além dos 8 visíveis. **Leitura honesta:** nesta rodada o
código do Power Mode é maior porque faz mais cenário, com funções um pouco menores e mais comentário; não é mais
refatorado nem mais fácil de manter que o da padrão, e também não é pior.

## Smoke no navegador (capturas nesta pasta)

As três abrem com a cena atrás do título, começam com uma tecla e mostram o pátio ambientado: árvores de outono com
copas vermelhas e laranja, tufos de grama, pedras, muros de tijolo com musgo, pilares, lua ou pôr do sol, fogueira
com brasas subindo, porta de névoa ao fundo; o cavaleiro tem elmo com crista, ombreiras, escudo redondo e espada (no
`--power max`, capa vermelha); os hollows são humanoides corcundas com olhos brilhantes e lâmina enferrujada.
Funcionam nas três: andar, correr, esquivar, ataques, guarda, frasco, lock-on com retículo e barra de poise,
fogueira (Descansar / Levantar), pausa, morte e respawn. A olho, o `--power max` é a cena mais rica (céu de pôr do
sol, pedras ao redor da fogueira, capa), a padrão a mais simples; nenhuma é feia. Falha comum às três: a câmera não
desvia de muro nem pilar. Não verificado na tela em nenhuma: névoa e minotauro, porque o roteiro automático morre no
pátio antes da porta (os testes ocultos da porta e do chefe passam nas três). No `--power max`, depois de
"Continuar" pelo clique, o teclado só volta a mover o jogador depois de clicar no canvas.
