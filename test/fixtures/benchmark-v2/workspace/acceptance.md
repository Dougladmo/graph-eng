# Aceites (executados fora do workspace)

Os aceites ficam em `acceptance/` do benchmark e são copiados para uma pasta temporária
somente na avaliação externa. Não estão no workspace e o agente não os vê.

- A normal: `'  João  '` vira `'João'`.
- A vazio: `''` e `'   '` viram `''`.
- A acento: `' São Paulo  '` vira `'São Paulo'`; `'ação'` continua `'ação'`.
- B normal: `[1, 2, 3]` soma `6`.
- B vazio: `[]` soma `0`. Acento não se aplica a B.
- C normal: `'  João  '` vira `'Registro: João'`.
- C vazio: `''` e `'   '` viram `'Registro: (vazio)'`.
- C acento: `' São Paulo '` vira `'Registro: São Paulo'`.
- Integração A→C: `textoPublico(x)` usa exatamente a saída de `normalizarRegistro(x)`.
