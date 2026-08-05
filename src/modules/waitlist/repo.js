// modules/waitlist/repo.js — ÚNICA camada que fala com o banco neste módulo.
import { supabase } from '../../config/supabase.js';

export const rpcJoin = ({ eventId, tierId, email, name, quantity, profileId }) =>
  supabase.rpc('waitlist_join', {
    p_event: eventId, p_tier: tierId ?? null, p_email: email,
    p_name: name ?? null, p_quantity: quantity ?? 1, p_profile: profileId ?? null,
  });

export const rpcInvite = ({ tierId, slots, ttlMinutes = 60 }) =>
  supabase.rpc('waitlist_invite', {
    p_tier: tierId, p_slots: slots ?? null, p_ttl_minutes: ttlMinutes,
  });

export const rpcExpireInvites = () => supabase.rpc('waitlist_expire_invites');

export const findEventTier = (slug, tierId) =>
  supabase.from('ticket_tiers')
    .select('id, name, price_cents, quantity_total, quantity_sold, status, events!inner(id, slug, title, status)')
    .eq('id', tierId).eq('events.slug', slug).maybeSingle();

export const listByEvent = (eventId) =>
  supabase.from('waitlist')
    .select('id, email, name, quantity, status, position, invited_at, invite_expires_at, created_at, ticket_tiers(name)')
    .eq('event_id', eventId).order('position', { ascending: true }).limit(500);

/** Lotes de um pedido — usado ao devolver estoque (reembolso/expiração). */
export const findOrderTiers = (orderId) =>
  supabase.from('order_items').select('ticket_tier_id, quantity').eq('order_id', orderId);
