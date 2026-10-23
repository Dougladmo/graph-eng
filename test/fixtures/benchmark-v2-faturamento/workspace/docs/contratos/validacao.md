# `src/validacao.mjs`

Depende de `dinheiro` e `datas`.

## `validarPedido(pedido)`

Devolve um array de códigos de erro; array vazio quer dizer pedido válido. Nunca lança.
Cada código aparece no máximo uma vez, **nesta ordem**:

1. `ID_AUSENTE`: `id` não é string ou só tem espaços.
2. `DATA_INVALIDA`: `emissao` não passa em `ehDataValida`.
3. `UF_INVALIDA`: `uf` não são exatamente duas letras maiúsculas. A existência da UF na
   tabela de impostos **não** é conferida aqui (ver `impostos.md`).
4. `MOEDA_INVALIDA`: `moeda` não é `'BRL'`, `'USD'` nem `'EUR'`.
5. `ITENS_VAZIOS`: `itens` não é array ou está vazio.
6. `QUANTIDADE_INVALIDA`: algum item com `quantidade` que não seja inteiro positivo.
7. `PRECO_INVALIDO`: algum item com `preco` que `paraCentavos` recusa, ou negativo.
   Preço zero é válido.

`pedido` pode vir `null` ou sem campos: devolve os códigos correspondentes, sem lançar.
