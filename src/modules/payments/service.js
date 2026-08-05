// modules/payments/service.js — processamento de webhooks de pagamento.
//
// Idempotente por event.id (a entrega do Asaas é "at least once", então o mesmo
// evento chega repetido de vez em quando).
//
// Antes este arquivo só sabia dizer "pagou". Todo o resto do vocabulário do
// provedor — estorno, chargeback, reprovação de risco — chegava e era jogado
// fora, deixando o ingresso válido depois de o dinheiro voltar. Agora cada
// evento é classificado e tratado.
import * as orders from '../orders/service.js';
import * as wallet from '../cashless/service.js';
import { logger } from '../../lib/logger.js';
import { classificar, podeCreditarCarteira } from './events.js';
import * as repo from './repo.js';

export async function processAsaasEvent(evt) {
  const eventId = evt?.id ?? null;
  const eventType = evt?.event ?? null;
  const payment = evt?.payment ?? {};
  const paymentId = payment?.id ?? null;
  const billingType = payment?.billingType ?? null;
  const paidValueCents = payment?.value != null ? Math.round(Number(payment.value) * 100) : null;

  if (eventId) {
    const { data: existing } = await repo.findWebhookEvent(eventId);
    if (existing?.processed) return { duplicated: true };
  }

  await repo.upsertWebhookEvent({
    provider: 'asaas', event_id: eventId, event_type: eventType, payload: evt, processed: false,
  });

  const { tipo, motivo } = classificar(eventType);
  let resultado = { tipo };

  try {
    if (!paymentId) {
      // Evento sem cobrança (ex.: teste do painel). Registrado e encerrado.
      resultado = { tipo: 'sem_pagamento' };
    } else if (tipo === 'confirma') {
      resultado = await confirmar({ eventType, paymentId, billingType, paidValueCents });
    } else if (tipo === 'reverte') {
      resultado = await reverter({ paymentId, motivo, eventType });
    } else if (tipo === 'aguarda') {
      // Pendente de propósito: não emite ingresso nem credita saldo. O erro
      // clássico é tratar "aguardando análise de risco" como pagamento.
      logger.info('webhook: pagamento aguardando definição', { eventType, paymentId });
    } else if (tipo === 'alerta') {
      logger.warn('webhook: evento que precisa de atenção humana', { eventType, paymentId });
    } else if (tipo === 'desconhecido') {
      // Provedor criou evento novo. Fica registrado e visível em vez de sumir.
      logger.warn('webhook: evento NÃO MAPEADO do Asaas', { eventType, paymentId });
    }
  } catch (e) {
    // Não marca como processado: o Asaas reenvia (entrega at least once) e a
    // próxima tentativa encontra o estado real. Engolir o erro aqui perderia
    // o evento para sempre.
    logger.error('webhook: falha ao processar', { eventType, paymentId, error: e.message });
    throw e;
  }

  if (eventId) await repo.markWebhookProcessed(eventId);
  return { ok: true, ...resultado };
}

/** Dinheiro entrou: credita recarga OU confirma pedido de ingresso. */
async function confirmar({ eventType, paymentId, billingType, paidValueCents }) {
  // Recarga primeiro: o id de cobrança pertence a uma das duas coisas.
  const encontrouRecarga = await wallet.topupExists(paymentId);

  if (encontrouRecarga) {
    if (!podeCreditarCarteira(eventType, billingType)) {
      // Cartão confirmado mas ainda não disponível: espera o PAYMENT_RECEIVED.
      logger.info('webhook: recarga aguardando liquidação', { paymentId, billingType, eventType });
      return { tipo: 'confirma', recarga: 'aguardando_liquidacao' };
    }
    const r = await wallet.creditTopupByPaymentId(paymentId, paidValueCents);
    return { tipo: 'confirma', recarga: r?.credited ? 'creditada' : 'sem_efeito' };
  }

  const r = await orders.markOrderPaidByPaymentId(paymentId, paidValueCents);
  return { tipo: 'confirma', pedido: r?.found ? 'confirmado' : 'nao_encontrado' };
}

/**
 * Dinheiro voltou ao cliente. Ingresso morre e saldo sai.
 * Ordem importa: tenta recarga e pedido, porque um paymentId serve a um só.
 */
async function reverter({ paymentId, motivo, eventType }) {
  const recarga = await wallet.reverseTopupByPaymentId(paymentId, motivo, eventType);
  if (recarga?.found) {
    if (recarga.wallet_blocked) {
      logger.warn('webhook: estorno deixou carteira NEGATIVA — bloqueada', {
        paymentId, motivo, debt_cents: recarga.debt_cents,
      });
    }
    return { tipo: 'reverte', recarga };
  }

  const pedido = await orders.reverseOrderByPaymentId(paymentId, motivo, eventType);
  if (pedido?.found && pedido.fraud_case) {
    logger.warn('webhook: pagamento revertido de ingresso JÁ UTILIZADO — caso de fraude aberto', {
      paymentId, motivo, tickets_already_used: pedido.tickets_already_used,
    });
  }
  return { tipo: 'reverte', pedido };
}
