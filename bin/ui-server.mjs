// Painel web ao vivo do graph-watch (`graph-watch ui`) — docs/specs/2026-09-27-painel-web.md.
// Node puro (node:http), sem dependências. Rotas de escrita: PUT /api/config (grava
// ~/.claude/graph-eng/config.json, via bin/config.mjs), POST /api/org/* (grava <stateDir>/organize.json,
// via bin/organize.mjs; o apagar remove só .graph-runs/<run>/ depois da contenção) e POST /api/requests*
// (grava <stateDir>/requests/, via bin/requests.mjs). A leitura da lista e do pedido também grava `falhou`
// num pedido vencido e faz a limpeza da fila (C2). Nenhum outro endpoint escreve em disco. Spec das ações e da organização: docs/specs/2026-09-28-acoes-no-painel.md (C1, C10, C11).
//
// ── Contrato HTTP (consumido pela página em bin/ui/) ──
// Todas as respostas: só GET (outro método → 405 com `Allow: GET`), exceto /api/config, que aceita GET e
// PUT (outro método → 405 com `Allow: GET, PUT`), e /api/org/*, que só aceita POST (`Allow: POST`). A
// tabela de escrita é conferida antes da regra GET-only. `Host` precisa ser `127.0.0.1:<porta>` ou
// `localhost:<porta>` (senão 403, contra DNS rebinding), em toda rota e todo método. Sem CORS: nenhuma
// resposta leva `Access-Control-Allow-*`, e o preflight `OPTIONS` recebe 405. Erros vêm como JSON
// `{ "error": "<texto pt-BR>" }`.
//
// GET /api/health → 200 `{ "app": "graph-watch", "version": 1 }`
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
// POST /api/requests (C10 A1) `{ type: resume|stop|rerun-node, wf, node?, dependents? }` → 202 `{ request }`.
//   Mesmas travas, na mesma ordem; 400 `{ error: "pedido inválido", fields }` (tabela estrita, D3 §3.4) · 404
//   run · 409 execução superada · 404 nó (no Modelo da execução atual) · 409 com o `why` da regra C12 (o mesmo
//   texto de `actions.*.why`), ou "Já existe um pedido aberto para esta run." numa corrida · 500 E/S. O resto
//   do pedido (runKey, runId, project, ownerSession, runDir absoluto e contido, dependentsList, route) sai
//   do índice, nunca do cliente.
// GET /api/requests/:id (A2) → 200 `{ request }` | 400 id fora do REQ_RE | 404.
// POST /api/requests/:id/cancel (A3) `{}` → 200 `{ request }` em `falhou` ("cancelado no painel", ou
//   "descartado no painel: a sessão não confirmou" num aceito há ≥ 2 min) | travas | 400 | 404 | 409.
// GET /api/listeners (A4) → 200 `{ sessions: [{ session: 8 chars, project, wf, beatAt: ms, until: ms|null }],
//   staleMs: 30000 }`, só os ouvintes vivos.
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
//                                       // bin/graph-watch.mjs: silêncio > N min sem sessão dona ouvindo,
//                                       // ou 3·N com ela, cota/interrupção na hora); senão rodando.
//     stop: null | { reason, text, idleSec }, // motivo da parada (spec C6), null fora de "parada?"
//     planOnly: boolean,                // só o planner rodou; nunca conta como parada
//     goal: string | null,              // goal do plano
//     done: number, total: number,      // nós com estado pronto* / todos os nós
//     round: number,
//     mtime: number,                    // ms epoch da última atividade (journal ou transcrição)
//     nodes: [{ id, state, round }],    // faixa-miniatura da barra lateral, na ordem do modelo
//     pending: "resume" | "stop" | "rerun-node" | null, // tipo do pedido aberto da key (C2)
//     listening: bool,                  // há ouvinte vivo no projeto da execução atual (C3)
//   }
//
// GET /api/runs/:wf → 200 Modelo | 400 (wf fora de /^wf_[A-Za-z0-9_-]+$/) | 404 (fora da lista de runs)
//   Modelo = saída de buildModel (bin/graph-watch.mjs) +
//     { project, goal, mode, lastActivity } e `status` trocado pelo status do RunResumo (considera a
//     atividade das transcrições). Campos de buildModel: wf, round, status, idleSec, warns: string[],
//     nodes: [{ id, kind, risk, round, title, deps: string[], explore, state, reps, closed,
//               orphan?, running?: { label, agentId } }],
//     critic: null | { r, running, gaps?, done? }, synth: "aguardando" | "rodando" | "pronto", spent,
//     estimate?/ceiling? (só quando há economy). Campos do I5 (C11): runId, runKey, current (wf da execução
//     atual da key), supersededBy (= current num wf superado, senão null), runDir (com ~ | null), requests
//     (os 5 pedidos mais novos da key), actions = { listening: { project, owner, ownerPresence, sessions },
//     open: Pedido | null, resume, stop, rerun, copy: { resume, stop, rerun } } com Pode = { ok, why, route? },
//     e em cada nó `rerun: Pode` (só a regra do nó e a da execução superada: a página combina com
//     `actions.rerun` ou `actions.copy.rerun`) e `dependents: id[]` (fecho transitivo pelos deps). `mode` e `economy` vêm das linhas `Mode:` e `Economy:` do
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
import {
  LISTEN_FRESH_MS,
  NODE_RE,
  REQ_RE,
  REQUEST_TYPES,
  WF_RE,
  createExclusive,
  createRequest,
  discardAccepted,
  isAcceptedDiscardable,
  isOpenForRunKey,
  listRequests,
  listenersDir,
  ownerPathInfo,
  ownerPresence,
  projectListening,
  readListeners,
  readRequest,
  reapExpired,
  requestsDir,
  writeJsonAtomic,
} from './requests.mjs'
import { variantOf } from './ui/graph-layout.mjs'

export const DEFAULT_PORT = 4477
const HOST = '127.0.0.1'
const RUNS_LIMIT = 50
// WF_RE e NODE_RE vêm de bin/requests.mjs (C2: uma regex em um lugar só, com os literais de sempre).
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

// ── Fila de pedidos (C2, C10 A1-A4) ──
const CLEANUP_EVERY_MS = 60000 // a limpeza da fila roda no máximo 1 vez por minuto (C2)
const FINAL_KEEP_MS = 7 * 24 * 3600 * 1000 // pedido final some depois de 7 dias…
const FINAL_KEEP_MAX = 200 // …ou quando passa dos 200 finais mais novos
const LISTENER_KEEP_MS = 24 * 3600 * 1000 // sinal de vida com beatAt de mais de 24 h some
const REQUESTS_IN_MODEL = 5 // o Modelo leva os 5 pedidos mais novos da key (C11)

// Remove os pedidos finais velhos (com .json, .claim, .final e .seen-*) e os sinais de vida parados há mais
// de 24 h. Nunca toca pedido pendente ou aceito.
function cleanupState(stateDir, now) {
  const finals = listRequests(stateDir)
    .filter((r) => r.state === 'feito' || r.state === 'falhou')
    .reverse()
  const drop = new Set()
  finals.forEach((r, i) => {
    const t = Date.parse(r.finishedAt || r.updatedAt || r.createdAt)
    if (i >= FINAL_KEEP_MAX || (!Number.isNaN(t) && now - t > FINAL_KEEP_MS)) drop.add(r.id)
  })
  if (drop.size) {
    const dir = requestsDir(stateDir)
    for (const f of fs.readdirSync(dir)) {
      if (drop.has(f.split('.')[0])) fs.rmSync(path.join(dir, f), { force: true })
    }
  }
  for (const l of readListeners(stateDir, now)) {
    const t = Date.parse(l.beatAt)
    if (Number.isNaN(t) || now - t <= LISTENER_KEEP_MS) continue
    const file = path.join(listenersDir(stateDir), `${l.session}.${l.pid}.json`)
    if (path.dirname(file) === listenersDir(stateDir)) fs.rmSync(file, { force: true })
  }
}

// Corpo da A1 (D3 §3.4, tabela CHECK estrita, no padrão do validateConfig): → { ok, value } | { ok, errors }.
// Pares + Object.fromEntries: um campo `__proto__` vira erro, e o protótipo fica intacto.
function validateRequestBody(body) {
  const errors = []
  const type = body.type
  const isRerun = type === 'rerun-node'
  for (const k of Object.keys(body)) {
    if (!['type', 'wf', 'node', 'dependents'].includes(k)) errors.push([k, 'campo desconhecido'])
  }
  if (!REQUEST_TYPES.includes(type)) errors.push(['type', 'use resume, stop ou rerun-node'])
  if (typeof body.wf !== 'string' || !WF_RE.test(body.wf)) errors.push(['wf', 'id de run inválido'])
  if (Object.hasOwn(body, 'node')) {
    if (REQUEST_TYPES.includes(type) && !isRerun) errors.push(['node', 'só vale em rerun-node'])
    else if (typeof body.node !== 'string' || !NODE_RE.test(body.node)) errors.push(['node', 'id de nó inválido'])
    else if (PSEUDO.has(body.node) || POLISH_API_RE.test(body.node)) errors.push(['node', 'plano, revisão, crítica, polimento e síntese não se refazem'])
  } else if (isRerun) errors.push(['node', 'obrigatório em rerun-node'])
  if (Object.hasOwn(body, 'dependents')) {
    if (REQUEST_TYPES.includes(type) && !isRerun) errors.push(['dependents', 'só vale em rerun-node'])
    else if (typeof body.dependents !== 'boolean') errors.push(['dependents', 'use true ou false'])
  }
  if (errors.length) return { ok: false, errors: Object.fromEntries(errors) }
  const value = { type, wf: body.wf }
  if (isRerun) {
    value.node = body.node
    value.dependents = body.dependents === true
  }
  return { ok: true, value }
}

// Fecho transitivo dos descendentes de `id` pelos `deps` do Modelo, na ordem do Modelo (C11, D3 §3.5).
function dependentsOf(nodes, id) {
  const out = new Set()
  let grew = true
  while (grew) {
    grew = false
    for (const n of nodes) {
      if (out.has(n.id) || n.id === id) continue
      if ((n.deps || []).some((d) => d === id || out.has(d))) {
        out.add(n.id)
        grew = true
      }
    }
  }
  return nodes.filter((n) => out.has(n.id)).map((n) => n.id)
}

// ── Regra das ações (C12). A primeira condição que falha dá o `why`; o mesmo texto volta como 409 na A1. ──
const WHY = {
  superseded: (cur) => `Essa execução foi retomada em ${cur}; use a mais nova.`,
  resumeDone: 'A run já terminou. Para rodar um nó de novo, use Refazer nó.',
  planOnly: 'Só o plano rodou. Aprovar o plano pelo painel está fora do escopo: aprove no chat.',
  resumeRunning: 'A run está rodando. Pare antes de retomar.',
  noRunDir: 'Essa run não tem pasta em .graph-runs; sem ela não há de onde retomar.',
  open: 'Espere o pedido aberto terminar, ou cancele.',
  openDone: 'A retomada foi feita; esperando a execução nova aparecer.',
  rearm: 'A sessão dona está rearmando a escuta do painel; tente de novo em instantes.',
  noProjectResume: 'Nenhuma sessão ouvindo este projeto. Use Copiar para retomar e cole numa sessão do Claude Code.',
  stopDone: 'A run já terminou.',
  stopGone: 'A sessão que rodou a run acabou; não há o que parar. Use Retomar.',
  stopNoOwner: 'A sessão que rodou esta run não está ouvindo. Use Copiar para parar e cole nela.',
  rerunRunning: 'A run está rodando. Pare antes de refazer um nó.',
  noProjectRerun: 'Nenhuma sessão ouvindo este projeto. Use Copiar para refazer e cole numa sessão do Claude Code.',
  nodeEmpty: 'Esse nó ainda não rodou.',
  nodeSkipped: 'Esse nó foi pulado. Refaça o nó de que ele depende, com os dependentes.',
  nodeRunning: 'Esse nó está rodando.',
  nodeGap: 'Nó da crítica: use Retomar, que a crítica decide de novo.',
  raced: 'Já existe um pedido aberto para esta run.',
}
const ok = (route) => (route ? { ok: true, why: null, route } : { ok: true, why: null })
const no = (why) => ({ ok: false, why })

// `ctx` = { wf, current, status, planOnly, stopReason, hasRunDir, open, presence, listenProject }. `status` é
// o do RunResumo: `rodando`, `terminado` ou a parada (`parada?`, e `parada` quando o C6 tirar o `?`).
export function runActions(ctx) {
  const { wf, current, status, planOnly, stopReason, hasRunDir, open, presence, listenProject } = ctx
  if (wf !== current) {
    const p = no(WHY.superseded(current))
    return { resume: p, stop: p, rerun: p, copy: { resume: p, stop: p, rerun: p } }
  }
  const running = status === 'rodando'
  const finished = status === 'terminado' && !planOnly
  const stopped = !running && status !== 'terminado'
  const openWhy = open ? (open.state === 'feito' ? WHY.openDone : WHY.open) : null
  // 5b (P1): numa parada que não é `interrompida`, a dona talvez ainda tenha o Workflow vivo.
  const ownerMaybeAlive = stopped && stopReason !== 'interrompida' && (presence === 'ouvindo' || presence === 'rearmando')

  const copyResume = finished ? no(WHY.resumeDone) : planOnly ? no(WHY.planOnly) : running ? no(WHY.resumeRunning) : !hasRunDir ? no(WHY.noRunDir) : ok()
  const copyStop = status === 'terminado' ? no(WHY.stopDone) : stopReason === 'sessao-encerrada' ? no(WHY.stopGone) : ok()
  const copyRerun = running ? no(WHY.rerunRunning) : planOnly ? no(WHY.planOnly) : !hasRunDir ? no(WHY.noRunDir) : ok()

  const viaListeners = (base, noProject) => {
    if (!base.ok) return base
    if (openWhy) return no(openWhy)
    if (ownerMaybeAlive) return presence === 'rearmando' ? no(WHY.rearm) : ok('owner')
    return listenProject ? ok('project') : no(noProject)
  }
  const resume = viaListeners(copyResume, WHY.noProjectResume)
  const rerun = viaListeners(copyRerun, WHY.noProjectRerun)
  const stop = !copyStop.ok ? copyStop : openWhy ? no(openWhy) : presence === 'ouvindo' ? ok('owner') : no(WHY.stopNoOwner)
  return { resume, stop, rerun, copy: { resume: copyResume, stop: copyStop, rerun: copyRerun } }
}

// Regra do nó (C12, pela variante do estado): combina com `actions.rerun` (ou `copy.rerun`) na página.
export function nodeRerun(node, { superseded, current, status }) {
  if (superseded) return no(WHY.superseded(current))
  if (node.round > 1) return no(WHY.nodeGap)
  const v = variantOf(node.state)
  if (v === 'done' || v === 'fail') return ok()
  if (v === 'skipped') return no(WHY.nodeSkipped)
  if (v === 'running') return status === 'rodando' ? no(WHY.nodeRunning) : ok()
  return no(WHY.nodeEmpty)
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

// Rotas de escrita da fila (C10 A1/A3): `/api/requests` e `/api/requests/:id/cancel`, só POST. A leitura
// `/api/requests/:id` segue a regra GET-only.
function requestRoute(pathname) {
  const parts = pathname.split('/').slice(1)
  if (parts[0] !== 'api' || parts[1] !== 'requests') return null
  if (parts.length === 2) return { kind: 'create' }
  if (parts.length === 4 && parts[3] === 'cancel') return { kind: 'cancel', id: parts[2] }
  return null
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
      // ele veio de uma (bin/graph-resume.mjs). Sem a linha, o wf foi disparado do zero.
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
// a lista sai sem organização. `stateDir` (C1) é de onde saem a fila de pedidos e os sinais de vida (C2,
// C3); sem ele, a lista sai sem pedidos e sem ouvinte, e o `computeStop` roda sem presença da dona.
export function createRunIndex(projectsDir, { configPath = defaultConfigPath(), organizePath = null, graphRunsHome = null, home = os.homedir(), stateDir = null } = {}) {
  const runsHome = graphRunsHome || path.join(home, '.claude', 'graph-runs')
  const cache = new Map() // dir → { sig, head | null, info? }
  const projects = new Map() // dir → nome do projeto (fixo depois de achado pelo cwd)
  let lastCleanup = -Infinity

  // Fila e sinais de vida, lidos uma vez por scan (C11). Pedido vencido vira `falhou` aqui (C2, "o
  // servidor, na leitura"), e a limpeza roda no máximo 1 vez por minuto. Tolerante: E/S ruim vira vazio.
  function loadState(now) {
    if (!stateDir) return { listeners: [], requests: [] }
    try {
      reapExpired(stateDir, now)
    } catch {
      /* corrida com um accept/done concorrente: fica para o próximo scan */
    }
    if (now - lastCleanup >= CLEANUP_EVERY_MS) {
      lastCleanup = now
      try {
        cleanupState(stateDir, now)
      } catch {
        /* limpeza é melhor esforço */
      }
    }
    let listeners = []
    let requests = []
    try {
      listeners = readListeners(stateDir, now)
    } catch {
      /* pasta ilegível: ninguém ouvindo */
    }
    try {
      requests = listRequests(stateDir)
    } catch {
      /* fila ilegível: nenhum pedido */
    }
    return { listeners, requests }
  }

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
      stallMinutes = resolveConfig({ stored: readConfig(configPath).stored }).config.stallMinutes
    } catch {
      /* config ilegível: mantém o padrão, como o resto da leitura de config */
    }
    const { org, warnings: orgWarnings } = loadOrg()
    const { listeners, requests } = loadState(now)
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
        // Dona da execução (C3): a sessão sai do caminho do wf; sem a forma <slug>/<sessão uuid>/…, `nunca`.
        const own = ownerPathInfo(c.dir)
        const ownerSession = own ? own.session : null
        const presence = ownerSession ? ownerPresence(listeners, ownerSession, now) : 'nunca'
        const ownerListening = presence === 'ouvindo'
        const ownerGone = presence === 'encerrada'
        // C6: a mesma regra e o mesmo motivo do `buildModel` (bin/graph-watch.mjs), sem janela fixa —
        // `openAgentIds`/`planOnly` vêm cacheados (dependem só do journal); `computeStop` é recalculado
        // a cada scan porque depende de `now`, da presença da dona e da cauda dos agentes ainda abertos.
        const stop = computeStop({ runDir: c.dir, openAgentIds: info.openAgentIds, terminated: info.terminated, planOnly: info.planOnly, now, stallMinutes, ownerListening, ownerGone })
        const status = info.terminated || info.planOnly ? 'terminado' : stop ? 'parada?' : 'rodando'
        entries.push({
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
          ownerSession,
          presence,
          ownerListening,
          ownerGone,
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
      // Pedidos da key (C2/C11): os mais novos primeiro; o aberto é no máximo 1, medido contra a execução
      // atual (o representante). `listening` = há ouvinte vivo no projeto da execução atual (C12).
      const reqs = requests.filter((r) => r.runKey === key).reverse()
      const openReq = reqs.find((r) => isOpenForRunKey(r, key, run.wf, now)) || null
      const live = listeners.filter((l) => l.live && l.project === rep.slug)
      run.reqs = reqs
      run.openReq = openReq
      run.pending = openReq ? openReq.type : null
      run.listening = projectListening(listeners, rep.slug)
      run.listenCount = live.length
      // O sinal SSE de cada wf da key muda quando muda um pedido, o ouvinte ou a execução atual (C11).
      const extra = JSON.stringify([run.wf, reqs.slice(0, 5).map((r) => [r.id, r.state, r.updatedAt]), run.listening, rep.presence])
      for (const e of entries) e.sig = `${e.sig}|${extra}`
      runs.push(run)
      for (const e of entries) byWf.set(e.wf, { entry: e, run })
    }
    const rank = (r) => (r.status === 'rodando' ? 0 : 1)
    runs.sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime)
    return { runs, org, warnings: [...orgWarnings, ...dupWarnings], dupWarnings, latest, byWf, listeners, requests }
  }

  async function scan(now = Date.now()) {
    return (await scanAll(now)).runs
  }

  return { scan, scanAll }
}

// RunResumo público: os campos internos (`dir`, `sig`, o cabeçalho, o caminho cru e as execuções) ficam
// no servidor.
const publicRun = ({ dir, sig, mode, economy, effort, ceiling, slug, runDirRaw, entries, ownerSession, presence, ownerListening, ownerGone, stallMinutes, reqs, openReq, listenCount, ...r }) => r

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
// global, padrão ~/.claude/graph-runs; só a contenção do apagar o usa), `now` (relógio) e `canDelete(key)
// → motivo | null` (o gancho que o I5 liga à fila de pedidos: um pedido aberto impede o apagar; passado
// pelo chamador, ele substitui essa regra).
export function createPanelServer(opts = {}) {
  const { projectsDir, pollMs = 1000, heartbeatMs = 15000, home = os.homedir(), now = () => Date.now() } = opts
  const configPath = opts.configPath ?? defaultConfigPath()
  const stateDir = opts.stateDir ?? (opts.configPath ? path.dirname(opts.configPath) : defaultStateDir())
  const organizePath = opts.organizePath ?? path.join(stateDir, 'organize.json')
  const graphRunsHome = opts.graphRunsHome ?? path.join(home, '.claude', 'graph-runs')
  const index = createRunIndex(projectsDir, { configPath, organizePath, graphRunsHome, home, stateDir })
  // C10: com um pedido aberto na key (pendente, aceito, ou resume/rerun feito esperando o wf novo), o
  // apagar dá 409. O `run` vem do snapshot de quem chama.
  const canDelete = opts.canDelete ?? ((key, run) => (run && run.openReq ? 'Espere o pedido em andamento terminar.' : null))
  const clients = new Set()
  let pollTimer = null
  let beatTimer = null
  let lastListSig = null
  let runSigs = new Map()
  let polling = false

  const listBody = (snap) => ({ runs: snap.runs.map(publicRun), org: publicOrg(snap.org, snap.warnings) })
  const listSig = (snap) =>
    JSON.stringify([
      snap.runs.map((r) => [r.key, r.wf, r.status, r.done, r.total, r.goal, r.round, r.nodes, r.pinned, r.group, r.archived, r.planOnly, r.wfs, r.runDir, r.pending, r.listening]),
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

  // O8: nome digitado idêntico ao `name` (sem trim nem caixa); rodando → 409; pedido aberto → 409 (gancho
  // do I5); pasta fora da contenção → 409 sem remover nada; a pasta sai antes de gravar a lista.
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

  // ── Pedidos, ouvinte e artefatos (C10 A1-A6, C11, C12) ──

  // O Modelo da execução, com o relógio, o limiar e a presença da dona que a lista usou (C6).
  const modelOf = (entry) =>
    buildModel({
      runDir: entry.dir,
      mode: entry.mode,
      economy: entry.economy,
      effort: entry.effort,
      ceiling: entry.ceiling,
      now: now(),
      stallMinutes: entry.stallMinutes,
      ownerListening: entry.ownerListening,
      ownerGone: entry.ownerGone,
    })

  // `actions` do Modelo (C11/C12) para o wf `entry`, sempre medido contra a execução atual da key.
  function actionsFor(entry, run) {
    const a = runActions({
      wf: entry.wf,
      current: run.wf,
      status: run.status,
      planOnly: run.planOnly,
      stopReason: run.stop ? run.stop.reason : null,
      hasRunDir: whereOf(run).ok,
      open: run.openReq,
      presence: run.presence,
      listenProject: run.listening,
    })
    const listening = { project: run.listening, owner: run.presence === 'ouvindo', ownerPresence: run.presence, sessions: run.listenCount }
    return { listening, open: run.openReq, ...a }
  }

  // A1: o cliente manda só { type, wf, node?, dependents? }; o resto sai do índice e do Modelo da execução
  // atual. Ordem: travas → 400 fields → 404 run → 409 superada → 404 nó → 409 C12 → 500.
  async function postRequest(req, res, host) {
    const body = await readJsonBody(req, res, host)
    if (body === null) return
    const checked = validateRequestBody(body)
    if (!checked.ok) return send(res, 400, { error: 'pedido inválido', fields: checked.errors })
    const v = checked.value
    const snap = await index.scanAll(now())
    const hit = snap.byWf.get(v.wf)
    if (!hit) return sendError(res, 404, `run ${v.wf} não encontrada`)
    const { run, entry } = hit
    if (run.wf !== v.wf) return sendError(res, 409, WHY.superseded(run.wf))
    let model
    try {
      model = await modelOf(entry)
    } catch (e) {
      if (e instanceof GraphWatchError) return sendError(res, 404, e.message)
      throw e
    }
    let node = null
    if (v.type === 'rerun-node') {
      node = model.nodes.find((n) => n.id === v.node)
      if (!node) return sendError(res, 404, `nó ${v.node} não existe em ${v.wf}`)
    }
    const actions = actionsFor(entry, run)
    const pode = v.type === 'resume' ? actions.resume : v.type === 'stop' ? actions.stop : actions.rerun
    if (!pode.ok) return sendError(res, 409, pode.why)
    if (node) {
      const nr = nodeRerun(node, { superseded: false, current: run.wf, status: run.status })
      if (!nr.ok) return sendError(res, 409, nr.why)
    }
    const where = whereOf(run)
    const own = ownerPathInfo(entry.dir)
    // Daqui até gravar não há `await`: a releitura da fila fecha a corrida de dois cliques no mesmo servidor.
    let fresh = []
    try {
      fresh = listRequests(stateDir)
    } catch {
      /* fila ilegível: a gravação abaixo diz se o disco responde */
    }
    if (fresh.some((r) => isOpenForRunKey(r, run.key, run.wf, now()))) return sendError(res, 409, WHY.raced)
    let created
    try {
      created = createRequest(
        stateDir,
        {
          type: v.type,
          wf: run.wf,
          node: node ? node.id : null,
          dependents: !!v.dependents,
          dependentsList: node && v.dependents ? dependentsOf(model.nodes, node.id) : [],
          runKey: run.key,
          runId: run.runId,
          project: run.slug,
          ownerSession: own ? own.session : null,
          runDir: where.ok ? where.real : null,
          route: pode.route,
        },
        now(),
      )
    } catch (e) {
      return sendError(res, 500, `não consegui gravar o pedido: ${e.message}`)
    }
    tick() // a página e as outras abas veem o pedido na hora
    return send(res, 202, { request: created })
  }

  // A2: leitura do pedido; o vencido vira `falhou` antes (C2).
  function getRequest(res, id) {
    if (!REQ_RE.test(id)) return sendError(res, 400, 'id de pedido inválido')
    try {
      reapExpired(stateDir, now())
    } catch {
      /* corrida com a sessão: a leitura abaixo mostra o que estiver gravado */
    }
    const request = readRequest(stateDir, id)
    if (!request) return sendError(res, 404, 'pedido não encontrado')
    return send(res, 200, { request })
  }

  // A3: cancelar um pendente (o `.claim` do painel tira o pedido da corrida do accept) ou descartar um aceito
  // há ≥ 2 min. O `.final` O_EXCL garante que só uma gravação final vence (C2).
  async function cancelRequest(req, res, host, id) {
    const body = await readJsonBody(req, res, host)
    if (body === null) return
    if (!REQ_RE.test(id)) return sendError(res, 400, 'id de pedido inválido')
    const extra = Object.keys(body)
    if (extra.length) return send(res, 400, { error: 'pedido inválido', fields: Object.fromEntries(extra.map((k) => [k, 'campo desconhecido'])) })
    const t = now()
    try {
      reapExpired(stateDir, t)
    } catch {
      /* segue com o que estiver gravado */
    }
    const cur = readRequest(stateDir, id)
    if (!cur) return sendError(res, 404, 'pedido não encontrado')
    const justAccepted = 'a sessão acabou de aceitar; dá para descartar depois de 2 min'
    const closed = 'o pedido já foi encerrado'
    try {
      if (cur.state === 'pendente') {
        const at = new Date(t).toISOString()
        const dir = requestsDir(stateDir)
        if (!createExclusive(path.join(dir, `${id}.claim`), { by: 'painel', pid: process.pid, at })) return sendError(res, 409, justAccepted)
        if (!createExclusive(path.join(dir, `${id}.final`), { by: 'painel', state: 'falhou', at })) return sendError(res, 409, closed)
        const base = readRequest(stateDir, id) || cur
        const request = {
          ...base,
          state: 'falhou',
          reason: 'cancelado no painel',
          finishedAt: at,
          updatedAt: at,
          history: [...(base.history || []), { state: 'falhou', at, by: 'painel' }],
        }
        writeJsonAtomic(path.join(dir, `${id}.json`), request)
        tick()
        return send(res, 200, { request })
      }
      if (cur.state === 'aceito') {
        if (!isAcceptedDiscardable(cur, t)) return sendError(res, 409, justAccepted)
        const r = discardAccepted(stateDir, id, { reason: 'descartado no painel: a sessão não confirmou', now: t })
        if (!r.ok) return sendError(res, 409, closed)
        tick()
        return send(res, 200, { request: r.req })
      }
    } catch (e) {
      return sendError(res, 500, `não consegui gravar o pedido: ${e.message}`)
    }
    return sendError(res, 409, closed)
  }

  // A4: só os ouvintes vivos, com a sessão encurtada (a página usa `actions.listening` do Modelo).
  function getListeners(res) {
    let ls = []
    try {
      ls = readListeners(stateDir, now())
    } catch {
      /* ninguém ouvindo */
    }
    const ms = (iso) => {
      const t = Date.parse(iso || '')
      return Number.isNaN(t) ? null : t
    }
    const sessions = ls.filter((l) => l.live).map((l) => ({ session: String(l.session).slice(0, 8), project: l.project ?? null, wf: l.wf ?? null, beatAt: ms(l.beatAt), until: ms(l.listenUntil) }))
    return send(res, 200, { sessions, staleMs: LISTEN_FRESH_MS })
  }

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
    // tabela de escrita antes da regra GET-only (C10); OPTIONS continua 405
    const rq = requestRoute(pathname)
    if (rq) {
      if (req.method !== 'POST') return sendError(res, 405, 'use POST', { Allow: 'POST' })
      return rq.kind === 'create' ? postRequest(req, res, host) : cancelRequest(req, res, host, rq.id)
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
    if (parts.length === 2 && parts[1] === 'health') return send(res, 200, { app: 'graph-watch', version: 1 })
    if (parts.length === 2 && parts[1] === 'events') return openEvents(req, res)
    if (parts.length === 2 && parts[1] === 'runs') return send(res, 200, listBody(await index.scanAll(now())))
    if (parts.length === 2 && parts[1] === 'listeners') return getListeners(res)
    if (parts.length === 3 && parts[1] === 'requests') return getRequest(res, parts[2])

    if (parts[1] === 'runs' && parts[3] === 'artifacts' && (parts.length === 4 || parts.length === 5)) {
      if (!WF_RE.test(parts[2])) return sendError(res, 400, 'id de run inválido')
      return getArtifacts(res, parts[2], parts[4])
    }

    if (parts[1] === 'runs' && (parts.length === 3 || (parts.length === 5 && parts[3] === 'nodes'))) {
      const wf = parts[2]
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
        // status/stop/planOnly vêm do RunResumo (run.*): é o mesmo cálculo, com o stallMinutes da config e a
        // presença da dona. Os campos do I5 (C11) medem as ações contra a execução atual da key.
        const cur = hit.run
        const superseded = run.wf !== cur.wf
        const nodes = model.nodes.map((n) => ({ ...n, rerun: nodeRerun(n, { superseded, current: cur.wf, status: run.status }), dependents: dependentsOf(model.nodes, n.id) }))
        return send(res, 200, {
          ...model,
          nodes,
          status: run.status,
          stop: run.stop,
          planOnly: run.planOnly,
          project: run.project,
          goal: run.goal,
          mode: run.mode,
          economy: run.economy,
          lastActivity: run.mtime,
          runId: cur.runId,
          runKey: cur.key,
          current: cur.wf,
          supersededBy: superseded ? cur.wf : null,
          runDir: cur.runDir,
          requests: cur.reqs.slice(0, REQUESTS_IN_MODEL),
          actions: actionsFor(run, cur),
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
