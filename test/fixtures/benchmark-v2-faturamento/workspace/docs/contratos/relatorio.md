# `src/relatorio.mjs`

Depende de `dinheiro`. Consome faturas no formato de `fatura.md`.

## `relatorioCSV(faturas)`

Devolve texto CSV.

- Separador de campo `;`. Fim de linha `\n`, inclusive depois da última linha.
- Cabeçalho exato: `id;emissao;vencimento;subtotal;desconto;imposto;total`.
- Uma linha por fatura, ordenada por `vencimento` crescente e, no empate, por `id`
  crescente (ordem de ponto de código; ver `00-convencoes.md`). A entrada não pode ser
  modificada.
- Valores com `formatarDecimal` (sem `R$`, sem milhar): `1234,56`.
- Campo `id` que contenha `;`, `"` ou quebra de linha vai entre aspas duplas, com cada `"`
  interno duplicado: `A;"B"` vira `"A;""B"""`. Os demais campos nunca vão entre aspas.
- Última linha: `TOTAL;;;` seguido das somas de subtotal, desconto, imposto e total,
  formatadas igual.
- Lista vazia: cabeçalho e `TOTAL;;;0,00;0,00;0,00;0,00`.
