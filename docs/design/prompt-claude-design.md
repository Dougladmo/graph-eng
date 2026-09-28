# Prompt para o Claude Design — visual do painel ao vivo do graph-eng

> Copie tudo abaixo da linha e cole no Claude Design. O prompt pede **só o CSS** (e, se precisar,
> ajustes estáticos no `index.html`), porque a lógica de renderização já está pronta e testada.

---

## O que é o produto

O **graph-eng** é um plugin do Claude Code que resolve tarefas grandes de programação
montando um grafo pequeno de agentes de IA. Um planner quebra a tarefa em nós; cada nó é executado por
um agente, verificado por outro e reparado se falhar; um "critic" confere o todo e uma "síntese" fecha
o relatório.

O **painel** é uma página web local (`http://127.0.0.1:4477`) que o próprio plugin sobe. Ela mostra
**todas** as runs do graph-eng rodando na máquina — muitas vezes 2 ou 3 ao mesmo tempo, uma por
terminal — e o grafo de cada uma **ao vivo**, atualizando a cada segundo.

**Quem usa:** um dev com terminais abertos rodando o Claude Code, que deixa o painel numa aba do
browser e olha de relance.

**Tarefa principal da tela:** responder em um segundo *onde cada run está agora e o que travou*.

## O que eu preciso de você

Um **`style.css` novo** que substitua o atual, dando identidade visual ao painel. A estrutura HTML, o
posicionamento dos nós e das arestas e a atualização ao vivo já existem e **não podem mudar**. O
seu trabalho é vestir esse esqueleto.

Entregue:

1. `style.css` completo, pronto para substituir o atual.
2. (Opcional) mudanças **estáticas** no `index.html`, como fonte do Google Fonts ou texto da legenda,
   mantendo todos os `id`, as classes e a ordem dos elementos listados abaixo.
3. Uma nota curta com a direção visual (paleta, tipografia, o que é o elemento memorável).

## Restrições rígidas (quebrar qualquer uma quebra o painel)

- **Sem framework, sem build, sem JS novo.** HTML e CSS puros. O JS já existe e fica como está.
- **O grafo é desenhado com elementos HTML, sem SVG e sem canvas.** Cada nó é um `button.node`
  posicionado por `left`/`top`, e cada aresta é uma `div.edge` girada. Não substitua isso por imagem
  ou SVG.
- **`left`/`top` de `.node` são o centro da bolinha.** O JS calcula as arestas a partir desse centro
  e as apara no raio da bolinha. Por isso o diâmetro da `.dot` dentro do grafo precisa continuar
  **16 px** (`--dot: 16px`). Se quiser outro tamanho, diga qual na nota e eu ajusto a constante
  `LAYOUT.DOT` no JS.
- **A `.dot` é posicionada por `margin`, não por `transform`.** Fique à vontade para animar
  `transform: scale(...)`, `box-shadow` ou `opacity` na bolinha.
- **A `.edge` recebe do JS `left`, `top`, `width` e `transform: rotate()`,** com `transform-origin`
  no meio da borda esquerda. Você controla a espessura (`--edge-w`), a cor e a opacidade, mas não o
  `transform` nem a geometria.
- **Mantenha as regras marcadas `ESTRUTURAL`** (lista abaixo). Pode acrescentar propriedades
  visuais a elas, mas não remova nem troque as que estão lá.
- **Fontes:** a CSP da página só aceita CSS de `fonts.googleapis.com` e fonte de `fonts.gstatic.com`.
  Nada de outro CDN. Use fallback do sistema, porque o painel precisa funcionar offline.
- **Acessibilidade mínima:** tema claro e escuro (`prefers-color-scheme`), foco de teclado visível
  em `.node` e `.run-btn`, `prefers-reduced-motion` respeitado (sem pulso, troque por um anel
  estático) e contraste AA no texto.
- **Celular (≤ 720 px):** a lateral vira um botão "suas runs" que abre a lista, o grafo rola na
  horizontal dentro do próprio quadro (a página não rola na horizontal) e o detalhe vira uma folha
  presa embaixo.

## A semântica que o visual precisa deixar óbvia

Cada nó é uma **bolinha**. O estado vem no atributo `data-variant`:

| `data-variant` | Significa                                      | Pedido do dono do projeto              |
| -------------- | ---------------------------------------------- | -------------------------------------- |
| `empty`        | ainda não rodou                                | bolinha **vazia** (só o contorno)      |
| `running`      | rodando agora (trabalhando, verificando, reparando) | bolinha **piscando**              |
| `done`         | já rodou                                       | bolinha **preenchida**                 |
| `fail`         | falhou (verificação reprovou, erro, bloqueado) | preenchida, em cor de erro             |
| `skipped`      | pulado (uma dependência falhou)                | contorno tracejado, esmaecido          |

Mais três regras:

- **Run parada não pulsa.** `#graph[data-status]` e `.run-btn[data-status]` valem `rodando`,
  `parada?` (sem evento há 2 min, provavelmente interrompida) ou `terminado`. Um nó `running` de run
  que não está `rodando` **não** pode piscar: mostre como congelado, sem fingir atividade.
- **Aresta percorrida × futura:** `.edge[data-active="true"]` quando a origem já rodou. A futura
  fica mais apagada.
- **Pseudo-nós:** `data-kind` vale `plan` (primeiro), `node` (os nós da tarefa), `critic` e `synth`
  (os dois últimos). `node` merece mais peso visual que os pseudo-nós. `data-round` (1, 2, 3…) diz o
  round do nó: runs com mais de um round podem usar um tom por round.

**Referência de forma do grafo, escolhida pelo dono:** desenho de livro de teoria dos grafos, com
bolinhas ligadas por linhas retas finas e rótulo curto ao lado. Nada de mapa de metrô, fluxograma
com caixas nem gráfico com cara de ferramenta de BI. A ousadia visual pode ir para a moldura, a
tipografia e a cor. O grafo em si continua simples e legível.

## O HTML (fixo)

```html
<div id="app">
  <button id="sidebar-toggle" type="button" aria-expanded="false" aria-controls="sidebar">suas runs</button>
  <nav id="sidebar" aria-label="suas runs"></nav>
  <main id="board">
    <header id="run-header"></header>
    <p id="conn" role="alert"></p>
    <p id="empty-msg" role="status">Procurando runs do graph-eng…</p>
    <div id="map-scroll">
      <div id="graph">
        <div id="edges" aria-hidden="true"></div>
        <div id="nodes"></div>
      </div>
    </div>
    <ul id="legend">
      <li><span class="dot" data-variant="empty" aria-hidden="true"></span> ainda não rodou</li>
      <li><span class="dot" data-variant="running" aria-hidden="true"></span> rodando agora</li>
      <li><span class="dot" data-variant="done" aria-hidden="true"></span> já rodou</li>
      <li><span class="dot" data-variant="fail" aria-hidden="true"></span> falhou</li>
      <li><span class="dot" data-variant="skipped" aria-hidden="true"></span> pulado</li>
    </ul>
  </main>
  <aside id="drawer" hidden aria-label="detalhe do nó">
    <button id="drawer-close" type="button" aria-label="Fechar detalhe">×</button>
    <div id="drawer-body"></div>
  </aside>
</div>
```

## O DOM que o JS gera (amostras reais, com dados de exemplo)

Lateral — uma `.project-group` por projeto, com uma `.run-btn` por run. A `.run-strip` é uma faixa
com uma bolinha por nó, para ver o progresso sem clicar:

```html
<div class="project-group">
  <h2>projeto-alfa</h2>
  <div class="project-runs">
    <button class="run-btn" type="button" data-wf="wf_sim00001-alfa" data-status="rodando" aria-current="true" title="Feature A de exemplo">
      <span class="run-name">sim00001-alfa</span>
      <span class="run-strip">
        <span class="dot" data-variant="done" data-round="1"></span>
        <span class="dot" data-variant="running" data-round="1"></span>
        <span class="dot" data-variant="empty" data-round="1"></span>
      </span>
    </button>
  </div>
</div>
```

Cabeçalho da run selecionada (campos vazios somem):

```html
<header id="run-header" data-status="rodando">
  <h1>projeto-alfa — sim00001-alfa</h1>
  <span class="meta meta-status">rodando</span>
  <span class="meta meta-round">round 1</span>
  <span class="meta meta-agents">6 agentes de ~11 (teto 24)</span>
  <span class="meta meta-goal">Feature A de exemplo</span>
  <span class="warns"></span>
</header>
```

Grafo — arestas em `#edges`, nós em `#nodes`, os dois no mesmo sistema de coordenadas de `#graph`
(colunas a cada 170 px, linhas a cada 80 px):

```html
<div id="graph" data-status="rodando" style="width: 1140px; height: 168px;">
  <div id="edges" aria-hidden="true">
    <div class="edge" data-from="plan" data-to="A1" data-active="true"
         style="left: 71px; top: 80px; width: 148px; transform: rotate(0deg);"></div>
    <div class="edge" data-from="A1" data-to="A2" data-active="false"
         style="left: 240.7px; top: 77.5px; width: 152.6px; transform: rotate(-13.24deg);"></div>
  </div>
  <div id="nodes">
    <button class="node" type="button" data-id="A1" data-kind="node" data-variant="done" data-state="pronto"
            data-round="1" data-selected="false" aria-label="A1 · Modelo de dados, pronto" style="left: 230px; top: 80px;">
      <span class="dot"></span><span class="node-label">A1 · Modelo de dados</span>
    </button>
    <button class="node" type="button" data-id="A2" data-kind="node" data-variant="running" data-state="trabalhando"
            data-round="1" data-selected="true" aria-label="A2 · API, trabalhando" style="left: 400px; top: 40px;">
      <span class="dot"></span><span class="node-label">A2 · API</span>
    </button>
  </div>
</div>
```

Detalhe do nó (a gaveta à direita abre ao clicar numa bolinha e se atualiza ao vivo; os agentes
aparecem do mais recente para o mais antigo):

```html
<div id="drawer-body">
  <p class="drawer-title">API (A2)</p>
  <p class="drawer-state" data-variant="running">trabalhando</p>
  <section class="agent-block" data-status="rodando">
    <h3>work:A2 — rodando</h3>
    <ul class="tool-calls">
      <li><time>00:16:37</time> Bash — Rodar testes de A2</li>
      <li><time>00:16:34</time> Bash — Ler arquivos de A2</li>
    </ul>
    <p class="verdict">veredito: não passou (1 bloqueio)</p>
    <ul class="blocking"><li>Exemplo de problema bloqueante — x.js:1</li></ul>
    <p class="summary">feito A2</p>
    <ul class="checks-list"><li data-ok="true">✓ node --test</li></ul>
    <p class="last-text">Último texto livre do agente.</p>
    <details class="prompt"><summary>prompt</summary><p>…</p></details>
  </section>
</div>
```

Avisos: `#conn` recebe "Perdi a conexão com o graph-watch. Tentando de novo…" quando o servidor cai
e fica vazio quando volta. `#empty-msg` mostra "Procurando runs do graph-eng…" na carga e "Nenhuma run
do graph-eng por aqui. Dispare /graph-eng numa sessão do Claude Code e ela aparece sozinha." quando não
há run nenhuma. Os dois precisam sumir (`:empty { display: none }`) quando estiverem vazios.

## Regras ESTRUTURAIS do CSS atual (mantenha)

```css
:root { --dot: 16px; }                                   /* = LAYOUT.DOT no JS */
#app { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr) auto; height: 100vh; }
#graph { position: relative; }                           /* origem única de nós e arestas */
#edges, #nodes { position: absolute; inset: 0; }
#drawer[hidden] { display: none; }

.edge {
  position: absolute;
  height: var(--edge-w);
  margin-top: calc(var(--edge-w) / -2);                  /* centraliza a espessura na reta */
  transform-origin: 0 50%;
  pointer-events: none;
}

.node {                                                  /* caixa de clique centrada no ponto do JS */
  --hit: 28px;
  position: absolute;
  width: var(--hit);
  height: var(--hit);
  margin: calc(var(--hit) / -2) 0 0 calc(var(--hit) / -2);
  padding: 0;
}
.node .dot {
  position: absolute; left: 50%; top: 50%;
  margin: calc(var(--dot) / -2) 0 0 calc(var(--dot) / -2);
}
.node-label {                                            /* rótulo centrado abaixo da bolinha */
  position: absolute;
  top: calc(50% + var(--dot) / 2 + 6px);
  left: 50%;
  transform: translateX(-50%);
  max-width: 150px;                                      /* < 170 px entre colunas: rótulos não se tocam */
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
```

A bolinha aparece em três tamanhos: 16 px no grafo, 8 px na faixa da lateral (`.run-strip .dot`) e
~11 px na legenda (`#legend .dot`). A mesma regra por `data-variant` deve valer para os três.

## Tom do texto

A interface é em pt-BR, com frases curtas, em sentence case e sem caixa alta decorativa. Se mudar
algum texto estático (legenda, botão), mantenha o vocabulário: "ainda não rodou", "rodando agora",
"já rodou", "falhou", "pulado".
