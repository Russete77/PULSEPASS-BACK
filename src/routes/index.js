import { Router } from 'express';
import { asaasMode } from '../modules/payments/provider.js';
import { supabase } from '../config/supabase.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import eventsRouter from '../modules/catalog/routes.js';
import ordersRouter from '../modules/orders/routes.js';
import ticketsRouter from '../modules/tickets/routes.js';
import { walletRouter, barRouter } from '../modules/cashless/routes.js';
import adminRouter from '../modules/identity/routes.js';
import listsRouter, { promoterRouter } from '../modules/guestlist/routes.js';
import tablesRouter from '../modules/tables/routes.js';
import webhooksRouter from '../modules/payments/routes.js';
import platformRouter from '../modules/platform/routes.js';

const router = Router();

// Liveness — processo de pé
router.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'pulsepass-api', asaas: asaasMode, ts: Date.now() }),
);

// Readiness — dependências (banco) respondendo
router.get('/health/ready', asyncHandler(async (_req, res) => {
  const { error } = await supabase.from('events').select('id', { head: true, count: 'exact' }).limit(1);
  if (error) return res.status(503).json({ status: 'degraded', db: false });
  res.json({ status: 'ready', db: true });
}));

router.use('/events', eventsRouter);
router.use('/orders', ordersRouter);
router.use('/tickets', ticketsRouter);
router.use('/wallet', walletRouter);
router.use('/bar-orders', barRouter);
router.use('/admin', adminRouter);
router.use('/lists', listsRouter);
router.use('/promoter', promoterRouter);
router.use('/tables', tablesRouter);
router.use('/webhooks', webhooksRouter);
router.use('/platform', platformRouter);

export default router;
