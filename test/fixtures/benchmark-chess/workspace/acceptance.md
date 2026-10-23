# Aceites (executados fora do workspace)

Os aceites ficam em `acceptance/` do benchmark e são copiados para uma pasta temporária
somente na avaliação externa. Não estão no workspace e o agente não os vê.

- perft da posição inicial (profundidade 1 a 4), da Kiwipete (1 a 3) e das posições 3 (1 a 4), 4, 5 e 6 (1 a 3)
  da página Perft Results da Chess Programming Wiki.
- FEN: ida e volta preserva os seis campos; FEN malformada lança erro.
- Lances legais da posição inicial, em UCI e ordenados.
- `applyMove`: avanço duplo e relógios, captura en passant, roque (e roque proibido por casa atacada),
  perda de direito por torre capturada, promoção, recusa de lance ilegal (peça cravada).
- `gameStatus`: em andamento, xeque, xeque-mate e afogamento.
