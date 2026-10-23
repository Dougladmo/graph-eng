# `src/impostos.mjs`

Depende de `dinheiro`.

Tabela: `data/impostos.json`.

- `aliquotas`: alíquota por UF em pontos-base (`1800` = 18%).
- `isentas`: categorias com imposto zero em qualquer UF.
- `reduzidas`: categoria → fator em pontos-base aplicado **sobre a alíquota**
  (`5000` = metade da alíquota). Categoria fora de `isentas` e `reduzidas` usa fator `10000`.

## `impostoDoItem(base, uf, categoria, tabela)`

- `base` em centavos, já sem desconto (ver `fatura.md`).
- UF sem alíquota na tabela: erro `UF_DESCONHECIDA`. Isso vale também para categoria isenta:
  a UF é conferida primeiro.
- Categoria isenta: `0`.
- Demais: `arredondar(base * aliquota * fator, 10000 * 10000)`. Um único arredondamento:
  **não** calcule a alíquota efetiva arredondada antes nem arredonde em duas etapas.
