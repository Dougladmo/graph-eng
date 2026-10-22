# Aceite do benchmark Minecraft MVP

Os agentes recebem só `workspace/` (com `task.md`, que é o prompt). O resto fica fora do repositório deles.

- `reference/engine/`: motor de referência. Passa em todos os testes visíveis e ocultos.
- `acceptance/engine.acceptance.test.mjs.txt`: 55 testes ocultos dos contratos do motor. Com os stubs, falham todos.
- `setup.sh <destino>`: cria o repositório (copia o esqueleto, tira o `.txt`, instala as dependências e faz o
  commit inicial).

## Como dar a nota

1. Copie o repositório sem `node_modules`, `.git` e `.graph-runs`, ponha o teste oculto em `acc/` sem o `.txt` e rode
   `node --test --test-concurrency=2 test/*.test.js acc/*.test.mjs`.
2. `npm run build` no repositório.
3. Smoke visual: `npm run dev`, abrir no navegador, criar um mundo, andar, minerar, colocar bloco, abrir inventário,
   F3, pausar. Anotar o que funciona e os erros do console.
