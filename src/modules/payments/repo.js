// modules/payments/repo.js — dedup de eventos de webhook (idempotência).
import { supabase } from '../../config/supabase.js';

export const findWebhookEvent = (eventId) =>
  supabase.from('webhook_events').select('id, processed').eq('event_id', eventId).maybeSingle();

export const upsertWebhookEvent = (row) =>
  supabase.from('webhook_events').upsert(row, { onConflict: 'event_id' });

export const markWebhookProcessed = (eventId) =>
  supabase.from('webhook_events').update({ processed: true }).eq('event_id', eventId);

// ── Reconciliação (rede de segurança quando o webhook não chega) ──

/** Pedidos pendentes que já têm cobrança criada e já deveriam ter resolvido. */
export const findPendingOrdersWithPayment = (desde, limit = 200) =>
  supabase.from('orders')
    .select('id, asaas_payment_id, total_cents, created_at')
    .eq('status', 'pending')
    .not('asaas_payment_id', 'is', null)
    .lt('created_at', desde)
    .order('created_at', { ascending: true })
    .limit(limit);

export const findPendingTopupsWithPayment = (desde, limit = 200) =>
  supabase.from('wallet_topups')
    .select('id, asaas_payment_id, amount_cents, created_at')
    .eq('status', 'pending')
    .not('asaas_payment_id', 'is', null)
    .lt('created_at', desde)
    .order('created_at', { ascending: true })
    .limit(limit);

/** Último evento recebido — silêncio longo sugere fila interrompida. */
export const findLastWebhookEvent = () =>
  supabase.from('webhook_events')
    .select('event_id, event_type, created_at')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

export const countPendingPayments = async () => {
  const { count } = await supabase.from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending').not('asaas_payment_id', 'is', null);
  return { count: count ?? 0 };
};
