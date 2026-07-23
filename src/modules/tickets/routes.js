// modules/tickets/routes.js — superfície HTTP do domínio Ingressos.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import * as ctrl from './controller.js';

const router = Router();

router.use(requireAuth);

router.get('/', asyncHandler(ctrl.listMine));
router.get('/:id', asyncHandler(ctrl.getMine));
router.get('/:id/qr-token', asyncHandler(ctrl.getQrToken));
router.post('/:id/transfer', asyncHandler(ctrl.transfer));

export default router;
