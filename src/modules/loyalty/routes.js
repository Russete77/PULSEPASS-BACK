// modules/loyalty/routes.js — superfície HTTP do programa de fidelidade.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import * as ctrl from './controller.js';

/** Cliente: o próprio saldo e o resgate. */
export const fidelidadeRouter = Router();
fidelidadeRouter.use(requireAuth);
fidelidadeRouter.get('/programas', asyncHandler(ctrl.programas));
fidelidadeRouter.get('/:orgId/saldo', asyncHandler(ctrl.meuSaldo));
fidelidadeRouter.post('/:orgId/resgatar', asyncHandler(ctrl.resgatar));

/** Produtora: a regra do programa. Montado sob /admin. */
export const fidelidadeAdminRouter = Router();
fidelidadeAdminRouter.get('/organizations/:orgId/fidelidade', asyncHandler(ctrl.getConfig));
fidelidadeAdminRouter.patch('/organizations/:orgId/fidelidade', asyncHandler(ctrl.setConfig));
