// modules/boxoffice/controller.js — HTTP da bilheteria (valida e delega).
import { z } from 'zod';
import { badRequest } from '../../utils/ApiError.js';
import * as service from './service.js';
import * as audit from '../audit/service.js';

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

  // Dinheiro entrando pela mão de alguém: fica na trilha imutável com o
  // operador, a forma e o valor. É o registro que sustenta o fechamento.
  await audit.record({
    req, action: 'box_office.sale', entity: 'orders', entityId: data.order_id,
    eventId: req.params.id, amountCents: data.total_cents,
    after: {
      method: data.method, received_cents: data.received_cents,
      change_cents: data.change_cents, tickets: data.tickets.length,
      bearer: data.bearer, buyer_name: p.data.buyer?.name ?? null,
    },
    note: p.data.note ?? null,
  });

  res.status(201).json({ data });
}

export async function report(req, res) {
  res.json({ data: await service.report({ user: req.user, eventId: req.params.id }) });
}
