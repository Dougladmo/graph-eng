FIX

1. **A chave do OpenRouter vaza para os agentes filhos.** Em `bin/hosts.mjs:302` o spawn é feito sem a opção `env`, então o processo filho herda o `process.env` inteiro. Com `OPENROUTER_API_KEY` no ambiente (§6), todo agente lançado (inclusive o executor, que tem permissão de escrita) consegue ler a chave e gravá-la em arquivo, commit ou saída.
   - Montar um `env` filtrado no spawn: tirar `OPENROUTER_API_KEY` e qualquer variável `GRAPH_ENG_TRIAGE_*`/`GRAPH_ENG_HOME` que aponte para segredo. Fazer o mesmo no check confiável e no benchmark.
   - Teste de regressão no passo 5: com o fake spawn, conferir que nenhuma variável de segredo chega ao filho.
   - Ampliar o teste 41 para cobrir também o env do filho e o diff da run.

2. **D4 contradiz §4.** D4 diz que só o runner grava eventos `triage.*`, mas §4 faz `refineTierAfterPlan` e `escalateTier`, que rodam no engine, emitirem `triage.escalated` com um `triageHash` calculado pelo próprio engine. Do jeito que está, o engine consegue forjar uma escalada, por exemplo `to:'fast'`, com um hash que ele mesmo inventou.
   - Fixar que o engine só **solicita** a escalada pelo canal de controle. O runner valida e grava.
   - O runner deve conferir três coisas: `from` igual ao tier vigente, `to` estritamente maior que `from`, e `prevHash` igual ao hash vigente (cadeia). O `triageHash` novo é calculado pelo runner.
   - Testes: escalada com `to <= from`, com `prevHash` errado ou emitida direto pelo engine é recusada.

3. **`triageHash` não está amarrado à run.** Hoje é `sha256({tier, floor, source, reasonCodes})`, então duas runs com a mesma classificação têm hash idêntico, e um hash de outra run ou de outro journal passa como válido.
   - Incluir `runId` (ou o identificador do journal), o `planningKey` e o `seq` do evento no canônico.
   - O teste 25 deve cobrir o hash copiado de outra run.

4. **Proveniência sintética se perde no reuso de artefatos.** `validateArtifact` (`phase-artifacts.mjs:126`) é puro e não tem acesso ao journal, então a frase "aceita `synthetic:true` se o `triageHash` bater com o journal" não é implementável ali. Além disso, um tasks publicado com plan-review sintético no tier fast pode ser reutilizado depois pelo estágio `implement` (`decidePipelineStages`, `:366`) numa run com tier maior ou com adaptive off, sem revisão real.
   - Gravar no próprio artefato publicado o registro `{synthetic, kind, tier, triageHash, runId}`.
   - `validateArtifact` só valida a forma desse registro. A checagem contra o journal fica no runner, no momento da publicação.
   - Definir em `resolveReuse` que um artefato com aprovação sintética só é reutilizável com adaptive on e com tier vigente dentro de `SYNTHETIC_ALLOWED`. Fora disso, o artefato é recusado (código novo, por exemplo `reuse_synthetic_approval`) ou obriga plan-review real.
   - Testes: reuso com adaptive off, reuso com tier standard e reuso válido em fast.

5. **Escalada depois do tasks já publicado.** Na cascata fast para standard (§4), o tasks já saiu com `tasks-approved` baseado no voto sintético. O design não diz o que acontece com esse artefato depois do plan-review real.
   - Ou republicar o tasks com o voto real (novo `tasks-approved` aceito somente depois de `triage.escalated`), ou marcar o slot como superado para ele não ser reutilizado.
   - Teste junto com o 33.

6. **Mudança de labels e o resume de checkpoints antigos.** A mudança `work:` para `research:`/`design:`/`notes` muda as chaves de provenance e de `restoreProvenanceFrontier` (`graph-run.mjs:1240-1265`).
   - Declarar que o resume de checkpoints anteriores à mudança é recusado com código explícito (o `workflowSourceHash` já muda) e não migrado, e testar isso.
   - Se a ideia for migrar, `migrateLedger` também precisa mapear os labels antigos.
   - Confirmar que o voto `verifier` exigido em `:1257` continua sendo procurado só em transições de implement e polish com os labels novos.

7. **Tier e effort se misturam.** §8 usa "largura por tier (`EFFORT_POLICY`)", mas `EFFORT_POLICY` é indexado por effort (low, medium, max) e os tetos de nó do tier (fast 2, standard 4) convivem com `EFFORT_NODE_CAP`.
   - Definir uma tabela única de interação, por exemplo largura e teto efetivos = `min(tier, effort)`.
   - Dizer o que `effort=low` faz com os papéis fortes. §2 só cobre o padrão e o max.
   - Teste de que o tier nunca aumenta largura nem teto além do effort pedido.

8. **Adaptive diferente entre o início e o resume.** Hoje só o caso "on sem evento" está coberto (`resume_triage_missing`). Fixar que o valor do journal manda e que divergir dele bloqueia com código próprio, nos dois sentidos (começou on e retomou off, e o contrário). Incluir no teste 27.

Itens sem ressalva: layout 3b com `PIPELINE_PAIRS` intacto, verify, check window e gate final nunca pulados, tier fora do `planningKey`, merge do classificador que só sobe, ativação opt-in, benchmark pré-registrado com braço D, e regras para a árvore suja e para commits.