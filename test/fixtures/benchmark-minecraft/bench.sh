#!/usr/bin/env bash
# Benchmark Minecraft de ponta a ponta: bench.sh <destino> [flags do grapheng...]
# Cria o repositório a partir do esqueleto, roda implemente com o task.md como tarefa, dá a nota (55 testes ocultos e
# npm run build) e resume a run. Cada run real gasta uso da conta do Claude.
# Com BENCH_SKIP_RUN=1, só dá a nota do que já estiver em <destino>.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
dest="$1"
shift

if [ -z "${BENCH_SKIP_RUN:-}" ]; then
  bash "$here/setup.sh" "$dest"
  cd "$dest"
  node -e 'const fs = require("node:fs"); fs.writeFileSync(".graph-invocation.json", JSON.stringify({ host: "claude", argv: ["implemente", fs.readFileSync("task.md", "utf8"), ...process.argv.slice(1)] }))' -- "$@"
  echo "run: implemente $*"
  started=$(date +%s)
  node "$root/bin/grapheng.mjs" --invocation .graph-invocation.json > bench-result.json || true
  echo "run: $(( $(date +%s) - started )) s"
fi

cd "$dest"
grade="$(mktemp -d)"
rsync -a --exclude node_modules --exclude .git --exclude .graph-runs "$dest/" "$grade/"
mkdir -p "$grade/acc"
cp "$here/acceptance/engine.acceptance.test.mjs.txt" "$grade/acc/engine.acceptance.test.mjs"
ln -s "$dest/node_modules" "$grade/node_modules"
(cd "$grade" && node --test --test-concurrency=2 test/*.test.js acc/*.test.mjs > "$dest/bench-acceptance.tap" 2>&1) || true
rm -rf "$grade"
echo "testes (visíveis + 55 ocultos): $(grep -E '^# (tests|pass|fail)' bench-acceptance.tap | tr '\n' ' ')"
if npm run build > bench-build.log 2>&1; then echo "build: ok"; else echo "build: FALHOU (bench-build.log)"; fi

[ -f bench-result.json ] || exit 0
node -e '
const r = JSON.parse(require("node:fs").readFileSync("bench-result.json", "utf8"))
const money = v => `US$ ${Number(v ?? 0).toFixed(2)}`
console.log(`status: ${r.status}${r.feedback ? ` (${r.feedback.reason})` : ""}${r.exception ? ` ${r.exception.code}: ${r.exception.message}` : ""}`)
console.log(`modo: ${r.power ? (r.powerMax ? "power max" : "power") : "padrão"}${r.haikuMax ? ` · haiku-max ${r.haikuMax}` : ""}`)
console.log(`tempo: ${Math.round((r.engineMs ?? 0) / 1000)} s · custo: ${money(r.cost?.costUSD)} · advisor: ${r.advisorCalls ?? 0} chamada(s) · runDir: ${r.runDir}`)
for (const [model, usd] of Object.entries(r.cost?.byModel ?? {})) console.log(`  ${model}: ${money(usd)}`)
if (r.power) for (const wave of r.routing ?? []) console.log(`  onda ${wave.wave}: ${wave.lanes.map(l => `${l.model} [${l.steps.join(", ")}]`).join(" | ")}`)
for (const s of r.sessions ?? []) console.log(`  sessão ${s.round}${s.wave ? ` onda ${s.wave}` : ""} ${s.model ?? ""}${s.steps ? ` [${s.steps.join(", ")}]` : s.from ? ` [${s.from}–${s.to}]` : ""}: ${s.status} em ${Math.round((s.ms ?? 0) / 1000)} s, advisor ${s.advisorCalls ?? 0}`)
for (const g of r.gate ?? []) console.log(`  gate ${g.round}: ${g.pass ? "passou" : "falhou"} (${g.results.map(x => `${x.command} → ${x.exitCode}`).join(", ")})`)
'
