// modules/catalog/repo.js — acesso a dados do catálogo público de eventos.
import { supabase } from '../../config/supabase.js';

export function findPublishedEvents({ city, q, category } = {}) {
  // Só eventos futuros (com 6h de folga p/ o que rola "hoje à noite" — não some no meio da festa).
  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  let query = supabase
    .from('events')
    .select('id, title, slug, description, cover_url, venue_name, city, state, starts_at, status, category, latitude, longitude, ticket_tiers(price_cents, quantity_total, quantity_sold, status)')
    .eq('status', 'published')
    .gte('starts_at', cutoff)
    .order('starts_at', { ascending: true });
  if (city) query = query.eq('city', city);
  if (category) query = query.eq('category', category);
  // Busca também pelo nome da casa: quem digita "Audio" quer o lugar, não um
  // evento cujo título por acaso tenha essa palavra.
  if (q) query = query.or(`title.ilike.%${q}%,venue_name.ilike.%${q}%`);
  return query;
}

/** Cidades com evento publicado no futuro — alimenta o seletor da vitrine. */
export const findPublishedCities = () =>
  supabase.from('events')
    .select('city, state')
    .eq('status', 'published')
    .gte('starts_at', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString());

export const findPublishedEventBySlug = (slug) =>
  supabase.from('events')
    .select('id, title, slug, description, cover_url, venue_name, address, city, state, starts_at, ends_at, status, organization_id, service_fee_bps, category, latitude, longitude, organizations(name, slug, logo_url, brand_color, site_url, instagram)')
    .eq('slug', slug).eq('status', 'published').maybeSingle();

export const findTiersByEvent = (eventId) =>
  supabase.from('ticket_tiers')
    .select('id, name, description, price_cents, half_price_cents, quantity_total, quantity_sold, max_per_order, status, position, sales_start, sales_end')
    .eq('event_id', eventId).order('position', { ascending: true });
