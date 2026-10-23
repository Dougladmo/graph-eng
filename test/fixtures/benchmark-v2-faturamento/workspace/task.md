# Tarefa do benchmark: faturamento

Implemente os nove módulos de `src/` de um faturador de assinaturas.
Cada módulo tem contrato próprio em `docs/contratos/`. Leia todos antes de começar:
os contratos se referem uns aos outros e às tabelas de `data/`.

Ordem de dependência (quem depende de quem):

- `dinheiro`, `datas` e `dados` não dependem de ninguém.
- `cambio`, `impostos` e `descontos` dependem de `dinheiro`.
- `validacao` depende de `dinheiro` e `datas`.
- `fatura` depende de todos os anteriores, menos `dados`.
- `relatorio` depende de `dinheiro` e consome a saída de `fatura`.

Regras:

- Escreva só em `src/`. Não altere `package.json`, `docs/`, `data/` nem `test/`.
- Vale só o que está em `docs/contratos/`. `docs/historico/` descreve regras antigas,
  substituídas, e está ali só como registro.
- Mantenha as assinaturas exportadas que já existem em `src/`.

Critério de pronto: todos os contratos de `docs/contratos/` atendidos. `npm test` roda os
testes de `test/`, que cobrem só o caminho feliz; passar neles não basta.
