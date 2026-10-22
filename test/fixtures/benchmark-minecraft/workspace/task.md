# Tarefa: clone de Minecraft (MVP) para a web, em React

Construa um clone jogável de Minecraft no navegador, com React 18, three.js e Vite. Quero o jogo com o máximo de
detalhe e de funcionalidade que couber nesta spec: mundo infinito gerado por seed, mineração, construção, inventário,
crafting, ciclo de dia e noite, salvamento e uma interface caprichada. Nada de asset externo: toda textura é gerada em
código.

O repositório já tem o esqueleto: `package.json` (dependências instaladas em `node_modules`), `vite.config.js`,
`index.html`, `src/main.jsx`, os módulos do motor em `src/engine/` (só com as assinaturas) e testes em `test/`.

## Regras do repositório

- Não altere `package.json`, `vite.config.js`, `index.html` nem os testes em `test/`. Não instale dependências novas:
  só `react`, `react-dom` e `three` estão disponíveis.
- Todo código vai em `src/`. Crie quantos arquivos precisar.
- **O motor (`src/engine/`) é JavaScript puro (ESM)**: não importa `three`, `react` nem nada do DOM, e roda no Node.
  Ele é testado com `node --test`. A interface (`src/ui/`, `src/render/` ou como preferir) usa o motor.
- Todas as funções do motor são determinísticas, e as marcadas como **pura** não alteram os argumentos: devolvem um
  objeto novo.

## Critério de pronto

1. `npm test` passa.
2. `npm run build` termina sem erro.
3. `npm run dev` abre um jogo jogável com tudo o que está na seção "Interface e jogabilidade".
4. Cada função do motor segue exatamente o contrato abaixo, inclusive os casos de borda. Há testes além dos visíveis.

---

## Motor (`src/engine/`)

### `blocks.js`: blocos e itens

IDs fixos, exportados como constantes com estes nomes:

| id | nome | sólido | transparente | dureza | ferramenta exigida | drop |
|---|---|---|---|---|---|---|
| 0 | `AIR` | não | sim | 0 | — | nada |
| 1 | `GRASS` | sim | não | 0.6 | — | `DIRT` |
| 2 | `DIRT` | sim | não | 0.5 | — | `DIRT` |
| 3 | `STONE` | sim | não | 1.5 | picareta | `COBBLESTONE` |
| 4 | `SAND` | sim | não | 0.5 | — | `SAND` |
| 5 | `WATER` | não | sim | ∞ (não quebra) | — | nada |
| 6 | `LOG` | sim | não | 2 | — | `LOG` |
| 7 | `LEAVES` | sim | sim | 0.2 | — | nada |
| 8 | `PLANKS` | sim | não | 2 | — | `PLANKS` |
| 9 | `COBBLESTONE` | sim | não | 2 | picareta | `COBBLESTONE` |
| 10 | `BEDROCK` | sim | não | ∞ (não quebra) | — | nada |
| 11 | `COAL_ORE` | sim | não | 3 | picareta | `COAL` |
| 12 | `IRON_ORE` | sim | não | 3 | picareta de pedra | `IRON_ORE` |
| 13 | `GLASS` | sim | sim | 0.3 | — | nada |
| 14 | `CRAFTING_TABLE` | sim | não | 2.5 | — | `CRAFTING_TABLE` |

Itens que não são blocos: `STICK = 100`, `WOODEN_PICKAXE = 101`, `STONE_PICKAXE = 102`, `COAL = 103`.

- `getBlock(id)` devolve `{ id, name, solid, transparent, hardness, tool, drop }`.
  - `name` é o nome em minúsculas (`'grass'`, `'crafting_table'`).
  - `hardness` é `Infinity` para água e bedrock.
  - `tool` é `null`, `'pickaxe'` ou `'stone_pickaxe'`.
  - `drop` é o id do drop ou `null`.
  - Id desconhecido lança `RangeError`.
- `getItem(id)` devolve `{ id, name, maxStack, placeable }` para qualquer bloco ou item.
  - Picaretas têm `maxStack: 1`; o resto, 64.
  - `placeable` é `true` só para blocos, exceto `AIR` e `WATER`.
  - Id desconhecido lança `RangeError`.
- `isSolid(id)` e `isTransparent(id)` seguem a tabela.

### `noise.js`: aleatoriedade com seed

- `hashSeed(seed)` aceita número ou string e devolve um inteiro de 32 bits sem sinal.
  - Mesma entrada, mesmo resultado.
  - `'abc'` e `'abd'` dão valores diferentes.
- `createRng(seed)` devolve uma função que gera números em `[0, 1)`, sempre a mesma sequência para a mesma seed.
- `createNoise2D(seed)` devolve `noise(x, z)` com valor em `[-1, 1]`, contínuo: pontos a 0.01 de distância diferem
  menos de 0.05. Seeds diferentes dão campos diferentes.

### `world.js`: mundo em chunks

Constantes: `CHUNK_SIZE = 16`, `WORLD_HEIGHT = 64`, `SEA_LEVEL = 20`.

- `chunkIndex(x, y, z)` é a posição de um bloco local no array do chunk: `x + z * 16 + y * 256`.
- `generateChunk(seed, cx, cz)` devolve um `Uint8Array` de `16 * 64 * 16` com os ids do chunk `(cx, cz)`, que cobre
  os blocos `x` em `[cx*16, cx*16+15]` e `z` em `[cz*16, cz*16+15]`. Regras:
  - y = 0 é sempre `BEDROCK`.
  - A altura do terreno `h(x, z)` vem do ruído e fica em `[SEA_LEVEL - 8, SEA_LEVEL + 20]`. Ela é a mesma seja qual for
    o chunk que gerou a coluna (sem emenda entre chunks).
  - Topo da coluna (y = h): `GRASS` se `h > SEA_LEVEL + 1`; senão `SAND`.
  - Os 3 blocos logo abaixo do topo são `DIRT` (sob grama) ou `SAND` (sob areia). Abaixo deles, `STONE` até y = 1.
  - Se `h < SEA_LEVEL`, de `h + 1` até `SEA_LEVEL` é `WATER`. Acima de tudo isso, `AIR`.
  - Minérios trocam `STONE` por `COAL_ORE` (só com y ≤ 40) ou `IRON_ORE` (só com y ≤ 24). Cada chunk tem ao menos um
    `COAL_ORE`.
  - Árvores só sobre `GRASS`, com o tronco em x e z locais de 2 a 13, para a copa caber no chunk.
    - Tronco: 4 a 6 `LOG` em cima da grama.
    - Copa: `LEAVES` em volta do topo do tronco, só em células que eram `AIR`.
    - Nenhuma folha e nenhum tronco ficam fora do chunk.
  - Mesma seed e mesmo chunk dão o mesmo array; seeds diferentes dão mundos diferentes.
- `createWorld(seed, options = {})` cria o mundo.
  - Os chunks são gerados sob demanda e guardados em cache.
  - Com `options.flat === true`, o gerador é plano: só `BEDROCK` em y = 0 e `AIR` no resto, sem árvore nem minério.
    Os testes usam esse modo.
- `getBlockAt(world, x, y, z)` devolve o id em coordenadas de mundo.
  - Inteiros, inclusive negativos: o bloco x = -1 é do chunk -1, posição local 15.
  - y < 0 devolve `BEDROCK`; y ≥ 64 devolve `AIR`.
- `setBlockAt(world, x, y, z, id)` grava o id.
  - y fora de `[0, 63]` lança `RangeError`.
  - Grava edições, e reverter um bloco ao valor gerado apaga a edição.
- `getSurfaceHeight(world, x, z)` devolve o maior y com bloco sólido na coluna.
- `serializeWorld(world)` devolve uma string JSON
  `{"version":1,"seed":...,"flat":...,"edits":[[x,y,z,id],...]}`.
  - Só entram as edições, ordenadas por x, depois y, depois z.
- `deserializeWorld(json)` recria o mundo com as edições aplicadas.
  - `serializeWorld(deserializeWorld(s)) === s`.
  - Versão diferente de 1 lança `Error`.

### `mesher.js`: malha de um chunk

`buildChunkMesh(world, cx, cz)` devolve `{ opaque, transparent }`. Cada um tem `positions` (`Float32Array`),
`normals` (`Float32Array`), `uvs` (`Float32Array`) e `indices` (`Uint32Array`).

- Cada face visível vira 4 vértices e 6 índices (2 triângulos).
  - As posições ficam em coordenadas de mundo: um cubo em (x, y, z) ocupa de x a x+1, e o mesmo em y e z.
  - A normal aponta para fora.
  - UVs em `[0, 1]`, dentro do tile do bloco num atlas de texturas.
  - Índices em sentido anti-horário visto de fora.
- **Culling**: uma face de um bloco não-ar é emitida se, e só se, o vizinho daquele lado:
  - é `AIR`; ou
  - é transparente com id diferente.
  - Por isso, água com água, vidro com vidro e folha com folha não geram face entre si, e a face de pedra virada para
    vidro aparece.
- Vizinhos em outro chunk são lidos do mundo. Abaixo de y = 0 conta como `BEDROCK`, acima de 63 como `AIR`.
- Blocos transparentes (`WATER`, `GLASS`, `LEAVES`) vão para `transparent`; os outros, para `opaque`.

### `raycast.js`: mira

`raycast(world, origin, direction, maxDistance)` percorre os voxels com DDA (Amanatides & Woo).
- `direction` não precisa estar normalizada.
- `AIR` e `WATER` não são alvo.
- Acerto devolve `{ x, y, z, block, face, distance }`:
  - `face` é a normal da face atingida, como `[0, 1, 0]`;
  - `distance` é a distância euclidiana da origem ao ponto de entrada.
- Sem acerto dentro de `maxDistance`, devolve `null`.
- Se a origem já estiver dentro de um bloco sólido, devolve esse bloco com `face: [0, 0, 0]` e `distance: 0`.
- O bloco onde se coloca outro é `(x + face[0], y + face[1], z + face[2])`.

### `physics.js`: jogador

Constantes exportadas:

| constante | valor |
|---|---|
| `PLAYER_WIDTH` | 0.6 |
| `PLAYER_HEIGHT` | 1.8 |
| `EYE_HEIGHT` | 1.62 |
| `GRAVITY` | 32 |
| `JUMP_VELOCITY` | 9 |
| `WALK_SPEED` | 4.3 |
| `SPRINT_SPEED` | 5.6 |
| `SNEAK_SPEED` | 1.3 |
| `TERMINAL_VELOCITY` | 78 |

- `createPlayer(position)` devolve `{ position: [x, y, z], velocity: [0, 0, 0], onGround: false, yaw: 0, pitch: 0, flying: false }`.
  `position` é o centro da base do AABB (os pés).
- `stepPlayer(player, input, dt, world)` (**pura**) avança a física e devolve o jogador novo.
  - `input` tem `{ forward, backward, left, right, jump, sprint, sneak }` (booleanos).
  - **Direção**: com `yaw = 0`, frente é -Z e direita é +X. Em geral, frente é `[-sin(yaw), 0, -cos(yaw)]` e direita é
    `[cos(yaw), 0, -sin(yaw)]`. A diagonal é normalizada, sem andar mais rápido.
  - **Velocidade** horizontal: `WALK_SPEED`, `SPRINT_SPEED` com `sprint` andando para a frente, ou `SNEAK_SPEED` com
    `sneak`. Ela é aplicada direto, sem inércia.
  - **Gravidade** reduz `velocity[1]` em `GRAVITY * dt`, limitada a `-TERMINAL_VELOCITY`.
  - **Pulo** só com `onGround`: `velocity[1] = JUMP_VELOCITY`. O pulo sobe um degrau de 1 bloco e não sobe 2.
  - **Colisão AABB** contra blocos sólidos, eixo por eixo: Y, depois X, depois Z.
    - Ao bater no chão, `onGround = true`, `velocity[1] = 0` e os pés ficam exatamente no topo do bloco.
    - Ao bater no teto, `velocity[1] = 0`.
    - `dt` maior que 0.05 é dividido em subpassos de no máximo 0.05, para não atravessar blocos.
  - **Sneak** no chão impede sair de uma borda: o jogador para antes de ficar sem bloco sólido embaixo.
  - **Água**: com o AABB em água, a gravidade cai a 1/4, a queda é limitada a 3 blocos/s e `jump` sobe a 3 blocos/s.
  - **Voo** (`flying: true`): sem gravidade; `jump` sobe e `sneak` desce, a `WALK_SPEED`; colisão continua valendo.
- `collidesAt(world, position)` diz se o AABB do jogador nessa posição intersecta um bloco sólido.
- `canPlaceBlock(player, x, y, z)` é `false` se o cubo do bloco intersectar o AABB do jogador.

### `inventory.js`: inventário (todas **puras**)

- `createInventory()` devolve `{ slots: Array(36).fill(null), selected: 0 }`.
  - Os slots 0 a 8 são a hotbar.
  - Uma pilha é `{ id, count }`.
- `addItem(inv, id, count)` devolve `{ inventory, leftover }`.
  - Primeiro completa as pilhas do mesmo id que já existem, em ordem de slot. Depois ocupa slots vazios em ordem.
  - Respeita `maxStack`: picaretas ficam uma por slot.
  - O que não cabe volta em `leftover`.
- `removeFromSlot(inv, slot, count)` tira até `count` itens; o slot que zera vira `null`.
- `selectSlot(inv, index)` aceita só 0 a 8; fora disso, lança `RangeError`.
- `scrollSelection(inv, delta)` anda na hotbar com volta (8 + 1 → 0, 0 − 1 → 8).
- `moveStack(inv, from, to)` move a pilha de um slot para outro:
  - destino vazio: move;
  - mesmo id: junta até `maxStack` e deixa a sobra na origem;
  - id diferente: troca.
- `selectedItem(inv)` devolve a pilha da hotbar selecionada ou `null`.

### `crafting.js`: receitas

`craft(grid)` recebe uma grade quadrada 2x2 ou 3x3: um array de linhas cujas células são `null` ou uma pilha
`{ id, count }`. A receita olha só os ids. Devolve `{ id, count }` ou `null`; grade que não é 2x2 nem 3x3 dá `null`.

| receita | grade | entrada | resultado |
|---|---|---|---|
| tábuas | 2x2 ou 3x3 | 1 `LOG` sozinho, em qualquer célula | 4 `PLANKS` |
| gravetos | 2x2 ou 3x3 | 2 `PLANKS` empilhados na vertical | 4 `STICK` |
| bancada | 2x2 ou 3x3 | 2x2 de `PLANKS` | 1 `CRAFTING_TABLE` |
| picareta de madeira | só 3x3 | linha de cima com 3 `PLANKS`, 2 `STICK` na coluna do meio abaixo | 1 `WOODEN_PICKAXE` |
| picareta de pedra | só 3x3 | igual à de madeira, com 3 `COBBLESTONE` | 1 `STONE_PICKAXE` |
| vidro | 2x2 ou 3x3 | 1 `SAND` + 1 `COAL`, em quaisquer duas células | 1 `GLASS` |

- Receitas com forma podem estar deslocadas na grade.
- Item extra em qualquer célula invalida a receita.
- `consumeIngredients(grid)` (**pura**) devolve a grade com 1 item a menos em cada célula ocupada (`null` onde zerou).
  Ela é usada depois de pegar o resultado.

### `mining.js`: mineração

- `canHarvest(blockId, toolId)` responde se o bloco dá drop com essa ferramenta.
  - Sem ferramenta exigida: sempre.
  - `'pickaxe'`: picareta de madeira ou de pedra.
  - `'stone_pickaxe'`: só a de pedra.
- `breakTime(blockId, toolId)` dá o tempo em segundos.
  - Fórmula: `dureza * (canHarvest ? 1.5 : 5) / velocidade`.
  - A velocidade é 1 na mão. Com picareta, em bloco que exige picareta, é 2 (madeira) ou 4 (pedra). Em outro bloco, 1.
  - Água e bedrock dão `Infinity`. `toolId` pode ser `null` (mão).
- `dropsFor(blockId, toolId)` devolve `[{ id, count: 1 }]`, ou `[]` quando não há drop ou não dá para colher.

### `daynight.js`: ciclo do dia

- `DAY_LENGTH = 1200` (segundos de jogo por dia).
- `skyState(seconds)` devolve `{ t, sunAngle, daylight, isNight }`.
  - `t = (seconds / DAY_LENGTH) mod 1`, sempre em `[0, 1)`, inclusive para negativos.
  - `t = 0` é o nascer do sol, 0.25 o meio-dia, 0.5 o pôr do sol e 0.75 a meia-noite.
  - `sunAngle = 2π·t`.
  - `daylight` é contínuo em `[0.15, 1]`: 1 ao meio-dia e 0.15 à meia-noite.
  - `isNight` vale para `t` em `(0.5, 1)`.

---

## Interface e jogabilidade (React + three.js)

### Menu principal
- Título do jogo.
- Campo de seed, preenchido com uma aleatória.
- Botões "Novo mundo" e "Continuar". "Continuar" só aparece se houver save.
- Slider de distância de renderização, de 2 a 8 chunks (padrão 4).

### Mundo
- Os chunks são carregados em volta do jogador conforme ele anda, até a distância escolhida, e descarregados fora dela.
  Gere poucas malhas por frame, para não travar.
- Malha opaca e transparente separadas: água semitransparente, vidro e folhas com transparência recortada.
- Atlas de texturas 16x16 por bloco, gerado num canvas, com filtro `NearestFilter`.
  - Grama tem topo, lado e base diferentes. Tronco tem topo (anéis) diferente do lado.
- Céu que muda de cor com o `skyState`, com sol e lua. A luz ambiente e a direcional seguem o `daylight`. Neblina na
  borda da distância de renderização.
- O jogador nasce no centro do mundo, em cima da superfície (`getSurfaceHeight` + 1).

### Controles
- Clique trava o mouse (pointer lock), e o mouse olha em volta, com pitch limitado a ±89°.
- Movimento:
  - WASD anda;
  - espaço pula (ou nada, na água);
  - Shift faz sneak;
  - Ctrl corre, assim como apertar W duas vezes;
  - F alterna o voo.
- Mineração e construção:
  - Segurar o botão esquerdo minera, levando o `breakTime` da ferramenta na mão, com uma textura de rachadura que
    progride. Soltar ou mudar o alvo zera o progresso. O drop vai direto para o inventário.
  - O botão direito coloca o bloco selecionado na face mirada; não coloca dentro do jogador e consome 1 do inventário.
  - Botão direito numa bancada abre o crafting 3x3.
  - O botão do meio pega o tipo do bloco mirado para a hotbar, se ele estiver no inventário.
- Alcance de 5 blocos, com contorno (wireframe) no bloco mirado.
- Hotbar:
  - as teclas 1 a 9 e a roda do mouse mudam o slot;
  - o nome do item aparece por 2 s ao trocar.
- Teclas de tela:
  - E abre o inventário (36 slots) com crafting 2x2, e clicar pega e solta pilhas;
  - Esc pausa, com Continuar, Salvar e Sair para o menu;
  - F3 mostra o overlay de debug: FPS, XYZ, chunk, direção, bloco mirado, seed e hora do dia.

### HUD
- Mira no centro.
- Hotbar com ícone de cada item (do atlas) e a quantidade.
- Overlay azulado quando a câmera está dentro da água.

### Salvamento
- Autosave a cada 30 s e ao pausar, no `localStorage` (chave `mc-mvp-save`).
- O save guarda `serializeWorld`, a posição e o olhar do jogador, o inventário e a hora do dia.
- "Continuar" restaura tudo isso.

### Qualidade
- 60 fps com distância 4 numa máquina comum.
- Sem erro no console.
- Código organizado em componentes e módulos coesos.
