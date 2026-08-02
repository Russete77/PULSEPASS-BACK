// modules/orders/controller.js — HTTP do checkout (valida e delega).
import { z } from 'zod';
import * as service from './service.js';
import { supabase } from '../../config/supabase.js';
import { badRequest } from '../../utils/ApiError.js';

const createSchema = z.object({
  eventSlug: z.string().min(1),
  items: z.array(z.object({
    ticket_tier_id: z.string().uuid(),
    quantity: z.number().int().positive(),
    half: z.boolean().optional(), // meia-entrada
  })).min(1),
  couponCode: z.string().min(1).optional(),
  paymentMethod: z.enum(['pix', 'card']).optional(),
  installmentCount: z.number().int().min(1).max(12).optional(),
  card: z.object({
    holderName: z.string().min(2), number: z.string().min(13),
    expiryMonth: z.string().min(1), expiryYear: z.string().min(2), ccv: z.string().min(3),
  }).optional(),
  holderInfo: z.object({
    name: z.string().min(2), email: z.string().email(), cpfCnpj: z.string().min(11),
    postalCode: z.string().min(8), addressNumber: z.string().min(1), phone: z.string().optional(),
  }).optional(),
});

// TODO(identity): trocar por fachada do módulo identity quando migrar.
async function loadProfile(userId) {
  const { data } = await supabase.from('profiles').select('full_name, cpf, phone, role').eq('id', userId).maybeSingle();
  return data;
}

export async function create(req, res) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest('Payload inválido', parsed.error.flatten());

  const profile = await loadProfile(req.user.id);
  const order = await service.createOrder({
    user: req.user, profile,
    items: parsed.data.items, eventSlug: parsed.data.eventSlug, couponCode: parsed.data.couponCode,
    paymentMethod: parsed.data.paymentMethod ?? 'pix',
    installmentCount: parsed.data.installmentCount,
    card: parsed.data.card, holderInfo: parsed.data.holderInfo,
    remoteIp: req.ip, idempotencyKey: req.headers['idempotency-key'] || null,
  });
  res.status(201).json({ data: order });
}

export async function listMine(req, res) {
  res.json({ data: await service.listMyOrders({ user: req.user }) });
}

export async function getById(req, res) {
  const order = await service.getOrder({ user: req.user, orderId: req.params.id });
  res.json({ data: order });
}

export async function refund(req, res) {
  res.json({ data: await service.refundOrder({ user: req.user, orderId: req.params.id }) });
}

/** DEV ONLY — simula a confirmação do pagamento sem depender do webhook. */
export async function simulatePaid(req, res) {
  const order = await service.getOrder({ user: req.user, orderId: req.params.id });
  const result = await service.markOrderPaidByPaymentId(order.asaas_payment_id);
  res.json({ data: result });
}

export async function resend(req, res) {
  res.json({ data: await service.resendTickets({ user: req.user, orderId: req.params.id }) });
}
