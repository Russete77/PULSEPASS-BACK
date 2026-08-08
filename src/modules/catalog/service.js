// modules/catalog/service.js — regra do catálogo público.
import { notFound } from '../../utils/ApiError.js';
import { cached } from '../../lib/ttlCache.js';
import * as repo from './repo.js';

// Validade do cache da vitrine. 30s é o equilíbrio: absorve a enxurrada de
// quando as vendas abrem (centenas de pessoas pedindo a MESMA lista no mesmo
// minuto) sem fazer evento recém-publicado demorar a aparecer.
//
// O que pode ficar momentaneamente desatualizado é o "esgotado" da listagem, e
// isso é seguro: quem clica cai no detalhe (sem cache) e a reserva de estoque
// no checkout é atômica. Ninguém compra ingresso inexistente por causa daqui.
const VITRINE_TTL_MS = 30_000;

/** Lista eventos publicados (catálogo). Filtros opcionais: city, q, category. */
export async function listEvents({ city, q, category } = {}) {
  return cached(`vitrine:${city ?? ''}:${q ?? ''}:${category ?? ''}`, VITRINE_TTL_MS,
    () => carregarVitrine({ city, q, category }));
}

/**
 * Cidades que de fato têm evento publicado, com a contagem.
 *
 * Lista fixa de capitais ofereceria "Manaus" sem nada dentro. Esta sai do que
 * existe, para a pessoa saber onde vale procurar.
 */
export async function listCities() {
  return cached('vitrine:cidades', VITRINE_TTL_MS, async () => {
    const { data, error } = await repo.findPublishedCities();
    if (error) throw error;
    const mapa = new Map();
    for (const e of data ?? []) {
      const chave = `${e.city}/${e.state}`;
      mapa.set(chave, (mapa.get(chave) ?? 0) + 1);
    }
    return [...mapa.entries()]
      .map(([chave, eventos]) => {
        const [city, state] = chave.split('/');
        return { city, state, eventos };
      })
      .sort((a, b) => b.eventos - a.eventos || a.city.localeCompare(b.city, 'pt-BR'));
  });
}

async function carregarVitrine({ city, q, category }) {
  const { data, error } = await repo.findPublishedEvents({ city, q, category });
  if (error) throw error;
  return (data ?? []).map((ev) => {
    const tiers = ev.ticket_tiers ?? [];
    const onSale = tiers.filter((t) => t.status === 'on_sale' && (t.quantity_total - t.quantity_sold) > 0);
    const prices = (onSale.length ? onSale : tiers).map((t) => t.price_cents).filter((p) => p != null);
    const soldOut = tiers.length > 0 && onSale.length === 0;

    // O percentual vendido é o que transforma um card em decisão. "87%
    // vendido" faz comprar; nome e data, não. O dado sempre existiu nos
    // lotes — era só ninguém somar.
    const total = tiers.reduce((s, t) => s + (t.quantity_total ?? 0), 0);
    const vendidos = tiers.reduce((s, t) => s + (t.quantity_sold ?? 0), 0);
    const pct = total > 0 ? Math.round((vendidos / total) * 100) : 0;

    const { ticket_tiers, ...rest } = ev;
    return {
      ...rest,
      min_price_cents: prices.length ? Math.min(...prices) : null,
      sold_out: soldOut,
      sold_pct: pct,
      // O selo só acende a partir de 70%. Abaixo disso "40% vendido" não
      // apressa ninguém — e apressar sem motivo é o que gasta o selo para
      // quando ele de fato importa.
      urgencia: soldOut ? 'esgotado' : pct >= 70 ? 'esgotando' : null,
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
