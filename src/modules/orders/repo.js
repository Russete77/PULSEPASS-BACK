// modules/orders/repo.js — acesso a dados do domínio Pedidos (checkout).
import { supabase } from '../../config/supabase.js';

export const findEventForCheckout = (slug) =>
  supabase.from('events')
    // fee_bps vem junto: a taxa aplicada é a da produtora (ou o padrão da
    // plataforma) e precisa ser resolvida ANTES de montar o split.
    .select('id, title, status, organization_id, organizations!inner(id, asaas_wallet_id, fee_bps)')
    .eq('slug', slug).maybeSingle();

/** Taxa efetiva da produtora: a dela, ou o padrão da plataforma. */
export const rpcEffectiveFee = (orgId) =>
  supabase.rpc('effective_fee_bps', { p_org: orgId });

export const rpcPlaceOrder = ({ buyerId, eventId, items, idempotencyKey }) =>
  supabase.rpc('place_order', {
    p_buyer: buyerId, p_event: eventId,
    p_items: items.map((i) => ({ ticket_tier_id: i.ticket_tier_id, quantity: i.quantity, half: i.half ?? false })),
    p_idempotency_key: idempotencyKey,
  });

export const rpcRedeemCoupon = (eventId, code) =>
  supabase.rpc('redeem_coupon', { p_event: eventId, p_code: code });

export const updateOrderCoupon = (orderId, patch) =>
  supabase.from('orders').update(patch).eq('id', orderId);

export const rpcAttachPayment = (args) => supabase.rpc('attach_order_payment', args);

export const cancelPendingOrder = (orderId) =>
  supabase.from('orders').update({ status: 'cancelled' }).eq('id', orderId).eq('status', 'pending');

/** Congela no pedido a taxa aplicada — historico nao muda quando a taxa muda. */
export const setOrderFee = (orderId, feeBps) =>
  supabase.from('orders').update({ platform_fee_bps: feeBps }).eq('id', orderId);

export const rpcExpirePending = () => supabase.rpc('expire_pending_orders');

export const findMyOrders = (userId, { limit = 50, offset = 0 } = {}) =>
  supabase.from('orders')
    .select('id, status, total_cents, service_fee_cents, discount_cents, created_at, paid_at, events(title, slug)')
    .eq('buyer_id', userId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);

export const findOrderForUser = (orderId, userId) =>
  supabase.from('orders').select('*, order_items(*, ticket_tiers(name))')
    .eq('id', orderId).eq('buyer_id', userId).maybeSingle();

export const findReplayOrder = (orderId) =>
  supabase.from('orders')
    .select('id, status, total_cents, event_id, pix_payload, pix_qr_base64, pix_expiration')
    .eq('id', orderId).maybeSingle();

export const findOrderByPaymentId = (paymentId) =>
  supabase.from('orders').select('id, total_cents, status').eq('asaas_payment_id', paymentId).maybeSingle();

/** Reverte o pedido (estorno/chargeback/risco): cancela ingresso, devolve estoque. */
export const rpcReverseOrder = (paymentId, kind, reason = null) =>
  supabase.rpc('reverse_order_payment', { p_payment_id: paymentId, p_kind: kind, p_reason: reason });

export const rpcConfirmOrderPayment = (paymentId) =>
  supabase.rpc('confirm_order_payment', { p_payment_id: paymentId });

export const findOrderForDelivery = (orderId) =>
  supabase.from('orders')
    // status entra aqui porque o reenvio manual só vale para pedido pago.
    .select('id, buyer_id, status, event_id, events(title), profiles:buyer_id(email)')
    .eq('id', orderId).maybeSingle();

export const findTicketsForDelivery = (orderId) =>
  supabase.from('tickets').select('id, code, qr_secret, ticket_tiers(name)').eq('order_id', orderId);

export const findOrderForRefund = (orderId, userId) =>
  supabase.from('orders').select('id, status, asaas_payment_id, total_cents')
    .eq('id', orderId).eq('buyer_id', userId).maybeSingle();

export const rpcRefundOrder = (orderId) => supabase.rpc('refund_order', { p_order: orderId });
