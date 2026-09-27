# Visualização do graph-eng: design

- **Data:** 2026-09-27
- **Status:** proposta, aguardando aprovação do usuário
- **Run que produziu esta spec:** `.graph-runs/20260927-1333-visualizacao-graph-eng/`. A evidência
  detalhada está em `tools-research.md`, `formats-research.md` e `render-design.md`, e os
  protótipos em `proto-*`.

Convenção de evidência: `graph-eng.js:N` quer dizer `workflows/graph-eng.js`, linha N, e
`SKILL.md:N` quer dizer `skills/graph-eng/SKILL.md`, linha N, conferidos em 2026-09-27. Os caminhos
`~/.claude/projects/...` são transcrições reais desta máquina. O que não tem prova vem marcado
**unverified**.

Nomes curtos das runs reais usadas como evidência:

| Apelido | Caminho | O que é |
|---|---|---|
| **wf_b914** | `~/.claude/projects/<projeto-a>/<sessão>/subagents/workflows/wf_b914fcbb-2b8/` | graph-eng completa, formato novo, com 2 rounds |
| **wf_d6d3** | `<projeto-a>/<sessão>/subagents/workflows/wf_d6d3e8d5-e3d/` | graph-eng interrompida (5 linhas, termina em `started work:R2`) |
| **wf_6b49** | `~/.claude/projects/<projeto-b>/<sessão>/subagents/workflows/wf_6b491263-c21/` | formato antigo, sem `label`/`phase` |
| **wf_ba7e** | `~/.claude/projects/<projeto-b>/<sessão>/subagents/workflows/wf_ba7ef654-b21/` | formato novo com 26 `failed`, mas **não é graph-eng** |
| **wf_29e9** | `.../7a137d27-35ef-40f3-92d6-e26bba463b77/subagents/workflows/wf_29e97854-b4a/` | esta própria run (graph-eng, com explore, check vermelho e reparos) |

---

## 1. Contexto e dores

O graph-eng roda como workflow em background. Hoje o usuário só vê o resultado no fim. Ele usa a
CLI no terminal **e** a extensão do VSCode, e tem três dores:

1. **Não vê o grafo.** Não enxerga o estado nem o andamento de cada nó, nem o que cada subagente
   está fazendo. O `mermaid()` (`graph-eng.js:354-368`) só desenha o grafo **final**, dentro do
   REPORT.
2. **Falso "terminei".** O Claude respondia como se o trabalho tivesse acabado enquanto o workflow
   ainda rodava. Hoje a etapa 5 só diz "não faça polling, porque a notificação chega sozinha"
   (`SKILL.md:133-134`) e não obriga a marcar o estado da run em cada resposta.
3. **Decisões em texto corrido.** O plan gate diz "faça as `questions` com AskUserQuestion"
   (`SKILL.md:124`), mas a aprovação do plano, as premissas e o gate humano (`SKILL.md:139-141`)
   saem em prosa.

Pedido novo: a visualização deve ser **a mais amigável possível e desenhar o grafo de verdade**,
com caixas e setas e não só uma lista. Pode usar uma ferramenta free/open source.

## 2. Opções consideradas

- **A. Só nativo:** `/workflows`, `log()` e notificações, sem visualizador. Barato, mas não resolve
  a dor 1 no VSCode (ver §6.5) nem desenha nada.
- **B. Nativo + visualizador (aprovada):** `bin/graph-watch.mjs`, só leitura, mais as mudanças na
  skill. A abordagem A continua sendo a reserva quando o graph-watch não reconhece o formato.
- **C. Visualizador com servidor próprio (HTML + SSE):** é o mais bonito, mas também o mais código.
  Fica coberto pela visão SVG opcional do D2 (§4.3), sem servidor nosso.

**Decisão: B**, já aprovada. Esta spec só rediscute a dependência opcional de desenho (§3).

---

## 3. Parte 1 (aprovada, só resumo)

`bin/graph-watch.mjs` em Node, **só leitura**, com quatro modos:

| Modo | Para quem | Saída |
|---|---|---|
| `live` | humano, num terminal à parte | redesenha o grafo a cada mudança |
| `events` | o **Monitor** do Claude | uma linha por marco (§5.1) |
| `snapshot` | o "como está?" | o quadro uma vez, mais o bloco "agora" |
| `agent <nó>` | inspeção de um subagente | tool calls, texto e veredito |

**O que lê** (em ordem de journal):

- `journal.jsonl` e o `result` do agente `plan` (nós e deps);
- o `result` de cada `critic:rN`: nós novos com id `'r'+(round+1)+'-'` + o id saneado pelo
  `normalize()` (`graph-eng.js:314-349`, prefixo em `:606`);
- `agent-<id>.meta.json` como reserva do label;
- `agent-<id>.jsonl`, só no modo `agent`.

**Qual run:** a mais recente do repo atual, ou a que for pedida com `--run wf_…`.

**Estado deduzido pelos labels:**

- `work`/`draft` = trabalhando;
- `verify`/`escalate` = verificando;
- `repair` = reparando N;
- último veredito passou = pronto;
- sem `verify` = pronto sem verificação;
- último veredito reprovou, sem novo reparo = falhou;
- evento `failed` = erro.

**Formato não reconhecido:** avisa numa linha e sai, e a skill cai na abordagem A.

**No `graph-eng.js`:** só ganha um `log()` com o grafo em texto a cada mudança de estado (§5.5).

**O que muda nesta spec em relação à parte 1:**

- entra uma ferramenta de desenho **opcional** (D2, §4). A reserva sem dependência continua
  desenhando caixas e setas;
- a regra de estado ganha os refinamentos que a leitura do motor exigiu (§6.2). Eles não mudam a
  intenção da parte 1, só tornam a dedução fiel ao `runNode` (`graph-eng.js:490-519`).

---

## 4. Pesquisa: ferramentas para desenhar o DAG

A pesquisa foi feita em 2026-09-27, com docs atuais, registry do npm e protótipos executados no
runDir, não de memória. A tabela completa está em `.graph-runs/20260927-1333-visualizacao-graph-eng/tools-research.md`.
Nenhum de `dot`, `mmdc` ou `d2` está instalado na máquina (`which dot mmdc d2` → not found). Os
protótipos baixaram o D2 só dentro do runDir, que é ignorado pelo git (`.gitignore:2`).

### 4.1 Comparação

| Ferramenta | Licença | Versão | URL | Instalação / peso | Terminal | Terminal do VSCode | Browser | Ao vivo | Layout |
|---|---|---|---|---|---|---|---|---|---|
| **D2, binário** | MPL-2.0 (`LICENSE.txt` do tarball) | v0.9.0 (`d2 --version`) | https://d2lang.com/tour/install · https://github.com/d2lang/d2/releases/tag/v0.9.0 | Tarball de 16,3 MB, binário Go de 38 MB, **sem dependência**. Detecção por `which d2` | Sim: `--stdout-format txt`, Unicode ou ASCII. **Beta**: bordas compartilhadas, aresta atravessando caixa, label cortado (`proto-d2bin/out-elk.txt`) | Sim (é texto) | SVG | **Browser: sim**, com `--watch` e live reload. **Terminal: não**: o `--watch` com `.txt` só regrava o arquivo e serve HTTP (`proto-d2bin/watch.log`: `listening on http://127.0.0.1:60084`) | SVG muito bom; render de 5,8-6,6 ms |
| **D2, npm** (`@terrastruct/d2`) | MPL-2.0 | 0.1.33 (motor `v0.7.0-HEAD`) | https://www.npmjs.com/package/@terrastruct/d2 | 57-60 MB descompactado (WASM). O Worker prende o processo (`warm.mjs` → exit 142) | Sim, mas desenha igual ou pior que o binário | Sim | SVG | Sem watch; seria preciso rerender | 1,1 s a frio |
| **Graphviz `dot`** | EPL-2.0 | 16.1.0 | https://graphviz.org/download/ · https://graphviz.org/license/ | `brew install graphviz` (C nativo) | Não desenha texto: `-Tplain` só dá coordenadas | Idem | SVG/PNG | Sem watch | Excelente para DAG |
| **Mermaid CLI** (`mmdc`) | MIT | 12.0.0 | https://github.com/mermaid-js/mermaid-cli | Puppeteer + Chromium (centenas de MB) | Não | Não | SVG/PNG/PDF | Sem watch | Boa |
| **mermaid-ascii** (Go) | MIT | 1.6.1 (2026-09-08) | https://github.com/AlexanderGrooff/mermaid-ascii/releases/tag/v1.6.1 | Binário Go, sem Node | Sim, caixas e setas | Sim | Modo `web` | Watch não documentado | Boa para flowchart. **Não prototipado** |
| **Graph::Easy** (Perl) | GPL-2.0-or-later | 0.76 | https://metacpan.org/dist/Graph-Easy | `cpan`, depende de runtime Perl | Sim, box-drawing | Sim | HTML/SVG | Não | Simples; projeto pouco ativo |
| **dagre** / **elkjs** | MIT / EPL-2.0 OR GPL-3.0 | 3.1.1 / 0.12.0 | https://www.npmjs.com/package/@dagrejs/dagre · https://www.npmjs.com/package/elkjs | npm, JS. Só calculam coordenadas | Só com renderer próprio por cima | Idem | Idem | Com rerender | Bom / muito bom |
| **Imagem inline** (iTerm2/kitty/Sixel) | protocolo | — | https://code.visualstudio.com/docs/terminal/advanced | Rasterizar e imprimir | iTerm2 e kitty | **Desligada por padrão** (`terminal.integrated.enableImages`) | — | Com rerender | Fidelidade total |
| **Renderer próprio** (Node puro, camadas) | do projeto | — | protótipo `proto-render/render2.mjs` | **Zero dependência** | Sim: caixas `┌─┐`, barramento `├──┐`, setas `▼`, sem sobreposição | Sim | — | Sim, redesenho próprio (§6.6) | Bom até ~15 nós; aresta que pula camada vira texto `← deps` |

### 4.2 Recomendação

- **No terminal (CLI e terminal integrado do VSCode), o renderer próprio em Node puro é o padrão,
  sempre.** Custa zero dependência e desenha caixas separadas. O texto do D2 é beta, e os defeitos
  apareceram tanto no DAG de exemplo (`proto-d2bin/out-elk.txt`) quanto no grafo real
  (`proto-render-b/final-d2.txt`). O renderer próprio foi prototipado e reproduz os goldens:
  `node proto-render/render2.mjs <wf_b914> 29 120 --no-color --economy balanced | diff - proto-render/v2-snapshot-b914-cut29.txt`
  → idêntico, conferido de novo nesta etapa.
- **No browser, o D2 v0.9.0 (MPL-2.0) é a ferramenta free/OSS escolhida, como dependência
  OPCIONAL.** O modo `live --svg` detecta o binário com `which d2` e roda
  `d2 --watch --browser=0 --layout=elk graph.d2 graph.svg`. É o desenho "mais amigável": SVG com cor
  por estado, borda tracejada nos nós de round 2 ou mais e live reload nativo. Render provado:
  `d2 --layout=elk run.d2 run.svg` → `successfully compiled ... in 6.566458ms`
  (`proto-render/run.svg`).
- **Reserva:** sem `d2`, o `live --svg` imprime uma linha de aviso e segue como `live` (§7).
- **Fora (YAGNI):**
  - o pacote npm do D2 (pesado, motor atrasado, Worker preso);
  - o layout `tala` (licença em conflito: a release diz "open source", o repo diz "closed-source",
    portanto unverified);
  - o Mermaid CLI (Chromium);
  - o Graphviz (não desenha texto);
  - imagem inline (desligada por padrão no VSCode).
- **Em aberto:** o mermaid-ascii é o único que desenha texto e não foi prototipado. Se o renderer
  próprio decepcionar acima de ~15 nós, ele é o próximo a testar.

---

## 5. Parte 3: marcos no chat, "como está?" e skill

### 5.1 Modo `events` (alimenta o Monitor)

**Contrato:** cada linha do stdout é um marco. O Monitor transforma cada linha em notificação
(descrição da ferramenta Monitor: "Your script's stdout is the event stream. Each line becomes a
notification", e linhas em até 200 ms viram uma notificação só). O modo nunca emite escape ANSI.

Formato de toda linha: `graph-eng <wf_curto> · <marco> · <k>/<N> prontos · agentes <S>`

| Marco | Quando | Exemplo |
|---|---|---|
| `retomando` | primeira linha de cada execução, com o resumo do estado atual. Assim o rearme não repete o histórico | `graph-eng wf_b914 · retomando: round 1, I1 reparando 1 · 1/5 prontos · agentes 13` |
| `plano` | `result` do `plan`, ou plano achado na run planOnly irmã (§6.1) | `graph-eng wf_b914 · plano: 5 nós, estimativa ~12, teto 24 · 0/5 prontos · agentes 1` |
| `<id> <estado>` | um nó entra num estado **final**: pronto, pronto s/ verif., bloqueado, erro ou pulado. `falhou`, `falhou (check)` e `sem reverificação` só são emitidos quando o nó **fecha** (§6.2), porque antes disso são transitórios | `graph-eng wf_b914 · I3 pronto (verificado) · 4/5 prontos · agentes 11` |
| `<id> reparo N` | `started repair:<id>`, com o motivo tirado do veredito anterior | `graph-eng wf_b914 · I1 reparo 1 (check: npm run format:check) · …` |
| `critic rN` | `result` de `critic:rN` | `… · critic r1: 2 gap(s) → round 2 (r2-G1, r2-G2) · …` / `… · critic r2: critérios atendidos · …` |
| `parada?` | 10 min sem evento e sem result do `synth`. Uma vez só por execução | `graph-eng wf_d6d3 · parada? último evento há 14 min · 0/4 prontos · agentes 3` |
| `TERMINADO` | `result` do `synth`. Depois disso, o processo sai com código 0 | `graph-eng wf_b914 · TERMINADO · 6/7 prontos · agentes 20` |
| `aviso` / `erro` | ver §7. Depois de um erro fatal, sai com código ≠ 0 | `graph-eng · erro: formato de journal não reconhecido (sem label); use /workflows` |

**Contra enxurrada:**

- **Nunca** emite em `started` de `work`, `verify` ou `draft`: esses estados aparecem só no
  `snapshot`/`live`.
- Cada marco sai de um `result`, de um `started repair` ou do fim da run. O total fica limitado
  pelo teto de agentes do preset (`graph-eng.js:35-37`: 12, 24 ou 48). No wf_b914, 19 `started`
  (`grep -c '"type":"started"'`) dariam ~15 linhas.
- Marcos iguais, com o mesmo nó e o mesmo estado, não se repetem.

A descrição da ferramenta Monitor diz: "Monitors that produce too many events are automatically
stopped". Essa frase **não** está na doc pública
(https://code.claude.com/docs/en/tools-reference, conferida em 2026-09-27). Por isso a regra acima é
defensiva, e a reação a uma parada por ruído está no §7.

### 5.2 Monitor: arme, rearme e fim

Fatos da doc (https://code.claude.com/docs/en/tools-reference, seção Monitor):

- "Every watch Claude starts has a deadline: 5 minutes by default, at most 30 minutes";
- "At the deadline the watch ends. Claude gets one notice, so it can start the watch again".

O `timeout_ms` máximo é 1800000.

Fluxo:

1. Logo depois de disparar o workflow (etapa 5), o Claude arma:
   ```
   Monitor({ description: "graph-eng <runId>", timeout_ms: 1800000,
             command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" events --run <wf> --economy <preset> --mode <mode>' })
   ```
   **`--run` é obrigatório no fluxo da skill.** O `wf_…` vem no retorno da própria chamada do
   Workflow, que é devolvido na hora, antes de a run terminar. Prova: no transcript
   `~/.claude/projects/<projeto-a>/<sessão>.jsonl`,
   o resultado da chamada traz `wf_b914fcbb-2b8` seguido de `Script file: …` (achado do verificador
   desta run, via grep). Se o retorno não trouxer o id, a skill passa `--run-id <runId>` no lugar
   (ver o item seguinte), e nunca omite os dois.

   **Sem `--run`, o `events` nunca escolhe run terminada** (§6.8, item 5). Ele aceita só:
   - uma run cujo journal **não** tenha `result` de `synth`; e
   - se vier `--run-id <runId>`, só a run cujo transcript do `plan` cite `.graph-runs/<runId>`.
     O `runDir` entra no prompt dos agentes: `grep -o '\.graph-runs/[^" \\]*'` num
     `agent-*.jsonl` do wf_b914 devolve `.graph-runs/20260926-2205-ci-auth-500-obs`, e o motor lê
     `A.runDir`/`A.runId` em `graph-eng.js:48-50`.

   Se nenhuma servir, espera até 60 s o journal aparecer e depois sai com `erro` (exit 3, §7), sem
   emitir `TERMINADO`. Isso evita o falso "terminei" (dor 2) de uma run antiga concluída que fosse
   a mais nova do slug.

   Por que o caminho vem com `${CLAUDE_PLUGIN_ROOT}` literal: a doc de plugins diz que essas
   variáveis "aren't present in the environment of commands Claude runs through the Bash tool", e
   que num skill se escreve "the ${...} reference in the Markdown body instead, and Claude Code
   substitutes the path inline" (https://code.claude.com/docs/en/plugins-reference, seção
   Environment variables). Por isso o nome curto `graph-watch` não resolve no Bash, e todo comando
   no SKILL.md (§5.4) é escrito por extenso.
2. **Cada notificação de marco** vira uma resposta curta no chat, com o cabeçalho ⏳ RODANDO
   (§5.4). O `falhou`/`erro` também leva uma dica de inspeção (o comando `agent` do §5.4 (b),
   item 4).
3. **Expirou** (aviso único do Monitor) e ainda não houve `TERMINADO` nem a notificação de fim do
   workflow: o Claude rearma com o mesmo comando, e a primeira linha é `retomando`. Com isso são 2
   rearmes por hora, cada um com uma linha de resumo.
4. **`TERMINADO`** (o `events` sai sozinho) **ou** a notificação de conclusão do workflow: o
   Claude não rearma e passa à etapa 6.

### 5.3 Fluxo do "como está?"

Gatilho: o usuário pergunta pelo andamento ("como está?", "status", "cadê?") enquanto há run
aberta.

1. O Claude roda via Bash:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf> --economy <preset> --mode <mode> --no-color`.
   Sem TTY, `cols` vale 100 e o desenho sai em caixas quando cabe (§6.5).
2. Responde com o cabeçalho ⏳ RODANDO e **cola a saída num bloco de código**. O bloco preserva o
   desenho em monoespaçado na CLI e no chat da extensão. Depois, no máximo 2 linhas de leitura
   ("I1 está no reparo 1 por check de format; os outros aguardam").
3. Se a pergunta for sobre um nó ("o que o I1 está fazendo?"), roda
   `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" agent I1 --run <wf> --no-color` e cola a saída.
4. Fecha com onde ver mais: no terminal, `/workflows` → run → fase → agente; no VSCode, o agent
   map (§6.5); e o `live` num terminal à parte, para acompanhar sem perguntar.
5. Se o graph-watch sair com erro (§7), cai na abordagem A. A resposta diz o que a última
   notificação disse e aponta para `/workflows`, **sem inventar estado**.

### 5.4 Mudanças exatas no `skills/graph-eng/SKILL.md`

Todas substituem ou acrescentam texto nas linhas citadas (estado em 2026-09-27).

**(a) Etapa 4, Plan gate: substituir o item 2 (`SKILL.md:124`) por:**

> 2. Mostre o plano **desenhado**: rode
>    `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf da run planOnly> --economy <preset> --mode <mode> --no-color`
>    e cole num bloco de código. Se o graph-watch falhar, use o `graph` (mermaid). Liste em
>    seguida as **premissas** e a **estimativa** (caminho feliz e teto). Depois decida **só com
>    AskUserQuestion**, nunca em texto corrido:
>    - uma pergunta "Aprova o plano?" com as opções `Aprovar e rodar` · `Editar nós` ·
>      `Cancelar`. A edição chega pelo campo Other ou pelas notas;
>    - uma pergunta "As premissas estão certas?" com as opções `Todas certas` · `Corrigir alguma`;
>    - uma pergunta por item de `questions` do plano, com 2-4 opções concretas.

**(b) Etapa 5, Executar: substituir o parágrafo de `SKILL.md:133-134` por:**

> Passe `args` como objeto JSON, não como string. O workflow roda em **background**: o retorno da
> chamada **não** é o fim da run.
>
> O retorno da chamada traz o id da run (`wf_…`, na linha antes de `Script file:`). Guarde-o como
> `<wf>`: **todo** comando abaixo leva `--run <wf>`. Se o retorno não trouxer o id, use
> `--run-id <runId>` no lugar de `--run <wf>`. Nunca rode o graph-watch sem um dos dois.
> `<preset>` e `<mode>` são os mesmos `args.economy` e `args.mode` passados ao Workflow.
>
> 1. Responda em até 4 linhas, começando por `⏳ RODANDO — graph-eng <runId>`: estimativa, teto,
>    paper trail e o comando para ver o grafo ao vivo **num terminal à parte** (aba ou split na
>    CLI; "Terminal: Split" no VSCode):
>    `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" live --run <wf> --economy <preset> --mode <mode>`
>    (acrescente `--svg` para a visão no browser, se o `d2` estiver instalado).
> 2. Arme o Monitor com este comando literal:
>    ```
>    Monitor({ description: "graph-eng <runId>", timeout_ms: 1800000,
>              command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" events --run <wf> --economy <preset> --mode <mode>' })
>    ```
>    Se ele expirar antes de `TERMINADO`, rearme com o **mesmo** comando.
> 3. **Enquanto não chegar `TERMINADO` ou a notificação de conclusão do workflow, toda resposta
>    começa com `⏳ RODANDO — graph-eng <runId> · k/N prontos`.** Não escreva "pronto", "terminei"
>    nem "concluído" sobre a tarefa, e não resuma resultado de nó como se fosse final. Um
>    `erro: nenhuma run do graph-eng` do Monitor **não** é fim da run: siga como no item 6.
> 4. "Como está?": rode via Bash
>    `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf> --economy <preset> --mode <mode> --no-color`
>    e cole a saída num bloco de código. Sobre um nó, rode
>    `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" agent <id> --run <wf> --no-color`
>    e cole a saída. Não faça polling por conta própria: o Monitor e a notificação final bastam.
> 5. Onde abrir cada agente: no terminal, `/workflows` → run → fase → agente (prompt, tool calls
>    recentes e resultado). No VSCode, o agent map (contador de agentes no prompt ou `/tasks`). Em
>    qualquer lugar, o comando `agent` do item 4.
> 6. Se o graph-watch sair com `erro` (formato não reconhecido, run não achada), siga sem ele:
>    só a notificação de conclusão do Workflow e o `/workflows`. Continue com ⏳ RODANDO até essa
>    notificação chegar.

**(c) Etapa 6, Entregar: substituir `SKILL.md:138-141` por:**

> 1. Leia `<runDir>/REPORT.md`.
> 2. Abra a resposta com `✅ TERMINADO — graph-eng <runId> · <status>`. Siga curto: o que mudou ou
>    o que achou · decisões · o que falhou ou ficou aberto (`openGaps` e nós `failed` com os
>    `blocking`) · custo (`stats.agents` contra a estimativa) · o grafo final (a saída de
>    `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf> --economy <preset> --mode <mode> --no-color`
>    num bloco de código, ou o mermaid do REPORT como reserva).
> 3. **Premissas e gate humano vão por AskUserQuestion, não em prosa:**
>    - uma pergunta "Confirma as premissas?", listando as premissas que mudam comportamento, com
>      as opções `Confirmo` · `Alguma está errada`;
>    - uma pergunta por item de `humanGate` que exige ação (commit, deploy, migration, publicar),
>      com as opções `Aprovo` · `Ainda não` · `Quero ver o diff`;
>    - se voltar `partial` ou houver `openGaps`: "Rodar mais um round focado nos gaps?", com as
>      opções `Sim` · `Não`.

Os itens 3-5 atuais (`SKILL.md:142-145`) passam a 4-6, sem mudança de texto, exceto o item 5 antigo,
que vira a terceira pergunta acima.

**(d) Recuperação: substituir `SKILL.md:150` por:**

> - **Resultado estranho:** rode
>   `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" snapshot --run <wf> --economy <preset> --mode <mode> --no-color`
>   e `node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" agent <id> --run <wf> --no-color` antes de
>   diagnosticar. Leia o `journal.jsonl` cru só se o graph-watch não reconhecer o formato.

**(e) Parâmetros (`SKILL.md:89-102`):** sem mudança. `--economy` e `--mode` do graph-watch
repetem os `args.economy`/`args.mode` já passados ao workflow. A skill **sempre** os repassa (§6.2).

### 5.5 `log()` no `workflows/graph-eng.js`

A doc de workflows diz que o script pode "call `log()` to show a message above the phases"
(https://code.claude.com/docs/en/workflows.md, seção Edit a saved script). O `log()` não vai para o
journal (`formats-research.md` §1). Restrições da mesma doc:

- `import()` quebra o script ("No module loading"). O desenho tem de estar **inline** no
  `graph-eng.js`, e não pode importar o graph-watch;
- `Date.now()` e `new Date()` lançam erro, então o texto não leva hora.

Mudança:

1. Criar `graphText()` ao lado de `mermaid()` (`graph-eng.js:354`), com ~30 linhas. É a forma
   **compacta** do §6.4 (uma linha por nó, indentada pela camada, `[marcador] id estado ← deps`),
   lida de `NODES`/`RESULTS`/`BLOCKED`. É a verdade do motor, sem dedução.
2. Chamar `log(graphText())` em três pontos:
   - logo depois do `log` de `graph-eng.js:419` (nó concluído);
   - depois do `log` de `:573` (plano aceito);
   - depois do `log` de `:608` (round novo).
   São só mudanças de estado de nó, então não há enxurrada.
3. Nada mais muda no motor.

**Unverified:** se a progress view mostra um `log()` de várias linhas inteiro, e não só a primeira
linha. Teste manual no §8.4. Se ela cortar, `graphText()` vira uma linha
(`R1+ R2o I1x I2~ I3·`).

---

## 6. Parte 2: o desenho do grafo

O desenho completo, com todas as provas, está em `render-design.md`. Aqui ficam os contratos.

### 6.1 Modelo

```
Model = { wf, round, status: 'rodando'|'terminado'|'parada?', idleSec, warns:[string],
          nodes: [{ id, kind, risk, round, title, deps:[id], explore, state, reps, orphan? }],
          critic: { r, running, gaps? } | null, synth: 'aguardando'|'rodando'|'pronto',
          spent, estimate?, ceiling? }
```

- **Casamento:** `result` e `failed` casam com o `started` pelo `key`, porque o `failed` não traz
  `label` (wf_ba7e, `journal.jsonl:48`: `{"type":"failed","key":"v2:6980…","agentId":"a75e2cf7360b6cfc7"}`).
- **Normalize:** o graph-watch replica o `normalize()` **inteiro** (`graph-eng.js:314-349`):
  - `sane` e o prefixo `r<round+1>-`;
  - id vazio vira `n<k>`;
  - colisão ganha sufixo `_`;
  - `kind`/`risk` inválidos viram `research`/`medium`;
  - `implement` vira `design` com `--mode research|review` (`:325-326`);
  - `explore` só vale em design (`:339`);
  - deps passam pelo `idMap` do lote ou por id já existente (`:342-347`).
  No wf_b914, R1 e R2 vêm com `explore:true` cru, mas são research, então não exploram.
- **Plan gate:** a run real recebe `args.plan` e não tem `started plan` (`graph-eng.js:523`). O
  graph-watch procura na mesma pasta `subagents/workflows/` a run `planOnly` mais recente, com mtime
  menor ou igual ao da run atual, que tenha `result` de `plan` e nenhum `work:`. Avisa
  `aviso: plano lido da run planOnly wf_…`. Sem ela, os nós nascem no `started` como `orphan`, e o
  desenho passa ao modo compacto com aviso. **Unverified contra run real:** não existe run com plan
  gate nas transcrições locais. Foi provado com a fixture `proto-render/fixtures/sess/`.
- **Custo:**
  - `spent` = número de `started` (19 no wf_b914);
  - `estimate` repete `graph-eng.js:557-558` sobre os nós normalizados (wf_b914 balanced → 12; a
    fórmula sobre o plano cru daria 16);
  - `ceiling` e `defer` vêm do preset (`:35-37`), que só é conhecido com `--economy`.
- **Idade:** `idleSec` = agora − mtime do journal, porque o journal não tem timestamp. O wf_d6d3
  tem mtime `Sep 26 22:00:03 2026` (`stat -f %Sm`).

### 6.2 Estados e legenda

Marcadores ASCII de 1 caractere: glifos de largura ambígua desalinham a caixa
(`tools-research.md`, ressalva c). A cor nunca é o único sinal, e some com `NO_COLOR` ou pipe.

| Estado | Regra (resumo; a regra completa está em `render-design.md` §4.2) | Marcador |
|---|---|---|
| trabalhando | agente aberto mais recente é `work`/`draft-*`/`judge`, ou os dois drafts ok com o `judge` ainda sem `started` e o nó aberto | `[~]` |
| verificando | agente aberto é `verify`/`escalate`; ou `work`/`judge` concluído, sem veredito, nó não deferido e não fechado | `[?]` |
| reparando N | agente aberto é `repair`, ou `repair` concluído sem veredito e o nó não fechado. N = nº de `repair:<id>` | `[R]` |
| pronto | último veredito `verify`/`escalate` com `pass:true` | `[+]` |
| pronto s/ verif. | `work`/`judge` concluído sem nenhum veredito, por defer (`graph-eng.js:495`), por orçamento, ou por verify nulo com o nó fechado | `[o]` |
| pronto s/ verif.? | ambíguo: faltou `--economy`/`--mode` para saber se o nó foi deferido (abaixo) | `[o]` + `?` |
| falhou | último veredito `pass:false`, sem `repair` depois | `[x]` |
| falhou (check) | check gate (`checkGate`, `:430-443`) reprovou num `repair`, ou num `work`/`judge` de nó não deferido, sem `repair` depois | `[x]` |
| bloqueado | `work`/`judge` com `status:'blocked'` (`:494`); ou `failed` no último agente sendo `work`/`judge` ou os dois drafts (`:492-493`); ou **os dois drafts ok, sem `started judge` e o nó fechado**: o juiz foi cortado pelo orçamento, porque `run()` devolve `null` sem gravar `started` (`:74-78`), `explore()` devolve esse `null` (`:479`) e o `runNode` devolve blocked (`:493`) | `[x]` |
| sem reverificação | `repair` concluído sem veredito e o nó fechado (`:507-510`) | `[r]` |
| erro | todos os agentes concluídos e o **último** em `failed`, sendo `verify`, `escalate`, `repair` ou um draft só. Não propaga | `[!]` |
| aguardando | sem `started` e sem dep em bloqueado/pulado | `[ ]` |
| pulado | sem `started`, e alguma dep bloqueada ou pulada (`BLOCKED`, `:385-390, :418`); **ou** o nó está fechado sem nunca ter começado (orçamento, `:77`) | `[-]` |

**"Fechado"** quer dizer que o nó não vai receber mais eventos: um dependente já tem `started`, já
existe `critic` de round maior ou igual ao do nó, ou o `synth` começou.

**Ordem do motor que a dedução respeita.** O defer (`graph-eng.js:495`) retorna antes do
`checkGate(work)` (`:498`). Por isso, um check vermelho em nó deferido **não** reprova: um worker
informa `checks` mesmo sem checks configurados, e o wf_29e9, linha 15, traz `[T,T,T,T,F]`.

**Ambiguidade e flags.** O defer depende de `C.defer`, que vem do preset, e do `kind`, que o
read-only muda. Nenhum dos dois está no journal.

- **Sem `--economy`, ou sem `--mode` para nós `implement`:** um nó cujo defer não dá para saber,
  com o `work`/`judge` de check vermelho ou sem veredito como último agente, sai `pronto s/ verif.?`
  com o aviso `aviso: <id>: deferido ou reprovado? passe --economy e --mode`. Enquanto a run está
  viva, o rótulo ganha `(parcial)`.
- **A skill sempre passa as duas flags (§5.4 b).** Com as duas, nenhum estado permanente sai
  errado. Os casos de estado da §8.2 cobrem isso.

A legenda sai em duas linhas no rodapé, cortadas em `cols`:

```
legenda: [~] trabalhando  [?] verificando  [R] reparando N  [r] reparado, sem reverificação  [+] pronto
         [o] pronto s/ verif.  [x] falhou / falhou (check) / bloqueado  [!] erro  [ ] aguardando  [-] pulado
```

### 6.3 Layout (renderer próprio)

- **Camada** = maior caminho pelas deps. Dentro da camada, a ordem é a do plan e depois a do
  critic, para o desenho ficar estável entre quadros.
- **Caixa** com W=22 e 4 linhas: `id · kind`, `[m] estado`, título cortado com `…` e `← deps`.
- **Setas** entre camadas vizinhas: troncos `│`, barramento `├ ┤ ┬ ┴ ┼ ─ └ ┘ ┌ ┐` e `▼`. A aresta
  que pula camada vira só texto no `← deps`: é a simplificação que garante caixas sem sobreposição.
- `plan`, `critic` e `synth` ficam no cabeçalho e no rodapé, não viram caixa (como no `mermaid()`).
- Cabeçalho: `graph-eng · <wf> · round R · k/N prontos · agentes S (estimativa ~E, teto T)`.

Exemplo real, saída do protótipo sobre o wf_b914 cortado na linha 29
(`proto-render/v2-snapshot-b914-cut29.txt`):

```
graph-eng · wf_b914fcbb-2b8 · round 2 · 4/7 prontos · agentes 14 (estimativa ~12, teto 24)

┌──────────────────────┐   ┌──────────────────────┐
│ R1 · research        │   │ R2 · research        │
│ [+] pronto           │   │ [o] pronto s/ verif. │
│ Reproduzir 500 de ge…│   │ Evidência Loki local…│
│ ← plan               │   │ ← plan               │
└──────────────────────┘   └──────────────────────┘
                                       │
            ┌──────────────────────────┤
            ▼                          ▼
┌──────────────────────┐   ┌──────────────────────┐
│ I1 · implement       │   │ r2-G2 · research     │
│ [x] falhou           │   │ [ ] aguardando       │
│ Falha de push Loki r…│   │ Corrigir o comando g…│
│ ← R2                 │   │ ← R2                 │
└──────────────────────┘   └──────────────────────┘
            │
            ├──────────────────────────┐
            ▼                          ▼
┌──────────────────────┐   ┌──────────────────────┐
│ I2 · implement       │   │ r2-G1 · implement    │
│ [+] pronto           │   │ [ ] aguardando       │
│ Fechar dev-auth com …│   │ Teste de dedupe do L…│
│ ← R1 I1              │   │ ← I1                 │
└──────────────────────┘   └──────────────────────┘
            │
            │
            ▼
┌──────────────────────┐
│ I3 · implement       │
│ [+] pronto           │
│ Corrigir cada 500 co…│
│ ← R1 I2              │
└──────────────────────┘

critic r1: 2 gap(s) → round 2 · synth: aguardando
legenda: [~] trabalhando  [?] verificando  [R] reparando N  [r] reparado, sem reverificação  [+] pronto
         [o] pronto s/ verif.  [x] falhou / falhou (check) / bloqueado  [!] erro  [ ] aguardando  [-] pulado
agora: nada rodando · próximos: r2-G1, r2-G2
```

(A última linha, o bloco "agora" do §5 de `render-design.md`, é acréscimo do `snapshot` e não está no golden.)

O I1 como `falhou` confere com a run real: `verify:I1` deu `pass:false` com 2 bloqueios, não houve
outro `repair:I1`, e o gap `r2-G1` nasceu dali.

### 6.4 Modo compacto

É usado quando as caixas não cabem: uma linha por nó, indentada pela camada
(`proto-render/v2-snapshot-b914-cut35-narrow.txt`, `cols=50`):

```
[+] R1 pronto  ← plan
[o] R2 pronto s/ verif.  ← plan
  └▶ [x] I1 falhou  ← R2
  └▶ [o] r2-G2 pronto s/ verif.  ← R2
    └▶ [+] I2 pronto  ← R1 I1
```

Se a lista passar de `rows`, os nós ativos saem primeiro, e a lista fecha com
`… +N nós (graph-watch snapshot)`.

### 6.5 Terminal comum, terminal do VSCode e browser

Nesta seção e nas de desenho, `graph-watch <modo>` é só abreviação de
`node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" <modo> --run <wf> …`. O nome curto não existe
no PATH nem no Bash do Claude (§5.2), e o SKILL.md sempre usa a forma por extenso (§5.4). O
comando que o usuário cola no terminal à parte é o que a skill imprime, já com o caminho
resolvido.

| Onde | Como ver o grafo | Como ver um agente |
|---|---|---|
| **CLI (Terminal.app/iTerm2)** | `graph-watch live` numa aba ou split à parte | `/workflows` → run → fase → agente: "the agent's prompt, its recent tool calls, and its result" (https://code.claude.com/docs/en/workflows.md#watch-the-run), ou `graph-watch agent <id>` |
| **Terminal integrado do VSCode** (xterm.js) | O mesmo `live`, em "Terminal: Split" ou num terminal novo | `graph-watch agent <id>`. No chat da extensão, o **agent map**: "draws the conversation's subagents as a tree … Click a subagent to see its prompt and tool calls", aberto pelo contador de agentes ou por `/tasks` (https://code.claude.com/docs/en/vs-code.md). **Unverified:** se os subagentes de *workflow* aparecem no agent map, e se `/workflows` existe na extensão (a página não cita nenhum dos dois) |
| **Desktop app** | — | Painel de tarefas: "subagents, background shell commands, and dynamic workflows" (https://code.claude.com/docs/en/desktop.md#watch-background-tasks) |
| **Browser** (externo ou o integrado do VSCode) | `graph-watch live --svg`, com D2 opcional (§4.2). No VSCode, o link `http://127.0.0.1:<porta>` abre no browser integrado (https://code.visualstudio.com/docs/debugtest/integrated-browser, setting `workbench.browser.openLocalhostLinks`) | — |

**Correção ao contexto recebido:** a extensão do VSCode não tem um "painel Tasks". O que ela tem é
o agent map (`/tasks`), e o painel de tarefas é do Desktop app. É justamente essa lacuna que o
graph-watch cobre no VSCode.

**Largura e altura:**

- `cols = stdout.columns || 100` e `rows = stdout.rows || 40`;
- caixas quando toda camada cabe (`n·24 + (n-1)·3 ≤ cols`; duas caixas lado a lado pedem 51
  colunas) e, no `live`, também a altura;
- senão, compacto;
- `resize` recalcula. O painel de terminal do VSCode costuma ser baixo e tende ao compacto
  (**unverified**, expectativa).

### 6.6 Redesenho no `live`

- **Entrar:** `ESC[?1049h ESC[?25l`.
- **Quadro:** `ESC[?2026h ESC[H` + linhas com `ESC[K` + `ESC[J ESC[?2026l`. O xterm.js trata o 2026
  como "synchronized output" (`InputHandler.ts`, conferido com `curl … | grep 2026`); CUP e ED
  estão em https://xtermjs.org/docs/api/vtfeatures/.
- **Sair:** `ESC[?25h ESC[?1049l`, e o último quadro é impresso no buffer normal. Isso roda em `q`,
  SIGINT, SIGTERM, `exit` e `uncaughtException`.
- **Cadência:** `stat` a cada 500 ms e leitura incremental a partir do último offset, guardando a
  linha parcial até o `\n`. O quadro só é escrito quando o texto muda, então não pisca. Uma linha de
  status por segundo: `atualizado 13:58:02 · último evento há 40s · q sai`.
- **Sem TTY:** sem escape nem cor. Imprime o quadro inteiro só quando muda.

### 6.7 Modo `agent <nó>`

- **Entrada:** label (`verify:I1`) ou id (`I1`, que pega o último `started` cujo label termina em
  `:I1`).
- **Label → agentId:** pelo `started`. A reserva é o `description` do `agent-<id>.meta.json`, por
  exemplo `{"agentType":"workflow-subagent","description":"verify:R1","workflowPhase":"Verify",…}`
  (wf_b914, `agent-a12d43c31bc27ef3b.meta.json`).
- **Saída:**
  - cabeçalho `label · agente · rodando|terminou|ERRO · N tool calls`;
  - as últimas N tool calls (`-n`, padrão 8), no formato `hh:mm:ss Ferramenta
    description|command|file_path`, com o `timestamp` das linhas do transcript;
  - o último texto livre;
  - o veredito ou o `status`/`summary`;
  - a linha do raciocínio.
- **Limite do raciocínio:** os blocos `thinking` são gravados **vazios**. O modo conta os blocos e
  diz isso, sem inventar nada. Evidência:
  - `grep -c '"thinking":""'` no wf_b914, `agent-a3903ca0d91dff39b.jsonl` → 6 (verify:I1);
  - o mesmo grep em `agent-a12d43c31bc27ef3b.jsonl` → 3.

Saída real (`node proto-render/agent.mjs <wf_b914> verify:I1 6`, idêntica a
`proto-render/agent-verify-I1.txt`, conferida de novo nesta etapa):

```
verify:I1 · agente a3903ca0d91dff39b · terminou · 8 tool calls

últimas 6 tool calls:
  01:28:37 Bash  Read logger head/tail and env key presence
  01:28:45 Bash  Run typecheck, lint, format, tests
  …
  01:37:01 StructuredOutput  {"pass":false,"confidence":"high","blocking":[{"issue":"O teste de dedupe da pro

último texto: (nenhum texto livre; saída só estruturada)
veredito: REPROVOU (confiança high) · 2 bloqueio(s)
raciocínio: 6 bloco(s) de thinking, 6 gravado(s) vazio(s) — não há o que mostrar
```

### 6.8 Achar a run

1. **Slug do cwd:** `cwd` com os caracteres não alfanuméricos trocados por `-`. Nos caminhos reais
   dá, por exemplo, `/home/ana/code/app` → `-home-ana-code-app`. **Unverified:** a regra
   exata para `.` e outros caracteres. Reserva: se o slug não existir, procurar em
   `~/.claude/projects/*/` a pasta cujo `agent-*.jsonl` tenha `"cwd"` igual ao cwd atual (o campo
   existe no transcript, `formats-research.md` §3).
2. **Candidatos:** `~/.claude/projects/<slug>/*/subagents/workflows/wf_*/journal.jsonl`,
   ordenados por mtime.
3. **Filtro graph-eng:** a run só conta se algum `label` casar com
   `^(plan|work|verify|escalate|repair|draft-[ab]|judge|critic|synth)(:|$)`. Os outros workflows
   são ignorados: o wf_ba7e tem só `confirma:…` (41) e `investiga:…` (4).
4. **`--run wf_…`:** procura primeiro no slug atual e depois em todos, avisando
   `aviso: run de outro projeto`. É o caminho **obrigatório** da skill (§5.2, §5.4 (b)).
5. **`--run-id <runId>` (reserva da skill quando o retorno do Workflow não trouxe o `wf_…`):** só
   conta a run cujo `agent-<id>.jsonl` do `plan` contenha `.graph-runs/<runId>` (ou
   `graph-runs/<runId>` fora de git, `SKILL.md:112`). O `runDir` absoluto vai no prompt dos
   agentes: `grep -o '\.graph-runs/[^" \\]*'` num `agent-*.jsonl` do wf_b914 devolve
   `.graph-runs/20260926-2205-ci-auth-500-obs`. Se houver mais de uma (plan gate + run real, §6.1),
   vale a que não é `planOnly`.
6. **Sem `--run` nem `--run-id`** (uso manual; a skill nunca faz isso):
   - `snapshot`, `live` e `agent` pegam a mais recente pelo mtime, como diz a parte 1, e avisam
     `aviso: sem --run, usando <wf> (<terminada|rodando>)`;
   - o **`events` descarta toda run com `result` de `synth`**. Ele nunca escolhe uma run
     terminada, então nunca emite `retomando` + `TERMINADO` sobre uma run antiga enquanto a nova
     roda (dor 2). Se nenhuma aberta aparecer em 60 s, sai com `erro: nenhuma run do graph-eng em
     andamento para <cwd>` e exit 3.
   Com `--run` explícito, uma run já terminada é aceita, e o `retomando` + `TERMINADO` é correto
   (linha "Run terminou sem ninguém olhando" do §7).

---

## 7. Tratamento de erro

Toda falha é **uma linha** no stdout (no `events`, porque é o que o Monitor lê) ou no stderr (nos
outros modos), sempre com o prefixo `graph-eng`. Nenhum modo escreve fora de `os.tmpdir()/graph-watch/`.

| Situação | Detecção | Comportamento | Código de saída | Skill |
|---|---|---|---|---|
| **Journal ausente** | nenhum `wf_*` graph-eng no slug (§6.8), ou `--run` inexistente | `erro: nenhuma run do graph-eng para <cwd>`. No `events` sem `--run`, espera até 60 s antes de desistir (a run pode estar nascendo) | 3 | abordagem A: notificações + `/workflows` |
| **Formato antigo** | nenhum `started` com `label`, e o meta.json sem `description`. O wf_6b49 tem 21 `started` e 21 `result`, nenhum `launched`, e os meta.json existem, mas só com `{"agentType":"workflow-subagent","spawnDepth":1}`. *Correção a `formats-research.md` §2, que dizia não haver meta.json* | `erro: formato de journal não reconhecido (sem label); use /workflows` | 2 | abordagem A |
| **Run de outro workflow** | labels fora do padrão graph-eng (wf_ba7e) | ignorada na busca; com `--run` explícito, `erro: wf_… não é run do graph-eng` | 2 | abordagem A |
| **Run interrompida** | 10 min sem evento e sem `result` do `synth` (wf_d6d3) | cabeçalho `· parada? (último evento há N min)`; no `events`, uma linha `parada?` uma vez só. Não sai sozinho | — | avisa o usuário e oferece `resumeFromRunId` (`SKILL.md:149`) |
| **Linha JSON parcial ou inválida** | o parse falha | a linha parcial fica guardada até o `\n`; a inválida é ignorada e soma no contador de `aviso: N linha(s) ilegível(is)` | — | — |
| **Evento `failed`** | casado por `key` | estados `erro`/`bloqueado` (§6.2); no `events`, a linha do nó | — | sugere `graph-watch agent <id>` |
| **Monitor expirado** | aviso único do Monitor (doc citada no §5.2) | — | — | rearma com o mesmo comando se não houve `TERMINADO`; a primeira linha nova é `retomando` |
| **Monitor parado por excesso de eventos** | notificação de parada (**unverified** na doc pública; consta na descrição da ferramenta) | — | — | **não** rearma; segue sob demanda, com `snapshot` no "como está?", e avisa o usuário numa linha |
| **Run terminou sem ninguém olhando** | o `events` rearmado **com `--run`** encontra `result` do `synth` | `retomando…` e em seguida `TERMINADO` | 0 | vai para a etapa 6 |
| **Só há runs terminadas e faltou `--run`** | `events` sem `--run`; todo candidato tem `result` do `synth` (§6.8, item 6) | espera 60 s; depois `erro: nenhuma run do graph-eng em andamento para <cwd>`. **Nunca** emite `TERMINADO` | 3 | não passa à etapa 6: segue ⏳ RODANDO até a notificação de conclusão do Workflow e rearma com `--run <wf>` |
| **Ferramenta de desenho ausente** | `which d2` falha no `live --svg` | `aviso: d2 não encontrado: visão no browser indisponível, seguindo no terminal (opcional: https://d2lang.com/tour/install)` e segue como `live` | — | — |
| **`d2` morre** | o filho sai | linha de status `browser: d2 saiu (código X)`; o terminal segue | — | — |
| **Transcript do agente ausente** (`agent`) | não existe `agent-<id>.jsonl` | `erro: sem transcrição para <label>` | 4 | aponta para `/workflows` |
| **Nó ainda não começou** (`agent`) | nenhum `started` | `nó X ainda não começou` | 0 | — |
| **Flags faltando** | sem `--economy`/`--mode` | estados ambíguos com `?` e aviso; sem estimativa nem teto (§6.2) | — | a skill sempre passa |
| **Terminal preso na tela alternativa** | exceção no `live` | a restauração roda no `exit` e no `uncaughtException` | 1 | — |

---

## 8. Plano de testes

Rodam com `node --test test/`, sem dependência e sem `package.json`, porque o repo não tem um
(`ls` da raiz: `.claude-plugin/ skills/ workflows/ README.md LICENSE`). O D2 não é necessário: o
teste do `--svg` é pulado se `which d2` falhar.

### 8.1 Fixtures (`test/fixtures/`, recortes das runs reais)

O texto de negócio é truncado ou parafraseado. O critic do wf_b914 cita um host do Grafana Cloud,
então `goal`, `assessment` e `result` longos são cortados ao copiar.

| Fixture | Origem | Cobre |
|---|---|---|
| `b914/journal.jsonl` + `b914/agent-*.meta.json` | wf_b914 inteiro, com os resultados truncados | caminho feliz, 2 rounds, gap com dep do round 1, check gate + repair, defer |
| `b914/agent-a3903ca0d91dff39b.jsonl` | wf_b914, recorte de ~10 linhas: tool calls, StructuredOutput, thinking vazio | modo `agent` |
| `d6d3/journal.jsonl` | wf_d6d3 inteiro (5 linhas) | interrompida, `started` sem `result`, `parada?` |
| `old-6b49/journal.jsonl` + 1 `agent-*.meta.json` | wf_6b49, 4 linhas + meta sem `description` | **formato antigo** → exit 2 |
| `other-ba7e/journal.jsonl` | wf_ba7e, 6 linhas (`started confirma:…` + `failed` do mesmo `key`) | run não graph-eng → ignorada / exit 2; casamento de `failed` por `key` |
| `wf_blocked`, `wf_repair_noverify`, `wf_repair_open`, `wf_deferred_check`, `wf_draft_failed`, `wf_verify_failed`, `wf_work_failed` | `proto-render/fixtures/`, derivadas do wf_b914 e do wf_29e9 com um evento trocado | uma regra de estado cada (§8.2) |
| `wf_judge_cut` (nova) | wf_29e9 até os dois `draft-*` ok, sem `judge`, com `started` de um dependente | juiz cortado pelo orçamento → `bloqueado` |
| `wf_readonly_implement` (nova) | wf_b914 com `I2` `risk:low`, rodado com `--mode research` e sem `--mode` | defer do implement em read-only |
| `sess/wf_gated` + `sess/wf_planonly`, `sess2/wf_orphan` | `proto-render/fixtures/` | plan gate e orphan |

### 8.2 Casos

1. **Goldens de desenho:** os `proto-render/v2-*.txt` (14 arquivos) viram
   `test/golden/*.txt`, em `cols` 120 e 50. Hoje reproduzem: `diff` de `cut29`, `cut12` e
   `agent-verify-I1` → idênticos, conferido nesta etapa.
2. **Estados**, um caso por linha do §6.2:
   - wf_b914: corte 12 → I1 `falhou (check)`; corte 13 → `reparando 1`; corte 29 → I1 `falhou`;
     completo com `--economy balanced` → R2 e r2-G2 `pronto s/ verif.`;
   - fixtures: `wf_blocked` → R2 `bloqueado`, I1-I3 `pulado`. `wf_repair_noverify` →
     `sem reverificação`. `wf_repair_open` → `reparando 1`;
   - `wf_deferred_check`: `balanced` → `pronto s/ verif.`; `max` → `falhou (check)`; sem flag →
     `pronto s/ verif.?` + aviso;
   - `wf_draft_failed` → `verificando`, e o dependente `aguardando`. `wf_verify_failed` → `erro`,
     dependentes `aguardando`. `wf_work_failed` → `bloqueado`, dependentes `pulado`;
   - `wf_judge_cut` → `bloqueado` (e **não** `trabalhando`), dependentes `pulado`;
   - `wf_readonly_implement`: `--mode research --economy balanced` → I2 `pronto s/ verif.`; sem
     `--mode` → `pronto s/ verif.?` + aviso;
   - **propriedade** sobre todas as fixtures com as duas flags: nenhum nó com veredito reprovado
     sem repair posterior sai `[o]`; nenhum `pulado` sem dep bloqueada ou pulada, a não ser nó
     fechado sem `started`.
3. **Normalize:** um teste por regra do §6.1, com lista sintética (id inválido, id vazio → `n1`,
   colisão → `X_`, kind/risk inválidos, read-only, explore em research → falso, dep desconhecida,
   `r2-G1 ← I1`).
4. **Estimativa:** wf_b914 balanced → 12 (e não 16); wf_29e9 balanced → 12; `wf_gated` → 11; sem
   `--economy` → ausente.
5. **Achar a run:** diretório temporário com a estrutura `~/.claude/projects` (via
   `--projects-dir`, uma flag só para teste) contendo `b914` e `other-ba7e` mais nova → escolhe
   `b914`. Slug inexistente com `cwd` no transcript → acha pela reserva. Nada → exit 3. E ainda:
   - **run antiga completa mais nova no slug, sem `--run`:** `b914` (com `synth`) com mtime mais
     novo que `d6d3` (aberta) → `events` escolhe `d6d3` e **não** emite `TERMINADO`;
   - só `b914` no slug, `events` sem `--run` → nenhuma linha `TERMINADO`, `erro: nenhuma run do
     graph-eng em andamento`, exit 3 (com a espera de 60 s encurtada por `--wait-ms`, flag só de
     teste);
   - `--run-id 20260926-2205-ci-auth-500-obs` → escolhe `b914`; `--run-id` inexistente → exit 3;
   - `snapshot` sem `--run` sobre `b914` → desenha e avisa `(terminada)`.
6. **Erros:** `old-6b49` → exit 2 e uma linha. `other-ba7e --run` → exit 2. Linha JSON cortada no
   fim → ignorada até completar. `agent` sem transcript → exit 4.
7. **`events`:** alimentar o journal do wf_b914 linha a linha num arquivo temporário e checar que:
   - a primeira linha é `retomando`;
   - sai uma linha por `result` de nó final, por `started repair`, por critic e por `TERMINADO`;
   - **nenhuma** linha sai de `started work|verify|draft`;
   - o total é ≤ o número de `started`;
   - o processo sai com 0 depois de `TERMINADO`;
   - um novo processo **com `--run`** sobre o journal completo emite só `retomando` e `TERMINADO`;
     o mesmo **sem `--run`** não emite `TERMINADO` (caso do item 5);
   - `d6d3` com mtime antigo (`fs.utimesSync`) emite `parada?` uma vez.
8. **Largura:** `cols` 51 e 50 alternam entre caixas e compacto; nenhuma linha passa de `cols`
   (contando code points); caixas vizinhas com ≥1 espaço entre si; todo nó aparece uma vez.
9. **Sem TTY / `NO_COLOR`:** nenhum byte `\x1b` no `snapshot`, no `events` nem no `live` em pipe.
10. **`live`:** com um `stdout` TTY falso:
    - aparece a sequência `?1049h … ?2026h ESC[H … ESC[J ?2026l`;
    - um quadro novo só sai quando o texto muda;
    - `?1049l` aparece depois de SIGINT e no `exit`.
11. **`--svg`:** com `PATH` vazio → uma linha de aviso e segue. Com `d2` → o `graph.d2` gerado
    compila (`d2 graph.d2 /dev/null`, exit 0).
12. **`graphText()` no `graph-eng.js`:** extrair a função para um teste com `NODES`/`RESULTS`
    sintéticos e comparar com o compacto do graph-watch sobre o mesmo estado. Como o script não
    pode importar (§5.5), o teste lê a função do arquivo por regex e a avalia.

### 8.3 Manual (checklist antes de fechar)

1. Terminal.app, iTerm2 e o terminal integrado do VSCode: `live` durante uma run real, com resize,
   `q` e Ctrl+C, e o terminal volta ao normal.
2. Um `/graph-eng` real na CLI e outro no VSCode:
   - toda resposta durante a run começa com ⏳ RODANDO;
   - nenhuma diz "terminei" antes do ✅ TERMINADO;
   - o plan gate e o gate humano saem por AskUserQuestion.
3. Monitor: uma run de mais de 30 min mostra um rearme com a linha `retomando`.
4. `/workflows`: o `log(graphText())` aparece acima das fases. Registrar se ele aparece com várias
   linhas ou cortado (§5.5).
5. VSCode: os subagentes do workflow aparecem ou não no agent map (`/tasks`). Registrar o
   resultado e ajustar o texto do §5.4 (b), item 5.
6. `live --svg` com o `d2` instalado: o link abre no browser integrado do VSCode e o live reload
   funciona. Se o WebSocket falhar, a reserva é o F5.

---

## 9. Trade-offs e riscos

- **O renderer próprio é código nosso (~100 linhas de layout).** Aceito em troca de zero
  dependência e de caixas sem defeito. O limite é ~15 nós, e acima disso a saída é o SVG.
- **A dedução de estado replica o motor.** Se o `runNode` mudar, o graph-watch diverge. Mitigação:
  o `log(graphText())` mostra a verdade do motor no `/workflows`, e o teste 12 compara as duas.
- **O formato do journal não é documentado** (nem em https://code.claude.com/docs/en/workflows.md).
  Uma mudança do runtime quebra o graph-watch, e aí a regra "avisa e sai" + abordagem A evita
  estado falso.
- **Transições sem timestamp:** a duração dos estados transitórios é **unverified**. Só os estados
  permanentes são garantidos (com as flags).
- **O VSCode depende de coisas não confirmadas:** o agent map para subagentes de workflow, o
  `/workflows` na extensão e o WebSocket do D2 no browser integrado. Todas têm reserva: o
  `graph-watch agent` e o F5.
- **O Monitor é limitado pela ferramenta:** prazo de 30 min e parada por excesso. O rearme e o
  "como está?" sob demanda cobrem.

## 10. Como verificar esta spec implementada

1. `node --test test/` passa, e os goldens batem.
2. Checklist manual do §8.3 feito e registrado.
3. `git diff --stat` mostra só `bin/graph-watch.mjs`, `test/**`, `skills/graph-eng/SKILL.md` (os 4
   blocos do §5.4) e `workflows/graph-eng.js` (só `graphText()` e 3 chamadas de `log`).
