// Ambiente dos processos filhos (agentes e gate): o do runner menos os segredos do graph-eng.
// A chave do OpenRouter e qualquer GRAPH_ENG_* ficam só no runner; o executor tem escrita e não pode vê-las.
const SECRET_KEYS = new Set(['OPENROUTER_API_KEY'])
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !SECRET_KEYS.has(key) && !key.startsWith('GRAPH_ENG_')))
}
