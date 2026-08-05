// modules/identity/routes.js — cockpit da produtora (/admin).
// Agrega as superfícies de gestão: identity (org/evento/equipe) + door (ops)
// + guestlist (promoters), montadas sob os mesmos caminhos de antes.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import * as ctrl from './controller.js';
import * as ops from '../door/controller.js';
import * as promoters from '../guestlist/controller.js';
import * as coupons from '../coupons/controller.js';
import * as menu from '../cashless/controller.js';
import * as tables from '../tables/controller.js';
import * as boxoffice from '../boxoffice/controller.js';
import * as fiscal from '../fiscal/controller.js';

const router = Router();
router.use(requireAuth);

router.get('/me', asyncHandler(ctrl.me));
router.post('/organizations', asyncHandler(ctrl.createOrg));
router.patch('/organizations/:orgId/asaas-wallet', asyncHandler(ctrl.setOrgWallet));

router.get('/events', asyncHandler(ctrl.listEvents));
router.post('/events', asyncHandler(ctrl.createEvent));
router.get('/events/:id', asyncHandler(ctrl.eventDetail));
router.patch('/events/:id/status', asyncHandler(ctrl.setStatus));
router.get('/events/:id/dashboard', asyncHandler(ctrl.dashboard));
router.get('/events/:id/reconciliation', asyncHandler(ctrl.reconciliation));

// Equipe do evento (RBAC) — manager / door / bar
router.get('/events/:id/staff', asyncHandler(ctrl.listStaff));
router.post('/events/:id/staff', asyncHandler(ctrl.addStaff));
router.delete('/events/:id/staff/:staffId', asyncHandler(ctrl.removeStaff));

// Operação (porta / bar / PDV) — módulo door
router.post('/events/:id/checkin', asyncHandler(ops.checkIn));
router.get('/events/:id/manifest', asyncHandler(ops.manifest));
router.get('/events/:id/occupancy', asyncHandler(ops.occupancy));
router.post('/events/:id/checkin-batch', asyncHandler(ops.checkInBatch));
router.get('/events/:id/menu', asyncHandler(ops.menu));
router.get('/events/:id/wallet-lookup', asyncHandler(ops.walletLookup));
router.post('/events/:id/pdv-charge', asyncHandler(ops.pdvCharge));

// Bilheteria física (venda na entrada: dinheiro / maquininha / Pix manual)
router.get('/events/:id/box-office', asyncHandler(boxoffice.open));
router.post('/events/:id/box-office/sales', asyncHandler(boxoffice.sell));
router.get('/events/:id/box-office/report', asyncHandler(boxoffice.report));

// Fiscal (NFS-e) — módulo fiscal
router.get('/events/:id/fiscal', asyncHandler(fiscal.list));
router.post('/events/:id/fiscal/issue', asyncHandler(fiscal.issue));

// Cardápio do bar (Zig) — módulo cashless
router.get('/events/:id/menu-items', asyncHandler(menu.menuList));
router.post('/events/:id/menu-items', asyncHandler(menu.menuCreate));
router.patch('/menu-items/:itemId', asyncHandler(menu.menuUpdate));
router.delete('/menu-items/:itemId', asyncHandler(menu.menuDelete));
router.get('/events/:id/cashier', asyncHandler(menu.cashierReport));
router.get('/events/:id/ledger-check', asyncHandler(menu.ledgerCheck));

// Camarotes / reservas (AZList) — módulo tables
router.get('/events/:id/tables', asyncHandler(tables.adminList));
router.post('/events/:id/tables', asyncHandler(tables.adminCreate));
router.delete('/tables/:tableId', asyncHandler(tables.adminDelete));
router.get('/events/:id/reservations', asyncHandler(tables.adminReservations));
router.patch('/reservations/:reservationId', asyncHandler(tables.adminSetReservation));

// Cupons de desconto (Sympla) — módulo coupons
router.post('/events/:id/coupons', asyncHandler(coupons.create));
router.get('/events/:id/coupons', asyncHandler(coupons.list));
router.patch('/coupons/:couponId', asyncHandler(coupons.setActive));
router.delete('/coupons/:couponId', asyncHandler(coupons.remove));

// Guest list / promoters (AZList) — módulo guestlist
router.post('/events/:id/promoters', asyncHandler(promoters.create));
router.get('/events/:id/promoters', asyncHandler(promoters.list));
router.get('/events/:id/guests', asyncHandler(promoters.eventGuests));
router.get('/events/:id/guests/summary', asyncHandler(promoters.guestlistSummary));
router.get('/promoters/:promoterId/guests', asyncHandler(promoters.guests));
router.post('/promoters/:promoterId/commission-paid', asyncHandler(promoters.commissionPaid));
router.post('/guests/:guestId/checkin', asyncHandler(promoters.checkInGuest));

export default router;
