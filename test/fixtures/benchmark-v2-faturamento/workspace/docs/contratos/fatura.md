# `src/fatura.mjs`

Depende de `dinheiro`, `datas`, `cambio`, `impostos`, `descontos` e `validacao`.

## `gerarFatura(pedido, contexto)`

`contexto` é o objeto de `carregarContexto()` (ver `dados.md`).

Pedido:

```js
{
  id, emissao, uf, moeda,           // ver validacao.md
  cupom,                            // opcional
  prazoDiasUteis,                   // opcional, padrão 5
  itens: [{ sku, categoria, quantidade, preco }] // preco: texto pt-BR na moeda do pedido
}
```

Passos, nesta ordem:

1. `validarPedido`. Com erro: lança `Error` com `code = 'PEDIDO_INVALIDO'` e
   `erros` = o array devolvido.
2. Subtotal de cada item, em BRL: `converterParaBRL(paraCentavos(preco) * quantidade, moeda, emissao, cambio)`.
   A conversão é **por item** (cada item arredonda uma vez), não no total.
3. Subtotal da fatura: soma dos subtotais dos itens.
4. Desconto: `calcularDesconto(subtotalDaFatura, cupom, emissao, cupons)`, rateado entre os
   itens com `ratear(desconto, subtotaisDosItens)`.
5. Base do item = subtotal do item − desconto do item.
   Imposto do item = `impostoDoItem(base, uf, categoria, impostos)`.
   Total do item = base + imposto.
6. Vencimento: `somarDiasUteis(emissao, prazoDiasUteis ?? 5, feriados)`.

Erros de `cambio` (`SEM_TAXA`, `MOEDA_INVALIDA`) e de `impostos` (`UF_DESCONHECIDA`)
propagam sem tratamento.

Retorno:

```js
{
  id, emissao, vencimento, uf,
  itens: [{ sku, subtotal, desconto, imposto, total }], // na ordem do pedido
  subtotal, desconto, imposto, total,                    // somas dos itens
  avisos                                                 // [] ou [aviso de calcularDesconto]
}
```
