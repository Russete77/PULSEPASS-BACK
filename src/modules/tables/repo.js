// modules/tables/repo.js — camarotes/mesas + reservas (AZList bottle service).
import { supabase } from '../../config/supabase.js';

// público
export const findEventBySlug = (slug) =>
  supabase.from('events').select('id, status, title').eq('slug', slug).maybeSingle();

export const findPublicTables = (eventId) =>
  supabase.from('event_tables')
    .select('id, name, area, capacity, min_spend_cents, position')
    .eq('event_id', eventId).eq('active', true).order('position', { ascending: true });

export const findTableWithEvent = (tableId) =>
  supabase.from('event_tables').select('id, event_id, active, events(status)').eq('id', tableId).maybeSingle();

export const insertReservation = (row) =>
  supabase.from('table_reservations').insert(row).select('id, name, status').single();

// admin
export const adminListTables = (eventId) =>
  supabase.from('event_tables')
    .select('id, name, area, capacity, min_spend_cents, active, position')
    .eq('event_id', eventId).order('position', { ascending: true });

export const adminInsertTable = (row) => supabase.from('event_tables').insert(row).select().single();

export const findTableEvent = (tableId) =>
  supabase.from('event_tables').select('id, event_id').eq('id', tableId).maybeSingle();

export const adminDeleteTable = (tableId) => supabase.from('event_tables').delete().eq('id', tableId);

export const adminListReservations = (eventId) =>
  supabase.from('table_reservations')
    .select('id, name, contact, party_size, status, created_at, event_tables(name, area)')
    .eq('event_id', eventId).order('created_at', { ascending: false });

export const findReservationEvent = (reservationId) =>
  supabase.from('table_reservations').select('id, event_id').eq('id', reservationId).maybeSingle();

export const updateReservationStatus = (reservationId, status) =>
  supabase.from('table_reservations').update({ status }).eq('id', reservationId).select('id, status').single();
