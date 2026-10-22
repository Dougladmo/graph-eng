# Convenções comuns a todos os módulos

- Valor monetário é sempre **inteiro em centavos** (`Number`). Nenhum módulo usa ponto
  flutuante para dinheiro.
- Data é sempre string `AAAA-MM-DD`, interpretada em UTC. Comparar datas por string é válido.
- Erro de contrato é um `Error` comum com a propriedade `code` (string em MAIÚSCULAS),
  como `VALOR_INVALIDO`. A mensagem é livre; os testes olham só o `code`.
- Todo arredondamento é **meio-para-par** (arredondamento bancário), feito com
  `arredondar` de `dinheiro` (ver `dinheiro.md`). Nada de `Math.round`.
- Arredondamento acontece **uma única vez** por valor final: não arredonde resultados
  intermediários (ver `impostos.md` e `cambio.md`).
- Ordenação de texto é por ponto de código (`<` e `>` de JavaScript), não por
  `localeCompare`.
