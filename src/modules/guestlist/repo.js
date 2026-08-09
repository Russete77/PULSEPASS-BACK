// modules/guestlist/repo.js — acesso a dados do domínio Guest list (AZList).
import { supabase, findProfileByEmail } from '../../config/supabase.js';

export { findProfileByEmail };

export const rpcIncrementHit = (code) =>
  supabase.rpc('increment_promoter_hit', { p_code: code });

// Portal do promoter (self-service)
export const rpcPromoterDashboard = (userId) =>
  supabase.rpc('promoter_dashboard', { p_user: userId });

export const findPromoterOwned = (promoterId, userId) =>
  supabase.from('promoters').select('id, name, profile_id').eq('id', promoterId).eq('profile_id', userId).maybeSingle();

export const findPromoterByCodePublic = (code) =>
  supabase.from('promoters')
    .select('id, name, code, list_type, free_until, event_id, events ( title, slug, venue_name, city, state, starts_at, status )')
    .eq('code', code).maybeSingle();

export const findPromoterByCode = (code) =>
  supabase.from('promoters').select('id, event_id').eq('code', code).maybeSingle();

export const insertGuest = (row) =>
  supabase.from('guests').insert(row).select('id, name, status, party_size').single();

export const insertPromoter = (row) =>
  supabase.from('promoters').insert(row).select().single();

export const rpcEventPromoters = (eventId) =>
  supabase.rpc('event_promoters', { p_event: eventId });

export const findPromoter = (promoterId) =>
  supabase.from('promoters').select('id, name, event_id').eq('id', promoterId).maybeSingle();

export const findGuestsByPromoter = (promoterId) =>
  supabase.from('guests')
    .select('id, name, email, phone, status, created_at, checked_in_at, party_size, checked_in_count')
    .eq('promoter_id', promoterId).order('created_at', { ascending: false });

// Todos os convidados de um EVENTO (para a portaria — busca + check-in).
// created_at: a hora da inscrição diz se a lista encheu cedo ou em cima da
// hora. list_type é da LISTA (vip, aniversário), não da pessoa — e é o que
// sustenta o filtro "aniversariantes" sem inventar data de nascimento.
export const findGuestsByEvent = (eventId) =>
  supabase.from('guests')
    .select('id, name, email, phone, status, created_at, checked_in_at, party_size, checked_in_count, promoters(name, list_type)')
    .eq('event_id', eventId).order('name', { ascending: true });

export const findGuestForCheckin = (guestId) =>
  supabase.from('guests').select('id, event_id, status').eq('id', guestId).maybeSingle();

/**
 * Check-in com acompanhantes: recebe QUANTAS pessoas estão entrando agora.
 * Idempotência aqui seria errada — chegar mais gente do mesmo convite é um
 * evento novo, não repetição da mesma chamada.
 */
export const rpcGuestCheckIn = (guestId, people = 1) =>
  supabase.rpc('guest_check_in', { p_guest: guestId, p_people: people });

export const rpcGuestlistSummary = (eventId) =>
  supabase.rpc('guestlist_summary', { p_event: eventId });

export const updateGuestCheckedIn = (guestId) =>
  supabase.from('guests')
    .update({ status: 'checked_in', checked_in_at: new Date().toISOString() })
    .eq('id', guestId);

export const updateCommissionPaid = (promoterId, paidAt) =>
  supabase.from('promoters')
    .update({ commission_paid_at: paidAt })
    .eq('id', promoterId).select('id, commission_paid_at').single();
