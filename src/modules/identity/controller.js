// modules/identity/controller.js — HTTP de perfil/org/eventos/equipe (cockpit).
import { z } from 'zod';
import * as service from './service.js';
import { badRequest } from '../../utils/ApiError.js';

export async function me(req, res) {
  res.json({ data: await service.getMe({ user: req.user }) });
}

const orgSchema = z.object({ name: z.string().min(2), cnpj: z.string().optional() });
export async function createOrg(req, res) {
  const p = orgSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({ data: await service.createOrganization({ user: req.user, ...p.data }) });
}

const eventSchema = z.object({
  organization_id: z.string().uuid(),
  title: z.string().min(2),
  description: z.string().optional(),
  venue_name: z.string().optional(),
  address: z.string().optional(),
  city: z.string().min(1),
  state: z.string().length(2),
  starts_at: z.string().min(1),
  ends_at: z.string().optional(),
  service_fee_bps: z.number().int().min(0).max(10000).optional(), // taxa de serviço (bps)
  // Reentrada: desligada por padrão. Ligar sem a casa pedir é convite a
  // ingresso emprestado (um entra, sai e passa o celular pro amigo).
  reentry_enabled: z.boolean().optional(),
  reentry_max: z.number().int().min(1).max(20).nullable().optional(),
  tiers: z.array(z.object({
    name: z.string().min(1),
    price_cents: z.number().int().nonnegative(),
    half_price_cents: z.number().int().nonnegative().nullable().optional(), // meia-entrada
    quantity_total: z.number().int().nonnegative(),
    sales_start: z.string().nullable().optional(), // janela de vendas (lote por data)
    sales_end: z.string().nullable().optional(),
  })).optional(),
});
export async function createEvent(req, res) {
  const p = eventSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({ data: await service.createEvent({ user: req.user, payload: p.data }) });
}

export async function listEvents(req, res) {
  res.json({ data: await service.listMyEvents({ user: req.user }) });
}

export async function eventDetail(req, res) {
  res.json({ data: await service.getEventDetail({ user: req.user, eventId: req.params.id }) });
}

const statusSchema = z.object({ status: z.string() });
export async function setStatus(req, res) {
  const p = statusSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.json({ data: await service.setEventStatus({ user: req.user, eventId: req.params.id, status: p.data.status }) });
}

export async function dashboard(req, res) {
  res.json({ data: await service.getDashboard({ user: req.user, eventId: req.params.id }) });
}

export async function reconciliation(req, res) {
  res.json({ data: await service.getReconciliation({ user: req.user, eventId: req.params.id }) });
}

// ── Equipe do evento (RBAC) ──
export async function listStaff(req, res) {
  res.json({ data: await service.listEventStaff({ user: req.user, eventId: req.params.id }) });
}

const staffSchema = z.object({ email: z.string().email(), role: z.enum(['manager', 'door', 'bar']) });
export async function addStaff(req, res) {
  const p = staffSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({ data: await service.addEventStaff({ user: req.user, eventId: req.params.id, ...p.data }) });
}

export async function removeStaff(req, res) {
  res.json({ data: await service.removeEventStaff({ user: req.user, eventId: req.params.id, staffId: req.params.staffId }) });
}

// ── Carteira Asaas da produtora (split/repasse) ──
const walletSchema = z.object({ asaas_wallet_id: z.string().min(1).nullable().optional() });
export async function setOrgWallet(req, res) {
  const p = walletSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.json({ data: await service.setOrgAsaasWallet({ user: req.user, orgId: req.params.orgId, asaasWalletId: p.data.asaas_wallet_id }) });
}
