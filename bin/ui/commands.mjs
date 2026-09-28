// Comandos copiáveis (spec docs/specs/2026-09-28-acoes-no-painel.md C9). Módulo puro, sem DOM: só
// monta o texto exato que o botão "Copiar" põe no clipboard, para colar de volta numa sessão do
// Claude Code (a 1ª seção da SKILL.md desvia `retomar`/`refazer`/`parar` para "Ações sobre uma run"
// sem pergunta — colar já é a confirmação).
import { WF_RE, NODE_RE } from '../requests.mjs'

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
