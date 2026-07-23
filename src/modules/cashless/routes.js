// modules/cashless/routes.js — dois routers do domínio: carteira e bar.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import * as ctrl from './controller.js';

// /wallet
export const walletRouter = Router();
walletRouter.use(requireAuth);
walletRouter.get('/', asyncHandler(ctrl.getWallet));
walletRouter.post('/refund', asyncHandler(ctrl.refundWallet));
walletRouter.post('/topups', asyncHandler(ctrl.createTopup));
walletRouter.get('/topups/:id', asyncHandler(ctrl.getTopup));
if (!env.isProd) {
  walletRouter.post('/topups/:id/simulate-paid', asyncHandler(ctrl.simulateTopupPaid));
}

// /bar-orders
export const barRouter = Router();
barRouter.use(requireAuth);
barRouter.post('/', asyncHandler(ctrl.createBarOrder));
barRouter.get('/', asyncHandler(ctrl.listMyBarOrders));
