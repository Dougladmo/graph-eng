# `src/dinheiro.mjs`

Sem dependências.

## `paraCentavos(texto)`

Converte valor escrito em pt-BR para centavos.

- Aceita só `string`. Qualquer outro tipo: erro `VALOR_INVALIDO`.
- Espaços no início e no fim são ignorados.
- Formato: sinal `-` opcional, parte inteira e, opcionalmente, vírgula com **1 ou 2**
  casas decimais. `'12'` → `1200`; `'12,5'` → `1250`; `'0,07'` → `7`; `'-3,10'` → `-310`.
- Separador de milhar `.` é opcional; se usado, em grupos de exatamente 3 dígitos:
  `'1.234,56'` → `123456`; `'1234,56'` → `123456`; `'12.34'` e `'1.2345'` são inválidos.
- Mais de 2 casas decimais (`'1,005'`), ponto como separador decimal (`'1.5'`), texto vazio
  ou letras: erro `VALOR_INVALIDO`.
- `'-0'` e `'-0,00'` devolvem `0` (nunca `-0`).

## `arredondar(numerador, denominador)`

Divisão de inteiros com arredondamento meio-para-par. `denominador` é inteiro positivo;
`numerador` é inteiro de qualquer sinal.

- Resto menor que a metade: arredonda para baixo (em módulo). Maior: para cima.
- Exatamente a metade: vai para o inteiro **par**. `arredondar(5, 2)` → `2`;
  `arredondar(7, 2)` → `4`; `arredondar(25, 10)` → `2`; `arredondar(35, 10)` → `4`.
- Simétrico no sinal: `arredondar(-5, 2)` → `-2`; `arredondar(-7, 2)` → `-4`.
- Nunca devolve `-0`.
- Precisa ser exato para numeradores até `9 * 10^15` (use `BigInt` se precisar).

## `formatarBRL(centavos)`

- `123456` → `'R$ 1.234,56'`; `0` → `'R$ 0,00'`; `5` → `'R$ 0,05'`.
- Milhar com `.`, decimal com `,`, sempre 2 casas.
- Negativo: `-123456` → `'-R$ 1.234,56'` (sinal antes do `R$`).

## `formatarDecimal(centavos)`

Formato do relatório (ver `relatorio.md`): **sem** `R$` e **sem** separador de milhar.

- `123456` → `'1234,56'`; `0` → `'0,00'`; `-5` → `'-0,05'`.
