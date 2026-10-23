# `src/cambio.mjs`

Depende de `dinheiro`.

Tabela: `data/cambio.json`, no formato `{ "USD": { "AAAA-MM-DD": "5,4321", … }, "EUR": … }`.
A taxa é texto pt-BR com até 4 casas decimais e diz quantos reais vale 1 unidade da moeda.
A tabela só tem dias úteis, e o EUR começa mais tarde que o USD.

## `taxaDoDia(moeda, data, tabela)`

- `moeda = 'BRL'` devolve `'1,0000'` sem consultar a tabela.
- Moeda ausente da tabela: erro `MOEDA_INVALIDA`.
- Usa a taxa da própria `data`; se não houver (fim de semana, feriado, lacuna), a taxa da
  **data anterior mais recente** que exista na tabela.
- Nenhuma data `<= data` na tabela daquela moeda: erro `SEM_TAXA`.

## `converterParaBRL(centavos, moeda, data, tabela)`

- `BRL` devolve `centavos` sem alteração.
- Demais moedas: `centavos × taxa`, com **um único** arredondamento meio-para-par no fim.
  Trate a taxa como inteiro de 4 casas (`'5,4321'` → `54321`) e use
  `arredondar(centavos * taxaInteira, 10000)`. Não converta a taxa para `Number` decimal.
