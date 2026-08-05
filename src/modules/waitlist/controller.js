// modules/waitlist/controller.js — HTTP da fila de espera.
import { z } from 'zod';
import { badRequest } from '../../utils/ApiError.js';
import * as service from './service.js';

const joinSchema = z.object({
  ticket_tier_id: z.string().uuid(),
  email: z.string().email().optional(),
  name: z.string().min(2).max(120).optional(),
  quantity: z.number().int().min(1).max(10).optional(),
});

export async function join(req, res) {
  const p = joinSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({
    data: await service.join({
      user: req.user ?? null, eventSlug: req.params.slug,
      tierId: p.data.ticket_tier_id, email: p.data.email,
      name: p.data.name, quantity: p.data.quantity ?? 1,
    }),
  });
}

export async function listForEvent(req, res) {
  res.json({ data: await service.listForEvent({ user: req.user, eventId: req.params.id }) });
}
