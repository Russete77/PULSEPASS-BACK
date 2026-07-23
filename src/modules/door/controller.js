// modules/door/controller.js — HTTP da porta/PDV (montado pelo cockpit em admin.routes).
import { z } from 'zod';
import * as service from './service.js';
import { badRequest } from '../../utils/ApiError.js';

const checkinSchema = z.object({ input: z.string().min(1) });
export async function checkIn(req, res) {
  const p = checkinSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Código inválido', p.error.flatten());
  res.json({ data: await service.checkIn({ user: req.user, eventId: req.params.id, input: p.data.input }) });
}

export async function manifest(req, res) {
  res.json({ data: await service.eventManifest({ user: req.user, eventId: req.params.id }) });
}

const batchSchema = z.object({
  scans: z.array(z.object({
    client_id: z.string().optional(),
    input: z.string().min(1),
    scanned_at: z.string().optional(),
  })).min(1).max(2000),
});
export async function checkInBatch(req, res) {
  const p = batchSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.json({ data: await service.checkInBatch({ user: req.user, eventId: req.params.id, scans: p.data.scans }) });
}

export async function menu(req, res) {
  res.json({ data: await service.eventMenu({ user: req.user, eventId: req.params.id }) });
}

export async function walletLookup(req, res) {
  res.json({ data: await service.walletLookup({ user: req.user, eventId: req.params.id, email: req.query.email }) });
}

const chargeSchema = z.object({
  email: z.string().email(),
  items: z.array(z.object({ menu_item_id: z.string().uuid(), quantity: z.number().int().positive() })).min(1),
});
export async function pdvCharge(req, res) {
  const p = chargeSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({
    data: await service.pdvCharge({
      user: req.user, eventId: req.params.id, ...p.data,
      idempotencyKey: req.headers['idempotency-key'] || null,
    }),
  });
}
