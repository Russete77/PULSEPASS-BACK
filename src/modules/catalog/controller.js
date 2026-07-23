// modules/catalog/controller.js — catálogo público (sem auth).
import * as service from './service.js';
// O menu público pertence ao domínio cashless; consumido via a fachada (service).
import { getMenu } from '../cashless/service.js';

export async function list(req, res) {
  const { city, q } = req.query;
  const events = await service.listEvents({ city, q });
  res.json({ data: events });
}

export async function detail(req, res) {
  const event = await service.getEventBySlug(req.params.slug);
  res.json({ data: event });
}

export async function menu(req, res) {
  res.json({ data: await getMenu(req.params.slug) });
}
