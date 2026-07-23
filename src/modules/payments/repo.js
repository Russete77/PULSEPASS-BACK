// modules/payments/repo.js — dedup de eventos de webhook (idempotência).
import { supabase } from '../../config/supabase.js';

export const findWebhookEvent = (eventId) =>
  supabase.from('webhook_events').select('id, processed').eq('event_id', eventId).maybeSingle();

export const upsertWebhookEvent = (row) =>
  supabase.from('webhook_events').upsert(row, { onConflict: 'event_id' });

export const markWebhookProcessed = (eventId) =>
  supabase.from('webhook_events').update({ processed: true }).eq('event_id', eventId);
