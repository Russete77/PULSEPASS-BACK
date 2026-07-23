// modules/cashless/service.js — regra do domínio Cashless (carteira + bar).
// Fachada do módulo: outros módulos importam funções daqui, nunca o repo.
import { notFound, badRequest, conflict } from '../../utils/ApiError.js';
import { externalRef } from '../../utils/codes.js';
import * as asaas from '../payments/provider.js';
import { assertEventAccess } from '../identity/access.js';
import * as repo from './repo.js';

// ═══════════════════════ CARTEIRA ═══════════════════════

/** Garante (e retorna) a carteira do usuário para um evento (ou geral). */
export async function getOrCreateWallet(userId, eventId = null) {
  const { data: existing } = await repo.findWallet(userId, eventId ?? null);
  if (existing) return existing;
  const { data, error } = await repo.insertWallet(userId, eventId ?? null);
  if (error) throw error;
  return data;
}

export async function getWallet({ user, eventId }) {
  const wallet = await getOrCreateWallet(user.id, eventId ?? null);
  const { data: txs, error } = await repo.findWalletTransactions(wallet.id);
  if (error) throw error;
  return { ...wallet, transactions: txs };
}

export async function createTopup({
  user, profile, eventId, amountCents,
  paymentMethod = 'pix', installmentCount, card, holderInfo, remoteIp,
  idempotencyKey = null,
}) {
  if (!Number.isInteger(amountCents) || amountCents < 500)
    throw badRequest('Valor mínimo de recarga é R$ 5,00');
  if (paymentMethod === 'card' && (!card || !holderInfo))
    throw badRequest('Pagamento no cartão exige dados do cartão e do titular');

  // Replay idempotente: mesma Idempotency-Key → devolve a recarga já criada.
  if (idempotencyKey) {
    const { data: existing } = await repo.findTopupByClientRequestId(idempotencyKey, user.id);
    if (existing) {
      return {
        id: existing.id, amount_cents: existing.amount_cents, status: existing.status,
        payment_method: existing.pix_payload ? 'pix' : 'card', idempotent_replay: true,
        ...(existing.pix_payload
          ? { pix: { payload: existing.pix_payload, qr_base64: existing.pix_qr_base64, expiration: existing.pix_expiration } }
          : {}),
      };
    }
  }

  const ref = externalRef('top');
  const value = Number((amountCents / 100).toFixed(2));
  const customer = await asaas.createCustomer({
    name: profile?.full_name || user.email || 'Cliente PulsePass',
    cpfCnpj: profile?.cpf || undefined,
    email: user.email,
    externalReference: user.id,
  });
  const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // ── CARTÃO ──
  if (paymentMethod === 'card') {
    const tok = await asaas.tokenizeCard({
      customer: customer.id,
      creditCard: {
        holderName: card.holderName, number: card.number,
        expiryMonth: card.expiryMonth, expiryYear: card.expiryYear, ccv: card.ccv,
      },
      creditCardHolderInfo: holderInfo,
      remoteIp,
    });
    const payment = await asaas.createCardPayment({
      customer: customer.id, value, dueDate,
      description: 'Recarga carteira PulsePass', externalReference: ref,
      installmentCount, remoteIp, creditCardToken: tok.creditCardToken,
    });

    const { data: topup, error } = await repo.insertTopup({
      profile_id: user.id, event_id: eventId ?? null, amount_cents: amountCents,
      status: 'pending', asaas_payment_id: payment.id, external_reference: ref,
      client_request_id: idempotencyKey ?? null,
    });
    if (error) throw error;

    let credited = false;
    if (['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'].includes(payment.status)) {
      await creditTopupByPaymentId(payment.id).catch(() => {});
      credited = true;
    }
    return {
      id: topup.id, amount_cents: topup.amount_cents,
      status: credited ? 'paid' : 'pending', payment_method: 'card',
      card: { brand: tok.creditCardBrand, last4: tok.creditCardNumber },
    };
  }

  // ── PIX (default) ──
  const payment = await asaas.createPixPayment({
    customer: customer.id, value, dueDate,
    description: 'Recarga carteira PulsePass', externalReference: ref,
  });
  const qr = await asaas.getPixQrCode(payment.id);

  const { data: topup, error } = await repo.insertTopup({
    profile_id: user.id, event_id: eventId ?? null, amount_cents: amountCents,
    status: 'pending', asaas_payment_id: payment.id, external_reference: ref,
    pix_payload: qr.payload, pix_qr_base64: qr.encodedImage, pix_expiration: qr.expirationDate,
    client_request_id: idempotencyKey ?? null,
  });
  if (error) throw error;

  return {
    id: topup.id, amount_cents: topup.amount_cents, status: topup.status,
    payment_method: 'pix',
    pix: { payload: qr.payload, qr_base64: qr.encodedImage, expiration: qr.expirationDate },
  };
}

export async function getTopup({ user, topupId }) {
  const { data, error } = await repo.findTopupForUser(topupId, user.id);
  if (error) throw error;
  if (!data) throw notFound('Recarga não encontrada');
  return data;
}

/** Estorna o saldo restante da carteira do usuário. */
export async function refundWallet({ user, eventId }) {
  const wallet = await getOrCreateWallet(user.id, eventId ?? null);
  const { data, error } = await repo.rpcRefundWallet(wallet.id);
  if (error) throw error;
  return { refunded_cents: data ?? 0 };
}

/** Credita a recarga (idempotente + atômico) via RPC transacional. */
export async function creditTopupByPaymentId(asaasPaymentId, paidValueCents = null) {
  const { data, error } = await repo.rpcCreditTopup(asaasPaymentId, paidValueCents);
  if (error) throw error;
  return data;
}

// ═══════════════════════ BAR ═══════════════════════

function mapBarError(message) {
  if (!message) return null;
  if (message.includes('EVENT_UNAVAILABLE')) return notFound('Evento indisponível');
  if (message.includes('INVALID_QTY')) return badRequest('Quantidade inválida');
  if (message.includes('ITEM_INVALID')) return badRequest('Item inválido para o evento');
  if (message.includes('ITEM_UNAVAILABLE')) return conflict('Item indisponível');
  if (message.includes('INSUFFICIENT_FUNDS')) return conflict('Saldo insuficiente. Recarregue a carteira.');
  if (message.includes('OUT_OF_STOCK')) return conflict('Item sem estoque');
  return null;
}

// ═══════════════════════ CARDÁPIO (gestão pelo produtor) ═══════════════════════

export async function listAdminMenu({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.adminListMenu(eventId);
  if (error) throw error;
  return data ?? [];
}

export async function createMenuItem({ user, eventId, item }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.adminInsertMenuItem({
    event_id: eventId, name: item.name, category: item.category || 'Geral',
    price_cents: Math.max(0, Math.round(Number(item.price_cents) || 0)),
    description: item.description || null,
    available: item.available !== false,
    stock: item.stock != null ? Math.max(0, Math.round(Number(item.stock))) : null,
    position: item.position ?? 0,
  });
  if (error) throw error;
  return data;
}

async function assertMenuItemAccess(user, itemId) {
  const { data: mi } = await repo.findMenuItemEvent(itemId);
  if (!mi) throw notFound('Item não encontrado');
  await assertEventAccess(user.id, mi.event_id, ['manager']);
}

export async function updateMenuItem({ user, itemId, patch }) {
  await assertMenuItemAccess(user, itemId);
  const clean = {};
  if (patch.name != null) clean.name = patch.name;
  if (patch.category != null) clean.category = patch.category;
  if (patch.price_cents != null) clean.price_cents = Math.max(0, Math.round(Number(patch.price_cents)));
  if (patch.description !== undefined) clean.description = patch.description || null;
  if (patch.available != null) clean.available = Boolean(patch.available);
  if (patch.stock !== undefined) clean.stock = patch.stock != null ? Math.max(0, Math.round(Number(patch.stock))) : null;
  const { data, error } = await repo.adminUpdateMenuItem(itemId, clean);
  if (error) throw error;
  return data;
}

export async function deleteMenuItem({ user, itemId }) {
  await assertMenuItemAccess(user, itemId);
  const { error } = await repo.adminDeleteMenuItem(itemId);
  if (error) throw error;
  return { removed: true };
}

/** Cardápio disponível de um evento (público). */
export async function getMenu(eventSlug) {
  const { data: event } = await repo.findEventBySlug(eventSlug);
  if (!event || event.status !== 'published') throw notFound('Evento indisponível');

  const { data, error } = await repo.findAvailableMenu(event.id);
  if (error) throw error;
  return { event_id: event.id, items: data };
}

/** Pedido no bar pago com saldo (cliente no app). */
export async function createBarOrder({ user, eventSlug, items, idempotencyKey = null }) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Pedido sem itens');
  const { data: event } = await repo.findEventBySlug(eventSlug);
  if (!event || event.status !== 'published') throw notFound('Evento indisponível');
  return placeBarOrder({ buyerId: user.id, eventId: event.id, items, idempotencyKey });
}

/** Núcleo reutilizável (cliente no app e PDV do operador). */
export async function placeBarOrder({ buyerId, eventId, items, idempotencyKey = null, operatorId = null }) {
  const { data, error } = await repo.rpcPlaceBarOrder({ buyerId, eventId, items, idempotencyKey });
  if (error) {
    const mapped = mapBarError(error.message);
    if (mapped) throw mapped;
    throw error;
  }
  // Registra o operador do PDV (metadado, best-effort; nunca em replay).
  if (operatorId && data.order_id && !data.idempotent_replay) {
    try { await repo.setBarOrderOperator(data.order_id, operatorId); } catch { /* best-effort */ }
  }
  return {
    id: data.order_id, status: 'paid', total_cents: data.total_cents,
    pickup_code: data.pickup_code, balance_cents: data.balance_cents, items: data.items,
  };
}

/** Integridade do ledger — carteiras com saldo divergente da soma das transações. */
export async function getLedgerCheck({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.findLedgerDrift(eventId);
  if (error) throw error;
  return { ok: (data ?? []).length === 0, drifts: data ?? [] };
}

/** Fechamento de caixa — total processado por operador de PDV. */
export async function getCashierReport({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.rpcCashierReport(eventId);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    operator_id: r.operator_id, name: r.operator_name, email: r.operator_email,
    orders: Number(r.orders), total_cents: Number(r.total_cents),
  }));
}

export async function listMyBarOrders({ user, limit = 50, offset = 0 }) {
  const { data, error } = await repo.findMyBarOrders(user.id, { limit, offset });
  if (error) throw error;
  return data;
}
