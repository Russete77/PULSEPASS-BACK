// modules/guestlist/service.js — regra do domínio Guest list / promoters.
import { notFound, badRequest, conflict } from '../../utils/ApiError.js';
import { assertEventAccess } from '../identity/access.js';
import * as repo from './repo.js';

function genCode(name) {
  const base = String(name).toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 12);
  return `${base || 'promo'}${Math.random().toString(36).slice(2, 6)}`;
}

// Guest list (AZList): dono, manager ou porta podem operar.
async function assertEventOwner(userId, eventId) {
  return assertEventAccess(userId, eventId, ['manager', 'door']);
}

/* PÚBLICO */
export async function getListByCode(code) {
  const { data: promoter, error } = await repo.findPromoterByCodePublic(code);
  if (error) throw error;
  if (!promoter) throw notFound('Lista não encontrada');
  return {
    promoter: { name: promoter.name, code: promoter.code, list_type: promoter.list_type, free_until: promoter.free_until },
    event: promoter.events,
  };
}

/** Beacon de clique no link do promoter (público, best-effort). */
export async function registerHit(code) {
  await repo.rpcIncrementHit(code);
  return { ok: true };
}

export async function signup({ code, name, email, phone, partySize = 1 }) {
  if (!name || name.trim().length < 2) throw badRequest('Informe seu nome');
  const { data: promoter } = await repo.findPromoterByCode(code);
  if (!promoter) throw notFound('Lista não encontrada');

  const { data, error } = await repo.insertGuest({
    promoter_id: promoter.id, event_id: promoter.event_id,
    name: name.trim(), email: email?.trim() || null, phone: phone?.trim() || null, status: 'confirmed',
    party_size: Math.max(1, Math.min(20, Number(partySize) || 1)),
  });
  if (error) throw error;
  return { id: data.id, name: data.name, status: data.status, party_size: data.party_size };
}

/* ADMIN */
export async function createPromoter({ user, eventId, name, commissionCents, email, goalCheckins, listType, freeUntil }) {
  const event = await assertEventOwner(user.id, eventId);
  if (!name || name.trim().length < 2) throw badRequest('Nome do promoter inválido');
  // Vincula a uma conta (por e-mail) → habilita o portal do promoter.
  let profileId = null;
  if (email && email.trim()) {
    const profile = await repo.findProfileByEmail(email.trim());
    if (!profile) throw badRequest('Nenhum usuário cadastrado com esse e-mail (peça para o promoter criar conta antes)');
    profileId = profile.id;
  }
  const { data, error } = await repo.insertPromoter({
    organization_id: event.organization_id, event_id: eventId, name: name.trim(),
    code: genCode(name), commission_cents: Math.max(0, Math.round(Number(commissionCents) || 0)),
    profile_id: profileId,
    goal_checkins: goalCheckins != null ? Math.max(0, Math.round(Number(goalCheckins))) : null,
    list_type: ['standard', 'free_until', 'birthday', 'vip'].includes(listType) ? listType : 'standard',
    free_until: (listType === 'free_until' && freeUntil) ? freeUntil : null,
  });
  if (error) throw error;
  return data;
}

/* PORTAL DO PROMOTER (self-service, autenticado como o próprio promoter) */
export async function getMyPromoterDashboard({ user }) {
  const { data, error } = await repo.rpcPromoterDashboard(user.id);
  if (error) throw error;
  return (data ?? []).map((p) => ({
    promoter_id: p.promoter_id, name: p.name, code: p.code,
    event: { id: p.event_id, title: p.event_title, slug: p.event_slug, starts_at: p.event_starts_at, status: p.event_status },
    commission_cents: p.commission_cents, clicks: Number(p.clicks), goal_checkins: p.goal_checkins ?? null,
    confirmed: Number(p.confirmed), checked_in: Number(p.checked_in),
    commission_due_cents: Number(p.commission_due_cents),
    commission_paid_at: p.commission_paid_at ?? null,
  }));
}

export async function getMyPromoterGuests({ user, promoterId }) {
  const { data: owned } = await repo.findPromoterOwned(promoterId, user.id);
  if (!owned) throw notFound('Promoter não encontrado');
  const { data, error } = await repo.findGuestsByPromoter(promoterId);
  if (error) throw error;
  return { promoter: { id: owned.id, name: owned.name }, guests: data ?? [] };
}

/** Promoters + agregados (contagem/comissão) calculados em SQL via RPC. */
export async function listPromoters({ user, eventId }) {
  await assertEventOwner(user.id, eventId);
  const { data, error } = await repo.rpcEventPromoters(eventId);
  if (error) throw error;
  return (data ?? []).map((p) => ({
    id: p.id, name: p.name, code: p.code, commission_cents: p.commission_cents,
    clicks: Number(p.clicks), goal_checkins: p.goal_checkins ?? null,
    confirmed: Number(p.confirmed), checked_in: Number(p.checked_in),
    commission_due_cents: Number(p.commission_due_cents),
    commission_paid_at: p.commission_paid_at ?? null,
  }));
}

export async function listGuests({ user, promoterId }) {
  const { data: promoter } = await repo.findPromoter(promoterId);
  if (!promoter) throw notFound('Promoter não encontrado');
  await assertEventOwner(user.id, promoter.event_id);
  const { data, error } = await repo.findGuestsByPromoter(promoterId);
  if (error) throw error;
  return { promoter: { id: promoter.id, name: promoter.name }, guests: data ?? [] };
}

/** Lista TODOS os convidados de um evento (portaria: busca por nome + check-in). */
export async function listEventGuests({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['door', 'manager']);
  const { data, error } = await repo.findGuestsByEvent(eventId);
  if (error) throw error;
  return (data ?? []).map((g) => ({
    id: g.id, name: g.name, email: g.email, phone: g.phone,
    status: g.status, checked_in_at: g.checked_in_at, promoter: g.promoters?.name ?? null,
    // O porteiro precisa ver o grupo, não só a linha: "João +2, entraram 1".
    party_size: g.party_size ?? 1, checked_in_count: g.checked_in_count ?? 0,
  }));
}

/**
 * Check-in de convidado, com acompanhantes.
 * `people` é quantas pessoas do convite estão entrando AGORA — o grupo
 * raramente chega junto, então chegada parcial é o caso comum, não exceção.
 */
export async function checkInGuest({ user, guestId, people = 1 }) {
  const { data: guest } = await repo.findGuestForCheckin(guestId);
  if (!guest) throw notFound('Convidado não encontrado');
  // Porteiro (door) ou manager podem dar check-in — não só o dono.
  await assertEventAccess(user.id, guest.event_id, ['door', 'manager']);

  const { data, error } = await repo.rpcGuestCheckIn(guestId, people);
  if (error) {
    if (String(error.message).includes('GUEST_CANCELLED')) throw conflict('Convite cancelado');
    if (String(error.message).includes('INVALID_PEOPLE')) throw badRequest('Quantidade inválida');
    throw error;
  }
  return data;
}

/** Resumo da lista em PESSOAS (não linhas) — é assim que a casa conta lotação. */
export async function guestlistSummary({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['door', 'manager']);
  const { data, error } = await repo.rpcGuestlistSummary(eventId);
  if (error) throw error;
  return data ?? {};
}

/** Marca (ou desmarca) a comissão de um promoter como paga. */
export async function setCommissionPaid({ user, promoterId, paid = true }) {
  const { data: promoter } = await repo.findPromoter(promoterId);
  if (!promoter) throw notFound('Promoter não encontrado');
  await assertEventOwner(user.id, promoter.event_id);
  const { data, error } = await repo.updateCommissionPaid(promoterId, paid ? new Date().toISOString() : null);
  if (error) throw error;
  return data;
}
