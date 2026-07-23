// modules/catalog/routes.js — catálogo público de eventos (sem auth).
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import * as ctrl from './controller.js';

const router = Router();

router.get('/', asyncHandler(ctrl.list));
router.get('/:slug', asyncHandler(ctrl.detail));
router.get('/:slug/menu', asyncHandler(ctrl.menu));

export default router;
