// modules/door/controller.js — HTTP da porta/PDV (montado pelo cockpit em admin.routes).
import { z } from 'zod';
import * as service from './service.js';
import { badRequest } from '../../utils/ApiError.js';

const checkinSchema = z.object({
  input: z.string().min(1),
  // Sem direction a porta alterna sozinha (fora→entra, dentro→sai).
  direction: z.enum(['in', 'out']).optional(),
  gate: z.string().max(40).optional(),
});
export async function checkIn(req, res) {
  const p = checkinSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Código inválido', p.error.flatten());
  res.json({ data: await service.checkIn({
    user: req.user, eventId: req.params.id,
    input: p.data.input, direction: p.data.direction ?? null, gate: p.data.gate ?? null,
  }) });
}

export async function occupancy(req, res) {
  res.json({ data: await service.occupancy({ user: req.user, eventId: req.params.id }) });
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
  // Praça do turno aberto — liga a venda à gaveta certa no fechamento.
  station: z.string().trim().min(1).max(60).optional(),
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
