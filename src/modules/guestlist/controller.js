// modules/guestlist/controller.js — HTTP do guest list: público (inscrição)
// + admin (promoters/guests/comissão, montado sob /admin pelo cockpit).
import { z } from 'zod';
import * as service from './service.js';
import { badRequest } from '../../utils/ApiError.js';

/* ── Público (sem auth) ── */
export async function getByCode(req, res) {
  res.json({ data: await service.getListByCode(req.params.code) });
}

const signupSchema = z.object({
  name: z.string().min(2),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  // "João +2": o convite vale para o grupo todo, não só pra quem se inscreveu.
  party_size: z.number().int().min(1).max(20).optional(),
});
export async function signup(req, res) {
  const p = signupSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Dados inválidos', p.error.flatten());
  res.status(201).json({
    data: await service.signup({
      code: req.params.code,
      name: p.data.name, email: p.data.email, phone: p.data.phone,
      partySize: p.data.party_size ?? 1,
    }),
  });
}

/** Beacon de clique no link (público). */
export async function hit(req, res) {
  res.json({ data: await service.registerHit(req.params.code) });
}

/* ── Admin (promoters) ── */
const createSchema = z.object({
  name: z.string().min(2),
  commission_cents: z.number().int().nonnegative().optional(),
  email: z.string().email().optional().or(z.literal('')), // vincula ao portal do promoter
  goal_checkins: z.number().int().nonnegative().nullable().optional(), // meta de presenças
  list_type: z.enum(['standard', 'free_until', 'birthday', 'vip']).optional(),
  free_until: z.string().nullable().optional(),
});
export async function create(req, res) {
  const p = createSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({
    data: await service.createPromoter({
      user: req.user, eventId: req.params.id,
      name: p.data.name, commissionCents: p.data.commission_cents ?? 0,
      email: p.data.email, goalCheckins: p.data.goal_checkins ?? null,
      listType: p.data.list_type, freeUntil: p.data.free_until ?? null,
    }),
  });
}

/* Portal do promoter (self-service) */
export async function promoterMe(req, res) {
  res.json({ data: await service.getMyPromoterDashboard({ user: req.user }) });
}
export async function myGuests(req, res) {
  res.json({ data: await service.getMyPromoterGuests({ user: req.user, promoterId: req.params.promoterId }) });
}

export async function list(req, res) {
  res.json({ data: await service.listPromoters({ user: req.user, eventId: req.params.id }) });
}

export async function guests(req, res) {
  res.json({ data: await service.listGuests({ user: req.user, promoterId: req.params.promoterId }) });
}

export async function eventGuests(req, res) {
  res.json({ data: await service.listEventGuests({ user: req.user, eventId: req.params.id }) });
}

const checkinSchema = z.object({
  // Quantas pessoas do convite estão entrando AGORA (o grupo raramente chega junto).
  people: z.number().int().min(1).max(20).optional(),
});
export async function checkInGuest(req, res) {
  const p = checkinSchema.safeParse(req.body ?? {});
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.json({ data: await service.checkInGuest({ user: req.user, guestId: req.params.guestId, people: p.data.people ?? 1 }) });
}

export async function commissionPaid(req, res) {
  const paid = req.body?.paid !== false;
  res.json({ data: await service.setCommissionPaid({ user: req.user, promoterId: req.params.promoterId, paid }) });
}

export async function guestlistSummary(req, res) {
  res.json({ data: await service.guestlistSummary({ user: req.user, eventId: req.params.id }) });
}
