// modules/cashless/repo.js — acesso a dados do domínio Cashless (carteira + bar).
import { supabase } from '../../config/supabase.js';

// ── Carteira ──
export function findWallet(userId, eventId) {
  const base = supabase.from('wallets').select('*').eq('profile_id', userId);
  return eventId ? base.eq('event_id', eventId).maybeSingle() : base.is('event_id', null).maybeSingle();
}

export const insertWallet = (userId, eventId) =>
  supabase.from('wallets').insert({ profile_id: userId, event_id: eventId, balance_cents: 0 }).select().single();

export const findWalletTransactions = (walletId, limit = 50) =>
  supabase.from('wallet_transactions')
    .select('id, type, amount_cents, description, created_at')
    .eq('wallet_id', walletId).order('created_at', { ascending: false }).limit(limit);

// ── Recargas (top-ups) ──
export const findTopupByClientRequestId = (key, userId) =>
  supabase.from('wallet_topups').select('*').eq('client_request_id', key).eq('profile_id', userId).maybeSingle();

export const insertTopup = (row) =>
  supabase.from('wallet_topups').insert(row).select().single();

export const findTopupForUser = (topupId, userId) =>
  supabase.from('wallet_topups').select('*').eq('id', topupId).eq('profile_id', userId).maybeSingle();

export const rpcRefundWallet = (walletId) =>
  supabase.rpc('refund_wallet', { p_wallet: walletId });

/** Existe recarga com esse id de cobranca? Decide se o evento e de recarga ou de pedido. */
export const findTopupByPaymentId = (paymentId) =>
  supabase.from('wallet_topups')
    .select('id, profile_id, amount_cents, status')
    .eq('asaas_payment_id', paymentId).maybeSingle();

/** Reverte a recarga (estorno/chargeback). Pode deixar o saldo negativo. */
export const rpcReverseTopup = (paymentId, kind, reason = null) =>
  supabase.rpc('reverse_topup_payment', { p_payment_id: paymentId, p_kind: kind, p_reason: reason });

export const rpcCreditTopup = (paymentId, paidValueCents = null) =>
  supabase.rpc('credit_topup', { p_payment_id: paymentId, p_paid_value_cents: paidValueCents });

// ── Bar ──
export const findEventBySlug = (slug) =>
  supabase.from('events').select('id, status').eq('slug', slug).maybeSingle();

export const findAvailableMenu = (eventId) =>
  supabase.from('menu_items')
    .select('id, name, description, category, price_cents, image_url, available, position, stock')
    .eq('event_id', eventId).eq('available', true).order('position', { ascending: true });

// Gestão de cardápio (produtor)
export const adminListMenu = (eventId) =>
  supabase.from('menu_items')
    .select('id, name, description, category, price_cents, image_url, available, position, stock')
    .eq('event_id', eventId).order('position', { ascending: true });

export const adminInsertMenuItem = (row) => supabase.from('menu_items').insert(row).select().single();

export const findMenuItemEvent = (itemId) =>
  supabase.from('menu_items').select('id, event_id').eq('id', itemId).maybeSingle();

export const adminUpdateMenuItem = (itemId, patch) =>
  supabase.from('menu_items').update(patch).eq('id', itemId).select().single();

export const adminDeleteMenuItem = (itemId) => supabase.from('menu_items').delete().eq('id', itemId);

export const rpcPlaceBarOrder = ({ buyerId, eventId, items, idempotencyKey }) =>
  supabase.rpc('place_bar_order', {
    p_buyer: buyerId, p_event: eventId,
    p_items: items.map((i) => ({ menu_item_id: i.menu_item_id, quantity: i.quantity })),
    p_idempotency_key: idempotencyKey,
  });

export const setBarOrderOperator = (orderId, operatorId) =>
  supabase.from('bar_orders').update({ operator_id: operatorId }).eq('id', orderId);

// ── Serviço de bar: cozinha, garçom e totem ──

/** Marca a origem do pedido: qual mesa, qual praça, qual garçom. */
export const setBarOrderOrigin = (orderId, { tableId = null, waiterId = null, station = null }) =>
  supabase.from('bar_orders')
    .update({ table_id: tableId, waiter_id: waiterId, station })
    .eq('id', orderId).select().single();

/**
 * Fila da cozinha: só o que está em aberto, mais velho primeiro.
 *
 * Ordenar por chegada e não por status é o ponto. A cozinha trabalha por
 * ordem de fila, e um pedido parado em 'preparing' há dez minutos é mais
 * urgente que um 'paid' que acabou de entrar.
 */
export const findKitchenQueue = (eventId) =>
  supabase.from('bar_orders')
    .select(`
      id, status, total_cents, pickup_code, station, created_at,
      preparing_at, ready_at,
      profiles:buyer_id (full_name, email),
      event_tables:table_id (name, area),
      bar_order_items (name, quantity, notes)
    `)
    .eq('event_id', eventId)
    .in('status', ['paid', 'preparing', 'ready'])
    .order('created_at', { ascending: true })
    .limit(120);

export const rpcAdvanceBarOrder = ({ orderId, para, operadorId = null, station = null }) =>
  supabase.rpc('advance_bar_order', {
    p_order: orderId, p_para: para, p_operador: operadorId, p_station: station,
  });

export const findBarOrderEvent = (orderId) =>
  supabase.from('bar_orders').select('id, event_id, status').eq('id', orderId).maybeSingle();

/** Mesas ativas do evento — a tela do garçom. */
export const findActiveTables = (eventId) =>
  supabase.from('event_tables')
    .select('id, name, area, capacity, active, position')
    .eq('event_id', eventId).eq('active', true)
    .order('position', { ascending: true });

export const findOpenOrdersByTable = (eventId) =>
  supabase.from('bar_orders')
    .select('id, table_id, status, total_cents, created_at, bar_order_items(name, quantity)')
    .eq('event_id', eventId)
    .not('table_id', 'is', null)
    .in('status', ['paid', 'preparing', 'ready']);

export const rpcCashierReport = (eventId) => supabase.rpc('cashier_report', { p_event: eventId });

// Integridade do ledger: carteiras cujo saldo diverge da soma das transações.
export const findLedgerDrift = (eventId) =>
  supabase.from('wallet_reconciliation')
    .select('wallet_id, profile_id, balance_cents, ledger_cents, drift_cents')
    .eq('event_id', eventId).neq('drift_cents', 0);

export const findMyBarOrders = (userId, { limit = 50, offset = 0 } = {}) =>
  supabase.from('bar_orders')
    .select('id, status, total_cents, pickup_code, created_at, events(title), bar_order_items(name, quantity)')
    .eq('buyer_id', userId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
