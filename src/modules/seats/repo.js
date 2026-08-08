// modules/seats/repo.js — assentos marcados.
import { supabase } from '../../config/supabase.js';

/**
 * Mapa completo do evento.
 *
 * Traz o lote junto porque é ele que carrega o preço: o assento sabe onde
 * fica, o lote sabe quanto custa. Sem o join a tela precisaria de uma
 * segunda chamada só para escrever "R$ 280" ao lado do setor.
 */
export const findSeatMap = (eventId) =>
  supabase.from('event_seats')
    .select('id, setor, fileira, numero, status, col, row_idx, tier_id, held_by, held_until, ticket_tiers(id, name, price_cents, half_price_cents)')
    .eq('event_id', eventId)
    .order('setor', { ascending: true })
    .order('row_idx', { ascending: true })
    .order('col', { ascending: true });

export const rpcLiberarVencidos = (eventId) =>
  supabase.rpc('liberar_assentos_vencidos', { p_event: eventId });

export const rpcReservar = ({ eventId, seatIds, userId, minutos }) =>
  supabase.rpc('reservar_assentos', {
    p_event: eventId, p_seats: seatIds, p_user: userId, p_minutos: minutos,
  });

export const rpcSoltar = ({ eventId, userId }) =>
  supabase.rpc('soltar_assentos', { p_event: eventId, p_user: userId });

export const insertSeats = (rows) => supabase.from('event_seats').insert(rows).select('id');

export const countSeats = (eventId) =>
  supabase.from('event_seats').select('id', { count: 'exact', head: true }).eq('event_id', eventId);

export const findEventPublished = (slug) =>
  supabase.from('events').select('id, title, venue_name, status').eq('slug', slug).maybeSingle();
