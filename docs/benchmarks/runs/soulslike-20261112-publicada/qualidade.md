# Souls-like com o `--power` publicado (1.4): uma run de validação

Run feita em 12/11/2026 no código `f8e1a7f` do graph-eng, logo depois de a 1.4 fixar a configuração única do
Power Mode: o Fable 5.2 planeja, revisa e aconselha, o Sonnet pega todas as raias, o Opus só entra no conserto.
Mesmo `task.md` da segunda rodada (ambientação, contrato fixado), mesmos 66 testes ocultos. Sem
`GRAPHENG_POWER_SPLIT`: é o `--power` como sai da caixa.

## Resultado

| Run | Status | Ocultos (66) | tsc / build | Custo | Tempo | Sessões |
| --- | --- | --- | --- | --- | --- | --- |
| `--power` (1.4 publicada) | done | 66/66 | ok / ok | US$ 3,69 | 746 s | 4 raias DONE (369, 124, 77, 46 s), sem conserto |

**Custo por modelo.** Médio (Sonnet) US$ 2,11; Fable 5.2 US$ 1,58 (plano e revisão). Nenhuma chamada ao advisor.
A revisão do plano devolveu `REVISE` com notas que as raias aplicaram.

**O que as mudanças da 1.4 fizeram nesta run.** O plano saiu em 4 ondas (5 raias no total, porque a onda 1 tinha
passos `high` e `medium` que o `powerWaves` juntou numa raia só do Sonnet, já que agora os dois vão para o mesmo
modelo). Três comandos de shell foram negados nas raias: um `cd … && python3`, um `cat > /tmp/p.py` e um
`cat > src/App.tsx <<'EOF'` (heredoc para gravar três arquivos de uma vez). Nenhuma raia perdeu a escrita nem
devolveu `BLOCKED`: as três seguiram com `Write` e `Edit`, como o prompt agora manda, e a regra de escrita pelo
caminho absoluto manteve o `Write` liberado depois do `cd` negado. A segunda tentativa da raia `BLOCKED` e o
conserto preso ao contrato não chegaram a ser acionados, porque não houve `BLOCKED` nem gate vermelho.

Comparado com a segunda rodada (mesma tarefa, 11/11): a run ficou entre o `--power` (US$ 3,37, 856 s) e o
`--power max` (US$ 4,12, 913 s) de então em custo, e foi a mais rápida das três runs do Power Mode nesta tarefa
(746 s, 1,2 vezes o padrão de 641 s). Em custo, 1,8 vezes o padrão (US$ 2,04).

## Código

| Run | Arquivos | Linhas | engine / render / game / ui | Maior função | Comentários | any / cast / `!` | Testes próprios | Spec UI (37) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| padrão (11/11) | 22 | 2767 | 981 / 1152 / 303 / 280 | 373 linhas (`scenery.ts`) | 69 | 0 / 0 / 0 | 0 | 33/37 |
| `--power max` (11/11) | 26 | 3752 | 1022 / 2061 / 0 / 508 | 240 linhas (`game.ts`) | 161 | 0 / 0 / 0 | 0 | 36/37 |
| `--power` (1.4 publicada) | 25 | 3431 | 992 / 1804 / 0 / 291 | 285 linhas (`game.ts`) | 96 | 0 / 0 / 0 | 0 | 36/37 |

Motor do mesmo tamanho (992 linhas), 24 % mais código que a padrão, quase todo em `render/` (cenário), e menos
comentário que as runs do Power Mode de 11/11 (96 contra 161). Cobre 36 dos 37 itens da spec de interface; o
único que falta no texto do código é a luz direcional com sombra (a cena usa luz ambiente, pontual e hemisférica).
Sem `any`, cast, `!` ou `@ts-ignore`; sem teste além dos 8 visíveis.

## Smoke no navegador (capturas nesta pasta)

`power-titulo.jpg`: título com seed editável e "Pressione qualquer tecla". `power-patio.jpg`: pátio noturno com
pilares, muros com musgo, árvores de outono, grama, pedras, fogueira com brasas, porta de névoa ao fundo, dois
hollows, e o cavaleiro de elmo, armadura, escudo e espada, com "Descansar [E]" sobre a fogueira. `power-lockon.jpg`:
lock-on com retículo no hollow depois de andar, atacar (leve e pesado) e rolar, com a estamina gasta na barra.
`power-pausa.jpg`: menu de pausa com "Continuar" e "Voltar ao título". Console sem erro em nenhum passo. Não
verificado na tela: porta de névoa e minotauro (os testes ocultos da porta e do chefe passam).
