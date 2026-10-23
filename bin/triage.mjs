// Triagem heurística da tarefa (pura, sem rede): escolhe o tier do fluxo adaptativo.
// O tier base é fast e cada sinal só sobe. Sinal duro sobe o piso (floor), que o classificador opcional nunca rebaixa;
// sinal brando (5 a 7 arquivos) sobe só o tier. O tamanho do texto nunca conta.
export const TIERS = Object.freeze(['fast', 'standard', 'full'])
export const tierRank = tier => TIERS.indexOf(tier)
export const maxTier = (...tiers) => tiers.reduce((a, b) => (tierRank(b) > tierRank(a) ? b : a), 'fast')

const RISK = /\b(dinheiro|money|fatura\w*|faturamento|billing|invoice\w*|pagamento\w*|payment\w*|cobran[çc]a\w*|auth\w*|autentica\w*|senha\w*|password\w*|token\w*|credencia\w*|secret\w*|segredo\w*|migra[çc][ãa]o|migra[çc][õo]es|migration\w*|permiss[ãa]o|permiss[õo]es|permission\w*|produ[çc][ãa]o|production|exclus[ãa]o de dados|apagar dados|delete data|data deletion)\b/i
// Contrato fora do texto da tarefa (docs/, spec) ou aviso de que o teste visível não basta. Contrato escrito na própria tarefa não conta.
const CONTRACTS = /(\bdocs\/|\bspecs?\/|n[ãa]o basta|not enough|isn'?t enough)/i
const INJECTION = /(pul(e|ar|em)\s+(a\s+|as\s+)?revis|skip\s+(the\s+)?review|sem\s+revis[ãa]o|n[ãa]o\s+precisa\s+(de\s+)?revis|trat(e|ar)\s+(isso\s+)?como\s+(simples|trivial|fast)|tier\s*[:=]\s*fast|ignore\s+(previous|prior|all)\s+instructions|ignore\s+as\s+instru[çc][õo]es)/i
const CRITERION = /(crit[ée]rio\s+de\s+pronto|done\s+when|acceptance|aceite|npm\s+(run\s+)?test|node\s+--test|testes?\s+passa|tests?\s+pass)/i
const LAYERS = {
  front: /\b(frontend|front-end|react|vue|angular|css|html|componente?s?|tela|telas|ui)\b/i,
  back: /\b(backend|back-end|api|endpoint\w*|rota\w*|route\w*|servidor|server)\b/i,
  db: /\b(sql|postgres\w*|mysql|mongo\w*|database|banco\s+de\s+dados|prisma|typeorm)\b/i,
  infra: /\b(docker\w*|kubernetes|k8s|terraform|deploy\w*|pipeline\s+de\s+ci|github\s+actions)\b/i,
}
// Caminho de arquivo citado: algo/arquivo.ext. Só caminhos com diretório e extensão contam, nunca nomes soltos.
const FILE_PATH = /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,6})(?=$|[\s`'"),.:;])/gim

const textOf = value => (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value))

export function triageTask({ task = '', context = '', spec = null, doneWhen = null, checks = [] } = {}) {
  const text = [task, context].map(textOf).join('\n')
  const files = new Set([...text.matchAll(FILE_PATH)].map(match => match[1]))
  const layers = Object.entries(LAYERS).filter(([, re]) => re.test(text)).map(([name]) => name)
  const hasChecks = Array.isArray(checks) && checks.length > 0
  const hasCriterion = (Array.isArray(doneWhen) && doneWhen.length > 0) || CRITERION.test(text)
  const features = {
    files: files.size, layers, hasChecks, hasCriterion, spec: Boolean(spec),
    risk: RISK.test(text), contracts: CONTRACTS.test(text) || Boolean(spec), injection: INJECTION.test(text),
  }
  const reasons = []
  let floor = 'fast'
  let soft = 'fast'
  const raise = (tier, reason) => { floor = maxTier(floor, tier); reasons.push(reason) }
  const nudge = (tier, reason) => { soft = maxTier(soft, tier); reasons.push(reason) }
  if (!hasChecks && !hasCriterion) raise('full', 'ambiguous_spec')
  if (features.risk) raise('standard', 'risk_domain')
  if (features.contracts) raise('standard', 'external_contracts')
  if (files.size >= 8) raise('full', 'many_files')
  else if (files.size >= 5) nudge('standard', 'several_files')
  if (layers.length >= 3) raise('full', 'multi_layer')
  if (features.injection) raise('standard', 'injection_suspect')
  return { tier: maxTier(floor, soft), floor, reasons, features }
}
