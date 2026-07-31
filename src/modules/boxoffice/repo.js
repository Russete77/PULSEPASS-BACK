// modules/boxoffice/repo.js — ÚNICA camada que fala com o banco neste módulo.
import { supabase, findProfileByEmail } from '../../config/supabase.js';

export const rpcPlaceOrder = ({ buyerId, eventId, items }) =>
  supabase.rpc('place_order', {
    p_buyer: buyerId, p_event: eventId, p_items: items, p_idempotency_key: null,
  });

export const rpcSettleOffline = ({ orderId, operatorId, method, receivedCents, buyerName, buyerDoc, note }) =>
  supabase.rpc('settle_order_offline', {
    p_order: orderId, p_operator: operatorId, p_method: method,
    p_received_cents: receivedCents ?? null,
    p_buyer_name: buyerName ?? null, p_buyer_doc: buyerDoc ?? null, p_note: note ?? null,
  });

export const rpcReport = (eventId) => supabase.rpc('box_office_report', { p_event: eventId });

export const findEvent = (eventId) =>
  supabase.from('events').select('id, title, slug, status').eq('id', eventId).maybeSingle();

export const findTiers = (eventId) =>
  supabase.from('ticket_tiers')
    .select('id, name, price_cents, half_price_cents, quantity_total, quantity_sold, status, position')
    .eq('event_id', eventId).order('position', { ascending: true });

export const findOrderTickets = (orderId) =>
  supabase.from('tickets').select('id, code, holder_name, ticket_tiers(name)').eq('order_id', orderId);

export const listSales = (eventId, { limit = 50 } = {}) =>
  supabase.from('box_office_sales')
    .select('id, order_id, method, amount_cents, received_cents, change_cents, buyer_name, created_at, profiles:operator_id(full_name)')
    .eq('event_id', eventId).order('created_at', { ascending: false }).limit(limit);

/** Cria o usuário do comprador quando ele informa e-mail e ainda não tem conta. */
export const createBuyerUser = (email, fullName) =>
  supabase.auth.admin.createUser({
    email,
    email_confirm: true, // veio pessoalmente na bilheteria: e-mail não precisa de double opt-in
    user_metadata: { full_name: fullName || null, created_via: 'box_office' },
  });

export { findProfileByEmail };
