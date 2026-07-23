// modules/orders/routes.js — superfície HTTP do checkout.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import * as ctrl from './controller.js';

const router = Router();

router.use(requireAuth);

router.post('/', asyncHandler(ctrl.create));
router.get('/', asyncHandler(ctrl.listMine));
router.get('/:id', asyncHandler(ctrl.getById));
router.post('/:id/refund', asyncHandler(ctrl.refund));

// Simulação de pagamento — apenas fora de produção
if (!env.isProd) {
  router.post('/:id/simulate-paid', asyncHandler(ctrl.simulatePaid));
}

export default router;
