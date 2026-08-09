// modules/tables/controller.js — HTTP de camarotes/reservas.
import { z } from 'zod';
import * as service from './service.js';
import { badRequest } from '../../utils/ApiError.js';

/* ── Público ── */
export async function publicList(req, res) {
  res.json({ data: await service.listPublicTables(req.params.slug) });
}

const reserveSchema = z.object({
  name: z.string().min(2),
  contact: z.string().optional(),
  party_size: z.number().int().positive().nullable().optional(),
});
export async function reserve(req, res) {
  const p = reserveSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Dados inválidos', p.error.flatten());
  res.status(201).json({
    data: await service.requestReservation({
      user: req.user, tableId: req.params.tableId,
      name: p.data.name, contact: p.data.contact, partySize: p.data.party_size,
    }),
  });
}

/* ── Admin ── */
const tableSchema = z.object({
  name: z.string().min(1),
  area: z.string().optional(),
  capacity: z.number().int().positive().nullable().optional(),
  min_spend_cents: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
  position: z.number().int().optional(),
});
export async function adminList(req, res) {
  res.json({ data: await service.listTables({ user: req.user, eventId: req.params.id }) });
}
export async function adminCreate(req, res) {
  const p = tableSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({ data: await service.createTable({ user: req.user, eventId: req.params.id, table: p.data }) });
}
export async function adminDelete(req, res) {
  res.json({ data: await service.deleteTable({ user: req.user, tableId: req.params.tableId }) });
}
export async function adminReservations(req, res) {
  res.json({ data: await service.listReservations({ user: req.user, eventId: req.params.id }) });
}
export async function adminSetReservation(req, res) {
  res.json({ data: await service.setReservationStatus({ user: req.user, reservationId: req.params.reservationId, status: req.body?.status, ocasiao: req.body?.ocasiao }) });
}
