// modules/catalog/routes.js — catálogo público de eventos (sem auth).
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import * as ctrl from './controller.js';
import * as waitlist from '../waitlist/controller.js';

const router = Router();

router.get('/', asyncHandler(ctrl.list));
// Antes de '/:slug': senão o Express leria "cidades" como slug de evento.
router.get('/cidades', asyncHandler(ctrl.cities));
router.get('/:slug', asyncHandler(ctrl.detail));
router.get('/:slug/menu', asyncHandler(ctrl.menu));
// Fila de espera de lote esgotado (público: quem quis comprar fica registrado)
router.post('/:slug/waitlist', asyncHandler(waitlist.join));

export default router;
