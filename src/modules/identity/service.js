// modules/identity/service.js — perfil, organização, gestão de eventos e equipe (RBAC).
import { notFound, forbidden, badRequest } from '../../utils/ApiError.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { assertEventAccess } from './access.js';
import * as repo from './repo.js';

function slugify(text) {
  const base = String(text).toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base || 'item'}-${suffix}`;
}

export async function getMe({ user }) {
  const { data: profile } = await repo.findProfile(user.id);
  const { data: orgs, error } = await repo.findOrgsByOwner(user.id);
  if (error) throw error;
  // Escalações (porta/bar/gerente): o cockpit usa isso pra levar o staff direto
  // pra sua tela de trabalho, em vez de mostrar o onboarding de produtora.
  const { data: staff, error: staffErr } = await repo.findMyStaffAssignments(user.id);
  if (staffErr) throw staffErr;
  const assignments = (staff ?? [])
    .filter((s) => s.events)
    .map((s) => ({ role: s.role, event: s.events }));
  return { profile, organizations: orgs ?? [], assignments };
}

export async function createOrganization({ user, name, cnpj }) {
  if (!name || name.trim().length < 2) throw badRequest('Nome da organização inválido');
  const { data: org, error } = await repo.insertOrg({
    owner_id: user.id, name: name.trim(), slug: slugify(name), cnpj: cnpj ?? null,
  });
  if (error) throw error;
  await repo.setProfileRole(user.id, 'produtora');
  return org;
}

async function assertOrgOwner(userId, orgId) {
  const { data } = await repo.findOrgOwned(orgId, userId);
  if (!data) throw forbidden('Organização não pertence a você');
}

/** Carteira atual — lida ANTES da troca para a trilha registrar o "de → para". */
export async function getOrgWallet({ user, orgId }) {
  await assertOrgOwner(user.id, orgId);
  const { data } = await repo.findOrgWallet(orgId);
  return data ?? null;
}

/** Configura a carteira Asaas da produtora (destino do repasse/split). */
export async function setOrgAsaasWallet({ user, orgId, asaasWalletId }) {
  await assertOrgOwner(user.id, orgId);
  const { data, error } = await repo.updateOrgWallet(orgId, asaasWalletId || null);
  if (error) throw error;
  return data;
}

async function assertEventOwner(userId, eventId) {
  const { data: event } = await repo.findEventWithOwner(eventId);
  if (!event) throw notFound('Evento não encontrado');
  if (event.organizations.owner_id !== userId) throw forbidden('Sem acesso a este evento');
  return event;
}

/**
 * Operações de evento (detalhe, status, dashboard): dono OU manager.
 * Gestão de equipe e wallet de repasse seguem owner-only.
 */
async function assertEventManage(userId, eventId, roles = ['manager']) {
  await assertEventAccess(userId, eventId, roles);
  const { data: event } = await repo.findEvent(eventId);
  if (!event) throw notFound('Evento não encontrado');
  return event;
}

export async function createEvent({ user, payload }) {
  const { organization_id, title, description, venue_name, address, city, state, starts_at, ends_at,
    service_fee_bps, reentry_enabled, reentry_max, category, latitude, longitude, tiers } = payload;
  if (!title || !city || !state || !starts_at) throw badRequest('Campos obrigatórios faltando');
  await assertOrgOwner(user.id, organization_id);

  const { data: event, error } = await repo.insertEvent({
    organization_id, title, slug: slugify(title),
    description: description ?? null, venue_name: venue_name ?? null, address: address ?? null,
    city, state, starts_at, ends_at: ends_at ?? null, status: 'draft',
    category: category ?? 'outro',
    latitude: latitude ?? null, longitude: longitude ?? null,
    service_fee_bps: Math.min(10000, Math.max(0, Math.round(Number(service_fee_bps) || 0))),
    reentry_enabled: reentry_enabled === true,
    reentry_max: reentry_enabled === true ? (reentry_max ?? null) : null,
  });
  if (error) throw error;

  if (Array.isArray(tiers) && tiers.length) {
    const rows = tiers.map((t, i) => ({
      event_id: event.id, name: t.name,
      price_cents: Math.round(Number(t.price_cents) || 0),
      half_price_cents: t.half_price_cents != null ? Math.max(0, Math.round(Number(t.half_price_cents))) : null,
      quantity_total: Math.round(Number(t.quantity_total) || 0),
      sales_start: t.sales_start || null,
      sales_end: t.sales_end || null,
      position: i, status: 'on_sale',
    }));
    const { error: tErr } = await repo.insertTiers(rows);
    if (tErr) throw tErr;
  }
  return getEventDetail({ user, eventId: event.id });
}

export async function getEventDetail({ user, eventId }) {
  const event = await assertEventManage(user.id, eventId);
  const { data: tiers } = await repo.findTiersByEvent(eventId);
  return { ...event, organizations: undefined, tiers: tiers ?? [] };
}

export async function listMyEvents({ user, limit = 100, offset = 0 }) {
  const { data: orgs } = await repo.findOrgIdsByOwner(user.id);
  const orgIds = (orgs ?? []).map((o) => o.id);
  if (!orgIds.length) return [];
  const { data, error } = await repo.findEventsByOrgs(orgIds, { limit, offset });
  if (error) throw error;
  return data;
}

export async function setEventStatus({ user, eventId, status }) {
  const allowed = ['draft', 'published', 'paused', 'ended', 'cancelled'];
  if (!allowed.includes(status)) throw badRequest('Status inválido');
  const event = await assertEventManage(user.id, eventId);

  // Publicar sem capa é proibido.
  //
  // A vitrine é a porta de entrada do produto: um evento sem imagem entre os
  // outros derruba a percepção de todos — e a produtora que publica assim
  // vende menos sem entender por quê. A regra vale só na TRANSIÇÃO para
  // publicado: rascunho segue sem capa, e evento já no ar não é derrubado.
  //
  // A checagem mora aqui, não na tela: bloquear só no botão seria contornável
  // chamando a API direto.
  if (status === 'published' && !event.cover_url) {
    throw badRequest(
      'Adicione a capa do evento antes de publicar. '
      + 'A imagem é a primeira coisa que a pessoa vê na vitrine e no ingresso.',
    );
  }

  const { data, error } = await repo.updateEventStatus(eventId, status);
  if (error) throw error;
  return data;
}

/** Dashboard ao vivo — métricas agregadas em SQL (RPC). */
export async function getDashboard({ user, eventId }) {
  await assertEventManage(user.id, eventId);
  const { data: metrics, error: mErr } = await repo.rpcEventDashboard(eventId);
  if (mErr) throw mErr;
  const { data: tiers } = await repo.findTiersByEvent(eventId);
  const { data: recent } = await repo.findRecentPaidOrders(eventId);
  return { metrics, tiers: tiers ?? [], recent_orders: recent ?? [] };
}

/** Conciliação financeira do produtor — bruto, taxas, reembolsos e repasse líquido. */
export async function getReconciliation({ user, eventId }) {
  await assertEventManage(user.id, eventId);
  const { data, error } = await repo.rpcEventReconciliation(eventId);
  if (error) throw error;

  const feePct = Number(env.asaas.platformFeePercent) || 0;
  const netSales = (data.tickets_gross_cents || 0) - (data.refunds_cents || 0);
  const platformFee = Math.round((netSales * feePct) / 100);
  return {
    ...data,
    platform_fee_percent: feePct,
    net_sales_cents: netSales,
    platform_fee_cents: platformFee,
    producer_net_cents: netSales - platformFee,
  };
}

// ── Equipe do evento (RBAC) — apenas o dono gerencia ──
const STAFF_ROLES = ['manager', 'door', 'bar'];

export async function listEventStaff({ user, eventId }) {
  await assertEventOwner(user.id, eventId);
  const { data, error } = await repo.findEventStaff(eventId);
  if (error) throw error;
  return data ?? [];
}

export async function addEventStaff({ user, eventId, email, role }) {
  await assertEventOwner(user.id, eventId);
  if (!STAFF_ROLES.includes(role)) throw badRequest('Papel inválido (manager | door | bar)');

  const target = await repo.findProfileByEmail(email);
  if (!target) throw notFound('Nenhum usuário cadastrado com esse e-mail');

  const { data, error } = await repo.upsertEventStaff({
    event_id: eventId, user_id: target.id, role, created_by: user.id,
  });
  if (error) throw error;
  return data;
}

export async function removeEventStaff({ user, eventId, staffId }) {
  await assertEventOwner(user.id, eventId);
  const { error } = await repo.deleteEventStaff(staffId, eventId);
  if (error) throw error;
  return { removed: true };
}

// ═══════════════════ CAPA DO EVENTO ═══════════════════

const EXTENSOES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' };

/**
 * Autoriza o envio da capa e devolve uma URL assinada.
 *
 * O arquivo vai DIRETO do navegador para o Storage — não passa pela API de
 * propósito: imagem de 5 MB subindo por aqui ocuparia processo que deveria
 * estar validando ingresso na porta. O backend decide quem pode enviar e
 * sob qual caminho; o Storage impõe tipo e tamanho.
 */
export async function createCoverUpload({ user, eventId, contentType }) {
  const event = await assertEventAccess(user.id, eventId, ['manager']);
  const ext = EXTENSOES[contentType];
  if (!ext) throw badRequest('Formato não aceito. Use JPG, PNG, WebP ou AVIF.');

  // Nome novo a cada envio: se reaproveitasse o mesmo, o CDN continuaria
  // servindo a capa antiga por horas e a produtora acharia que não subiu.
  const path = `${eventId}/${Date.now()}.${ext}`;
  const { data, error } = await repo.createCoverUploadUrl(path);
  if (error) throw error;
  return { path, signed_url: data.signedUrl, token: data.token };
}

/** Confirma o envio: grava a URL pública no evento e limpa a capa anterior. */
export async function confirmCover({ user, eventId, path }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  // O caminho precisa pertencer a ESTE evento — senão bastaria informar o
  // caminho da capa de outra produtora para roubá-la.
  if (!String(path).startsWith(`${eventId}/`)) throw badRequest('Caminho inválido para este evento');

  const { data: anterior } = await repo.findEvent(eventId);
  const { data: pub } = repo.publicCoverUrl(path);
  const { data, error } = await repo.updateEventCover(eventId, pub.publicUrl);
  if (error) throw error;

  // Capa antiga vira lixo pago: remove depois de trocar, e falha aqui não
  // desfaz a troca — o evento já está com a capa nova.
  const antigo = extrairCaminho(anterior?.cover_url);
  if (antigo && antigo !== path) {
    repo.removeCover([antigo]).catch((e) => logger.warn('capa: falha ao remover a anterior', { error: e.message }));
  }
  return data;
}

/** Remove a capa e volta ao fundo padrão. */
export async function removeCoverFromEvent({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data: event } = await repo.findEvent(eventId);
  const caminho = extrairCaminho(event?.cover_url);
  const { data } = await repo.updateEventCover(eventId, null);
  if (caminho) {
    repo.removeCover([caminho]).catch((e) => logger.warn('capa: falha ao remover', { error: e.message }));
  }
  return data;
}

/** Extrai `<evento>/<arquivo>` de uma URL pública do Storage. */
function extrairCaminho(url) {
  if (!url) return null;
  const m = /\/event-covers\/(.+)$/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}
