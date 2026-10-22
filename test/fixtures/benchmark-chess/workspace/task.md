# Tarefa do benchmark: gerador de lances de xadrez

Implemente as regras do xadrez em JavaScript puro (ESM, sem dependências) nos quatro módulos de `src/`.
Não altere `package.json` nem nenhum arquivo fora de `src/`. Você pode criar arquivos novos em `src/`.

Notação: posições em FEN padrão (seis campos), lances em UCI (`e2e4`; promoção com a peça minúscula no fim, `e7e8q`).

## `src/fen.mjs`
- `parseFen(fen)` lê a FEN e devolve uma posição (formato interno livre). FEN malformada lança `Error`
  (número de campos, fileiras, casas por fileira, peças e lado a jogar inválidos).
- `toFen(posicao)` devolve a FEN. `toFen(parseFen(f)) === f` para toda FEN válida.

## `src/movegen.mjs` (depende de fen)
- `legalMoves(fen)` devolve os lances **legais** do lado a jogar, em UCI, em ordem alfabética.
- Todas as regras: roque (direitos, casas livres, rei não pode estar, passar nem chegar em xeque),
  en passant (inclusive quando a captura deixaria o próprio rei em xeque), promoção para q, r, b e n,
  peças cravadas, xeque duplo e xeque descoberto.

## `src/game.mjs` (depende de fen e movegen)
- `applyMove(fen, uci)` devolve a FEN depois do lance. Lance ilegal lança `Error`.
  - Casa de en passant: marcada sempre depois de um avanço duplo de peão; `-` nos demais lances.
  - Direitos de roque: saem quando o rei ou a torre se movem, ou quando a torre é capturada na casa de origem.
  - Meio-lance: zera em lance de peão ou captura; senão soma 1. Número do lance soma 1 depois do lance das pretas.
- `gameStatus(fen)` devolve `'ongoing'`, `'check'`, `'checkmate'` ou `'stalemate'`.
  Regras de empate por repetição, 50 lances ou material insuficiente ficam de fora.

## `src/perft.mjs` (depende de fen e movegen)
- `perft(fen, profundidade)` conta as folhas da árvore de lances legais até a profundidade.
  `perft(fen, 0) === 1`. Precisa contar a profundidade 4 da posição inicial (197281) em poucos segundos.

Critério de pronto: `npm test` passa e os valores de perft batem com os publicados
(https://www.chessprogramming.org/Perft_Results).
