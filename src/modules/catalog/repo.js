// modules/catalog/repo.js — acesso a dados do catálogo público de eventos.
import { supabase } from '../../config/supabase.js';

export function findPublishedEvents({ city, q } = {}) {
  // Só eventos futuros (com 6h de folga p/ o que rola "hoje à noite" — não some no meio da festa).
  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  let query = supabase
    .from('events')
    .select('id, title, slug, description, cover_url, venue_name, city, state, starts_at, status, ticket_tiers(price_cents, quantity_total, quantity_sold, status)')
    .eq('status', 'published')
    .gte('starts_at', cutoff)
    .order('starts_at', { ascending: true });
  if (city) query = query.eq('city', city);
  if (q) query = query.ilike('title', `%${q}%`);
  return query;
}

export const findPublishedEventBySlug = (slug) =>
  supabase.from('events')
    .select('id, title, slug, description, cover_url, venue_name, address, city, state, starts_at, ends_at, status, organization_id, service_fee_bps')
    .eq('slug', slug).eq('status', 'published').maybeSingle();

export const findTiersByEvent = (eventId) =>
  supabase.from('ticket_tiers')
    .select('id, name, description, price_cents, half_price_cents, quantity_total, quantity_sold, max_per_order, status, position, sales_start, sales_end')
    .eq('event_id', eventId).order('position', { ascending: true });
