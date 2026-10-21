// Painel web ao vivo do graph-watch (`graph-watch ui`) — docs/specs/2026-09-27-painel-web.md.
// Node puro (node:http), sem dependências. Rotas de escrita: PUT /api/config (grava
// ~/.claude/graph-eng/config.json, via bin/config.mjs), POST /api/org/* (grava <stateDir>/organize.json,
// via bin/organize.mjs; o apagar remove só .graph-runs/<run>/ depois da contenção). Nenhum outro endpoint
// escreve em disco. O painel é só visualização ao vivo: não há fila de pedidos nem sinal de vida de sessão.
//
// ── Contrato HTTP (consumido pela página em bin/ui/) ──
// Todas as respostas: só GET (outro método → 405 com `Allow: GET`), exceto /api/config, que aceita GET e
// PUT (outro método → 405 com `Allow: GET, PUT`), e /api/org/*, que só aceita POST (`Allow: POST`). A
// tabela de escrita é conferida antes da regra GET-only. `Host` precisa ser `127.0.0.1:<porta>` ou
// `localhost:<porta>` (senão 403, contra DNS rebinding), em toda rota e todo método. Sem CORS: nenhuma
// resposta leva `Access-Control-Allow-*`, e o preflight `OPTIONS` recebe 405. Erros vêm como JSON
// `{ "error": "<texto pt-BR>" }`.
//
// GET /api/health → 200 `{ "app": "graph-watch", "version": 1, "pid": <pid do servidor> }`
//
// GET /api/config → 200 ConfigPublica, sempre (arquivo ausente = padrões; campo inválido no arquivo volta
//   ao padrão e vira `warnings`) | 500 (erro de E/S na leitura que não seja arquivo ausente).
//   ConfigPublica = {
//     config:   { effort, ceiling, economy, planGate, maxRounds, maxRepairs },   // efetiva
//     source:   { <mesmos campos>: "config" | "default" },
//     defaults: { <mesmos campos> },                                           // fábrica: 24/auto
//     limits:   { ceiling: { min: 8, max: 100 }, maxRounds: { min: 1, max: 5 }, maxRepairs: { min: 1, max: 3 },
//                 effort: ["manual","auto","low","medium","high","max"], economy: ["lean","balanced","max"] },
//     file: "~/.claude/graph-eng/config.json",                                 // home trocado por ~
//     warnings: string[],
//   }
//   A tabela de alvos não vem daqui: a página a calcula com /agent-target.mjs.
//
// PUT /api/config → 200 ConfigPublica (depois de gravar). Checagens em ordem, parando no primeiro erro:
//   403 `Origin` ausente, "null" ou ≠ `http://<Host>` · 415 Content-Type ≠ application/json (charset pode vir)
//   · 413 corpo > 4096 bytes · 400 JSON inválido / corpo que não é objeto / `{ error: "config inválida",
//   fields: { <campo>: "<motivo>" } }` (campo desconhecido, tipo, faixa, teto < 8 ou > 100) · 500 falha ao
//   gravar. O PUT substitui o arquivo: chave ausente volta ao padrão, e chave desconhecida posta à mão no
//   arquivo some. Gravação atômica (tmp no mesmo diretório + rename). Nada é gravado em caminho de erro.
//
// POST /api/org/* (C10 O1-O9) → 200 `{ org: OrgPublica, … }`. Mesmas travas do PUT /api/config, na mesma
//   ordem (readJsonBody): 403 Origin · 415 · 413 (declarado ou em chunks) · 400 JSON inválido / corpo que não
//   é objeto / `{ error: "pedido de organização inválido", fields: { <campo>: "<motivo>" } }` (tabela
//   estrita: campo a mais dá "campo desconhecido"). Depois: 404 run/grupo · 409 conflito · 500 E/S. A key da
//   run nunca vem do cliente: o `wf` (qualquer wf da run) vira a key no servidor.
//   O1 pin {wf, pinned} · O2 groups {name, wf?} → +group · O3 groups/:gid/rename {name} ·
//   O4 groups/:gid/move {index} · O5 groups/:gid/delete {} → +released · O6 move {wf, group|null} (desafixa)
//   · O7 archive {wf, archived} · O8 delete {wf, confirm = name} → +deleted, removedDir ·
//   O9 delete-finished {wfs, confirm: "apagar N"} → +deleted[], failed[{wf, reason}].
//   OrgPublica = { groups: [{ id, name }], pinned: key[], warnings: string[] }.
//
// GET /api/runs/:wf/artifacts (A5) → 200 `{ runId, runDir, files: [{ name, kind, node?, variant?, size, mtime }] }`
//   | 400 | 404 run | 404 "essa run não tem pasta de artefatos". GET …/artifacts/:name (A6) → 200 `{ name,
//   kind, size, mtime, truncated, text }` (teto 256 KB) | 400 "nome de artefato inválido" | 404. Só entrada
//   direta da pasta contida (`resolveRunDir`), `[A-Za-z0-9][A-Za-z0-9_-]{0,63}(.x)?.md`, regular, sem link,
//   aberta com O_NOFOLLOW. Vale também para um wf superado (é só leitura).
//
// GET /api/runs → 200 `{ "runs": RunResumo[], "org": OrgPublica }`: uma entrada por key (P3: o runId da
//   skill, ou `<slug>/<wf>` sem ele), no máximo 50 keys (fixadas e em grupo nunca somem por idade; key
//   apagada fica fora até um wf dela ficar mais novo que o apagar), `rodando` primeiro e depois `mtime` desc.
//   Os campos de estado são os do representante (o wf rodando mais novo; senão o mais novo que não é
//   planOnly; senão o planOnly mais novo).
//   RunResumo = {
//     key, runId: string | null, name,  // name = runId, ou o wf sem `wf_` (é o texto que o apagar exige)
//     wfs: ["wf_…"],                    // do mais novo para o mais velho; `wf` é o representante
//     pinned: bool, group: gid | null, archived: bool,
//     runDir: string | null,            // pasta da run com o home como ~; null sem pasta ou fora da contenção
//     wf: "wf_…",                       // id do diretório do workflow (o representante)
//     project: "postify-backend",       // basename do `cwd` das transcrições; sem elas, último trecho do slug
//     status: "rodando" | "parada?" | "terminado",
//                                       // terminado = synth com result, ou run planOnly (spec C6);
//                                       // parada? = computeStop() ≠ null (mesma regra do buildModel,
//                                       // bin/graph-watch.mjs: silêncio > N min,
//                                       // cota/interrupção na hora); senão rodando.
//     stop: null | { reason, text, idleSec }, // motivo da parada (spec C6), null fora de "parada?"
//     planOnly: boolean,                // só o planner rodou; nunca conta como parada
//     goal: string | null,              // goal do plano
//     done: number, total: number,      // nós com estado pronto* / todos os nós
//     round: number,
//     mtime: number,                    // ms epoch da última atividade (journal ou transcrição)
//     nodes: [{ id, state, round }],    // faixa-miniatura da barra lateral, na ordem do modelo
//   }
//
// GET /api/runs/:wf → 200 Modelo | 400 (wf fora de /^wf_[A-Za-z0-9_-]+$/) | 404 (fora da lista de runs)
//   Modelo = saída de buildModel (bin/graph-watch.mjs) +
//     { project, goal, mode, lastActivity } e `status` trocado pelo status do RunResumo (considera a
//     atividade das transcrições). Campos de buildModel: wf, round, status, idleSec, warns: string[],
//     nodes: [{ id, kind, risk, round, title, deps: string[], explore, state, reps, closed,
//               orphan?, running?: { label, agentId } }],
//     critic: null | { r, running, gaps?, done? }, synth: "aguardando" | "rodando" | "pronto", spent,
//     estimate?/ceiling? (só quando há economy). Campos de execução: runId, runKey, current (wf da
//     execução atual da key), supersededBy (= current num wf superado, senão null), runDir (com ~ | null).
//     `mode` e `economy` vêm das linhas `Mode:` e `Economy:` do
//     prompt do agente `plan` (ausentes se não achar; `Economy:` só existe em runs da 0.3.0 em diante).
//   Estados de nó: trabalhando | verificando | reparando (rodando agora); pronto | pronto-sem-verif |
//     pronto-sem-verif? | sem-reverificacao (já rodou); falhou | falhou-check | bloqueado | erro (falha);
//     aguardando (ainda não rodou); pulado.
//
// GET /api/runs/:wf/nodes/:id → 200 Detalhe | 400 (id fora de /^[A-Za-z0-9_-]{1,64}$/) | 404
//   :id é um nó do modelo ou um pseudo-nó `plan` | `critic` (todas as rodadas) | `design-review` (todas as
//   tentativas) | `polish-<k>` (o polidor `polish:<k>`; a URL usa hífen porque `:` não passa na regex) |
//   `synth`. O nó do plano vence o pseudo-nó de mesmo id.
//   Detalhe = { wf, id, pseudo: bool, title, kind?, risk?, round?, deps?, state, reps?, closed?,
//     agents: Agente[] }   // agents vazio = nó ainda não começou
//   Agente = { label: "work:I2", agentId, status: "rodando" | "terminou" | "erro",
//     transcript: bool, prompt: string (até 600 chars), totalCalls,
//     toolCalls: [{ ts: ISO-8601 UTC | null, time: "HH:MM:SS" (hora local do servidor), name, desc }],
//                  // últimas 20; a UI deve formatar `ts` na hora local do browser (`time` é conveniência)
//     lastText: string | null, think, thinkEmpty,
//     verdict: null | { pass, confidence, blocking: [{ issue, where?, evidence?, fix? }] },
//     result: objeto cru do journal | null, checks: [{ cmd, ok, output? }] }
//
// GET /api/events → text/event-stream (SSE). Ao conectar: `event: runs` com `{ runs, org }` (o corpo do
//   GET /api/runs). Depois, poll a cada ~1 s (e logo depois de cada escrita em /api/org/*): `event: runs`
//   (mesmo formato) quando a lista muda (wf, status, done/total, estados dos nós, goal, organização);
//   `event: run` com `{ "wf": "wf_…" }` quando o journal (mtime/tamanho) ou a
//   transcrição de um agente daquela run muda. Comentário `: ping` a cada ~15 s. Timers limpos quando o
//   último cliente desconecta.
//
// Estáticos (lista fixa, qualquer outro caminho → 404): `/` e `/index.html` (text/html), `/app.js`
// (text/javascript), `/graph-layout.mjs` (módulo importado pelo app.js), `/agent-target.mjs` (fórmula de
// alvos, importada pelo modal), `/config-modal.mjs` (modal de engrenagem), `/theme.js` (aplica o tema antes
// da pintura), `/style.css`, `/favicon.svg`, `/favicon-32.png` e `/apple-touch-icon.png` (7º pedido do
// PEDIDO.md: o mesmo logo do cabeçalho, gerado uma vez e versionado — Safari não mostra favicon SVG) e as
// fontes Geist em `/fonts/*.woff2` (SIL OFL, fonts/OFL.txt), lidos de bin/ui/. `/favicon.ico` devolve o PNG
// de 32px (não há .ico de verdade — todo browser que pede /favicon.ico aceita PNG nessa resposta). Além da
// lista, a regra fechada dos módulos da UI (C10): `/<nome>.mjs` com nome `[a-z0-9-]+` serve um arquivo
// regular (sem symlink) direto em bin/ui/, como text/javascript; assim um módulo novo da página entra sem
// editar este arquivo. Nada vem de fora: CSP com script, estilo, fonte e conexão só 'self'.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { buildModel, computeStop, listAllWfDirs, isGraphEngRun, isTerminatedRun, agentsOfNode, readJournalTolerant, GraphWatchError } from './graph-watch.mjs'
import { MAX_BODY, defaultConfigPath, defaultStateDir, displayPath, isPlainObject, publicConfig, readConfig, resolveConfig, validateConfig, writeConfig } from './config.mjs'
import {
  GROUP_RE,
  RUN_ID_RE,
  applyOrgOp,
  emptyOrg,
  isInFinishedSection,
  pickRepresentative,
  pruneRevived,
  publicOrg,
  readOrg,
  removeRunDir,
  resolveRunDir,
  runKey,
  validateOrgBody,
  writeOrg,
} from './organize.mjs'
import { readRunRegistry } from './run-registry.mjs'
import { readRunV2 } from './run-view-v2.mjs'

export const DEFAULT_PORT = 4477
const HOST = '127.0.0.1'
const RUNS_LIMIT = 50
// Seletor opaco de geração v2. Não coincide com a forma legada `wf_*`.
const V2_RUN_RE = /^v2-[a-f0-9]{64}$/
const WF_RE = /^wf_[A-Za-z0-9_-]+$/
const NODE_RE = /^[A-Za-z0-9_-]{1,64}$/
const PSEUDO = new Set(['plan', 'critic', 'design-review', 'synth'])
const POLISH_API_RE = /^polish-(\d{1,3})$/ // subconjunto do NODE_RE: o polidor `polish:<k>` na URL
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui')
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/graph-layout.mjs': ['graph-layout.mjs', 'text/javascript; charset=utf-8'],
  '/agent-target.mjs': ['agent-target.mjs', 'text/javascript; charset=utf-8'],
  '/config-modal.mjs': ['config-modal.mjs', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon-32.png': ['favicon-32.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/fonts/geist-latin.woff2': ['fonts/geist-latin.woff2', 'font/woff2'],
  '/fonts/geist-latin-ext.woff2': ['fonts/geist-latin-ext.woff2', 'font/woff2'],
  '/fonts/geist-mono-latin.woff2': ['fonts/geist-mono-latin.woff2', 'font/woff2'],
  '/fonts/geist-mono-latin-ext.woff2': ['fonts/geist-mono-latin-ext.woff2', 'font/woff2'],
}
// Regra fechada dos módulos da UI (C10), complemento do STATIC: só nome [a-z0-9-]+.mjs direto em bin/ui/.
const UI_MODULE_RE = /^\/([a-z0-9-]+\.mjs)$/

// Tabela de escrita da organização (C10 O1-O9): caminho → { op, gid? }. Map, e não objeto, para um
// segmento como `__proto__` nunca casar com nada herdado.
const ORG_ROUTES = new Map([
  ['pin', 'pin'],
  ['groups', 'group-create'],
  ['move', 'move'],
  ['archive', 'archive'],
  ['delete', 'delete'],
  ['delete-finished', 'delete-finished'],
])
const ORG_GROUP_ROUTES = new Map([
  ['rename', 'group-rename'],
  ['move', 'group-move'],
  ['delete', 'group-delete'],
])
function orgRoute(pathname) {
  const parts = pathname.split('/').slice(1)
  if (parts[0] !== 'api' || parts[1] !== 'org') return null
  if (parts.length === 3 && ORG_ROUTES.has(parts[2])) return { op: ORG_ROUTES.get(parts[2]) }
  if (parts.length === 5 && parts[2] === 'groups' && ORG_GROUP_ROUTES.has(parts[4])) return { op: ORG_GROUP_ROUTES.get(parts[4]), gid: parts[3] }
  return null
}

// ── Artefatos da run (C10 A5/A6): lista fechada, só leitura, sem sair da pasta da run ──
const ARTIFACT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\.[a-z])?\.md$/
const ARTIFACT_MAX = 200
const ARTIFACT_READ_MAX = 262144 // 256 KB
const FIXED_KINDS = { 'REPORT.md': 'report', 'plan.md': 'plan', 'PEDIDO.md': 'pedido' }

// Entradas diretas de `real` que casam com ARTIFACT_RE e são arquivo regular pelo lstat (symlink fica fora),
// no máximo 200, com o `kind` e a ordem do D3 §3.4.
function listArtifacts(real, nodeIds) {
  const order = new Map(nodeIds.map((id, i) => [id, i]))
  const files = []
  for (const e of fs.readdirSync(real, { withFileTypes: true })) {
    if (files.length >= ARTIFACT_MAX) break
    if (!ARTIFACT_RE.test(e.name)) continue
    let st
    try {
      st = fs.lstatSync(path.join(real, e.name))
    } catch {
      continue
    }
    if (!st.isFile() || st.isSymbolicLink()) continue
    const f = { name: e.name, kind: 'outro', size: st.size, mtime: Math.round(st.mtimeMs) }
    const m = /^(.+?)(?:\.([a-z]))?\.md$/.exec(e.name)
    if (FIXED_KINDS[e.name]) f.kind = FIXED_KINDS[e.name]
    else if (m && order.has(m[1])) {
      f.kind = 'node'
      f.node = m[1]
      if (m[2]) f.variant = m[2]
    }
    files.push(f)
  }
  const rank = (f) => (f.kind === 'report' ? [0] : f.kind === 'plan' ? [1] : f.kind === 'pedido' ? [2] : f.kind === 'node' ? [3, order.get(f.node), f.variant ? 1 : 0] : [4])
  files.sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    for (let i = 0; i < Math.max(ra.length, rb.length); i++) if ((ra[i] ?? 0) !== (rb[i] ?? 0)) return (ra[i] ?? 0) - (rb[i] ?? 0)
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return files
}

// Abre com O_NOFOLLOW (fecha a janela entre o lstat da listagem e o open) e confere o fstat.
function readArtifact(real, name) {
  const fd = fs.openSync(path.join(real, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return null
    const buf = Buffer.alloc(Math.min(st.size, ARTIFACT_READ_MAX))
    let n = 0
    while (n < buf.length) {
      const r = fs.readSync(fd, buf, n, buf.length - n, n)
      if (!r) break
      n += r
    }
    return { size: st.size, mtime: Math.round(st.mtimeMs), truncated: st.size > ARTIFACT_READ_MAX, text: buf.toString('utf8', 0, n) }
  } finally {
    fs.closeSync(fd)
  }
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

// ── Leitura das runs (com cache por assinatura do journal, para não reler journal antigo a cada tick) ──

function statOr(p) {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

// Maior mtime entre as transcrições `agent-*.jsonl` da run (elas mudam a cada tool call; o journal só
// muda quando um agente começa ou termina).
function agentActivity(dir) {
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return 0
  }
  let max = 0
  for (const f of files) {
    if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue
    const st = statOr(path.join(dir, f))
    if (st && st.mtimeMs > max) max = st.mtimeMs
  }
  return max
}

function projectOf(projectsDir, dir) {
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
  } catch {
    /* sem arquivos de agente */
  }
  for (const f of files) {
    let fd
    try {
      fd = fs.openSync(path.join(dir, f), 'r')
      const buf = Buffer.alloc(65536)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/)
      if (m) {
        const cwd = JSON.parse(`"${m[1]}"`)
        const base = path.basename(cwd.replace(/[\\/]+$/, ''))
        if (base) return base
      }
    } catch {
      /* transcrição ilegível: tenta a próxima */
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  const slug = path.relative(projectsDir, dir).split(path.sep)[0] || ''
  const parts = slug.split('-').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : slug || '?'
}

// Todo prompt do graph-eng abre com o mesmo prefixo (`SHARED` em workflows/graph-eng.js), com as linhas
// `Mode: <modo>` e `Economy: <preset>` (esta, só em runs a partir da 0.3.0) e, em runs com esforço e teto,
// `Effort: <nível>`, `Ceiling: <int>` e `Target: <int> | auto <min>-<max>`. Lê o começo da transcrição do
// `plan` e, sem ela (plano vindo de run planOnly irmã), de outro agente. Sem economy o modelo não sabe se
// um nó recém-terminado ainda vai ser verificado, e a bolinha pisca "já rodou" antes do verify.
const ECONOMIES = new Set(['lean', 'balanced', 'max'])
function inferHeader(dir) {
  const { events } = readJournalTolerant(path.join(dir, 'journal.jsonl'))
  const st = [...events].reverse().find((e) => e.type === 'started' && e.label === 'plan')
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl')).sort()
  } catch {
    return {}
  }
  if (st && st.agentId) files = [`agent-${st.agentId}.jsonl`, ...files.filter((f) => f !== `agent-${st.agentId}.jsonl`)]
  for (const f of files.slice(0, 3)) {
    let fd
    try {
      fd = fs.openSync(path.join(dir, f), 'r')
      const buf = Buffer.alloc(65536)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      // o prompt vem como string JSON: a quebra de linha antes de `Mode:` aparece escapada (\n), e o
      // harness pode indentar o texto da tarefa
      const text = buf.toString('utf8', 0, n)
      const m = text.match(/(?:^|\\n|\n)[ \t]*Mode: ([a-z]+)/)
      if (!m) continue
      const e = text.match(/(?:^|\\n|\n)[ \t]*Economy: ([a-z]+)/)
      const ef = text.match(/(?:^|\\n|\n)[ \t]*Effort: (auto|low|medium|high|max)/)
      const c = text.match(/(?:^|\\n|\n)[ \t]*Ceiling: (\d+)/)
      const t = text.match(/(?:^|\\n|\n)[ \t]*Target: (?:(\d+)|auto (\d+)-(\d+))/)
      // chave da run e pasta de artefatos (D4 §3.1): `# Graph run <runId>` e `Run dir (paper trail): <dir>`.
      // O `# Graph run` pode abrir o prompt, logo depois da aspa da string JSON.
      const r = text.match(/(?:^|\\n|\n|")[ \t]*# Graph run ([A-Za-z0-9._-]{1,96})/)
      const d = text.match(/(?:^|\\n|\n)[ \t]*Run dir \(paper trail\): ([^\\"\n]{1,1024})/)
      // I8: `Resume: <rs>` (workflows/graph-eng.js buildShared) — id da retomada que originou este wf, se
      // ele veio de uma retomada. Sem a linha, o wf foi disparado do zero.
      const rs = text.match(/(?:^|\\n|\n)[ \t]*Resume: (rs-\d{8}-\d{6}(?:-\d+)?)/)
      return {
        runId: r ? r[1] : undefined,
        runDirRaw: d ? d[1].trim() || undefined : undefined,
        resume: rs ? rs[1] : undefined,
        mode: m[1],
        economy: e && ECONOMIES.has(e[1]) ? e[1] : undefined,
        effort: ef ? ef[1] : undefined,
        ceiling: c ? Number(c[1]) : undefined,
        target: t && t[1] ? Number(t[1]) : undefined,
        targetRange: t && t[2] ? { min: Number(t[2]), max: Number(t[3]) } : undefined,
      }
    } catch {
      /* transcrição ausente ou ilegível: tenta a próxima */
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  return {}
}

function planGoal(dir) {
  const { events } = readJournalTolerant(path.join(dir, 'journal.jsonl'))
  const starts = events.filter((e) => e.type === 'started' && e.label === 'plan')
  for (const st of starts.reverse()) {
    const res = events.find((e) => e.key === st.key && e.type === 'result')
    if (res && res.result && typeof res.result.goal === 'string') return res.result.goal
  }
  return null
}

// Cria o leitor de runs de um projectsDir. `scanAll()` devolve a lista agrupada por key (RunResumo +
// campos internos `dir`, `sig`, `runDirRaw`, `entries`…), a org lida e o índice por wf (`byWf`, que acha
// também o wf superado de uma run retomada). `scan()` devolve só a lista. O cache guarda o que depende só
// do journal. `configPath` é de onde sai `stallMinutes` (C6): lido a cada scan, tolerante como o resto da
// config, para o modal de engrenagem valer na hora. `organizePath` (C1) é a organização da lista; sem ele,
// a lista sai sem organização. `stateDir` é de onde sai o registro de runs v2 (bin/run-registry.mjs).
export function createRunIndex(projectsDir, { configPath = defaultConfigPath(), organizePath = null, graphRunsHome = null, home = os.homedir(), stateDir = null } = {}) {
  const runsHome = graphRunsHome || path.join(home, '.claude', 'graph-runs')
  const cache = new Map() // dir → { sig, head | null, info? }
  const projects = new Map() // dir → nome do projeto (fixo depois de achado pelo cwd)
  let lastCleanup = -Infinity

  // Parte leve, lida de todo wf (é o que dá a key): graph-eng? + cabeçalho do prompt.
  function headOf(c) {
    const st = statOr(path.join(c.dir, 'journal.jsonl'))
    if (!st) return null
    const sig = `${st.mtimeMs}:${st.size}`
    const hit = cache.get(c.dir)
    if (hit && hit.sig === sig) return hit.head
    const head = isGraphEngRun(c.dir) ? { ...inferHeader(c.dir), sig, journalMtime: st.mtimeMs } : null
    cache.set(c.dir, { sig, head })
    return head
  }

  // Parte pesada (modelo), só dos wfs das keys que entram na lista.
  async function describe(c, head) {
    const hit = cache.get(c.dir)
    if (hit && hit.sig === head.sig && hit.info) return hit.info
    const { mode, economy, effort, ceiling } = head
    let model = null
    try {
      model = await buildModel({ runDir: c.dir, mode, economy, effort, ceiling })
    } catch {
      /* journal de formato estranho: entra na lista sem nós */
    }
    const nodes = model ? model.nodes : []
    const info = {
      terminated: isTerminatedRun(c.dir),
      planOnly: model ? model.planOnly : false,
      openAgentIds: model ? model.openAgentIds : [],
      goal: planGoal(c.dir),
      done: nodes.filter((n) => n.state.startsWith('pronto')).length,
      total: nodes.length,
      round: model ? model.round : 1,
      nodes: nodes.map((n) => ({ id: n.id, state: n.state, round: n.round })),
    }
    if (hit && hit.sig === head.sig) hit.info = info
    return info
  }

  function loadOrg() {
    if (!organizePath) return { org: emptyOrg(), warnings: [] }
    try {
      return readOrg(organizePath)
    } catch (e) {
      return { org: emptyOrg(), warnings: [`não consegui ler organize.json: ${e.message}`] }
    }
  }

  async function scanAll(now = Date.now()) {
    // Só `stallMinutes` importa aqui; os demais campos (effort/ceiling/…) não afetam a lista.
    let stallMinutes = 5
    try {
      stallMinutes = readConfig(configPath).operational.stallMinutes
    } catch {
      /* config ilegível: mantém o padrão, como o resto da leitura de config */
    }
    const { org, warnings: orgWarnings } = loadOrg()
    const keep = new Set([...org.pinned, ...Object.keys(org.placement)])
    const all = listAllWfDirs(projectsDir).sort((a, b) => b.mtime - a.mtime)

    // 1) agrupa por key, do mais novo para o mais velho. RUNS_LIMIT conta keys; fixadas e em grupo entram
    //    sempre. `latest` guarda o maior mtime de toda key vista, inclusive das apagadas.
    const groups = new Map() // key → [{ c, head, slug, runId }]
    const latest = new Map()
    const seen = new Set()
    for (const c of all) {
      if (seen.has(c.wf)) continue
      const head = headOf(c)
      if (!head) continue
      seen.add(c.wf)
      const slug = path.relative(projectsDir, c.dir).split(path.sep)[0] || ''
      const runId = typeof head.runId === 'string' && RUN_ID_RE.test(head.runId) ? head.runId : null
      const key = runKey({ slug, runId, wf: c.wf })
      if (!latest.has(key)) latest.set(key, c.mtime)
      const deletedAt = org.deleted[key]
      if (deletedAt !== undefined && !(latest.get(key) > deletedAt)) continue
      if (!groups.has(key)) {
        if (groups.size >= RUNS_LIMIT && !keep.has(key)) continue
        groups.set(key, [])
      }
      groups.get(key).push({ c, head, slug, runId })
    }

    // 2) estado de cada wf das keys escolhidas e o representante de cada key
    const runs = []
    const byWf = new Map()
    const dupWarnings = []
    for (const [key, items] of groups) {
      const entries = []
      for (const { c, head, slug, runId } of items) {
        const info = await describe(c, head)
        const agents = info.terminated ? 0 : agentActivity(c.dir)
        const last = Math.max(head.journalMtime, agents)
        if (!projects.has(c.dir)) projects.set(c.dir, projectOf(projectsDir, c.dir))
        // A mesma regra e o mesmo motivo do `buildModel` (bin/graph-watch.mjs): `openAgentIds`/`planOnly` vêm
        // cacheados (dependem só do journal); `computeStop` é recalculado a cada scan porque depende de `now`
        // e da cauda dos agentes ainda abertos.
        const stop = computeStop({ runDir: c.dir, openAgentIds: info.openAgentIds, terminated: info.terminated, planOnly: info.planOnly, now, stallMinutes })
        const status = info.terminated || info.planOnly ? 'terminado' : stop ? 'parada?' : 'rodando'
        entries.push({
          generation: 'legacy',
          wf: c.wf,
          project: projects.get(c.dir),
          status,
          stop,
          planOnly: info.planOnly,
          goal: info.goal,
          done: info.done,
          total: info.total,
          round: info.round,
          mtime: Math.round(last),
          nodes: info.nodes,
          dir: c.dir,
          mode: head.mode,
          economy: head.economy,
          effort: head.effort,
          ceiling: head.ceiling,
          sig: `${head.sig}:${agents}`,
          key,
          slug,
          runId,
          runDirRaw: head.runDirRaw || null,
          stallMinutes,
        })
      }
      const rep = pickRepresentative(entries)
      if (!rep) continue
      const byNew = [...entries].sort((a, b) => b.mtime - a.mtime)
      const runId = rep.runId || (byNew.find((e) => e.runId) || {}).runId || null
      // Limite conhecido da chave (D4 §3.1): dois runIds iguais com pastas diferentes viram uma linha só.
      const raws = new Set(entries.map((e) => e.runDirRaw).filter(Boolean))
      if (raws.size > 1) dupWarnings.push(`duas runs com o mesmo runId: ${runId}`)
      const runDirRaw = rep.runDirRaw || (byNew.find((e) => e.runDirRaw) || {}).runDirRaw || null
      const where = runDirRaw ? resolveRunDir(runDirRaw, runId, { projectsDir, graphRunsHome: runsHome, home }) : null
      const run = {
        generation: 'legacy',
        ...rep,
        key,
        runId,
        name: runId || rep.wf.replace(/^wf_/, ''),
        wfs: byNew.map((e) => e.wf),
        pinned: org.pinned.includes(key),
        group: Object.hasOwn(org.placement, key) ? org.placement[key] : null,
        archived: Object.hasOwn(org.archived, key),
        runDir: where && where.ok ? displayPath(runDirRaw, home) : null,
        runDirRaw,
        entries,
      }
      runs.push(run)
      for (const e of entries) byWf.set(e.wf, { entry: e, run })
    }

    // Registry v2 é apenas uma pista local de descoberta; a projeção relê e valida cada identidade sem
    // adquirir lease, recuperar journal ou aceitar caminhos vindos do browser.
    const registry = stateDir ? await readRunRegistry({ stateDir }) : { entries: [], warnings: [] }
    const registryWarnings = registry.warnings.map((w) => `Registry v2: ${w.code || 'aviso'} (entrada indisponível).`)
    for (const entry of registry.entries) {
      const projected = await readRunV2(entry)
      if (!projected.run) {
        for (const w of projected.warnings || []) registryWarnings.push(`Run v2: ${w.code || 'aviso'} (projeção indisponível).`)
        continue
      }
      const v2 = projectV2Summary(projected.run)
      const selector = `v2-${projected.run.key}`
      const timestamps = (projected.run.events || []).map((event) => Date.parse(event.at)).filter(Number.isFinite)
      const registeredAt = Date.parse(entry.registeredAt)
      const mtime = timestamps.length ? timestamps.reduce((max, value) => Math.max(max, value), -Infinity) : Number.isFinite(registeredAt) ? registeredAt : now
      const warnings = [...new Set((projected.run.warnings || []).map((w) => safeDisplay(w.code, 40) || 'aviso'))].map((code) => `Aviso v2 (${code}); detalhes internos omitidos.`)
      const summary = {
        generation: 'v2', key: selector, wf: selector, wfs: [selector], runId: projected.run.runId, sig: JSON.stringify(projected.signatures),
        project: path.basename(projected.run.cwd), status: statusLabel(projected.run.status), stop: { reason: projected.run.statusReason, text: stopText(projected.run.status) },
        planOnly: false, goal: safeDisplay(projected.run.task, 240), done: 0, total: 0, round: v2.planVersion || '—',
        mtime, nodes: [], pinned: false, group: null, archived: false, runDir: null,
        host: safeDisplay(projected.run.host, 80) || 'desconhecido', _v2Receipts: v2.receipts,
        v2: { ...v2, receipts: undefined, receiptCount: v2.receipts.length, warnings },
      }
      runs.push(summary)
      byWf.set(selector, { entry: summary, run: summary })
    }
    const rank = (r) => (r.status === 'rodando' ? 0 : 1)
    runs.sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime)
    return { runs, org, warnings: [...orgWarnings, ...dupWarnings, ...registryWarnings], dupWarnings, latest, byWf }
  }

  async function scan(now = Date.now()) {
    return (await scanAll(now)).runs
  }

  return { scan, scanAll }
}

const FEEDBACK_HISTORY_LIMIT = 10
const STATUS_LABELS = { done: 'concluída', blocked: 'bloqueada', needs_clarification: 'precisa de esclarecimento', plan_only: 'plano concluído' }
const REPAIR_STAGES = ['design-fix-intent', 'critic-fix-complete']

function statusLabel(status) { return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : 'desconhecida' }

function stopText(status) {
  if (Object.hasOwn(STATUS_LABELS, status)) return `Execução ${statusLabel(status)}; o status veio do evento run.finished.`
  return 'O status final desta execução ainda não está disponível.'
}

function projectV2Summary(run) {
  const events = Array.isArray(run.events) ? run.events : []
  const versions = [run.state?.planVersion, ...events.map((event) => event.planVersion)].filter((n) => Number.isSafeInteger(n) && n > 0)
  // Reparos e replanos vêm só dos control.transition já projetados por allowlist (run-view-v2).
  const transitions = events.filter((event) => event.type === 'control.transition' && event.payload && typeof event.payload === 'object')
  const hasTransitions = transitions.length > 0
  const repairs = transitions.filter((event) => REPAIR_STAGES.includes(event.payload.stage)).length
  const replans = transitions.filter((event) => event.payload.stage === 'plan-approved' && Number.isSafeInteger(event.payload.previousPlanVersion)).length
  const feedbackHistory = events
    .filter((event) => event.feedback || event.payload?.feedback)
    .slice(-FEEDBACK_HISTORY_LIMIT)
    .map((event) => {
      const item = event.feedback || event.payload.feedback
      return { seq: event.seq, kind: item.kind ?? null, reason: item.reason ?? null, severity: item.severity ?? null, affectedNodes: item.affectedNodes ?? null }
    })
  // Só IDs de seleção e contagem por papel; o summary dos registros nunca sai daqui.
  const memoryEvents = events.filter((event) => event.type === 'memory.selected')
  const memoryByRole = new Map()
  for (const event of memoryEvents) {
    const role = typeof event.payload?.role === 'string' ? event.payload.role : 'desconhecido'
    memoryByRole.set(role, (memoryByRole.get(role) || 0) + 1)
  }
  const memorySelections = {
    total: memoryEvents.length,
    byRole: [...memoryByRole].map(([role, count]) => ({ role, count })),
    selectionIds: memoryEvents.map((event) => event.payload?.selectionId).filter((id) => typeof id === 'string'),
    // R-E9c: seleções reaproveitadas na retomada (reused: true).
    reused: memoryEvents.filter((event) => event.payload?.reused === true).length,
  }
  const feedbackEvent = [...events].reverse().find((event) => event.feedback || event.payload?.feedback)
  const feedback = run.state?.feedback || feedbackEvent?.feedback || feedbackEvent?.payload?.feedback || null
  const callsById = new Map()
  const roleCounts = new Map()
  const modelCounts = new Map()
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  const usageKnown = Object.fromEntries(Object.keys(usage).map((key) => [key, false]))
  const times = []
  const receipts = []
  for (const event of events) {
    if (Number.isFinite(Date.parse(event.at))) times.push(Date.parse(event.at))
    const payload = event.payload || {}
    const identity = typeof event.agentId === 'string' && event.agentId ? event.agentId : typeof event.key === 'string' && event.key ? event.key : null
    if (identity && ['started', 'result', 'failed'].includes(event.type)) {
      const call = callsById.get(identity) || { identity }
      if (typeof payload.role === 'string') call.role = payload.role
      for (const field of ['requestedModel', 'effectiveModel']) {
        if (Object.hasOwn(payload, field)) {
          call[`${field}Available`] = true
          call[field] = typeof payload[field] === 'string' ? payload[field] : null
        }
      }
      if (event.type === 'result' && payload.usage && typeof payload.usage === 'object') call.usage = payload.usage
      callsById.set(identity, call)
    }
    if (payload.checkId) {
      receipts.push({ seq: event.seq, checkId: payload.checkId || null, identity: payload.identity || null, valid: typeof payload.valid === 'boolean' ? payload.valid : null })
    }
  }
  const calls = [...callsById.values()].filter((call) => typeof call.role === 'string')
  for (const call of calls) {
    roleCounts.set(call.role, (roleCounts.get(call.role) || 0) + 1)
    for (const [kind, available, name] of [
      ['solicitado', call.requestedModelAvailable, call.requestedModel],
      ['efetivo', call.effectiveModelAvailable, call.effectiveModel],
    ]) {
      if (!available) continue
      const label = `${call.role} · ${kind} · ${name || 'não informado'}`
      modelCounts.set(label, (modelCounts.get(label) || 0) + 1)
    }
    const u = call.usage
    if (!u) continue
    const input = u.input_tokens ?? u.prompt_tokens
    const output = u.output_tokens ?? u.completion_tokens
    const total = u.total_tokens
    const cacheRead = u.cache_read_input_tokens ?? u.cached_tokens
    const cacheCreation = u.cache_creation_input_tokens
    if (Number.isSafeInteger(input)) { usage.inputTokens += input; usageKnown.inputTokens = true }
    if (Number.isSafeInteger(output)) { usage.outputTokens += output; usageKnown.outputTokens = true }
    if (Number.isSafeInteger(total)) { usage.totalTokens += total; usageKnown.totalTokens = true }
    if (Number.isSafeInteger(cacheRead)) { usage.cacheReadTokens += cacheRead; usageKnown.cacheReadTokens = true }
    if (Number.isSafeInteger(cacheCreation)) { usage.cacheCreationTokens += cacheCreation; usageKnown.cacheCreationTokens = true }
  }
  const from = times.length ? times.reduce((min, value) => Math.min(min, value), Infinity) : null
  const to = times.length ? times.reduce((max, value) => Math.max(max, value), -Infinity) : null
  const observed = times.length ? { from, to, durationMs: to - from } : null
  const modelFieldsAvailable = calls.some((call) => call.requestedModelAvailable || call.effectiveModelAvailable)
  const usageFieldValue = {
    inputTokens: (u) => u.input_tokens ?? u.prompt_tokens,
    outputTokens: (u) => u.output_tokens ?? u.completion_tokens,
    totalTokens: (u) => u.total_tokens,
    cacheReadTokens: (u) => u.cache_read_input_tokens ?? u.cached_tokens,
    cacheCreationTokens: (u) => u.cache_creation_input_tokens,
  }
  const usageFields = Object.fromEntries(Object.entries(usageFieldValue).map(([field, getValue]) => [field, {
    observedCalls: calls.filter((call) => Number.isSafeInteger(getValue(call.usage || {}))).length,
    totalCalls: calls.length,
  }]))
  const planVersions = [...new Set(versions)].sort((a, b) => a - b)
  return {
    planVersion: versions.length ? versions.reduce((max, value) => Math.max(max, value), 0) : null,
    planVersions,
    feedback,
    repairs: hasTransitions ? repairs : null,
    replans: hasTransitions ? replans : null,
    feedbackHistory,
    memorySelections,
    terminalStatus: run.status ?? 'unknown',
    terminalReason: run.statusReason ?? null,
    callCount: calls.length,
    roleCounts: [...roleCounts].map(([role, count]) => ({ role, count })),
    modelCounts: [...modelCounts].map(([label, count]) => ({ label, count })),
    observed,
    usage: Object.values(usageKnown).some(Boolean)
      ? {
          ...Object.fromEntries(Object.keys(usage).map((key) => [key, usageKnown[key] ? usage[key] : null])),
          coverage: usageFields,
          callsWithUsage: calls.filter((call) => call.usage).length,
          partial: Object.values(usageFields).some(({ observedCalls, totalCalls }) => observedCalls < totalCalls),
        }
      : null,
    modelFieldsAvailable,
    receipts,
    preservation: null,
    invalidation: null,
    supportWarning: 'Os dados por nó e de preservação ainda não estão disponíveis para esta execução.',
  }
}

function safeDisplay(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : ''
}

function publicV2Model(run) {
  const v2 = run.v2
  const receipts = run._v2Receipts || []
  const feedback = v2.feedback
  const feedbackText = feedback ? `Feedback ${feedback.kind || 'indisponível'}${feedback.reason ? `: ${feedback.reason}` : ''}${feedback.severity ? ` · gravidade ${feedback.severity}` : ''}${feedback.affectedNodes?.length ? ` · nós ${feedback.affectedNodes.join(', ')}` : ''}${feedback.evidenceIds?.length ? ` · evidências ${feedback.evidenceIds.join(', ')}` : ''}` : 'Feedback: indisponível'
  const callText = v2.callCount ? `Chamadas observadas: ${v2.roleCounts.map(({ role, count }) => `${role} ${count}`).join(', ')}` : 'Chamadas por papel/modelo: indisponíveis'
  const usageText = v2.usage ? `Usage ${v2.usage.partial ? 'parcial' : 'observado'}: ${v2.usage.inputTokens ?? 'indisponível'} entrada · ${v2.usage.outputTokens ?? 'indisponível'} saída · ${v2.usage.totalTokens ?? 'indisponível'} total · cache lido ${v2.usage.cacheReadTokens ?? 'indisponível'} · criado ${v2.usage.cacheCreationTokens ?? 'indisponível'}` : 'Usage: indisponível'
  const modelsText = v2.modelFieldsAvailable
    ? v2.modelCounts.map((item) => `${item.label} (${item.count})`).join('; ')
    : 'Modelo solicitado/efetivo: indisponível'
  const v2Summary = [
    `Host ${run.host}`,
    `Plan version atual ${v2.planVersion ?? 'indisponível'} · histórico ${v2.planVersions.length ? v2.planVersions.join(', ') : 'indisponível'}`,
    modelsText,
    callText,
    v2.observed ? `Tempo observado ${Math.round(v2.observed.durationMs / 1000)} s` : 'Tempo observado: indisponível',
    usageText,
    v2.repairs === null ? 'Reparos e replanejamentos ainda não estão disponíveis para esta execução' : `Reparos ${v2.repairs} · Replanejamentos ${v2.replans}`,
    feedbackText,
    receipts.length ? `Checks/receipts observados: ${receipts.length}` : 'Checks/receipts: indisponíveis',
    'Dados de preservação e invalidação indisponíveis para esta execução',
  ].join(' · ')
  return {
    generation: 'v2', key: run.key, wf: run.wf, current: run.wf, runId: run.runId, runKey: run.key,
    status: statusLabel(v2.terminalStatus), statusReason: v2.terminalReason ?? 'terminal_contract_unsupported', stop: run.stop, planOnly: false,
    project: run.project, goal: [run.goal, v2Summary].filter(Boolean).join(' · '), round: v2.planVersion ?? '—',
    nodes: [], warns: [...run.v2.warnings, v2.supportWarning], spent: undefined,
    v2: { ...v2, receipts },
    runDir: null,
  }
}

// RunResumo público: os campos internos (`dir`, `sig`, o cabeçalho, o caminho cru e as execuções) ficam
// no servidor.
const publicRun = ({ dir, sig, mode, economy, effort, ceiling, slug, runDirRaw, entries, stallMinutes, _v2Receipts, ...r }) => r

// ── Servidor ──

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  })
  res.end(payload)
}

const sendError = (res, status, msg, extra) => send(res, status, { error: msg }, undefined, extra)

function pseudoState(agents) {
  const last = agents[agents.length - 1]
  if (!last) return 'aguardando'
  if (last.status === 'rodando') return 'trabalhando'
  return last.status === 'erro' ? 'erro' : 'pronto'
}

// Lê o corpo com limite de MAX_BODY bytes. Acima disso, descarta o resto (sem acumular) e resolve
// { tooBig: true } no fim; nunca guarda mais que o limite na memória.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooBig = false
    req.on('data', (d) => {
      size += d.length
      if (size > MAX_BODY) tooBig = true
      else chunks.push(d)
    })
    req.on('end', () => resolve(tooBig ? { tooBig } : { text: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', reject)
  })
}

// Opções (C1): `configPath` (config.json), `stateDir` (padrão: a pasta do configPath explícito, ou
// defaultStateDir()), `organizePath` (padrão `<stateDir>/organize.json`), `graphRunsHome` (o graph-runs
// global, padrão ~/.claude/graph-runs; só a contenção do apagar o usa), `now` (relógio) e `canDelete(key, run)`
// → motivo | null (gancho opcional de quem chama para impedir o apagar).
export function createPanelServer(opts = {}) {
  const { projectsDir, pollMs = 1000, heartbeatMs = 15000, home = os.homedir(), now = () => Date.now() } = opts
  const configPath = opts.configPath ?? defaultConfigPath()
  const stateDir = opts.stateDir ?? (opts.configPath ? path.dirname(opts.configPath) : defaultStateDir())
  const organizePath = opts.organizePath ?? path.join(stateDir, 'organize.json')
  const graphRunsHome = opts.graphRunsHome ?? path.join(home, '.claude', 'graph-runs')
  const index = createRunIndex(projectsDir, { configPath, organizePath, graphRunsHome, home, stateDir })
  // Gancho do apagar (O8/O9): `canDelete(key, run)` → motivo | null. Sem fila de pedidos, nada o impede por padrão.
  const canDelete = opts.canDelete ?? (() => null)
  const clients = new Set()
  let pollTimer = null
  let beatTimer = null
  let lastListSig = null
  let runSigs = new Map()
  let polling = false

  const listBody = (snap) => ({ runs: snap.runs.map(publicRun), org: publicOrg(snap.org, snap.warnings) })
  const listSig = (snap) =>
    JSON.stringify([
      snap.runs.map((r) => [r.key, r.generation, r.wf, r.status, r.done, r.total, r.goal, r.round, r.nodes, r.pinned, r.group, r.archived, r.planOnly, r.wfs, r.runDir, r.v2]),
      publicOrg(snap.org, snap.warnings),
    ])
  // assinatura de cada wf das runs listadas (também dos superados, que a página ainda pode ter aberto)
  const wfSigs = (snap) => new Map([...snap.byWf].map(([wf, { entry }]) => [wf, entry.sig]))

  function broadcast(event, data) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) res.write(chunk)
  }

  async function tick() {
    if (polling) return
    polling = true
    try {
      const snap = await index.scanAll(now())
      const sig = listSig(snap)
      if (sig !== lastListSig) {
        lastListSig = sig
        broadcast('runs', listBody(snap))
      }
      const next = wfSigs(snap)
      for (const [wf, s] of next) {
        const prev = runSigs.get(wf)
        if (prev !== undefined && prev !== s) broadcast('run', { wf })
      }
      runSigs = next
    } catch {
      /* leitura transitória: tenta no próximo tick */
    } finally {
      polling = false
    }
  }

  function stopTimers() {
    clearInterval(pollTimer)
    clearInterval(beatTimer)
    pollTimer = null
    beatTimer = null
  }

  async function openEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    })
    res.write('retry: 2000\n\n')
    const snap = await index.scanAll(now())
    if (!clients.size) {
      // primeiro cliente: fotografa o estado atual para só avisar mudanças daqui em diante
      lastListSig = listSig(snap)
      runSigs = wfSigs(snap)
    }
    res.write(`event: runs\ndata: ${JSON.stringify(listBody(snap))}\n\n`)
    clients.add(res)
    if (!pollTimer) {
      pollTimer = setInterval(tick, pollMs)
      beatTimer = setInterval(() => {
        for (const c of clients) c.write(': ping\n\n')
      }, heartbeatMs)
    }
    const drop = () => {
      clients.delete(res)
      if (!clients.size) stopTimers()
    }
    req.on('close', drop)
    res.on('error', drop)
  }

  function getConfig(res) {
    let body
    try {
      body = publicConfig(configPath)
    } catch (e) {
      return sendError(res, 500, `não consegui ler a config: ${e.message}`)
    }
    return send(res, 200, body)
  }

  // Travas comuns de toda escrita (C10), na ordem do PUT /api/config de sempre (Host e método já foram
  // conferidos em handle()): Origin 403 → Content-Type 415 → 413 declarado → 413 em chunks → 400 JSON
  // inválido → 400 corpo que não é objeto. → o objeto, ou null (a resposta de erro já saiu).
  async function readJsonBody(req, res, host) {
    // recusa antes de ler o corpo: descarta o que vier sem guardar (req.resume) e responde
    const refuse = (status, msg) => {
      req.resume()
      sendError(res, status, msg)
      return null
    }
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin.toLowerCase() !== `http://${host}`) return refuse(403, 'Origin não permitido')
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json') return refuse(415, 'use Content-Type: application/json')
    const tooBig = `corpo acima de ${MAX_BODY} bytes`
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY) return refuse(413, tooBig)
    const body = await readBody(req)
    if (body.tooBig) {
      sendError(res, 413, tooBig)
      return null
    }
    let parsed
    try {
      parsed = JSON.parse(body.text)
    } catch {
      sendError(res, 400, 'JSON inválido')
      return null
    }
    if (!isPlainObject(parsed)) {
      sendError(res, 400, 'o corpo deve ser um objeto')
      return null
    }
    return parsed
  }

  async function putConfig(req, res, host) {
    const parsed = await readJsonBody(req, res, host)
    if (parsed === null) return
    const checked = validateConfig(parsed)
    if (!checked.ok) return send(res, 400, { error: 'config inválida', fields: checked.errors })
    try {
      writeConfig(configPath, checked.value)
    } catch (e) {
      return sendError(res, 500, `não consegui gravar a config: ${e.message}`)
    }
    return getConfig(res)
  }

  // ── Organização da lista (C10 O1-O9) ──

  // Ler, aplicar e gravar sem `await` no meio: duas abas no mesmo servidor não perdem escrita. As keys
  // apagadas que voltaram (wf mais novo que o apagar) saem de `deleted` nesta mesma escrita.
  function commitOrg(snap, op, args) {
    const { org } = readOrg(organizePath)
    const r = applyOrgOp(pruneRevived(org, snap.latest), op, args, { now: now() })
    if (!r.ok) return r
    const written = writeOrg(organizePath, r.org)
    return { ok: true, org: written, extra: r.extra }
  }

  function sendOrgResult(res, snap, r, extra = {}) {
    if (!r.ok) return r.fields ? send(res, r.status, { error: r.error, fields: r.fields }) : sendError(res, r.status, r.error)
    tick() // avisa as outras abas na hora (event: runs)
    return send(res, 200, { org: publicOrg(r.org, snap.dupWarnings), ...r.extra, ...extra })
  }

  const whereOf = (run) => resolveRunDir(run.runDirRaw, run.runId, { projectsDir, graphRunsHome, home })

  async function postOrg(req, res, host, route) {
    const body = await readJsonBody(req, res, host)
    if (body === null) return
    const v2Target = typeof body.wf === 'string' && V2_RUN_RE.test(body.wf)
      ? body.wf
      : Array.isArray(body.wfs) ? body.wfs.find((wf) => typeof wf === 'string' && V2_RUN_RE.test(wf)) : null
    if (v2Target) {
      const reason = route.op === 'delete' || route.op === 'delete-finished'
        ? 'Exclusão física de run v2 bloqueada nesta entrega: contenção e lease proprietário não são verificados pelo serviço de organização.'
        : 'Organização de runs v2 indisponível: o formato atual de organize.json só suporta identidades wf legadas.'
      return sendError(res, 409, reason)
    }
    if (route.gid !== undefined && !GROUP_RE.test(route.gid)) return sendError(res, 400, 'id de grupo inválido')
    const checked = validateOrgBody(route.op, body)
    if (!checked.ok) return send(res, 400, { error: 'pedido de organização inválido', fields: checked.errors })
    const v = checked.value
    const snap = await index.scanAll(now())
    let run = null
    if (v.wf !== undefined) {
      const hit = snap.byWf.get(v.wf)
      if (!hit) return sendError(res, 404, `run ${v.wf} não encontrada`)
      run = hit.run
    }

    if (route.op === 'delete') return deleteOne(res, snap, run, v)
    if (route.op === 'delete-finished') return deleteFinished(res, snap, v)

    const args = { ...v, gid: route.gid }
    delete args.wf
    if (run) args.key = run.key
    let r
    try {
      r = commitOrg(snap, route.op, args)
    } catch (e) {
      return sendError(res, 500, `não consegui gravar a organização: ${e.message}`)
    }
    return sendOrgResult(res, snap, r)
  }

  // O8: nome digitado idêntico ao `name` (sem trim nem caixa); rodando → 409; gancho `canDelete` → 409;
  // pasta fora da contenção → 409 sem remover nada; a pasta sai antes de gravar a lista.
  async function deleteOne(res, snap, run, v) {
    if (v.confirm !== run.name) return send(res, 400, { error: 'pedido de organização inválido', fields: { confirm: 'digite o nome da run exatamente como aparece' } })
    if (run.status === 'rodando') return sendError(res, 409, 'Pare a run antes de apagar.')
    const why = canDelete(run.key, run)
    if (why) return sendError(res, 409, why)
    const where = whereOf(run)
    if (!where.ok && !where.absent) return sendError(res, 409, `não apago: ${where.why}`)
    let removedDir = false
    if (where.ok) {
      try {
        removeRunDir(where.real)
        removedDir = true
      } catch (e) {
        return sendError(res, 500, `não consegui apagar a pasta: ${e.message}`)
      }
    }
    let r
    try {
      r = commitOrg(snap, 'delete', { key: run.key })
    } catch (e) {
      return sendError(res, 500, removedDir ? `a pasta foi apagada, mas não consegui gravar a lista: ${e.message}` : `não consegui gravar a lista: ${e.message}`)
    }
    return sendOrgResult(res, snap, r, { deleted: run.key, removedDir })
  }

  // O9: os wfs são os representantes da seção Finalizadas quando o dialog abriu. Qualquer um que sumiu,
  // deixou de ser o representante, passou a rodar ou saiu da seção → 409 e nada é apagado. Falha de
  // contenção, de `rm` ou do gancho vai para `failed`, e as outras seguem; a lista é gravada uma vez.
  async function deleteFinished(res, snap, v) {
    const stale = () => sendError(res, 409, 'a lista de finalizadas mudou; reabra o dialog')
    const runs = []
    for (const wf of v.wfs) {
      const hit = snap.byWf.get(wf)
      if (!hit || hit.run.wf !== wf) return stale()
      if (hit.run.status === 'rodando' || !isInFinishedSection(hit.run)) return stale()
      if (runs.includes(hit.run)) return stale()
      runs.push(hit.run)
    }
    const keys = []
    const failed = []
    for (const run of runs) {
      const why = canDelete(run.key, run)
      if (why) {
        failed.push({ wf: run.wf, reason: why })
        continue
      }
      const where = whereOf(run)
      if (!where.ok && !where.absent) {
        failed.push({ wf: run.wf, reason: `não apago: ${where.why}` })
        continue
      }
      if (where.ok) {
        try {
          removeRunDir(where.real)
        } catch (e) {
          failed.push({ wf: run.wf, reason: `não consegui apagar a pasta: ${e.message}` })
          continue
        }
      }
      keys.push(run.key)
    }
    let r
    try {
      r = keys.length ? commitOrg(snap, 'delete-finished', { keys }) : { ok: true, org: readOrg(organizePath).org, extra: {} }
    } catch (e) {
      return sendError(res, 500, `as pastas foram apagadas, mas não consegui gravar a lista: ${e.message}`)
    }
    return sendOrgResult(res, snap, r, { deleted: keys, failed })
  }

  // ── Modelo da execução (com o relógio e o limiar que a lista usou, C6) e artefatos (A5/A6) ──
  const modelOf = (entry) =>
    buildModel({
      runDir: entry.dir,
      mode: entry.mode,
      economy: entry.economy,
      effort: entry.effort,
      ceiling: entry.ceiling,
      now: now(),
      stallMinutes: entry.stallMinutes,
    })

  // A5/A6: a pasta sai da contenção `resolveRunDir` da run (vale para wf superado: é só leitura); o nome é o
  // segmento cru, precisa casar com ARTIFACT_RE e estar na listagem atual.
  async function getArtifacts(res, wf, name) {
    if (name !== undefined && !ARTIFACT_RE.test(name)) return sendError(res, 400, 'nome de artefato inválido')
    const hit = (await index.scanAll(now())).byWf.get(wf)
    if (!hit) return sendError(res, 404, `run ${wf} não encontrada`)
    const where = whereOf(hit.run)
    if (!where.ok) return sendError(res, 404, 'essa run não tem pasta de artefatos')
    let files
    try {
      files = listArtifacts(where.real, hit.entry.nodes.map((n) => n.id))
    } catch {
      return sendError(res, 404, 'essa run não tem pasta de artefatos')
    }
    if (name === undefined) return send(res, 200, { runId: hit.run.runId, runDir: hit.run.runDir, files })
    const f = files.find((x) => x.name === name)
    if (!f) return sendError(res, 404, 'artefato não encontrado')
    let got
    try {
      got = readArtifact(where.real, name)
    } catch {
      got = null
    }
    if (!got) return sendError(res, 404, 'artefato não encontrado')
    return send(res, 200, { name, kind: f.kind, ...got })
  }

  // Serve um módulo da UI pela regra fechada (C10): nome [a-z0-9-]+.mjs, arquivo regular direto em bin/ui/.
  function sendUiModule(res, name) {
    const file = path.join(UI_DIR, name)
    let body
    try {
      if (!fs.lstatSync(file).isFile()) return sendError(res, 404, 'não encontrado')
      body = fs.readFileSync(file)
    } catch {
      return sendError(res, 404, 'não encontrado')
    }
    return send(res, 200, body, 'text/javascript; charset=utf-8')
  }

  async function handle(req, res) {
    const port = server.address() && server.address().port
    const host = String(req.headers.host || '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendError(res, 403, 'Host não permitido')
    let pathname
    try {
      pathname = new URL(req.url, `http://${HOST}`).pathname
    } catch {
      return sendError(res, 400, 'URL inválida')
    }
    if (pathname === '/api/config') {
      if (req.method === 'GET') return getConfig(res)
      if (req.method === 'PUT') return putConfig(req, res, host)
      return sendError(res, 405, 'use GET ou PUT', { Allow: 'GET, PUT' })
    }
    const write = orgRoute(pathname)
    if (write) {
      if (req.method !== 'POST') return sendError(res, 405, 'use POST', { Allow: 'POST' })
      return postOrg(req, res, host, write)
    }
    if (req.method !== 'GET') return sendError(res, 405, 'só leitura: use GET', { Allow: 'GET' })

    if (Object.hasOwn(STATIC, pathname)) {
      const [file, type] = STATIC[pathname]
      let body
      try {
        body = fs.readFileSync(path.join(UI_DIR, file))
      } catch {
        return sendError(res, 404, 'arquivo do painel ausente')
      }
      return send(res, 200, body, type, type.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {})
    }

    const mod = UI_MODULE_RE.exec(pathname)
    if (mod) return sendUiModule(res, mod[1])

    if (pathname === '/favicon.ico') {
      // Sem .ico de verdade no repo (7º pedido do PEDIDO.md): devolve o PNG de 32px, que todo
      // browser que bate em /favicon.ico aceita nessa resposta (antes: 204 vazio, sem ícone nenhum).
      let body
      try {
        body = fs.readFileSync(path.join(UI_DIR, 'favicon-32.png'))
      } catch {
        return send(res, 204, '')
      }
      return send(res, 200, body, 'image/png')
    }
    const parts = pathname.split('/').slice(1)
    if (parts[0] !== 'api') return sendError(res, 404, 'não encontrado')
    if (parts.length === 2 && parts[1] === 'health') return send(res, 200, { app: 'graph-watch', version: 1, pid: process.pid })
    if (parts.length === 2 && parts[1] === 'events') return openEvents(req, res)
    if (parts.length === 2 && parts[1] === 'runs') return send(res, 200, listBody(await index.scanAll(now())))

    if (parts[1] === 'runs' && parts[3] === 'artifacts' && (parts.length === 4 || parts.length === 5)) {
      if (V2_RUN_RE.test(parts[2])) return sendError(res, 404, 'artefatos v2 indisponíveis nesta entrega')
      if (!WF_RE.test(parts[2])) return sendError(res, 400, 'id de run inválido')
      return getArtifacts(res, parts[2], parts[4])
    }

    if (parts[1] === 'runs' && (parts.length === 3 || (parts.length === 5 && parts[3] === 'nodes'))) {
      const wf = parts[2]
      if (V2_RUN_RE.test(wf)) {
        const hit = (await index.scanAll(now())).byWf.get(wf)
        if (!hit || hit.run.generation !== 'v2') return sendError(res, 404, `run ${wf} não encontrada`)
        if (parts.length !== 3) return sendError(res, 404, 'detalhes de nós não existem nesta projeção v2')
        return send(res, 200, publicV2Model(hit.run))
      }
      if (!WF_RE.test(wf)) return sendError(res, 400, 'id de run inválido')
      if (parts.length === 5 && !NODE_RE.test(parts[4])) return sendError(res, 400, 'id de nó inválido')
      const hit = (await index.scanAll(now())).byWf.get(wf)
      if (!hit) return sendError(res, 404, `run ${wf} não encontrada`)
      const run = hit.entry
      let model
      try {
        model = await modelOf(run)
      } catch (e) {
        if (e instanceof GraphWatchError) return sendError(res, 404, e.message)
        throw e
      }
      if (parts.length === 3) {
        // status/stop/planOnly vêm do RunResumo (run.*): é o mesmo cálculo da lista, com o stallMinutes da config.
        const cur = hit.run
        const superseded = run.wf !== cur.wf
        return send(res, 200, {
          ...model,
          status: run.status,
          stop: run.stop,
          planOnly: run.planOnly,
          project: run.project,
          generation: run.generation || 'legacy',
          goal: run.goal,
          mode: run.mode,
          economy: run.economy,
          lastActivity: run.mtime,
          runId: cur.runId,
          runKey: cur.key,
          current: cur.wf,
          supersededBy: superseded ? cur.wf : null,
          runDir: cur.runDir,
        })
      }
      const id = parts[4]
      const node = model.nodes.find((n) => n.id === id)
      const polish = POLISH_API_RE.exec(id)
      if (!node && !PSEUDO.has(id) && !polish) return sendError(res, 404, `nó ${id} não existe em ${wf}`)
      const agents = agentsOfNode(run.dir, id, 20) // polish-<k> → rótulo polish:<k> (graph-watch)
      if (node) return send(res, 200, { wf, ...node, pseudo: false, agents })
      const title = polish ? `polimento ${Number(polish[1])}` : id
      return send(res, 200, { wf, id, pseudo: true, title, state: pseudoState(agents), agents })
    }
    return sendError(res, 404, 'não encontrado')
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) sendError(res, 500, `erro inesperado: ${String((e && e.message) || e)}`)
      else res.end()
    })
  })

  server.stateDir = stateDir
  server.organizePath = organizePath
  server.closePanel = () =>
    new Promise((resolve) => {
      stopTimers()
      for (const c of clients) c.end()
      clients.clear()
      server.close(() => resolve())
      if (server.closeAllConnections) server.closeAllConnections()
    })

  return server
}

// ── Instância única ──

// 'graph-watch' | 'outro' | 'livre'
export function probePanel(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/api/health', timeout: timeoutMs, headers: { Host: `${HOST}:${port}` } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => {
        if (body.length < 4096) body += d
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).app === 'graph-watch' ? 'graph-watch' : 'outro')
        } catch {
          resolve('outro')
        }
      })
      res.on('error', () => resolve('outro'))
    })
    req.on('timeout', () => {
      req.destroy()
      resolve('outro')
    })
    req.on('error', (e) => resolve(e.code === 'ECONNREFUSED' ? 'livre' : 'outro'))
  })
}

// Garante um painel em 127.0.0.1:<port>. Se já há um graph-watch lá, reaproveita (reused: true, não sobe
// nada). Porta com outro programa → GraphWatchError(5). `port: 0` pula o probe e usa porta efêmera
// (testes). Devolve { url, port, reused, server?, close() }.
export async function ensurePanel(opts = {}) {
  const { port = DEFAULT_PORT, projectsDir = path.join(os.homedir(), '.claude', 'projects'), pollMs, heartbeatMs, configPath, stateDir, organizePath, graphRunsHome, home, now, canDelete } = opts
  const reused = (p) => ({ url: `http://${HOST}:${p}`, port: p, reused: true, close: async () => {} })
  const busy = () => new GraphWatchError(5, `porta ${port} ocupada por outro programa; use --port <N> ou GRAPH_ENG_PORT=<N>`)
  if (port !== 0) {
    const who = await probePanel(port)
    if (who === 'graph-watch') return reused(port)
    if (who === 'outro') throw busy()
  }
  const server = createPanelServer({ projectsDir, pollMs, heartbeatMs, configPath, stateDir, organizePath, graphRunsHome, home, now, canDelete })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, HOST, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      // corrida: outro graph-watch pode ter subido entre o probe e o listen
      if (port !== 0 && (await probePanel(port)) === 'graph-watch') return reused(port)
      throw busy()
    }
    throw new GraphWatchError(5, `não consegui abrir 127.0.0.1:${port}: ${e.message}`)
  }
  const real = server.address().port
  return { url: `http://${HOST}:${real}`, port: real, reused: false, server, close: () => server.closePanel() }
}

// Abre a URL no browser padrão; falha em silêncio (o link já foi impresso).
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* sem browser: ignora */
  }
}
