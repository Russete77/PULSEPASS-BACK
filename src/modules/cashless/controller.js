// modules/cashless/controller.js — HTTP da carteira + bar (valida e delega).
import { z } from 'zod';
import * as service from './service.js';
import { supabase } from '../../config/supabase.js';
import { badRequest } from '../../utils/ApiError.js';

// TODO(identity): trocar por fachada do módulo identity quando migrar.
async function loadProfile(userId) {
  const { data } = await supabase.from('profiles').select('full_name, cpf').eq('id', userId).maybeSingle();
  return data;
}

const cardSchema = z.object({
  holderName: z.string().min(2), number: z.string().min(13),
  expiryMonth: z.string().min(1), expiryYear: z.string().min(2), ccv: z.string().min(3),
}).optional();
const holderInfoSchema = z.object({
  name: z.string().min(2), email: z.string().email(), cpfCnpj: z.string().min(11),
  postalCode: z.string().min(8), addressNumber: z.string().min(1), phone: z.string().optional(),
}).optional();

// ── Carteira ──
export async function getWallet(req, res) {
  const wallet = await service.getWallet({ user: req.user, eventId: req.query.eventId });
  res.json({ data: wallet });
}

export async function refundWallet(req, res) {
  res.json({ data: await service.refundWallet({ user: req.user, eventId: req.query.eventId }) });
}

const topupSchema = z.object({
  eventId: z.string().uuid().optional(),
  amount_cents: z.number().int().positive(),
  paymentMethod: z.enum(['pix', 'card']).optional(),
  installmentCount: z.number().int().min(1).max(12).optional(),
  card: cardSchema,
  holderInfo: holderInfoSchema,
});

export async function createTopup(req, res) {
  const parsed = topupSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest('Payload inválido', parsed.error.flatten());
  const profile = await loadProfile(req.user.id);
  const topup = await service.createTopup({
    user: req.user, profile,
    eventId: parsed.data.eventId, amountCents: parsed.data.amount_cents,
    paymentMethod: parsed.data.paymentMethod ?? 'pix',
    installmentCount: parsed.data.installmentCount,
    card: parsed.data.card, holderInfo: parsed.data.holderInfo,
    remoteIp: req.ip, idempotencyKey: req.headers['idempotency-key'] || null,
  });
  res.status(201).json({ data: topup });
}

export async function getTopup(req, res) {
  const topup = await service.getTopup({ user: req.user, topupId: req.params.id });
  res.json({ data: topup });
}

export async function simulateTopupPaid(req, res) {
  const topup = await service.getTopup({ user: req.user, topupId: req.params.id });
  const result = await service.creditTopupByPaymentId(topup.asaas_payment_id);
  res.json({ data: result });
}

// ── Bar ──
export async function menu(req, res) {
  res.json({ data: await service.getMenu(req.params.slug) });
}

const itensSchema = z.array(z.object({
  menu_item_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  notes: z.string().max(140).optional(),
})).min(1);

const barOrderSchema = z.object({
  eventSlug: z.string().min(1),
  items: itensSchema,
});

// Só etapas para FRENTE. Qual transição é legal a partir do estado atual é
// decidido no banco; aqui só se recusa nome inventado.
const advanceSchema = z.object({
  para: z.enum(['preparing', 'ready', 'delivered', 'cancelled']),
  station: z.string().max(60).optional(),
});

const waiterOrderSchema = z.object({
  buyer_id: z.string().uuid(),
  table_id: z.string().uuid().optional(),
  station: z.string().max(60).optional(),
  items: itensSchema,
});

export async function createBarOrder(req, res) {
  const parsed = barOrderSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest('Payload inválido', parsed.error.flatten());
  const order = await service.createBarOrder({
    user: req.user, eventSlug: parsed.data.eventSlug, items: parsed.data.items,
    idempotencyKey: req.headers['idempotency-key'] || null,
  });
  res.status(201).json({ data: order });
}

export async function listMyBarOrders(req, res) {
  res.json({ data: await service.listMyBarOrders({ user: req.user }) });
}

// ── Cardápio (gestão pelo produtor — montado sob /admin pelo cockpit) ──
const menuItemSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  price_cents: z.number().int().nonnegative(),
  description: z.string().optional(),
  available: z.boolean().optional(),
  stock: z.number().int().nonnegative().nullable().optional(),
  position: z.number().int().optional(),
});

export async function menuList(req, res) {
  res.json({ data: await service.listAdminMenu({ user: req.user, eventId: req.params.id }) });
}
export async function menuCreate(req, res) {
  const p = menuItemSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({ data: await service.createMenuItem({ user: req.user, eventId: req.params.id, item: p.data }) });
}
export async function menuUpdate(req, res) {
  res.json({ data: await service.updateMenuItem({ user: req.user, itemId: req.params.itemId, patch: req.body ?? {} }) });
}
export async function menuDelete(req, res) {
  res.json({ data: await service.deleteMenuItem({ user: req.user, itemId: req.params.itemId }) });
}

// Fechamento de caixa (por operador de PDV)
export async function cashierReport(req, res) {
  res.json({ data: await service.getCashierReport({ user: req.user, eventId: req.params.id }) });
}

// Integridade do ledger (drift-check)
export async function ledgerCheck(req, res) {
  res.json({ data: await service.getLedgerCheck({ user: req.user, eventId: req.params.id }) });
}

// ── Serviço de bar: cozinha, garçom, totem ──

export async function kitchenQueue(req, res) {
  res.json({ data: await service.getKitchenQueue({ user: req.user, eventId: req.params.id }) });
}

export async function barOrderAdvance(req, res) {
  const p = advanceSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.json({
    data: await service.advanceBarOrder({
      user: req.user, orderId: req.params.orderId, para: p.data.para, station: p.data.station ?? null,
    }),
  });
}

export async function waiterBoard(req, res) {
  res.json({ data: await service.getWaiterBoard({ user: req.user, eventId: req.params.id }) });
}

export async function waiterOrder(req, res) {
  const p = waiterOrderSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({
    data: await service.placeWaiterOrder({
      user: req.user, eventId: req.params.id,
      tableId: p.data.table_id ?? null, buyerId: p.data.buyer_id,
      items: p.data.items, station: p.data.station ?? null,
      idempotencyKey: req.get('Idempotency-Key') ?? null,
    }),
  });
}
