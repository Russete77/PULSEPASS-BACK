// modules/payments/reconcile.js — rede de segurança do webhook.
//
// Por que isto existe: a doc do Asaas diz que, após 15 falhas consecutivas de
// entrega, a FILA DE WEBHOOK É INTERROMPIDA e só volta com reativação manual
// no painel. Os eventos ficam guardados 14 dias e depois somem.
//
// Traduzindo para a operação: se a API cair no sábado à noite, ninguém mais
// recebe ingresso — e nós nem saberíamos, porque o sistema não tem como
// distinguir "nenhuma venda" de "fila travada".
//
// Aqui a gente para de depender só do webhook: consulta o provedor pelos
// pagamentos pendentes e aplica o que encontrar. É idempotente por natureza,
// porque reusa os mesmos caminhos de confirmação/reversão.
import { logger } from '../../lib/logger.js';
import * as asaas from './provider.js';
import { classificar } from './events.js';
import * as orders from '../orders/service.js';
import * as wallet from '../cashless/service.js';
import * as repo from './repo.js';

/** Status da cobrança no Asaas → o que fazer aqui. */
const STATUS_CONFIRMA = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']);
const STATUS_REVERTE = new Map([
  ['REFUNDED', 'refund'],
  ['REFUND_REQUESTED', 'refund'],
  ['CHARGEBACK_REQUESTED', 'chargeback'],
  ['CHARGEBACK_DISPUTE', 'chargeback'],
  ['AWAITING_CHARGEBACK_REVERSAL', 'chargeback'],
]);

/**
 * Varre pagamentos pendentes e sincroniza com o provedor.
 * @param {object} [opts]
 * @param {number} [opts.olderThanMinutes] só mexe no que já deveria ter resolvido
 * @param {number} [opts.limit]
 */
export async function reconcilePending({ olderThanMinutes = 10, limit = 200 } = {}) {
  const desde = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const resumo = { verificados: 0, confirmados: 0, revertidos: 0, inalterados: 0, erros: 0 };

  const { data: pedidos } = await repo.findPendingOrdersWithPayment(desde, limit);
  for (const o of pedidos ?? []) {
    resumo.verificados++;
    try {
      const pagamento = await asaas.getPayment(o.asaas_payment_id);
      const status = pagamento?.status;
      if (STATUS_CONFIRMA.has(status)) {
        await orders.markOrderPaidByPaymentId(o.asaas_payment_id, Math.round(Number(pagamento.value) * 100));
        resumo.confirmados++;
        logger.warn('reconciliação: pedido confirmado FORA do webhook', { orderId: o.id, status });
      } else if (STATUS_REVERTE.has(status)) {
        await orders.reverseOrderByPaymentId(o.asaas_payment_id, STATUS_REVERTE.get(status), 'reconciliação');
        resumo.revertidos++;
      } else {
        resumo.inalterados++;
      }
    } catch (e) {
      resumo.erros++;
      logger.warn('reconciliação: falha ao consultar pedido', { orderId: o.id, error: e.message });
    }
  }

  const { data: recargas } = await repo.findPendingTopupsWithPayment(desde, limit);
  for (const t of recargas ?? []) {
    resumo.verificados++;
    try {
      const pagamento = await asaas.getPayment(t.asaas_payment_id);
      // Recarga só é creditada com o dinheiro DISPONÍVEL (ver events.js).
      if (pagamento?.status === 'RECEIVED'
        || (pagamento?.status === 'CONFIRMED' && pagamento?.billingType === 'PIX')) {
        await wallet.creditTopupByPaymentId(t.asaas_payment_id, Math.round(Number(pagamento.value) * 100));
        resumo.confirmados++;
        logger.warn('reconciliação: recarga creditada FORA do webhook', { topupId: t.id });
      } else if (STATUS_REVERTE.has(pagamento?.status)) {
        await wallet.reverseTopupByPaymentId(t.asaas_payment_id, STATUS_REVERTE.get(pagamento.status), 'reconciliação');
        resumo.revertidos++;
      } else {
        resumo.inalterados++;
      }
    } catch (e) {
      resumo.erros++;
      logger.warn('reconciliação: falha ao consultar recarga', { topupId: t.id, error: e.message });
    }
  }

  // Confirmar algo pela reconciliação significa que o webhook NÃO chegou.
  // Isso é sintoma de fila travada e precisa ser gritado, não sussurrado.
  if (resumo.confirmados > 0 || resumo.revertidos > 0) {
    logger.error('reconciliação: webhook não entregou eventos — verifique a fila no painel do Asaas', resumo);
  }
  return resumo;
}

/**
 * Saúde da entrega de webhooks.
 * Um silêncio longo com pagamentos pendentes acumulando é a assinatura de
 * "fila interrompida" — que só volta com reativação manual no painel.
 */
export async function webhookHealth({ silenceMinutes = 30 } = {}) {
  const { data: ultimo } = await repo.findLastWebhookEvent();
  const { count: pendentes } = await repo.countPendingPayments();

  const minutosSemEvento = ultimo?.created_at
    ? Math.round((Date.now() - new Date(ultimo.created_at).getTime()) / 60_000)
    : null;

  const suspeito = pendentes > 0
    && (minutosSemEvento === null || minutosSemEvento > silenceMinutes);

  return {
    last_event_at: ultimo?.created_at ?? null,
    last_event_type: ultimo?.event_type ?? null,
    minutes_since_last_event: minutosSemEvento,
    pending_payments: pendentes ?? 0,
    healthy: !suspeito,
    hint: suspeito
      ? 'Pagamentos pendentes sem eventos recentes. A fila de webhook do Asaas pode estar interrompida (15 falhas seguidas a pausam). Verifique em Integrações → Webhooks.'
      : null,
  };
}

/** Reexporta a classificação para quem quiser inspecionar o mapa de eventos. */
export { classificar };
