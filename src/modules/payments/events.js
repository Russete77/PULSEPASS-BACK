// modules/payments/events.js — o que cada evento do Asaas SIGNIFICA para nós.
//
// O webhook do Asaas manda 28 tipos de evento. Tratar só os de "pago" abre um
// golpe trivial: comprar, entrar na festa e pedir estorno pelo painel do Asaas
// — o evento chegava e era ignorado, e o ingresso continuava válido.
//
// Aqui cada evento é traduzido para UMA intenção de negócio. Eventos
// informativos (boleto visualizado, fatura aberta) são explicitamente
// ignorados: registrar que foram recebidos e não fazer nada é diferente de
// esquecer que existem.
//
// Doc: https://docs.asaas.com/docs/webhook-para-cobrancas

/** Dinheiro entrou e o cliente pode receber o produto. */
export const CONFIRMA = new Set([
  'PAYMENT_CONFIRMED',                 // pago; saldo ainda indisponível na conta Asaas
  'PAYMENT_RECEIVED',                  // pago e saldo disponível
  'PAYMENT_APPROVED_BY_RISK_ANALYSIS', // liberado após análise manual
  'PAYMENT_ANTICIPATED',               // antecipado: para nós, dinheiro entrou
]);

/**
 * Dinheiro VOLTOU para o cliente. Ingresso tem que morrer e saldo tem que
 * sair — mesmo que isso deixe a carteira negativa.
 */
export const REVERTE = new Map([
  ['PAYMENT_REFUNDED', 'refund'],
  ['PAYMENT_PARTIALLY_REFUNDED', 'refund_partial'],
  ['PAYMENT_CHARGEBACK_REQUESTED', 'chargeback'],
  ['PAYMENT_AWAITING_CHARGEBACK_REVERSAL', 'chargeback'],
  ['PAYMENT_REPROVED_BY_RISK_ANALYSIS', 'risk_reproved'],
  ['PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'capture_refused'],
  ['PAYMENT_DELETED', 'deleted'],
  ['PAYMENT_RECEIVED_IN_CASH_UNDONE', 'cash_undone'],
]);

/**
 * Ainda não é dinheiro nem é perda: fica pendente e NÃO emite ingresso.
 * O erro clássico aqui é tratar "aguardando análise" como pago.
 */
export const AGUARDA = new Set([
  'PAYMENT_AWAITING_RISK_ANALYSIS',
  'PAYMENT_AUTHORIZED',        // autorizado, ainda precisa de captura
  'PAYMENT_REFUND_IN_PROGRESS',
]);

/** Precisa da atenção de alguém, mas não muda ingresso nem saldo. */
export const ALERTA = new Set([
  'PAYMENT_CHARGEBACK_DISPUTE',
  'PAYMENT_REFUND_DENIED',
  'PAYMENT_DUNNING_REQUESTED',
  'PAYMENT_DUNNING_RECEIVED',
  'PAYMENT_SPLIT_CANCELLED',     // o repasse à produtora foi cancelado
  'PAYMENT_SPLIT_DIVERGENCE_BLOCK',
  'PAYMENT_OVERDUE',
]);

/** Informativo. Registrado e ignorado de propósito. */
export const INFORMATIVO = new Set([
  'PAYMENT_CREATED',
  'PAYMENT_UPDATED',
  'PAYMENT_RESTORED',
  'PAYMENT_BANK_SLIP_VIEWED',
  'PAYMENT_CHECKOUT_VIEWED',
  'PAYMENT_BANK_SLIP_CANCELLED',
]);

/**
 * Classifica o evento.
 * @returns {{ tipo: 'confirma'|'reverte'|'aguarda'|'alerta'|'informativo'|'desconhecido', motivo?: string }}
 */
export function classificar(eventType) {
  if (CONFIRMA.has(eventType)) return { tipo: 'confirma' };
  if (REVERTE.has(eventType)) return { tipo: 'reverte', motivo: REVERTE.get(eventType) };
  if (AGUARDA.has(eventType)) return { tipo: 'aguarda' };
  if (ALERTA.has(eventType)) return { tipo: 'alerta' };
  if (INFORMATIVO.has(eventType)) return { tipo: 'informativo' };
  // Evento novo do provedor: registra e alerta em vez de ignorar em silêncio.
  return { tipo: 'desconhecido' };
}

/**
 * A recarga de carteira só é creditada quando o dinheiro está DISPONÍVEL.
 *
 * A doc do Asaas separa PAYMENT_CONFIRMED (pago, saldo indisponível) de
 * PAYMENT_RECEIVED (saldo na conta), e no cartão de crédito essa distância é
 * de ~32 dias. Creditar a carteira no CONFIRMED faria o cliente beber hoje um
 * dinheiro que a produtora só recebe no mês seguinte — e, em caso de
 * chargeback, o produto já foi consumido.
 *
 * No Pix os dois eventos são praticamente simultâneos, então nada muda.
 * Ingresso é diferente: emite no CONFIRMED, porque o cliente pagou e precisa
 * entrar hoje.
 */
export function podeCreditarCarteira(eventType, billingType) {
  if (eventType === 'PAYMENT_RECEIVED') return true;
  if (eventType !== 'PAYMENT_CONFIRMED') return false;
  // Pix e dinheiro: confirmado já é recebido.
  return ['PIX', 'UNDEFINED', undefined, null].includes(billingType);
}
