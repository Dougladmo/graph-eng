# Painel web ao vivo dos grafos (substitui o `--svg`/D2)

## Objetivo

Um painel em `localhost`, servido pelo próprio `bin/graph-watch.mjs`, que mostra **todas** as runs do
graph-eng da máquina (vários terminais, vários projetos) e o grafo de cada uma ao vivo. Substitui a
visão `--svg` com D2, que não ficou boa. Só leitura: o painel nunca altera uma run.

## Decisões já tomadas com o usuário

- **Stack:** Node puro (`node:http`) + HTML/CSS/JS sem build e sem dependência. Nada de React, npm ou
  `package.json`. Atualização ao vivo por **SSE** (`text/event-stream`).
- **D2 sai:** remover `detectD2`, `buildD2Source`, `ensureSvgPipeline` e `test/svg.test.mjs`. `live --svg`
  passa a subir/reaproveitar o painel e imprimir a URL (alias de compatibilidade), sem D2.
- **Subida automática:** a skill, ao disparar uma run, garante o painel rodando (um servidor só por
  máquina, reaproveitado entre terminais) e mostra o link. À mão: `graph-watch ui`.
- **Só leitura:** clique no nó abre o detalhe; sem parar, retomar ou rerodar.

## Critérios de aceite (verificáveis)

1. `node bin/graph-watch.mjs ui [--port N] [--no-open] [--projects-dir D]` sobe um servidor HTTP em
   `127.0.0.1` (porta padrão fixa, ex. 4477) e imprime `graph-eng: painel: http://127.0.0.1:<porta>`.
   Com `--open` (ou padrão sem `--no-open` quando é TTY) abre o browser (`open`/`xdg-open`/`start`).
1b. **Porta editável:** precedência `--port N` > variável `GRAPH_ENG_PORT` > padrão 4477. Porta inválida
   (não inteiro, fora de 1-65535) → erro claro. Porta ocupada por outro programa → erro que diz como trocar:
   `graph-eng: erro: porta 4477 ocupada por outro programa; use --port <N> ou GRAPH_ENG_PORT=<N>`. A skill
   repassa a porta (nunca fixa 4477 no texto) e o README ensina a fixar de vez com
   `"env": {"GRAPH_ENG_PORT": "<N>"}` no `~/.claude/settings.json`. `live --svg` respeita a mesma precedência.
2. **Instância única:** se a porta já tem um graph-watch (`GET /api/health` → `{"app":"graph-watch"}`),
   o comando imprime a mesma URL e sai 0 sem subir outro. Porta ocupada por outro programa → erro claro,
   código ≠ 0.
3. `GET /api/runs` lista as runs do graph-eng de **todos** os projetos sob `~/.claude/projects`
   (reusa `listAllWfDirs` + `isGraphEngRun`), cada uma com: `wf`, projeto legível (derivado do slug ou do
   `cwd` dos arquivos do agente), `status` (`rodando`/`parada?`/`terminado`), `goal` do plano quando
   houver, contagem `feitos/total`, `mtime`. Ordem: em andamento primeiro, depois mais recentes. Limite
   razoável (ex. 50) para não ler journals antigos a cada tick.
4. `GET /api/runs/:wf` devolve o modelo de `buildModel` (nós, deps, estado, round, critic, synth,
   gastos, estimativa). `:wf` é validado (`/^wf_[A-Za-z0-9_-]+$/`) e precisa existir na lista — nunca vira
   caminho arbitrário. Economy/mode: inferir da transcrição do agente `plan` quando der barato; senão
   `undefined` (o estado visual é o mesmo).
5. `GET /api/runs/:wf/nodes/:id` devolve o detalhe do nó em JSON (dados do `buildAgentView`: agentes do
   nó, rótulo, prompt resumido, últimas tool calls, resultado/veredito, checks).
6. `GET /api/events` (SSE) empurra `runs` quando a lista muda e `run` (com `wf`) quando o journal de uma
   run muda (poll de `mtime`/tamanho ~1 s, sem `fs.watch` obrigatório). Heartbeat a cada ~15 s. Fecha
   limpo quando o cliente desconecta.
7. **A página** (arquivos estáticos em `bin/ui/`: `index.html`, `app.js`, `style.css`):
   - barra lateral com as runs; a run em andamento tem indicador pulsando; clicar troca o grafo;
     a URL guarda a run selecionada (`?run=wf_…` ou hash) para dar refresh/compartilhar a aba;
   - grafo em camadas pelas deps (DAG, esquerda→direita), nós como elementos HTML, arestas desenhadas
     sem biblioteca; pseudo-nós `plan` no início e `critic`/`synth` no fim; nós de round 2+ agrupados
     visualmente;
   - **bolinha por nó:** piscando = rodando agora (`trabalhando`, `verificando`, `reparando`);
     preenchida = já rodou (`pronto*`; vermelha em `falhou*`/`bloqueado`/`erro`); **vazia** = ainda não
     rodou (`aguardando`); vazia tracejada/esmaecida = `pulado`. Legenda visível;
   - clique no nó abre painel de detalhe (endpoint do item 5); o detalhe se atualiza ao vivo;
   - cabeçalho da run: status, round, agentes gastos vs estimativa/teto, avisos (`warns`);
   - tema claro e escuro (`prefers-color-scheme`), legível em largura de celular;
   - todo texto vindo do journal entra via `textContent` (nunca `innerHTML` com dado).
8. **Segurança:** bind só em `127.0.0.1`; rejeita `Host` que não seja `127.0.0.1:<porta>` ou
   `localhost:<porta>` (DNS rebinding); estáticos servidos por lista fixa, sem path traversal; nenhum
   endpoint escreve em disco.
9. `live --svg` não usa mais D2: garante o painel (item 2) e imprime a URL com `?run=<wf>`, depois segue
   como `live` normal.
10. `skills/graph-eng/SKILL.md` §5: ao disparar a run, subir o painel em background de forma idempotente
    (`node "${CLAUDE_PLUGIN_ROOT}/bin/graph-watch.mjs" ui --no-open` via Bash `run_in_background`, ou
    equivalente). **Todo marco** da skill carrega o link na mesma linha, no formato literal
    `⏳ RODANDO — graph-eng <runId> · k/N prontos · veja ao vivo em http://127.0.0.1:<porta>/?run=<wf>`
    (a primeira resposta e cada atualização do item 3 do §5; o `✅ TERMINADO` também leva o link). A
    porta vem da saída do `ui`, nunca chutada. Remover menções a D2/`--svg` como visão SVG. `README.md`
    ganha a seção do painel e perde a de D2.
11. `.claude-plugin/plugin.json` sobe para `0.3.0`.
12. `node --test` na raiz passa. Testes novos com fixtures sintéticas (`--projects-dir`): lista de runs
    multi-projeto, `/api/runs/:wf`, `:wf` inválido → 400/404, `Host` inválido → 403, instância única
    reaproveitada, SSE emite `run` após append no journal, estáticos servidos e caminho fora da lista → 404.
14. **Horário local:** o `agent` (`bin/graph-watch.mjs:810`) e o `live` (`:1039`) hoje mostram HH:MM:SS em
    UTC (`toISOString().slice(11,19)`/`timestamp.slice(11,19)`), o que fez uma run ativa parecer parada.
    Passam a mostrar hora local, e o painel também. Nos testes, fixar `TZ` para o resultado ser determinístico.
13. Privacidade: nenhum caminho absoluto da máquina (`/Users/`, `/Volumes/`) em `bin/` e `test/`; fixtures
    só com textos inventados.

## Fora de escopo

Ações sobre a run (parar, retomar, rerodar), autenticação, acesso remoto/LAN, React/build, persistência
de estado do painel além de `localStorage` para preferências de UI.

## Always / Ask first / Never

- **Always:** zero dependência; modos `snapshot`, `agent`, `events`, `live` continuam com o mesmo contrato
  e os testes deles verdes; reusar `buildModel`/`findRun`/`buildAgentView` em vez de duplicar lógica.
- **Never:** `innerHTML` com dado do journal; bind em `0.0.0.0`; escrever fora de `os.tmpdir()`; commit.

## Como verificar

`node --test`; subir `node bin/graph-watch.mjs ui --no-open --projects-dir test/fixtures-…` e conferir
com `curl` os endpoints; abrir no browser (Playwright, se disponível) e checar as três bolinhas.

## Direção visual (skill frontend-design — vale para `bin/ui/`)

**Assunto e público.** Um dev com um ou mais terminais rodando graph-eng olha de relance uma aba do
browser. A tarefa principal da tela é responder, em um segundo, *onde cada run está agora e o que travou*.

**Conceito: grafo de livro-texto (decisão do usuário, substitui o "mapa de metrô").** Desenho de teoria
dos grafos, simples: cada nó é uma **bolinha** (componente HTML, `button` posicionado com `left/top`) e
cada dependência é uma **linha reta fina** (componente HTML: `div` de 1-1.5 px rotacionado entre os dois
centros; sem SVG, sem canvas, sem biblioteca, sem geração de imagem). Rótulo curto (`I2`, título
truncado) ao lado da bolinha. Posição calculada no JS a cada atualização (camadas pelas deps,
distribuídas no quadro) e recalculada no resize. Semântica das bolinhas: **vazia** (anel, miolo da cor do
fundo) = ainda não rodou; **cheia** = já rodou; **pulsando** = rodando agora; cheia vermelha = falhou;
anel tracejado esmaecido = pulado. Aresta cujo nó de origem já rodou fica em tinta cheia; o resto, esmaecida.

**Cor (tokens em `:root`, redefinidos no escuro):**
- `--paper` #F3F6F8 (fundo claro, frio, sem creme) / escuro `--paper` #141A22 (azul-ardósia noturno)
- `--ink` #1B2533 texto / escuro #E4EAF0
- `--line-1` #2356A8 (round 1) · `--line-2` #0F8468 (round 2) · `--line-3` #9B2C7A (round 3+)
- `--fail` #D3263A · `--muted` #8793A0 (aguardando/pulado, arestas futuras)
Aresta percorrida em tinta cheia, futura com 35% de opacidade. Nada de gradiente nem sombra decorativa.

**Tipo:** uma família só, **Overpass**,
via Google Fonts com `display=swap`, e fallback `system-ui` para funcionar offline. Pesos: 800 no nome da
run, 600 no rótulo do nó, 400 no corpo. Escala 13/15/19/28 px. Sem monoespaçada em rótulo, sem
CAIXA ALTA, sem eyebrow acima de título. O id do nó (`I2`) abre o rótulo.

**Layout:**
```
┌──────────────┬──────────────────────────────────────────────────────┐
│ suas runs    │ painel-web-grafos        rodando   round 1   7 de 24 │
│              │                                                      │
│ postify      │  plan ●━━━━● I1 ━━━━◉ I2 ━━━━○ I4 ━━━━○ critic ━━○ synth
│  ●●◉○○ ...   │            ┗━━━━● I3 ━━━━━━━━┛                      │
│ graph-eng    │                                                      │
│  ●●●●● ...   │                                    ┌ detalhe do nó ┐ │
│              │  legenda: ○ ainda não  ◉ rodando  ● rodou  ⊘ falhou │
└──────────────┴──────────────────────────────────────────────────────┘
```
- **Barra lateral:** runs agrupadas por projeto; cada run mostra o nome + uma **faixa-miniatura** com
  as estações em linha (mesma semântica das bolinhas). Dá para ler o progresso das 3 runs de 3
  terminais sem clicar. Run ativa em cima.
- **Grafo** em camadas da esquerda para a direita, bolinhas e linhas retas como na referência do usuário;
  round 2+ usa a cor do round na bolinha. Rótulo ao lado da bolinha.
- **Detalhe:** gaveta à direita (sobre o grafo no celular), abre ao clicar na bolinha e fecha com Esc.
  Mostra o título, o estado, os agentes do nó, as últimas tool calls com hora local, o resultado ou
  veredito e os checks. Foco de teclado visível em bolinha e run; bolinhas são `button`.
- **Celular:** a lista de runs vira um seletor no topo, e o mapa rola na horizontal dentro do próprio
  quadro (a página não rola na horizontal).

**Movimento:** só o pulso da bolinha ativa, que é a única coisa que precisa chamar atenção. A gaveta
desliza ao abrir, porque responde ao clique. Com `prefers-reduced-motion`, o pulso vira anel duplo estático.

**Texto (pt-BR, sentence case, voz da interface):**
- vazio: "Nenhuma run do graph-eng por aqui. Dispare /graph-eng numa sessão do Claude Code e ela aparece sozinha."
- run parada: "Sem evento há 12 min. A run pode ter sido interrompida."
- conexão caiu: "Perdi a conexão com o graph-watch. Tentando de novo…"

**Onde gastar a ousadia:** no grafo, pela simplicidade. O resto (lateral, cabeçalho, gaveta) fica quieto: sem cards, sem
bordas arredondadas repetidas, sem string de metadado separada por "·".
