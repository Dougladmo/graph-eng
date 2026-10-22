# `src/descontos.mjs`

Depende de `dinheiro`.

Tabela: `data/cupons.json`: código → `{ tipo, valor, inicio, fim }`.
`tipo` é `'percentual'` (`valor` em pontos-base sobre o subtotal) ou `'fixo'` (`valor` em
centavos). `inicio` e `fim` são datas **inclusivas**.

## `calcularDesconto(subtotal, codigo, data, cupons)`

Devolve `{ desconto, aviso }`.

- Sem cupom (`undefined`, `null` ou `''`): `{ desconto: 0, aviso: null }`.
- Código inexistente: `{ desconto: 0, aviso: 'CUPOM_INEXISTENTE' }`. Não é erro.
- `data` fora de `[inicio, fim]`: `{ desconto: 0, aviso: 'CUPOM_EXPIRADO' }`. Não é erro.
- Percentual: `arredondar(subtotal * valor, 10000)`.
- Fixo: o menor entre `valor` e `subtotal`. O desconto nunca passa do subtotal
  (não existe crédito).

## `ratear(total, pesos)`

Divide `total` centavos entre os itens, proporcional a `pesos` (inteiros `>= 0`), pelo
método do **maior resto**:

1. Cada item recebe o piso de `total * peso / somaDosPesos`.
2. Os centavos que sobram vão, um por item, para os itens com maior resto da divisão
   do passo 1. Empate de resto: vai para o item de **menor índice**.
3. A soma do resultado é sempre exatamente `total`.

- Soma dos pesos igual a zero: todos recebem `0`.
- Exemplo: `ratear(100, [1, 1, 1])` → `[34, 33, 33]`.
- Exemplo: `ratear(10, [3, 3, 4])` → `[3, 3, 4]`.
