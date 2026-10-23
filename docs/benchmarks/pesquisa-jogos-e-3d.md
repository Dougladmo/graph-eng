# Pesquisa: benchmarks de LLM criando jogos, mundos 3D e software inteiro

Pesquisa de 21/10/2026 para as próximas rodadas de benchmark do graph-eng, depois do xadrez. Nada aqui foi rodado. É um catálogo de cases para copiar o formato.

Aviso: a maior parte veio de busca na web (resumos de artigos, blogs e agregadores). Números de placar e nomes de modelo em sites secundários não foram conferidos na fonte. Antes de citar qualquer número, abra o artigo.

## O que procurar num case

O harness do graph-eng avalia com aceites externos rodados por `node --test`, fora do workspace. Um case serve melhor quando:

1. **A nota sai de máquina, sem juiz.** Valor de referência conhecido (perft), simulação determinística, estado do jogo exportável em JSON.
2. **É difícil acertar sem verificar.** Regras com casos de borda, muitos arquivos que precisam concordar entre si, contrato espalhado.
3. **É grande o bastante para estourar uma chamada só.** É aí que o graph-eng pode ganhar do agente único. No cenário `happy` (3 funções), ele perdeu: custou 5,2x mais e levou 9,6x mais tempo.

Cases que dependem de juiz visual (screenshot, votação, VLM) exigem infraestrutura nova: navegador headless, captura e juiz. Ficam para depois.

## A. Jogos verificáveis sem tela (cabem no harness atual)

| case | o que o modelo faz | como avaliar | por que é difícil | estado |
|---|---|---|---|---|
| **Xadrez com perft** | gerador de lances, FEN, roque, en passant, promoção, mate e afogamento | contagem perft contra a [Chess Programming Wiki](https://www.chessprogramming.org/Perft_Results) | um erro de regra muda a contagem; sem shell, o agente não roda o perft | **rodado** (cenário `chess`): os dois passaram 15/15; agente único 2,3x mais barato |
| **Bola quicando em hexágono que gira** | física 2D: gravidade, atrito, colisão com paredes que giram | simulação headless com semente fixa: a bola nunca sai do polígono, a energia não cresce, N passos determinísticos | viralizou como teste informal ([TechCrunch](https://techcrunch.com/2025/01/24/people-are-benchmarking-ai-by-having-it-make-balls-bounce-in-rotating-shapes)); a variante com 5 bolas e hexágonos aninhados é bem mais difícil | proposta |
| **Tetris (motor)** | peças, rotação SRS com wall kicks, linhas, pontuação, gerador 7-bag | sequência de entradas com semente fixa e estado final esperado (tabuleiro e pontos) | wall kicks e T-spin têm muitos casos de borda | proposta |
| **Raycaster estilo Doom** | mapa, raycasting, colisão, portas | função `render(estado)` devolve buffer de pixels; aceite compara hash de quadros com semente fixa | geometria e precisão numérica | proposta |
| **Jogo de tiro (lógica, sem tela)** | movimento, projéteis, dano, inimigos com IA simples, rodadas | simulação por ticks com entradas gravadas; estado em JSON comparado ao esperado | muitos sistemas que precisam concordar (física, dano, IA, rodadas) | proposta |

## B. Criação de jogo completo (precisa de juiz ou motor de jogo)

| case | o que é | como avalia | o que tirar dele |
|---|---|---|---|
| [GameCraft-Bench](https://arxiv.org/pdf/2606.17861) | 140 tarefas em Godot, 15 famílias (plataforma, estratégia, tycoon, roguelike, visual novel) | o projeto precisa abrir no Godot headless (senão nota 0); replay de demonstrações e juiz multimodal com rubrica (mecânica, profundidade, visual, arte) | o melhor agente fica em torno de 41% ([resumo](https://aiweekly.co/alerts/claude-code-tops-ai-game-building-benchmark-at-41)); só 2D. Godot guarda cena em texto e roda por linha de comando, então dá para automatizar |
| [GameDevBench](https://arxiv.org/pdf/2602.11103) | tarefas de desenvolvimento de jogo | solução de referência com média de 4,7 arquivos e 114 linhas em 3,2 tipos de arquivo | segundo os autores, mais que o triplo de edição do SWE-bench; bom para "muitos arquivos que precisam concordar" |
| [OpenGame-Bench](https://notesbylex.com/opengame-open-agentic-coding-for-games) | jogos web do começo ao fim | inclui nota de **inconsistência entre arquivos** | é a falha que o graph-eng diz evitar (cada arquivo plausível sozinho, o conjunto quebrado) |
| Minecraft clone ([Artificial Analysis MicroEvals](https://artificialanalysis.ai/microevals/minecraft-clone-1762988092197)) | mundo voxel 3D na web, criar e destruir blocos | prompt padronizado; comparação visual | teste popular de "um prompt só"; precisa de navegador e juiz |
| FPS multiplayer em three.js ([relato](https://tejaskulkarni.substack.com/p/vibe-coding-a-3d-game-using-ai)) | jogo de tiro 3D com rede | relato pessoal, sem placar | mostra o tamanho do escopo; não é benchmark controlado |
| [VibeGame](https://huggingface.co/blog/vibegame) | geração de jogo por prompt | relato | contraponto: "faz um jogo pra mim" num prompt só não funciona além do que o motor já oferece |

## C. Modelos 3D e mundos (casa, cena)

| case | o que é | como avalia |
|---|---|---|
| [WorldCoder-Bench](https://arxiv.org/html/2606.01869) | 2.026 tarefas; saída é um HTML único com mundo three.js executável e interativo | execução no navegador e checagem física |
| [WorldBench](https://arxiv.org/html/2610.10622) | mundos voxel em three.js | escada de 280 itens; juiz por render e juiz por código **discordam em 32%** dos itens (cuidado com juiz único) |
| [CodeGen-3D](https://scholarworks.sjsu.edu/faculty_rsca/6835/) | 100 prompts para Blender (Python) | taxa de erro de execução, CLIP e preferência de VLM; sistemas iterativos falham 3-4%, LLMs gerais falham 21-92% |
| [3DCodeBench](https://arxiv.org/html/2606.01057v1) | modelagem procedural 3D em Blender | modelo sozinho contra agente que escreve, executa e refina olhando o render |
| [P3D-Bench](https://arxiv.org/pdf/2606.11152) | 3D paramétrico em JSON, OpenSCAD, CadQuery e three.js | executa e renderiza toda saída |
| [AA-3D](https://artificialanalysis.ai/evaluations/aa-3d) | brief escrito vira cena three.js | Elo por votação cega em pares |

**Case proposto: casa paramétrica.** Gerar uma casa em three.js (ou OpenSCAD) a partir de uma planta em texto: cômodos, medidas, portas e janelas. Para caber no harness sem juiz visual, o código exporta o grafo da cena em JSON. Os aceites conferem: número de cômodos, área de cada um com tolerância, toda porta ligando dois cômodos, janela só em parede externa, telhado cobrindo a planta, nenhuma parede se cruzando. Nenhum benchmark achado é específico de casa; o desenho de checagem vem do CodeGen-3D e do P3D-Bench.

## D. Software inteiro e multiagente contra agente único

| fonte | o que diz |
|---|---|
| [Vals.ai, Multi-Agent Vibe Code Bench](https://www.vals.ai/blogs/multi-agent-vibe-code-bench) | apps feitos do zero. Time contra agente único: ganho significativo em só 1 de 4 comparações; times levaram até 2,3x mais tempo |
| [Rethinking Multi-Agent Collaboration: When More Is Less](https://arxiv.org/pdf/2609.19759) | questiona o ganho de pôr mais agentes (números não lidos) |
| [The Collaboration Tax](https://arxiv.org/pdf/2608.22152) | mede o custo de coordenar dois agentes (puzzles sintéticos) |
| [Coordination Mode in From-Scratch Multi-Agent Coding](https://arxiv.org/pdf/2607.27877) | modo de coordenação em código do zero |
| [SlopCodeBench](https://arxiv.org/pdf/2603.24755) | como agentes degradam em tarefas longas e iterativas (onde revisão separada deveria ajudar) |
| ProgramBench ([SWE-bench](https://www.swebench.com/)) | reconstruir um programa inteiro só com o executável e a documentação |
| [Pelican on a bicycle](https://github.com/simonw/pelican-bicycle) | SVG de pelicano de bicicleta; juiz por comparação em pares com modelo barato. Não mede trabalho de repositório |

**Leitura.** A literatura não garante que dividir em vários agentes ganhe numa tarefa difícil: em vários estudos o time empata e custa mais. A aposta do graph-eng é outra (modelo barato executando, modelo forte revisando, supervisor recusando DONE falso), e precisa ser medida caso a caso. A hipótese a testar: quanto maior a tarefa e mais casos de borda, mais o agente único dá DONE falso ou erra o aceite, e o graph-eng não.

## Ordem sugerida para as próximas rodadas

1. **Xadrez** (`chess`): rodado em 21/10, sem separar as variantes no acerto.
2. **Faturamento** (`faturamento`): 9 módulos, contrato espalhado; montado em outra sessão.
3. **Bola em hexágono giratório** e **Tetris**: física e regras determinísticas, ainda no harness atual.
4. **Jogo de tiro sem tela**: vários sistemas interligados, estado em JSON.
5. **Casa paramétrica em three.js**: grafo de cena em JSON, sem juiz.
6. **Minecraft clone / jogo Godot**: só com navegador headless, captura e juiz multimodal (infra nova).
