import { paraCentavos } from './dinheiro.mjs'
import { somarDiasUteis } from './datas.mjs'
import { converterParaBRL } from './cambio.mjs'
import { impostoDoItem } from './impostos.mjs'
import { calcularDesconto, ratear } from './descontos.mjs'
import { validarPedido } from './validacao.mjs'

// Estado inicial do benchmark: implementação pendente. Contrato em docs/contratos/ fatura.md.
export function gerarFatura(pedido) { return { id: pedido.id, emissao: pedido.emissao, vencimento: pedido.emissao, uf: pedido.uf, itens: [], subtotal: 0, desconto: 0, imposto: 0, total: 0, avisos: [] } }
