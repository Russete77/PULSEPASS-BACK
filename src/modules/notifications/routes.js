// modules/notifications/routes.js — superfície HTTP da central de avisos.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import * as ctrl from './controller.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(ctrl.listar));
router.get('/nao-lidas', asyncHandler(ctrl.naoLidas));
router.post('/lidas', asyncHandler(ctrl.marcarLidas));

export default router;
