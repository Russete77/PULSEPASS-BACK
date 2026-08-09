// modules/identity/controller.js — HTTP de perfil/org/eventos/equipe (cockpit).
import { z } from 'zod';
import * as service from './service.js';
import { badRequest } from '../../utils/ApiError.js';
import * as audit from '../audit/service.js';

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
  const data = await service.setEventStatus({ user: req.user, eventId: req.params.id, status: p.data.status });
  // Publicar abre as vendas; pausar/cancelar as fecha. Decisao de negocio.
  await audit.record({
    req, action: `event.status.${p.data.status}`, entity: 'events', entityId: req.params.id,
    eventId: req.params.id, after: { status: p.data.status },
  });
  res.json({ data });
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
  const data = await service.addEventStaff({ user: req.user, eventId: req.params.id, ...p.data });
  // Quem entra na equipe passa a poder validar entrada e mexer no caixa.
  await audit.record({
    req, action: 'staff.add', entity: 'event_staff', entityId: data?.id,
    eventId: req.params.id, after: { email: p.data.email, role: p.data.role },
  });
  res.status(201).json({ data });
}

export async function removeStaff(req, res) {
  const data = await service.removeEventStaff({ user: req.user, eventId: req.params.id, staffId: req.params.staffId });
  await audit.record({
    req, action: 'staff.remove', entity: 'event_staff', entityId: req.params.staffId,
    eventId: req.params.id,
  });
  res.json({ data });
}

// ── Carteira Asaas da produtora (split/repasse) ──
const walletSchema = z.object({ asaas_wallet_id: z.string().min(1).nullable().optional() });
export async function setOrgWallet(req, res) {
  const p = walletSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  const antes = await service.getOrgWallet({ user: req.user, orgId: req.params.orgId });
  const data = await service.setOrgAsaasWallet({ user: req.user, orgId: req.params.orgId, asaasWalletId: p.data.asaas_wallet_id });

  // Esta é a mudança mais perigosa do sistema: altera PARA ONDE vai o repasse
  // de todas as vendas. Sem o antes/depois na trilha, um desvio de destino
  // seria invisível.
  await audit.record({
    req, action: 'organization.wallet_change', entity: 'organizations', entityId: req.params.orgId,
    organizationId: req.params.orgId,
    before: { asaas_wallet_id: antes?.asaas_wallet_id ?? null },
    after: { asaas_wallet_id: data?.asaas_wallet_id ?? null },
  });

  res.json({ data });
}

// ── Capa do evento ──
// A imagem vai direto do navegador para o Storage; aqui só decidimos quem
// pode enviar. Ver identity/service.js para o porquê.
const coverSchema = z.object({
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif']),
});
export async function coverUpload(req, res) {
  const p = coverSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Formato não aceito. Use JPG, PNG, WebP ou AVIF.', p.error.flatten());
  res.json({
    data: await service.createCoverUpload({
      user: req.user, eventId: req.params.id, contentType: p.data.content_type,
    }),
  });
}

const confirmSchema = z.object({ path: z.string().min(3) });
export async function coverConfirm(req, res) {
  const p = confirmSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  const data = await service.confirmCover({ user: req.user, eventId: req.params.id, path: p.data.path });
  await audit.record({
    req, action: 'event.cover_change', entity: 'events', entityId: req.params.id,
    eventId: req.params.id, after: { cover_url: data.cover_url },
  });
  res.json({ data });
}

export async function coverRemove(req, res) {
  res.json({ data: await service.removeCoverFromEvent({ user: req.user, eventId: req.params.id }) });
}

// ── Marca da produtora (white-label) ──

export async function brandingGet(req, res) {
  res.json({ data: await service.getOrgBranding({ user: req.user, orgId: req.params.orgId }) });
}

export async function brandingPatch(req, res) {
  res.json({ data: await service.setOrgBranding({ user: req.user, orgId: req.params.orgId, patch: req.body ?? {} }) });
}

export async function logoUpload(req, res) {
  res.status(201).json({
    data: await service.createLogoUpload({
      user: req.user, orgId: req.params.orgId, contentType: req.body?.content_type,
    }),
  });
}

export async function logoConfirm(req, res) {
  res.json({ data: await service.confirmLogo({ user: req.user, orgId: req.params.orgId, path: req.body?.path }) });
}

export async function logoRemove(req, res) {
  res.json({ data: await service.removeOrgLogo({ user: req.user, orgId: req.params.orgId }) });
}


/** Permissões granulares da equipe. */
export async function staffPermissoes(req, res) {
  res.json({
    data: await service.setStaffPermissoes({
      user: req.user, eventId: req.params.id, staffId: req.params.staffId,
      permissoes: req.body?.permissoes,
    }),
  });
}

export async function permissoesCatalogo(_req, res) {
  res.json({ data: service.listarPermissoes() });
}
