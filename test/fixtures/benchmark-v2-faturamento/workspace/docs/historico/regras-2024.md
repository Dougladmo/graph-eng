# Regras de faturamento de 2024 (SUBSTITUÍDAS)

> Registro histórico. Estas regras **não valem mais**; os contratos vigentes estão em
> `docs/contratos/`. Mantido só para auditoria de faturas antigas.

- Arredondamento meio-para-cima (`Math.round`) em todas as etapas.
- Conversão de moeda no total da fatura, não por item.
- Taxa de câmbio exigida na data exata da emissão; sem taxa, a fatura era recusada.
- Vencimento em dias corridos (`prazo` padrão de 7 dias), sem calendário de feriados.
- Cupom fixo maior que o subtotal gerava crédito (total negativo).
- Desconto rateado pelo número de itens, com a diferença de centavos no último item.
- Alíquota reduzida arredondada para pontos-base inteiros antes de aplicar.
- Relatório separado por vírgula, valores com `R$` e milhar, ordenado só por emissão.
