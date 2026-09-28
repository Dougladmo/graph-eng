# Esqueleto de fases, esforço e teto de agentes, revisão do design, síntese com polimento e config no painel

**Objetivo.** Hoje o graph-eng usa poucos agentes (~8 numa feature), paraleliza pouco e deixa o planner
pular fases: a run que planejou esta spec foi do plano direto para design e implementação, sem pesquisa.

Esta spec traz três mudanças:

- toda run passa a ter um esqueleto de fases fixo, garantido no código. A pesquisa vem antes do design,
  a revisão do design antes de implementar e a revisão da implementação antes da síntese;
- o tamanho do grafo passa a vir de um teto de agentes e de um esforço (low, medium, high, max, manual ou
  auto);
- o painel ganha uma engrenagem com a configuração, e o tema claro/escuro vai para ela.

## Critérios de aceite

1. **Esqueleto de fases.** Toda run tem as fases do seu modo, nesta ordem, e o planner não pode pular
   nenhuma:

   | Modo               | Fases                                                                                                                   |
   | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
   | `implement`        | Plano → Pesquisa → Design → Revisão do design → Implementação → Revisão da implementação (verificação de cada nó + crítica) → Síntese |
   | `architecture`     | Plano → Pesquisa → Design → Revisão do design → Crítica → Síntese                                                       |
   | `research`/`review` | Plano → Pesquisa → Crítica → Síntese                                                                                   |

   - `auto` vira `implement` quando a tarefa muda código. Senão, vira `architecture` ou `research`.
   - A pesquisa vem logo depois do plano. Ela levanta o código, a documentação do repo e as docs externas
     das bibliotecas envolvidas, na versão instalada. Assim o design não parte de premissa errada.
   - O atalho "tarefa trivial = 1 nó, sem crítica nem síntese" deixa de existir.
2. **Trilhos no código.** O workflow valida o plano antes de executar, sem depender de o planner obedecer:
   - plano sem nó de pesquisa ganha um nó de pesquisa de base, na raiz do grafo;
   - nó de design sem pesquisa entre os ancestrais ganha dependência das pesquisas;
   - no modo `implement`, plano sem nó de design ganha um, que depende das pesquisas;
   - nó de implementação sem design entre os ancestrais ganha dependência do design;
   - nó de pesquisa não depende de design nem de implementação: essa dependência cai.

   Cada correção entra no log e aparece no plan gate. Os rounds de gap da crítica são correções pontuais e
   não repetem o esqueleto. Mesmo assim, cada nó desses rounds é verificado, e a crítica roda de novo.
3. **Esforço e teto.** Dois args novos:
   - `effort`: `manual | auto | low | medium | high | max`;
   - `ceiling`: inteiro, do piso até 100.

   **Alvo** de agentes = `max(piso, round(pct × ceiling))`, nunca acima do teto. O pct depende do esforço:
   low 0,2 · medium 0,4 · high 0,7 · max 1,0.
   - **Piso** = 1 agente por fase do esqueleto do modo. Em `implement` são 8: plano, pesquisa, design,
     revisão do design, implementação, verificação, crítica e síntese. Em `architecture` são 6, e em
     `research`/`review`, 4. Teto abaixo do piso é recusado na validação.
   - `manual`: a cada disparo, a skill pergunta o nível (low…max) com AskUserQuestion e mostra quantos
     agentes cada um dá com o teto atual. `--effort` na chamada pula a pergunta.
   - `auto`: o planner escolhe o nível pela complexidade da tarefa e diz por quê. A escolha aparece no plan
     gate e pode ser trocada.
   - Padrão de fábrica, sem config nem flag: `ceiling` 24 e `effort` auto.
   - `maxAgents` continua aceito como sinônimo de `ceiling`.
   - `economy` passa a escolher só os modelos.
   - Este `effort` mede o tamanho do grafo. Ele não se confunde com o esforço de raciocínio de cada agente,
     que continua vindo do papel e do preset.
4. **Dimensionamento.** O planner recebe o alvo e dimensiona o grafo para ele:
   - tarefa complexa (feature, bug com várias partes) ganha vários nós de pesquisa e de design em paralelo,
     de 3 a 5 de cada quando o alvo comporta;
   - tarefa simples fica perto do piso;
   - `max` usa o teto.

   Largura de paralelismo e máximo de nós derivam do alvo, e não mais do preset.
5. **Revisão do design.** Um agente revisor valida o planejamento depois de todos os nós de pesquisa e
   design, e antes do primeiro nó de implementação. Ele confere:
   - as premissas contra a evidência da pesquisa;
   - os critérios de pronto e de aceite;
   - as histórias de usuário;
   - as boas práticas.

   Bloqueio volta como reparo dos nós de design apontados (≤ `maxRepairs`), seguido de nova revisão. A
   implementação não começa com a revisão reprovada. Se a revisão continuar reprovada depois dos reparos,
   a run para antes de implementar, e o relatório leva o bloqueio ao humano.
6. **Rigor e revisão cruzada.** Nenhuma saída segue adiante sem outro agente revisar:
   - todo nó de implementação é verificado por um agente que não o escreveu;
   - pesquisa e design são revisados pela revisão do design. Com esforço high ou max, também são
     revisados um a um;
   - verificador e crítica sempre aplicam a lente de boas práticas: padrões do repo, código suspeito,
     defeitos e segurança. Em nó de implementação, violação é bloqueio;
   - a crítica julga o todo contra os critérios, com os checks.
7. **Implementação em paralelo** quando os nós declaram arquivos disjuntos. Se os arquivos se sobrepõem,
   a raia continua única.
8. **Síntese.** São `ceil(2/3 × nós de implementação)` agentes de polimento, com mínimo de 1 e dentro do
   orçamento. Cada um:
   - cuida de uma área, com arquivos disjuntos das outras;
   - corrige problemas pequenos de qualidade **sem mudar comportamento**;
   - roda os checks e desfaz a própria mudança se algum quebrar.

   Depois, 1 agente consolida o REPORT.md. Em `research` e `review`, que são só leitura, a síntese continua
   com 1 agente.
9. **Config.** O arquivo `~/.claude/graph-eng/config.json` guarda `effort`, `ceiling`, `economy`,
   `planGate`, `maxRounds` e `maxRepairs`. Sem o arquivo, valem os padrões de fábrica.
   - A skill lê a config efetiva e a tabela de alvos por um comando do plugin. A fórmula não é reescrita no
     prompt.
   - Precedência: flag ou parâmetro da skill > arquivo > padrão.
   - Flags novas: `--effort <nível>` e `--ceiling <N>`.
10. **Servidor.** `GET /api/config` e `PUT /api/config` são a única rota de escrita.
    - Exigem Host permitido, `Origin` igual à do painel e `Content-Type: application/json`.
    - O corpo tem limite de tamanho e validação campo a campo. Campo desconhecido ou inválido → 400.
    - A gravação é atômica (tmp + rename).
    - Qualquer outro método ou rota continua 405/404.
11. **Painel.** Um botão de engrenagem na lateral abre um modal na identidade visual atual: card flutuante,
    mesmos tokens, animação de abrir e fechar, Esc fecha e o foco fica preso no modal. Seções:
    - Agentes: teto e esforço, com Manual e Automático explicados, e a prévia "≈ N agentes por run". No
      automático a prévia mostra a faixa; no manual, "você escolhe ao disparar";
    - Modelos: economia;
    - Execução: plan gate sempre, máximo de rounds e máximo de reparos;
    - Aparência: tema escuro.

    O switch de tema sai do rodapé da lateral. O tema continua sendo preferência do navegador.
12. **Visualização.** O `graph-watch` (live, snapshot, events e painel) reconhece os agentes e as fases
    novas:
    - a coluna Pesquisa sempre aparece;
    - a Revisão do design é coluna própria, entre Design e Implementação;
    - nó injetado pelos trilhos aparece marcado;
    - a síntese mostra seus agentes;
    - a estimativa do cabeçalho usa o alvo e o teto novos.
13. **Docs.** SKILL.md, DESIGN.md (as decisões novas e por quê) e README atualizados. A tabela de papéis
    reflete as quantidades novas.
14. **Testes.** `node --test` verde, com testes novos para:
    - a fórmula do alvo e do piso, com a tabela idêntica no workflow e no módulo do painel;
    - os trilhos: plano sem pesquisa ganha pesquisa, implementação sem design ganha dependência, pesquisa
      não depende de design e revisão do design reprovada não deixa implementar;
    - a config: leitura, padrões 24/auto e precedência. PUT com Origin errado → 403, corpo inválido → 400
      e outras escritas → 405;
    - o mapeamento dos agentes novos no modelo.

    O workflow continua com sintaxe válida.

## Fora de escopo

- Mudar o formato do journal do runtime de Workflow.
- Telemetria de custo em dinheiro.
- Editar a config de uma run já em andamento.

## Sempre / perguntar antes / nunca

- Sempre: manter o plugin sem dependências em tempo de execução. Tailwind só em desenvolvimento, com
  `bin/ui/style.css` regerado e versionado.
- Perguntar antes: qualquer rota de escrita além de `/api/config`.
- Nunca: commit, push ou publicar o plugin pelos agentes da run. O commit sai depois, revisado.
