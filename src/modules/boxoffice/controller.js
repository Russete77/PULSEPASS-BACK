// modules/boxoffice/controller.js — HTTP da bilheteria (valida e delega).
import { z } from 'zod';
import { badRequest } from '../../utils/ApiError.js';
import * as service from './service.js';

const sellSchema = z.object({
  items: z.array(z.object({
    ticket_tier_id: z.string().uuid(),
    quantity: z.number().int().positive().max(50),
    half: z.boolean().optional(),
  })).min(1),
  method: z.enum(['cash', 'card_machine', 'pix_manual', 'courtesy']),
  received_cents: z.number().int().nonnegative().optional(),
  buyer: z.object({
    name: z.string().min(2).max(120).optional(),
    email: z.string().email().optional(),
    doc: z.string().min(5).max(20).optional(),
  }).optional(),
  note: z.string().max(240).optional(),
});

export async function open(req, res) {
  res.json({ data: await service.openRegister({ user: req.user, eventId: req.params.id }) });
}

export async function sell(req, res) {
  const p = sellSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  const data = await service.sell({
    user: req.user, eventId: req.params.id,
    items: p.data.items, method: p.data.method, receivedCents: p.data.received_cents,
    buyer: p.data.buyer ?? {}, note: p.data.note,
  });
  res.status(201).json({ data });
}

export async function report(req, res) {
  res.json({ data: await service.report({ user: req.user, eventId: req.params.id }) });
}
