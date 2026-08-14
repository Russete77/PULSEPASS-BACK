// modules/catalog/controller.js — catálogo público (sem auth).
import * as service from './service.js';
// O menu público pertence ao domínio cashless; consumido via a fachada (service).
import { getMenu } from '../cashless/service.js';

export async function list(req, res) {
  const { city, q, category } = req.query;
  const events = await service.listEvents({ city, q, category });
  // Catálogo é público e idêntico para todo mundo: deixa CDN e navegador
  // absorverem parte do pico de quando as vendas abrem.
  // stale-while-revalidate serve a lista anterior por mais 60s enquanto busca a
  // nova, então nem o vencimento do cache gera fila no banco.
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  res.json({ data: events });
}

/** Cidades com evento no ar — o seletor da vitrine sai daqui, não de lista fixa. */
export async function cities(req, res) {
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
  res.json({ data: await service.listCities() });
}

/**
 * Página pública da produtora. Mesmo cache do catálogo: é conteúdo público e
 * idêntico para todo mundo, e a agenda de uma casa muda em dias, não em
 * segundos.
 */
export async function casa(req, res) {
  const data = await service.getCasaBySlug(req.params.slug);
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  res.json({ data });
}

export async function detail(req, res) {
  const event = await service.getEventBySlug(req.params.slug);
  res.json({ data: event });
}

export async function menu(req, res) {
  res.json({ data: await getMenu(req.params.slug) });
}
