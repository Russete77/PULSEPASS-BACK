// modules/door/repo.js — acesso a dados da porta/PDV (check-in, manifesto, menu, lookup).
import { supabase, findProfileByEmail } from '../../config/supabase.js';

const CHECKIN_COLS =
  'id, code, qr_secret, status, event_id, checked_in_at, profiles:owner_id(full_name), ticket_tiers(name)';

export function findTicketForCheckin({ id, secret, code }) {
  let q = supabase.from('tickets').select(CHECKIN_COLS);
  q = id ? q.eq('id', id).eq('qr_secret', secret) : q.eq('code', code);
  return q.maybeSingle();
}

/** Busca por id só (p/ validar o token rotativo, cuja assinatura usa o qr_secret do banco). */
export const findTicketById = (id) =>
  supabase.from('tickets').select(CHECKIN_COLS).eq('id', id).maybeSingle();

/** Consome o ingresso de forma idempotente (só muda se status='valid'). */
export const consumeTicketRow = (ticketId, when) =>
  supabase.from('tickets')
    .update({ status: 'used', checked_in_at: when })
    .eq('id', ticketId).eq('status', 'valid').select('id').maybeSingle();

export const findManifestTickets = (eventId) =>
  supabase.from('tickets')
    .select('id, code, qr_secret, status, checked_in_at, profiles:owner_id(full_name), ticket_tiers(name)')
    .eq('event_id', eventId).order('code', { ascending: true });

export const findEventMenu = (eventId) =>
  supabase.from('menu_items')
    .select('id, name, category, price_cents, available, position')
    .eq('event_id', eventId).eq('available', true).order('position', { ascending: true });

// Carteira ÚNICA (0027): o saldo do cliente vive na carteira geral (event_id null).
export const findWalletBalance = (profileId) =>
  supabase.from('wallets').select('balance_cents')
    .eq('profile_id', profileId).is('event_id', null).maybeSingle();

// (legado — não usar; mantido só p/ compat se algo referenciar)
export const findWalletBalanceByEvent = (profileId, eventId) =>
  supabase.from('wallets').select('balance_cents')
    .eq('profile_id', profileId).eq('event_id', eventId).maybeSingle();

export { findProfileByEmail };
