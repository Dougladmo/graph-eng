# Tarefa do benchmark v2

Implemente os três módulos de `src/` conforme os contratos abaixo.
Não altere `package.json` nem nenhum arquivo fora de `src/`.

## A: `src/a.mjs`
- Exporta `normalizarRegistro(texto)`.
- Remove espaços no início e no fim. Preserva acentos.
- Texto vazio ou só com espaços devolve `''`.

## B: `src/b.mjs` (independente)
- Exporta `somarInteiros(lista)`.
- Soma os inteiros da lista. Lista vazia devolve `0`.

## C: `src/c.mjs` (depende de A)
- Exporta `textoPublico(texto)`.
- Devolve exatamente `'Registro: ' + normalizarRegistro(texto)`.
- Se o registro normalizado for vazio, devolve `'Registro: (vazio)'`.

Critério de pronto: `npm test` passa.
