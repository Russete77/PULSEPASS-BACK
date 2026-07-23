// modules/guestlist/routes.js — inscrição pública em lista de promoter (sem auth).
// As rotas de admin (promoters/guests/comissão) são montadas pelo cockpit em admin.routes.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import * as ctrl from './controller.js';

const router = Router();

router.get('/:code', asyncHandler(ctrl.getByCode));
router.post('/:code/hit', asyncHandler(ctrl.hit));
router.post('/:code/signup', asyncHandler(ctrl.signup));

export default router;

// Portal do promoter (self-service, autenticado). Montado em /promoter.
export const promoterRouter = Router();
promoterRouter.use(requireAuth);
promoterRouter.get('/me', asyncHandler(ctrl.promoterMe));
promoterRouter.get('/promoters/:promoterId/guests', asyncHandler(ctrl.myGuests));
