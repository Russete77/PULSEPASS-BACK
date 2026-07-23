// modules/payments/service.js — processamento de webhooks de pagamento.
// Idempotente por event.id; reconcilia valor no caminho de pedido.
import * as orders from '../orders/service.js';
import * as wallet from '../cashless/service.js';
import * as repo from './repo.js';

/**
 * Processa um evento do Asaas. PAYMENT_CONFIRMED / PAYMENT_RECEIVED confirmam
 * pagamento (recarga OU compra de ingresso). Idempotente por evt.id.
 */
export async function processAsaasEvent(evt) {
  const eventId = evt?.id ?? null;
  const eventType = evt?.event ?? null;
  const payment = evt?.payment ?? {};
  const paidValueCents = payment?.value != null ? Math.round(Number(payment.value) * 100) : null;

  if (eventId) {
    const { data: existing } = await repo.findWebhookEvent(eventId);
    if (existing?.processed) return { duplicated: true };
  }

  await repo.upsertWebhookEvent({
    provider: 'asaas', event_id: eventId, event_type: eventType, payload: evt, processed: false,
  });

  if (['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'].includes(eventType) && payment.id) {
    // Tenta creditar recarga; se não for recarga, confirma pedido de ingresso.
    const topup = await wallet.creditTopupByPaymentId(payment.id, paidValueCents);
    if (!topup?.found) {
      await orders.markOrderPaidByPaymentId(payment.id, paidValueCents);
    }
  }

  if (eventId) await repo.markWebhookProcessed(eventId);
  return { ok: true };
}
