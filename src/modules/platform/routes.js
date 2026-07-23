// modules/platform/routes.js — god-mode. Todas as rotas exigem super-admin.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireSuperAdmin } from '../../middleware/auth.js';
import * as ctrl from './controller.js';

const router = Router();
router.use(requireSuperAdmin);

router.get('/stats', asyncHandler(ctrl.stats));
router.get('/orgs', asyncHandler(ctrl.orgs));
router.get('/fraud', asyncHandler(ctrl.fraud));
router.get('/finance', asyncHandler(ctrl.finance));
router.get('/activity', asyncHandler(ctrl.activity));
// Ping p/ o front decidir se mostra a entrada do PulseADM (retorna 200 só p/ super-admin).
router.get('/whoami', (req, res) => res.json({ data: { email: req.user.email, admin: true } }));

export default router;
