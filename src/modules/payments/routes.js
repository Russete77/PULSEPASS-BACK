// modules/payments/routes.js — webhooks de pagamento (sem auth de usuário).
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import * as ctrl from './controller.js';

const router = Router();

// Asaas → POST /api/webhooks/asaas (valida token próprio)
router.post('/asaas', asyncHandler(ctrl.asaas));

export default router;
