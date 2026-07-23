// modules/tables/routes.js — superfície pública de camarotes (montado em /tables).
// A gestão (admin) é montada pelo cockpit em identity/routes.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { optionalAuth } from '../../middleware/auth.js';
import * as ctrl from './controller.js';

const router = Router();

router.get('/event/:slug', asyncHandler(ctrl.publicList));
// Reserva pode ser anônima ou logada (optionalAuth popula profile_id se houver token).
router.post('/:tableId/reserve', optionalAuth, asyncHandler(ctrl.reserve));

export default router;
