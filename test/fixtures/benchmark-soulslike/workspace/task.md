# Tarefa: ASHEN GATE, um souls-like (MVP) para a web, em React + TypeScript

Construa um souls-like jogável no navegador, com React 18, three.js, TypeScript e Vite. É um MVP com um cenário só,
mas quero o combate com a profundidade dos jogos da FromSoftware (Elden Ring, Dark Souls): estamina, esquiva com
quadros de invencibilidade, ataque leve em combo, ataque pesado, ataque em salto, guarda com contra-ataque, poise e
atordoamento com golpe crítico, frasco de cura, fogueira que restaura e faz os inimigos renascerem, morte que derruba
as runas num rastro recuperável, porta de névoa e uma luta de chefe com duas fases. Nada de asset externo: toda
geometria, textura e efeito é gerado em código.

O repositório já tem o esqueleto: `package.json` (dependências instaladas em `node_modules`), `vite.config.ts`,
`tsconfig.json`, `index.html`, `src/main.tsx`, os módulos do motor em `src/engine/` (só com os tipos e as
assinaturas) e testes em `test/`.

## Regras do repositório

- Não altere `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html` nem os testes em `test/`. Não instale
  dependências novas: só `react`, `react-dom`, `three` e `motion` estão disponíveis.
- Todo código vai em `src/`. Crie quantos arquivos precisar.
- **O motor (`src/engine/`) é TypeScript puro (ESM)**: não importa `three`, `react`, `motion` nem nada do DOM, e roda
  no Node. Ele é testado com `node --test` (o Node executa `.ts` direto; os imports levam a extensão `.ts`).
- Todas as funções do motor são determinísticas, e as marcadas como **pura** não alteram os argumentos: devolvem um
  objeto novo. Os tipos exportados pelos stubs são o contrato: mantenha os nomes e as formas.
- `tsconfig.json` é estrito (`strict`, `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`,
  `verbatimModuleSyntax`). `npm run build` roda `tsc --noEmit` antes do `vite build`: erro de tipo quebra o build.
  Nada de `any`, `as unknown as`, `@ts-ignore` ou `@ts-expect-error`.

## Critério de pronto

1. `npm test` passa.
2. `npm run build` termina sem erro (tipos limpos e bundle gerado).
3. `npm run dev` abre um jogo jogável com tudo o que está na seção "Interface e jogabilidade".
4. Cada função do motor segue exatamente o contrato abaixo, inclusive os casos de borda. Há testes além dos visíveis.

---

## Convenções

- O mundo do motor é o plano XZ, visto de cima. `Vec2 = { x: number; z: number }`. A altura `y` existe só para o
  salto do jogador.
- Orientação (`yaw`, em radianos): `yaw = 0` olha para +Z; `yaw = π/2` olha para +X. `fromYaw(yaw)` é
  `{ x: sin(yaw), z: cos(yaw) }` e `yawOf(v)` é `Math.atan2(v.x, v.z)`.
- Ângulos de arco são dados em graus. "Dentro do arco" quer dizer: distância ≤ alcance **e** o desvio absoluto entre o
  `yaw` de quem ataca e o `yaw` até o alvo é ≤ metade do arco. Distância zero conta como dentro.
- Tempos em segundos, distâncias em metros, velocidades em m/s. Toda entrada de ação ("apertou") vale como um
  pressionamento naquele passo: a interface é quem transforma tecla em pressionamento único. Quando um passo é
  dividido em subpassos, os pressionamentos valem só no primeiro subpasso; as entradas seguradas (`move`, `sprint`,
  `guard`) valem em todos.
- Cada entidade é um círculo no plano: jogador raio 0.4, hollow 0.45, chefe 1.0.

---

## Motor (`src/engine/`)

### `rng.ts`: aleatoriedade com seed

- `hashSeed(seed: number | string): number` devolve um inteiro de 32 bits sem sinal. Mesma entrada, mesmo resultado;
  `'abc'` e `'abd'` dão valores diferentes.
- `randomStep(state: number): { value: number; next: number }` (**pura**) é um passo de mulberry32: `value` em
  `[0, 1)` e `next` o estado seguinte. Mesmo estado, mesmo par.
- `createRng(seed)` devolve uma função que gera números em `[0, 1)`, a mesma sequência para a mesma seed, usando
  `randomStep` a partir de `hashSeed(seed)`.

### `vec.ts`: vetores no plano (todas **puras**)

- `add(a, b)`, `sub(a, b)`, `scale(v, k)`, `dot(a, b)`, `length(v)`, `distance(a, b)`.
- `normalize(v)`: vetor unitário; o vetor nulo devolve `{ x: 0, z: 0 }`.
- `yawOf(v)`, `fromYaw(yaw)`, `yawTo(from, to)` (= `yawOf(sub(to, from))`).
- `yawDelta(from, to)`: menor diferença com sinal, em `(-π, π]`.
- `turnTowards(yaw, target, maxDelta)`: aproxima `yaw` de `target` pelo caminho mais curto, no máximo `maxDelta`.
- `withinArc(origin, yaw, target, range, arcDeg)`: a definição de "dentro do arco" das convenções.

### `stats.ts`: vitais, estamina e poise

Constantes exportadas:

| constante | valor |
|---|---|
| `PLAYER_MAX_HP` | 400 |
| `PLAYER_MAX_STAMINA` | 100 |
| `PLAYER_MAX_POISE` | 40 |
| `STAMINA_REGEN` | 25 (por s) |
| `STAMINA_REGEN_DELAY` | 0.6 |
| `SPRINT_COST` | 12 (por s) |
| `POISE_DECAY` | 15 (por s) |
| `FLASK_MAX` | 3 |
| `FLASK_HEAL` | 180 |
| `WALK_SPEED` | 4 |
| `SPRINT_SPEED` | 6.5 |
| `GUARD_SPEED` | 2 |

- `Vitals = { hp, maxHp, stamina, maxStamina, poise, maxPoise, regenDelay }`. `poise` é o dano de poise
  **acumulado** (0 = inteiro); `regenDelay` é o tempo que falta até a estamina voltar a regenerar.
- `createVitals(maxHp, maxStamina, maxPoise)` devolve vitais cheias com `poise: 0` e `regenDelay: 0`.
- `createPlayerVitals()` = `createVitals(400, 100, 40)`.
- `canAct(v)` é `true` se `stamina > 0`. Uma ação pode começar com qualquer estamina positiva, mesmo que o custo seja
  maior (a estamina para em 0).
- `spendStamina(v, cost)` (**pura**): `stamina = max(0, stamina - cost)` e `regenDelay = STAMINA_REGEN_DELAY`.
- `regen(v, dt, allow)` (**pura**): o `poise` acumulado cai `POISE_DECAY * dt` até 0 sempre. Se `allow` for `true`:
  `regenDelay` cai `dt` até 0 e, se depois disso ele está em 0, a estamina sobe `STAMINA_REGEN * dt`, até
  `maxStamina`. Com `allow` `false`, estamina e `regenDelay` não mudam.
- `takeDamage(v, damage, poiseDamage)` (**pura**) devolve `{ vitals, broke }`: `hp = max(0, hp - damage)`,
  `poise += poiseDamage`; se `poise >= maxPoise`, `broke = true` e o `poise` volta a 0.
- `heal(v, amount)` (**pura**): `hp = min(maxHp, hp + amount)`.

### `attacks.ts`: perfis das ações do jogador

- `AttackName = 'light1' | 'light2' | 'heavy' | 'jumpAttack'`.
- `AttackProfile = { duration, hitStart, hitEnd, damage, poiseDamage, range, arcDeg, stamina, lunge }`.
  `lunge` é quanto o jogador avança para a frente, uniformemente, entre `t = 0` e `t = hitStart`.
- `ATTACKS: Record<AttackName, AttackProfile>`:

| nome | duration | hitStart | hitEnd | damage | poiseDamage | range | arcDeg | stamina | lunge |
|---|---|---|---|---|---|---|---|---|---|
| `light1` | 0.55 | 0.20 | 0.30 | 45 | 10 | 1.8 | 100 | 20 | 0.6 |
| `light2` | 0.60 | 0.22 | 0.32 | 55 | 12 | 1.8 | 110 | 20 | 0.8 |
| `heavy` | 1.0 | 0.45 | 0.60 | 90 | 25 | 2.2 | 120 | 35 | 0.5 |
| `jumpAttack` | 0.6 | 0.25 | 0.35 | 110 | 30 | 2.0 | 120 | 30 | 0 |

- `ROLL = { duration: 0.6, iframeStart: 0.08, iframeEnd: 0.40, moveTime: 0.45, speed: 7, stamina: 25 }`.
- `JUMP = { duration: 0.7, height: 1.2, stamina: 10, attackWindow: 0.45 }`.
- `FLASK = { duration: 1.2, healAt: 0.8 }`.
- `RIPOSTE = { damage: 200, duration: 0.9, range: 2.0, arcDeg: 90 }`.
- `GUARD = { damageFactor: 0.3, staminaFactor: 0.5, arcDeg: 180, counterWindow: 0.5, counterDamage: 1.5,
  counterPoise: 2 }`.
- `STAGGER = { player: 1.0, hollow: 1.5, boss: 2.0 }`.
- `LIGHT_COMBO_START = 0.35`: a partir desse `t` do `light1`, apertar ataque leve emenda o `light2`.

### `player.ts`: o jogador

```ts
type ActionKind = 'idle' | 'roll' | 'attack' | 'jump' | 'jumpAttack' | 'flask' | 'riposte' | 'stagger' | 'dead'
type PlayerAction = { kind: ActionKind; t: number; attack: AttackName | null; dir: Vec2; hitIds: number[]; healed: boolean }
type Player = {
  pos: Vec2; y: number; yaw: number; vitals: Vitals; flasks: number; action: PlayerAction;
  guarding: boolean; sprinting: boolean; lockOn: number | null; guardCounter: number
}
type PlayerInput = { move: Vec2; sprint: boolean; roll: boolean; jump: boolean; light: boolean; heavy: boolean; guard: boolean; flask: boolean }
type PlayerContext = { targetPos: Vec2 | null; room: Room }
```

- `IDLE_ACTION: PlayerAction` = `{ kind: 'idle', t: 0, attack: null, dir: { x: 0, z: 0 }, hitIds: [], healed: false }`.
- `createPlayer(pos, yaw)`: vitais de jogador, `flasks: 3`, `y: 0`, ação `IDLE_ACTION`, `guarding`, `sprinting`
  `false`, `lockOn: null`, `guardCounter: 0`.
- `stepPlayer(player, input, dt, ctx)` (**pura**) avança o jogador e devolve o novo. Ela **não** resolve acertos:
  isso é do `game.ts`. Regras, nesta ordem:
  - `dt` maior que 0.05 é dividido em subpassos de no máximo 0.05.
  - `action.t` sobe `dt`. Ação com `t >= duration` volta a `IDLE_ACTION` e zera `guardCounter` (o salto e o ataque
    em salto pousam com `y = 0`). `guardCounter` cai `dt` até 0 só enquanto a ação é `idle`.
  - `dead` e `stagger` ignoram a entrada (`stagger` termina sozinho em `STAGGER.player`).
  - `guarding` é `input.guard` quando a ação é `idle`; senão `false`. `sprinting` é `input.sprint` com `move`
    não nulo, estamina > 0, ação `idle` e sem `guard`; senão `false`. Os dois são calculados depois do início de
    ação deste passo.
  - **Início de ação** (só uma por passo, nesta prioridade, todas exigem `canAct` exceto o frasco):
    1. frasco: ação `idle`, `flasks > 0` → `flask` (consome 1 frasco já no início);
    2. esquiva: ação `idle`, ou `attack` com `t >= hitEnd` ("cancelar com a esquiva") → `roll`, gasta
       `ROLL.stamina`; `dir` é `normalize(move)` ou, com `move` nulo, o oposto de `fromYaw(yaw)` (passo atrás);
       sem lock-on, `yaw` passa a `yawOf(dir)`;
    3. salto: ação `idle` → `jump`, gasta `JUMP.stamina`;
    4. ataque pesado: ação `idle` → `attack` `heavy`;
    5. ataque leve: ação `idle` → `attack` `light1`; ação `attack` `light1` com `t >= LIGHT_COMBO_START` →
       `attack` `light2` (novo `t = 0`, novos `hitIds`); ação `jump` com `t < JUMP.attackWindow` → `jumpAttack`
       (novo `t = 0`), gasta o `stamina` do perfil.
    Cada ataque gasta o `stamina` do seu perfil ao começar. Começar um `heavy` com `guardCounter > 0` arma o
    contra-ataque de guarda (o contador fica como está até a ação acabar); começar qualquer outra ação zera
    `guardCounter`.
  - **Orientação:** com `ctx.targetPos` (lock-on), o jogador olha para o alvo sempre, inclusive durante as ações.
    Sem alvo, olha para `move` quando anda e para `dir` quando esquiva; ações não viram.
  - **Movimento:**
    - `idle`: `pos += normalize(move) * speed * dt`, com `speed` = `GUARD_SPEED` guardando, `SPRINT_SPEED`
      correndo (gasta `SPRINT_COST * dt` como `spendStamina`), senão `WALK_SPEED`;
    - `roll`: avança `dir * ROLL.speed * (min(t, moveTime) − min(t0, moveTime))`, com `t0 = max(0, t − dt)`,
      para o deslocamento total ser exatamente `ROLL.speed * ROLL.moveTime` = 3.15 m, seja qual for o `dt` (o
      passo em que a ação começa tem `t = 0` e não anda);
    - `attack`: avança `fromYaw(yaw) * lunge * (min(t, hitStart) − min(t0, hitStart)) / hitStart`, com o mesmo
      `t0`, para o avanço total ser exatamente `lunge`;
    - `jump`: controle aéreo em `WALK_SPEED` seguindo `move`; `y = height * 4 * u * (1 - u)` com
      `u = t / duration`;
    - `jumpAttack`: sem deslocamento horizontal; `y` cai `JUMP.height / ATTACKS.jumpAttack.duration` por segundo,
      até 0;
    - `flask`, `riposte`, `stagger`, `dead`: parado.
    - Depois de mover, `pos` passa por `resolveRoom(ctx.room, pos, 0.4)`.
  - **Frasco:** quando `t` cruza `FLASK.healAt` e `healed` é `false`, cura `FLASK_HEAL` e marca `healed`.
  - **Regeneração:** `regen(vitals, dt, allow)` com `allow` = ação `idle` e não correndo.
- `isInvulnerable(player)`: `true` durante `roll` com `t` em `[iframeStart, iframeEnd)`, e durante `dead`.
- `activeAttack(player)`: o `AttackProfile` da ação atual se ela é `attack` ou `jumpAttack` com `t` em
  `[hitStart, hitEnd)`; senão `null`.

### `enemies.ts`: hollows e chefe

```ts
type EnemyKind = 'hollow' | 'boss'
type EnemyState = 'idle' | 'intro' | 'chase' | 'windup' | 'attack' | 'recover' | 'stagger' | 'dead'
type EnemyAttackName = 'slash' | 'slam' | 'charge' | 'shockwave'
type Enemy = {
  id: number; kind: EnemyKind; room: RoomId; home: Vec2; homeYaw: number;
  pos: Vec2; yaw: number; vitals: Vitals; state: EnemyState; t: number;
  attack: EnemyAttackName | null; hitDone: boolean; phase: 1 | 2
}
type EnemyHit = { damage: number; poiseDamage: number; origin: Vec2 }
type EnemyTarget = { pos: Vec2; alive: boolean }
```

- `ENEMY_PROFILES`:

| kind | hp | poise | radius | speed | aggroRange | staggerTime | runes | intro |
|---|---|---|---|---|---|---|---|---|
| `hollow` | 120 | 30 | 0.45 | 3 | 9 | 1.5 | 100 | 0 |
| `boss` | 1500 | 80 | 1.0 | 3.5 | 40 | 2.0 | 5000 | 2.0 |

- `ENEMY_ATTACKS` (`shape` `'arc'` usa `range` + `arcDeg` a partir do `yaw`; `'radius'` acerta qualquer alvo a até
  `range` do centro; `'charge'` acerta quando o alvo está a até `range` durante o `active`):

| nome | quem | windup | active | recover | damage | poiseDamage | range | arcDeg | shape | startRange |
|---|---|---|---|---|---|---|---|---|---|---|
| `slash` | hollow | 0.5 | 0.3 | 0.8 | 60 | 20 | 1.8 | 100 | arc | 2.0 |
| `slash` | boss | 0.6 | 0.3 | 0.9 | 110 | 25 | 2.8 | 120 | arc | 4.0 |
| `slam` | boss | 1.0 | 0.3 | 1.2 | 160 | 40 | 3.0 | 360 | radius | 4.0 |
| `charge` | boss | 0.4 | 0.7 | 1.0 | 90 | 20 | 1.4 | 0 | charge | ∞ |
| `shockwave` | boss (fase 2) | 0.8 | 0.2 | 1.5 | 120 | 30 | 5.0 | 360 | radius | ∞ |

  Exporte como `ENEMY_ATTACKS: Record<EnemyKind, Partial<Record<EnemyAttackName, EnemyAttack>>>` com
  `EnemyAttack = { windup, active, recover, damage, poiseDamage, range, arcDeg, shape, startRange }`
  (`startRange: Infinity` para `charge` e `shockwave`).
- `CHARGE_SPEED = 12`, `TRACK_RATE = 2.5` (rad/s), `BOSS_PHASE2_HP = 750`, `PHASE2_SPEED = 4.5`,
  `PHASE2_WINDUP = 0.75` (multiplica o `windup`), `CHARGE_DISTANCE = 5`, `RIPOSTE_RECOVER = 1.0`.
- `createEnemy(id, kind, room, pos, yaw)`: vitais do perfil, `home`/`homeYaw` iguais a `pos`/`yaw`, `state: 'idle'`,
  `t: 0`, `attack: null`, `hitDone: false`, `phase: 1`.
- `respawnEnemy(enemy)` (**pura**): volta a `home`, vitais cheias, `idle`, fase 1.
- `enemyRadius(enemy)`.
- O `poise` acumulado do inimigo só muda com dano: não decai sozinho (nenhum `regen` nos inimigos).
- `stepEnemy(enemy, target, dt, rng, room)` (**pura**) devolve `{ enemy, rng, hit }`, com `rng` o estado de
  `randomStep` já avançado o quanto foi usado e `hit: EnemyHit | null`. Regras:
  - `dt` maior que 0.05 é dividido em subpassos de no máximo 0.05; `t` sobe `dt`.
  - `dead` não muda. `stagger` dura `staggerTime` e vai para `chase`. `intro` dura o `intro` do perfil e vai para
    `chase`.
  - Com `target.alive` `false`, `chase` vira `idle`; `windup`/`attack`/`recover` terminam normalmente e caem em
    `idle`.
  - `idle`: se `distance(pos, target) <= aggroRange` (e o alvo vive) → `chase`. O chefe entra em `intro` em vez
    de `chase` quando `t` ainda é 0 na primeira vez (ou seja: `idle` → `intro` para o chefe, `idle` → `chase` para o
    hollow).
  - `chase`: `yaw = yawTo(pos, target)` na hora; anda `speed * dt` (fase 2: `PHASE2_SPEED`) até ficar a
    `enemyRadius + 0.4` do alvo, sem passar dele. Depois de andar, com `d` a distância nova ao alvo, pode escolher
    um ataque e ir para `windup` (`t = 0`, `hitDone = false`):
    - hollow: `d <= 2.0` (`startRange` do `slash`) → `slash`.
    - chefe, fase 1: `d > CHARGE_DISTANCE` → `charge`; `d <= 4.0` (`startRange` de `slash` e `slam`) → um
      `randomStep`: `value < 0.6` → `slash`, senão `slam`; entre os dois, continua perseguindo.
    - chefe, fase 2: `d > CHARGE_DISTANCE` → um `randomStep`: `value < 0.5` → `charge`, senão `shockwave`;
      `d <= 4.0` → um `randomStep`: `< 0.45` → `slash`, `< 0.75` → `slam`, senão `shockwave`; entre os dois,
      continua perseguindo.
  - `windup`: vira para o alvo com `turnTowards(yaw, yawTo, TRACK_RATE * dt)`; dura `windup` (fase 2: ×0.75) e vai
    para `attack`.
  - `attack`: não vira. `charge` anda `CHARGE_SPEED * dt` na direção do `yaw`. O acerto é testado a cada passo e
    emitido **uma vez** (`hitDone`): `arc`/`radius` acertam se o alvo está dentro da forma; `charge` acerta se o alvo
    está a até `range` do centro. O `hit` tem `damage`, `poiseDamage` e `origin = pos` do inimigo. Dura `active`
    e vai para `recover`.
  - `recover` dura o `recover` do ataque atual, ou `RIPOSTE_RECOVER` quando não há ataque (depois do riposte), e vai
    para `chase`.
  - Depois de mover, `pos` passa por `resolveRoom(room, pos, enemyRadius)`.
  - **Fase 2** é decidida fora (`game.ts`) quando `hp <= BOSS_PHASE2_HP`: `stepEnemy` só lê `phase`.

### `arena.ts`: o cenário (tudo **puro**)

```ts
type RoomId = 'courtyard' | 'bossRoom'
type Circle = { x: number; z: number; r: number }
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number }
type Room = { id: RoomId; rect: Rect | null; circle: Circle | null; pillars: Circle[] }
```

- `COURTYARD: Room` = `{ id: 'courtyard', rect: { minX: -12, maxX: 12, minZ: -10, maxZ: 14 }, circle: null,
  pillars: [{ x: -5, z: 2, r: 0.8 }, { x: 5, z: 2, r: 0.8 }, { x: -5, z: 8, r: 0.8 }, { x: 5, z: 8, r: 0.8 }] }`.
- `BOSS_ROOM: Room` = `{ id: 'bossRoom', rect: null, circle: { x: 0, z: 28, r: 11 }, pillars: [] }`.
- `getRoom(id)`.
- Pontos: `BONFIRE = { x: 0, z: -6 }`, `START_POS = { x: 0, z: -4 }`, `FOG_GATE = { x: 0, z: 14 }`,
  `BOSS_ROOM_ENTRY = { x: 0, z: 18 }`, `BOSS_SPAWN = { x: 0, z: 34 }`,
  `HOLLOW_SPAWNS = [{ x: -4, z: 6 }, { x: 4, z: 7 }, { x: 0, z: 11 }]` (todos com `yaw = π`, olhando para a
  fogueira).
- `INTERACT_RANGE = 2.0`, `LOCK_RANGE = 12`, `PLAYER_RADIUS = 0.4`.
- `pushOut(pos, radius, obstacle)`: se `distance(pos, obstacle) < obstacle.r + radius`, empurra `pos` para fora ao
  longo da reta centro→pos até a distância `obstacle.r + radius`; com `pos` no centro, empurra para +X.
- `resolveRoom(room, pos, radius)`: prende dentro do `rect` recuado por `radius` (ou dentro do `circle` com raio
  `r - radius`, projetando pelo raio), e depois aplica `pushOut` em cada pilar, na ordem.

### `game.ts`: a simulação inteira (**pura**)

```ts
type Phase = 'title' | 'playing' | 'resting' | 'dead' | 'victory'
type Input = PlayerInput & { interact: boolean; lockOn: boolean }
type GameEvent =
  | { type: 'playerHit'; damage: number; blocked: boolean }
  | { type: 'dodged' }
  | { type: 'guardBreak' }
  | { type: 'playerStaggered' }
  | { type: 'enemyHit'; id: number; damage: number; riposte: boolean }
  | { type: 'enemyStaggered'; id: number }
  | { type: 'enemyDied'; id: number; runes: number }
  | { type: 'flask' }
  | { type: 'playerDied' }
  | { type: 'respawn' }
  | { type: 'rest' }
  | { type: 'enterBossRoom' }
  | { type: 'bossPhase2' }
  | { type: 'victory' }
  | { type: 'runesRecovered'; runes: number }
type Bloodstain = { room: RoomId; pos: Vec2; runes: number }
type GameState = {
  seed: number; rng: number; time: number; phase: Phase; room: RoomId;
  player: Player; enemies: Enemy[]; runes: number; bloodstain: Bloodstain | null;
  bossDefeated: boolean; deathTimer: number; events: GameEvent[]
}
```

- `IDLE_INPUT: Input` com tudo `false` e `move = { x: 0, z: 0 }`.
- `DEATH_DELAY = 3.0`, `RUNES_PICKUP_RANGE = 1.0`.
- `createGame(seed)`: `seed = hashSeed(seed)`, `rng = seed`, `time: 0`, `phase: 'title'`, `room: 'courtyard'`,
  jogador em `START_POS` com `yaw = 0`, `enemies` = três hollows (ids 1, 2 e 3, em `HOLLOW_SPAWNS`, sala
  `courtyard`) e o chefe (id 10, em `BOSS_SPAWN`, `yaw = π`, sala `bossRoom`), `runes: 0`, `bloodstain: null`,
  `bossDefeated: false`, `deathTimer: 0`, `events: []`.
- `stepGame(state, input, dt)` (**pura**) devolve o estado novo. `events` traz só os eventos **deste** passo.
  `time += dt` sempre. `dt` maior que 0.05 é dividido em subpassos de no máximo 0.05 (os eventos dos subpassos se
  acumulam). Por fase:
  - `title`: qualquer pressionamento (`light`, `heavy`, `roll`, `jump`, `flask`, `interact`) → `playing`. Nada mais
    acontece.
  - `resting`: `interact` ou `roll` → `playing`. Nada mais acontece.
  - `dead`: `deathTimer` cai; em 0, **renasce**: `phase: 'playing'`, `room: 'courtyard'`, jogador novo em
    `START_POS` (vitais e frascos cheios, `lockOn: null`), hollows com `respawnEnemy`, o chefe também se não foi
    derrotado, `bloodstain` = `{ room, pos, runes }` da morte se `runes > 0` (senão o que já havia), `runes = 0`,
    evento `respawn`.
  - `victory`: só o jogador anda (`stepPlayer` com `targetPos: null`); sem inimigos, sem interações.
  - `playing`, nesta ordem:
    1. **Lock-on:** `lockOn` alterna: com alvo → `null`; sem alvo → o inimigo vivo mais perto na sala atual a até
       `LOCK_RANGE`, ou `null`. Alvo morto ou fora da sala limpa o lock.
    2. **Riposte:** `light` com jogador `idle` e um inimigo em `stagger` dentro de `RIPOSTE.range`/`arcDeg` na frente
       do jogador → ação `riposte`, o inimigo recebe `RIPOSTE.damage` na hora (evento `enemyHit` com
       `riposte: true`), e sai do `stagger` para `recover` (`t = 0`). Esse `light` não chega ao `stepPlayer`.
    3. **Jogador:** `stepPlayer` com `targetPos` do alvo do lock-on (ou `null`) e a sala atual.
    4. **Acertos do jogador:** com `activeAttack`, para cada inimigo vivo da sala ainda fora de `action.hitIds` e
       dentro de `range + enemyRadius`/`arcDeg` a partir de `pos`/`yaw`: dano do perfil (×`GUARD.counterDamage` e
       poise ×`GUARD.counterPoise` se `guardCounter > 0` e o ataque é `heavy`), `takeDamage`, id entra em
       `hitIds`, evento `enemyHit`; `broke` → `stagger` (`t = 0`, evento `enemyStaggered`); `hp = 0` → `dead`,
       `runes += runes` do perfil, evento `enemyDied`, lock-on limpo se era ele; chefe morto → `bossDefeated`,
       `phase: 'victory'`, evento `victory`.
    5. **Fase 2:** chefe vivo com `hp <= BOSS_PHASE2_HP` e `phase: 1` → `phase: 2`, evento `bossPhase2`.
    6. **Inimigos:** `stepEnemy` para cada inimigo da sala atual (os de outra sala ficam parados), com
       `target = { pos: player.pos, alive: player.action.kind !== 'dead' }` e o `rng` encadeado na ordem dos ids.
    7. **Acertos nos jogador:** para cada `hit` devolvido: `isInvulnerable` → evento `dodged`; senão, guardando e
       com `origin` dentro de `GUARD.arcDeg` na frente do jogador e estamina > 0 → bloqueio: dano
       ×`damageFactor`, `spendStamina(damage * staminaFactor)`, `guardCounter = counterWindow`, evento `playerHit`
       com `blocked: true` (o bloqueio não causa dano de poise); se a estamina chegou a 0 com isso → `stagger`
       (evento `guardBreak`); senão acerto cheio: `takeDamage`, evento `playerHit`; `broke` → `stagger` (evento
       `playerStaggered`, interrompe qualquer ação que não seja `dead`, com `y = 0`). `hp = 0` → ação `dead`,
       `phase: 'dead'`, `deathTimer = DEATH_DELAY`, evento `playerDied`.
    8. **Empurrão:** o jogador é empurrado para fora de cada inimigo vivo da sala (`pushOut` com o raio do
       inimigo) e depois passa por `resolveRoom`.
    9. **Interações** (`interact`, só com o jogador `idle`):
       - a até `INTERACT_RANGE` da fogueira (`courtyard`): `phase: 'resting'`, vitais e frascos cheios,
         `lockOn: null`, hollows com `respawnEnemy`, chefe idem se não derrotado, evento `rest`;
       - a até `INTERACT_RANGE` da porta de névoa (`courtyard`): `room: 'bossRoom'`, jogador em `BOSS_ROOM_ENTRY`
         com `yaw = 0`, `lockOn: null`, evento `enterBossRoom`.
    10. **Rastro de sangue:** `bloodstain` na sala atual a até `RUNES_PICKUP_RANGE` → `runes += runes` do rastro,
        `bloodstain = null`, evento `runesRecovered`.
- Mesma seed e mesma sequência de entradas e `dt` dão estados idênticos (`deepEqual`).

---

## Interface e jogabilidade (React + three.js + motion)

### Tela inicial
- Título "ASHEN GATE", a seed em uso (campo editável, preenchido com uma aleatória) e "Pressione qualquer tecla".
- Qualquer tecla ou clique começa o jogo (`createGame(seed)` e a fase sai de `title`).

### Loop e câmera
- `stepGame` roda num acumulador de passo fixo de 1/60 s; o render interpola nada: desenha o último estado.
- Câmera em terceira pessoa atrás do jogador: distância 5 m, altura 2.2 m, olhando 1.2 m acima dos pés.
  - Com o mouse travado (pointer lock, ao clicar no canvas), o mouse orbita (yaw livre, pitch entre −20° e 60°).
  - Sem pointer lock, a câmera segue atrás do jogador, alinhada ao `yaw` dele, com suavização.
  - Com lock-on, a câmera fica atrás do jogador apontando para o alvo, e um retículo marca o alvo na tela.
- O `move` enviado ao motor é relativo à câmera: W anda para onde a câmera olha.

### Personagens e cenário (sem asset externo)
- Jogador: cápsula com uma espada (caixa fina) presa a um pivô no ombro. A espada gira com o `t` da ação: arco
  horizontal no leve, de cima para baixo no pesado e no ataque em salto, brilho no riposte. O corpo inclina na
  esquiva e sobe `y` no salto. Guarda levanta a espada na frente.
- Hollows: cápsulas cinzentas e corcundas com uma lâmina; o chefe ("Sentinela da Névoa") é uma cápsula de 2.6 m
  com chifres e um martelo, mais escura; na fase 2 ganha emissão vermelha. `windup` inclina para trás, `attack`
  desce a arma, `stagger` cambaleia, `dead` tomba e some em 2 s.
- Pátio: chão de pedra com textura procedural (canvas), quatro pilares, muros nas bordas do `rect`, a fogueira
  (espada fincada em brasas, luz pontual tremulante e partículas subindo) e a porta de névoa (plano semitransparente
  com névoa animada entre dois batentes, em `FOG_GATE`).
- Sala do chefe: círculo de pedra com muro ao redor, mais escura, com neblina e tochas nos muros (luzes pontuais).
- Rastro de sangue: marca luminosa no chão onde o jogador morreu, só na sala do rastro.
- Luz: ambiente + direcional; sombras nos personagens.

### Controles
- WASD anda (relativo à câmera); Shift segurado corre; Espaço esquiva (ou passo atrás parado); F pula.
- Botão esquerdo ou J: ataque leve (apertar de novo no tempo emenda o combo). Botão direito ou K: ataque pesado.
  Pular e atacar no ar dá o ataque em salto.
- Q segurado: guarda. Depois de bloquear, um pesado no tempo é o contra-ataque de guarda.
- Tab: lock-on (alterna). R: frasco. E: interagir (fogueira, porta de névoa).
- Esc pausa (menu com Continuar e Voltar ao título) e solta o mouse.
- Ataque leve com um inimigo atordoado na frente é o golpe crítico (riposte).

### HUD (com `motion` para as animações)
- Canto superior esquerdo: barra de HP (vermelha) e de estamina (verde), com um rastro amarelo que encolhe atrás da
  barra quando ela cai. Contador de frascos ao lado.
- Canto inferior direito: runas em posse.
- Barra do chefe embaixo, com o nome, visível da entrada na sala até a vitória; pisca ao entrar na fase 2.
- Retículo do lock-on sobre o alvo; barra de poise do alvo acima dele (enche com o dano de poise, atordoado quando
  cheia).
- Mensagens no centro, com fade: "VOCÊ MORREU" (vermelha) na morte, "INIMIGO ABATIDO" (dourada) por hollow,
  "GRANDE INIMIGO ABATIDO" na vitória, "Descansar [E]" perto da fogueira, "Atravessar a névoa [E]" perto da porta.
- Tela de descanso: "Fogueira" com "Levantar [E]".
- Flash vermelho na borda ao tomar dano; flash azul no bloqueio; flash branco no golpe crítico.

### Qualidade
- 60 fps numa máquina comum.
- Sem erro no console.
- `tsc` estrito limpo; código organizado em componentes e módulos coesos, com os tipos do motor reaproveitados na
  interface.
