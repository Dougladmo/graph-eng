# Aceite do benchmark souls-like (ASHEN GATE)

Os agentes recebem só `workspace/` (com `task.md`, que é o prompt). O resto fica fora do repositório deles.

- `reference/engine/`: motor de referência em TypeScript. Passa em todos os testes visíveis e ocultos e no `tsc`
  estrito do esqueleto.
- `acceptance/engine.acceptance.test.ts.txt`: 66 testes ocultos dos contratos do motor (rng, vec, stats, attacks, player,
  enemies, arena e game). Com os stubs só passam os 2 que conferem tabelas de constantes já dadas no esqueleto; os
  outros 64 falham.
- `setup.sh <destino>`: cria o repositório (copia o esqueleto, tira o `.txt`, instala as dependências e faz o
  commit inicial).

## Como dar a nota

1. Copie o repositório sem `node_modules`, `.git` e `.graph-runs`, ponha o teste oculto em `acc/` sem o `.txt` e rode
   `node --test --test-concurrency=2 test/*.test.ts acc/*.test.ts`.
2. `npx tsc --noEmit` (tipos estritos) e `npm run build` no repositório.
3. Smoke visual: `npm run dev`, abrir no navegador, conferir a ambientação (árvores, folhas caindo, pedras, grama, cavaleiro com armadura, espada e escudo, minotauro), começar, andar, esquivar, atacar um hollow (leve, combo, pesado,
   salto), guardar, usar o frasco, lock-on, descansar na fogueira, atravessar a névoa e lutar com o chefe. Anotar o
   que funciona e os erros do console.
4. Qualidade do código: tamanho e estrutura do `src/`, maior função, comentários, `any`/casts, cobertura da spec de
   interface (ver `docs/benchmarks/`).
