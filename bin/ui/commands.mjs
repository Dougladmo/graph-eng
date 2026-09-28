// Comandos copiáveis (spec docs/specs/2026-09-28-acoes-no-painel.md C9). Módulo puro, sem DOM: só
// monta o texto exato que o botão "Copiar" põe no clipboard, para colar de volta numa sessão do
// Claude Code (a 1ª seção da SKILL.md desvia `retomar`/`refazer`/`parar` para "Ações sobre uma run"
// sem pergunta — colar já é a confirmação).
//
// WF_RE e NODE_RE são cópias literais das de bin/requests.mjs (fonte da verdade), e não um import:
// este módulo roda no navegador (servido por bin/ui-server.mjs via UI_MODULE_RE, sem bundler), e
// bin/requests.mjs importa node:fs. Um `import '../requests.mjs'` resolveria, no navegador, para
// `/requests.mjs` (fora de bin/ui/, 404) e quebraria mesmo se o arquivo existisse ali.
const WF_RE = /^wf_[A-Za-z0-9_-]+$/
const NODE_RE = /^[A-Za-z0-9_-]{1,64}$/

// runDir "seguro" para ir dentro de aspas duplas no comando: absoluto ou `~/…`, sem `"` nem quebra
// de linha (o resto do texto do run dir é livre — pode ter espaço, acento etc.).
function isSafeRunDir(runDir) {
  if (typeof runDir !== 'string' || !runDir) return false
  if (runDir.includes('"') || /[\r\n]/.test(runDir)) return false
  return runDir.startsWith('/') || runDir.startsWith('~/') || runDir === '~'
}

// commandText({ type, runDir, wf, node, dependents }) → string | null (C9).
export function commandText({ type, runDir, wf, node, dependents = false } = {}) {
  if (type === 'resume') {
    if (!isSafeRunDir(runDir)) return null
    return `/graph-eng:graph-eng retomar --run-dir "${runDir}"`
  }
  if (type === 'rerun-node') {
    if (!isSafeRunDir(runDir)) return null
    if (!NODE_RE.test(String(node))) return null
    return dependents
      ? `/graph-eng:graph-eng refazer ${node} --dependentes --run-dir "${runDir}"`
      : `/graph-eng:graph-eng refazer ${node} --run-dir "${runDir}"`
  }
  if (type === 'stop') {
    if (!WF_RE.test(String(wf))) return null
    return `/graph-eng:graph-eng parar --run ${wf}`
  }
  return null
}
