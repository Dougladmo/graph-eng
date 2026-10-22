# `src/dados.mjs`

Sem dependências de outros módulos.

## `carregarContexto()`

Assíncrona. Lê as quatro tabelas de `data/` e devolve
`{ feriados, cambio, impostos, cupons }`, cada uma com o conteúdo do JSON correspondente
(`feriados.json`, `cambio.json`, `impostos.json`, `cupons.json`), sem transformação.

- O caminho é relativo ao próprio módulo (`new URL('../data/…', import.meta.url)`), não ao
  diretório corrente: a função precisa funcionar com o processo rodando de qualquer pasta.
- `pedidos-exemplo.json` não faz parte do contexto; é só massa de exemplo de pedidos.
