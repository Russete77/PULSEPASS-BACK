// modules/catalog/routes.js — catálogo público de eventos (sem auth).
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import * as ctrl from './controller.js';
import * as waitlist from '../waitlist/controller.js';
import * as seats from '../seats/controller.js';
import { optionalAuth, requireAuth } from '../../middleware/auth.js';

const router = Router();

router.get('/', asyncHandler(ctrl.list));
// Antes de '/:slug': senão o Express leria "cidades" como slug de evento.
router.get('/cidades', asyncHandler(ctrl.cities));
router.get('/:slug', asyncHandler(ctrl.detail));
router.get('/:slug/menu', asyncHandler(ctrl.menu));
// Mapa de assentos. Auth OPCIONAL: sem login o mapa aparece igual, só não
// marca quais lugares são seus — e ver antes de criar conta é o que faz a
// pessoa decidir criar.
router.get('/:slug/assentos', optionalAuth, asyncHandler(seats.map));
router.post('/:slug/assentos/reservar', requireAuth, asyncHandler(seats.hold));
router.post('/:slug/assentos/soltar', requireAuth, asyncHandler(seats.release));
// Fila de espera de lote esgotado (público: quem quis comprar fica registrado)
router.post('/:slug/waitlist', asyncHandler(waitlist.join));

/**
 * Página pública da produtora — montada em /casas, não sob /events.
 *
 * Não dá para pendurar em '/events/...': '/:slug' já engole qualquer
 * caminho de um segmento, e uma casa não é um evento. Router próprio mantém
 * a URL honesta (/api/casas/audio-club) e o módulo continua sendo o catalog,
 * que é quem conhece o que pode ou não ser público.
 */
export const casasRouter = Router();
casasRouter.get('/:slug', asyncHandler(ctrl.casa));

export default router;
