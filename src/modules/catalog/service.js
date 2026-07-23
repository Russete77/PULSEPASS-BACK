// modules/catalog/service.js — regra do catálogo público.
import { notFound } from '../../utils/ApiError.js';
import * as repo from './repo.js';

/** Lista eventos publicados (catálogo). Filtros opcionais: city, q. */
export async function listEvents({ city, q } = {}) {
  const { data, error } = await repo.findPublishedEvents({ city, q });
  if (error) throw error;
  // Deriva "a partir de" (menor preço à venda) e disponibilidade para o catálogo.
  return (data ?? []).map((ev) => {
    const tiers = ev.ticket_tiers ?? [];
    const onSale = tiers.filter((t) => t.status === 'on_sale' && (t.quantity_total - t.quantity_sold) > 0);
    const prices = (onSale.length ? onSale : tiers).map((t) => t.price_cents).filter((p) => p != null);
    const soldOut = tiers.length > 0 && onSale.length === 0;
    const { ticket_tiers, ...rest } = ev;
    return {
      ...rest,
      min_price_cents: prices.length ? Math.min(...prices) : null,
      sold_out: soldOut,
    };
  });
}

/** Detalhe de um evento por slug, incluindo lotes à venda. */
export async function getEventBySlug(slug) {
  const { data: event, error } = await repo.findPublishedEventBySlug(slug);
  if (error) throw error;
  if (!event) throw notFound('Evento não encontrado');

  const { data: tiers, error: tErr } = await repo.findTiersByEvent(event.id);
  if (tErr) throw tErr;

  const now = Date.now();
  return {
    ...event,
    tiers: tiers.map((t) => {
      const available = Math.max(0, t.quantity_total - t.quantity_sold);
      // Estado de venda por janela de datas (virada automática de lote).
      let sale_state = 'on_sale';
      if (t.status === 'sold_out' || available <= 0) sale_state = 'sold_out';
      else if (t.sales_start && now < Date.parse(t.sales_start)) sale_state = 'upcoming';
      else if (t.sales_end && now > Date.parse(t.sales_end)) sale_state = 'ended';
      return { ...t, available, sale_state };
    }),
  };
}
