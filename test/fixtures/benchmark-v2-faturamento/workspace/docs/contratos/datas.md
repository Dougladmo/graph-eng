# `src/datas.mjs`

Sem dependências. Todas as datas em UTC (ver `00-convencoes.md`).

## `ehDataValida(texto)`

- `true` só para string no formato `AAAA-MM-DD` que seja data real do calendário.
- `'2026-02-29'` é inválida (2026 não é bissexto); `'2028-02-29'` é válida.
- `'2026-1-05'`, `'2026-13-01'`, `'05/01/2026'`, `null` e números são inválidos.

## `ehDiaUtil(data, feriados)`

- `false` para sábado, domingo e para qualquer data presente na lista `feriados`
  (array de strings `AAAA-MM-DD`, como `data/feriados.json`).

## `somarDiasUteis(data, n, feriados)`

`n` é inteiro `>= 0`.

- `n = 0`: devolve `data` se ela for dia útil; senão, o próximo dia útil.
- `n > 0`: devolve o `n`-ésimo dia útil **estritamente depois** de `data`. A própria `data`
  nunca conta, mesmo que seja dia útil.
- Exemplos com os feriados de `data/feriados.json`:
  - `('2026-01-05', 1)` → `'2026-01-06'` (segunda → terça).
  - `('2026-01-09', 1)` → `'2026-01-12'` (sexta → segunda).
  - `('2026-01-03', 0)` → `'2026-01-05'` (sábado → segunda).
  - `('2026-02-13', 1)` → `'2026-02-18'` (sexta; 16 e 17/02 são feriados de Carnaval).
