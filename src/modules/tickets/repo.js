// modules/tickets/repo.js — ÚNICA camada que fala com o banco neste módulo.
// Retorna as promises do supabase ({ data, error }); o service trata erro/regra.
import { supabase, findProfileByEmail } from '../../config/supabase.js';

const LIST_COLS = `
  id, code, status, holder_name, checked_in_at, created_at,
  events ( id, title, slug, cover_url, venue_name, city, state, starts_at ),
  ticket_tiers ( name )
`;

const DETAIL_COLS = `
  id, code, qr_secret, status, holder_name, checked_in_at, created_at,
  events ( id, title, slug, venue_name, city, state, starts_at ),
  ticket_tiers ( name )
`;

export const findMyTickets = (userId, { limit, offset }) =>
  supabase.from('tickets').select(LIST_COLS)
    .eq('owner_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

export const findMyTicketById = (userId, ticketId) =>
  supabase.from('tickets').select(DETAIL_COLS)
    .eq('id', ticketId).eq('owner_id', userId).maybeSingle();

export const findOwnedTicket = (userId, ticketId) =>
  supabase.from('tickets').select('id, owner_id, status')
    .eq('id', ticketId).eq('owner_id', userId).maybeSingle();

export const insertTransfer = (row) =>
  supabase.from('ticket_transfers').insert(row).select().single();

export const setTicketOwner = (ticketId, ownerId) =>
  supabase.from('tickets').update({ owner_id: ownerId, holder_name: null }).eq('id', ticketId);

export { findProfileByEmail };
