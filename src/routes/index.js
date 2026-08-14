import { Router } from 'express';
import { asaasMode } from '../modules/payments/provider.js';
import { webhookHealth } from '../modules/payments/reconcile.js';
import { supabase } from '../config/supabase.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import eventsRouter, { casasRouter } from '../modules/catalog/routes.js';
import ordersRouter from '../modules/orders/routes.js';
import ticketsRouter from '../modules/tickets/routes.js';
import notificacoesRouter from '../modules/notifications/routes.js';
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

  // A saúde da entrega de webhooks entra aqui porque fila interrompida no
  // Asaas é invisível de fora: as vendas param de virar ingresso e ninguém
  // percebe até o cliente reclamar. Como readiness, o monitor já alerta.
  const webhooks = await webhookHealth().catch(() => null);
  const degradado = Boolean(webhooks && !webhooks.healthy);
  res.status(degradado ? 503 : 200).json({
    status: degradado ? 'degraded' : 'ready',
    db: true,
    ...(webhooks ? { webhooks } : {}),
  });
}));

router.use('/events', eventsRouter);
// Página pública da produtora (marca + agenda). Sem auth, como a vitrine.
router.use('/casas', casasRouter);
router.use('/orders', ordersRouter);
router.use('/tickets', ticketsRouter);
router.use('/notificacoes', notificacoesRouter);
router.use('/wallet', walletRouter);
router.use('/bar-orders', barRouter);
router.use('/admin', adminRouter);
router.use('/lists', listsRouter);
router.use('/promoter', promoterRouter);
router.use('/tables', tablesRouter);
router.use('/webhooks', webhooksRouter);
router.use('/platform', platformRouter);

export default router;
