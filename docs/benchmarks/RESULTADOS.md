# Resultados das runs reais

Gerado por `node bin/graph-benchmark.mjs archive`. Não edite à mão. Leitura e contexto: `docs/validation/graph-eng-2-benchmark.md`.

| run | cenário | host | variante | status | motivo | reportedStatus | externo | falso DONE | chamadas | custo | motor (s) | maior contexto | entrada / saída |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bench-claude-chess-20261021143235-733f | chess | claude | adaptive | PASS | — | DONE | PASS 15/15 | false | 34 | US$ 1.83 | 1315 | 143k | 1858k / 220k |
| bench-claude-chess-20261021143235-733f | chess | claude | single-agent | PASS | — | DONE | PASS 15/15 | false | 2 | US$ 0.80 | 261 | 80k | 146k / 24k |
| bench-claude-chess-20261021163158-152b | chess | claude | adaptive | PASS | — | DONE | PASS 15/15 | false | 20 | US$ 0.68 | 575 | 113k | 780k / 87k |
| bench-claude-chess-20261021163158-152b | chess | claude | single-agent | PASS | — | DONE | PASS 15/15 | false | 2 | US$ 0.70 | 180 | 111k | 195k / 19k |
| bench-claude-chess-20261021195304-0a58 | chess | claude | adaptive | PASS | — | DONE | PASS 15/15 | false | 9 | US$ 0.39 | 322 | 125k | 416k / 58k |
| bench-claude-chess-20261021195304-0a58 | chess | claude | single-agent | BLOCK | single_agent_checks_failed | BLOCKED | PASS 15/15 | false | 3 | US$ 0.86 | 218 | 106k | 271k / 21k |
| bench-claude-faturamento-20261021163158-7b6f | faturamento | claude | adaptive | PASS | — | DONE | PASS 31/31 | false | 18 | US$ 0.73 | 856 | 624k | 2463k / 170k |
| bench-claude-faturamento-20261021163158-7b6f | faturamento | claude | single-agent | PASS | — | DONE | PASS 31/31 | false | 1 | US$ 0.51 | 105 | 144k | 144k / 12k |
| bench-claude-faturamento-20261021201806-6fac | faturamento | claude | adaptive | BLOCK | engine_blocked | BLOCKED | PASS 31/31 | false | 20 | US$ 1.53 | 730 | 215k | 1677k / 125k |
| bench-claude-faturamento-20261021201806-6fac | faturamento | claude | single-agent | PASS | — | DONE | PASS 31/31 | false | 1 | US$ 0.49 | 109 | 107k | 107k / 13k |
| bench-claude-faturamento-20261021204352-5407 | faturamento | claude | adaptive | PASS | — | DONE | PASS 31/31 | false | 21 | US$ 0.96 | 618 | 277k | 1548k / 105k |
| bench-claude-happy-20261020172233-a14f | happy | claude | v1-normalized | BLOCK | engine_blocked | BLOCKED | FAIL 1/10 | false | 9 | US$ 64.96 | 1149 | 3068k | 19252k / 116k |
| bench-claude-happy-20261020172233-a14f | happy | claude | adaptive | BLOCK | plan_review_failed_or_invalid | BLOCKED | FAIL 1/10 | false | 2 | US$ 22.84 | 171 | 3019k | 3839k / 16k |
| bench-claude-happy-20261020180329-e669 | happy | claude | v1-normalized | BLOCK | engine_blocked | BLOCKED | FAIL 1/10 | false | 10 | US$ 0.55 | 208 | 67k | 382k / 30k |
| bench-claude-happy-20261020180329-e669 | happy | claude | adaptive | BLOCK | plan_stage_research_incomplete | BLOCKED | FAIL 1/10 | false | 5 | US$ 0.42 | 94 | 73k | 195k / 15k |
| bench-claude-happy-20261020184133-7197 | happy | claude | v1-normalized | PASS | — | PARTIAL | PASS 10/10 | false | 10 | US$ 0.46 | 230 | 82k | 409k / 35k |
| bench-claude-happy-20261020184133-7197 | happy | claude | adaptive | BLOCK | provenance_unsealed_window:I1 | BLOCKED | FAIL 4/10 | false | 10 | US$ 0.68 | 176 | 39k | 302k / 21k |
| bench-claude-happy-20261021005926-8c6c | happy | claude | v1-normalized | PASS | — | PARTIAL | PASS 10/10 | false | 10 | US$ 0.57 | 228 | 87k | 383k / 34k |
| bench-claude-happy-20261021005926-8c6c | happy | claude | adaptive | BLOCK | CLI_FAILED | BLOCKED | FAIL 1/10 | false | 8 | US$ 0.57 | 176 | 45k | 183k / 14k |
| bench-claude-happy-20261021010744-b343 | happy | claude | v1-normalized | PASS | — | PARTIAL | PASS 10/10 | false | 10 | US$ 0.47 | 223 | 82k | 396k / 33k |
| bench-claude-happy-20261021010744-b343 | happy | claude | adaptive | BLOCK | provenance_frontier_changed_before_window | BLOCKED | PASS 10/10 | false | 16 | US$ 0.61 | 229 | 46k | 508k / 29k |
| bench-claude-happy-20261021012200-0d8d | happy | claude | v1-normalized | PASS | — | PARTIAL | PASS 10/10 | false | 10 | US$ 0.43 | 222 | 62k | 420k / 33k |
| bench-claude-happy-20261021012200-0d8d | happy | claude | adaptive | BLOCK | plan_effort_mismatch | BLOCKED | FAIL 1/10 | false | 7 | US$ 0.49 | 123 | 48k | 189k / 15k |
| bench-claude-happy-20261021013235-7df4 | happy | claude | v1-normalized | PASS | — | PARTIAL | PASS 10/10 | false | 10 | US$ 0.45 | 233 | 128k | 479k / 35k |
| bench-claude-happy-20261021013235-7df4 | happy | claude | adaptive | BLOCK | no_progress_feedback_loop | BLOCKED | FAIL 1/10 | false | 7 | US$ 0.45 | 124 | 39k | 202k / 16k |
| bench-claude-happy-20261021014324-0e5c | happy | claude | v1-normalized | PASS | — | PARTIAL | PASS 10/10 | false | 10 | US$ 0.37 | 239 | 87k | 537k / 42k |
| bench-claude-happy-20261021014324-0e5c | happy | claude | adaptive | BLOCK | original_plan_criteria_changed | BLOCKED | FAIL 1/10 | false | 8 | US$ 0.65 | 151 | 55k | 243k / 18k |
| bench-claude-happy-20261021020006-99b1 | happy | claude | v1-normalized | PASS | — | PARTIAL | PASS 10/10 | false | 10 | US$ 0.36 | 226 | 85k | 467k / 37k |
| bench-claude-happy-20261021020006-99b1 | happy | claude | adaptive | BLOCK | critic_done_evidence_invalid | BLOCKED | FAIL 1/10 | false | 5 | US$ 0.29 | 71 | 32k | 132k / 9k |
| bench-claude-happy-20261021021437-6ab6 | happy | claude | v1-normalized | PASS | — | PARTIAL | PASS 10/10 | false | 10 | US$ 0.39 | 257 | 126k | 568k / 41k |
| bench-claude-happy-20261021021437-6ab6 | happy | claude | adaptive | BLOCK | provenance_frontier_changed_before_window | BLOCKED | PASS 10/10 | false | 19 | US$ 0.93 | 302 | 42k | 527k / 36k |
| bench-claude-happy-20261021022930-45db | happy | claude | v1-normalized | PASS | — | PARTIAL | PASS 10/10 | false | 10 | US$ 0.47 | 232 | 69k | 428k / 35k |
| bench-claude-happy-20261021022930-45db | happy | claude | adaptive | BLOCK | engine_blocked | BLOCKED | PASS 10/10 | false | 18 | US$ 0.77 | 281 | 52k | 582k / 38k |
| bench-claude-happy-20261021024320-144b | happy | claude | v1-normalized | PASS | — | PARTIAL | PASS 10/10 | false | 10 | US$ 0.46 | 241 | 90k | 491k / 37k |
| bench-claude-happy-20261021024320-144b | happy | claude | adaptive | BLOCK | engine_blocked | BLOCKED | PASS 10/10 | false | 23 | US$ 0.78 | 313 | 42k | 653k / 39k |
| bench-claude-happy-20261021030511-f366 | happy | claude | v1-normalized | PASS | — | PARTIAL | PASS 10/10 | false | 10 | US$ 0.55 | 261 | 99k | 519k / 41k |
| bench-claude-happy-20261021030511-f366 | happy | claude | adaptive | PASS | — | DONE | PASS 10/10 | false | 21 | US$ 0.80 | 292 | 50k | 605k / 36k |
| bench-claude-happy-20261021141749-2efe | happy | claude | single-agent | PASS | — | DONE | PASS 10/10 | false | 1 | US$ 0.15 | 30 | 36k | 36k / 3k |
