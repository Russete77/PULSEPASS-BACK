// modules/tables/service.js — camarotes/mesas + reservas.
import { notFound, badRequest } from '../../utils/ApiError.js';
import { assertEventAccess } from '../identity/access.js';
import * as repo from './repo.js';

const STATUSES = ['requested', 'confirmed', 'rejected', 'cancelled'];

/* ── PÚBLICO ── */
export async function listPublicTables(slug) {
  const { data: event } = await repo.findEventBySlug(slug);
  if (!event || event.status !== 'published') throw notFound('Evento indisponível');
  const { data, error } = await repo.findPublicTables(event.id);
  if (error) throw error;
  return { event_id: event.id, tables: data ?? [] };
}

export async function requestReservation({ user, tableId, name, contact, partySize }) {
  if (!name || name.trim().length < 2) throw badRequest('Informe seu nome');
  const { data: table } = await repo.findTableWithEvent(tableId);
  if (!table || !table.active || table.events?.status !== 'published') throw notFound('Camarote indisponível');
  const { data, error } = await repo.insertReservation({
    table_id: tableId, event_id: table.event_id, profile_id: user?.id ?? null,
    name: name.trim(), contact: contact?.trim() || null,
    party_size: partySize != null ? Math.max(1, Math.round(Number(partySize))) : null,
    status: 'requested',
  });
  if (error) throw error;
  return data;
}

/* ── ADMIN (produtor) ── */
export async function listTables({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.adminListTables(eventId);
  if (error) throw error;
  return data ?? [];
}

export async function createTable({ user, eventId, table }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  if (!table.name || table.name.trim().length < 1) throw badRequest('Nome do camarote obrigatório');
  const { data, error } = await repo.adminInsertTable({
    event_id: eventId, name: table.name.trim(), area: table.area || 'Camarote',
    capacity: table.capacity != null ? Math.max(1, Math.round(Number(table.capacity))) : null,
    min_spend_cents: Math.max(0, Math.round(Number(table.min_spend_cents) || 0)),
    active: table.active !== false, position: table.position ?? 0,
  });
  if (error) throw error;
  return data;
}

async function assertTableAccess(user, tableId) {
  const { data: t } = await repo.findTableEvent(tableId);
  if (!t) throw notFound('Camarote não encontrado');
  await assertEventAccess(user.id, t.event_id, ['manager']);
}

export async function deleteTable({ user, tableId }) {
  await assertTableAccess(user, tableId);
  const { error } = await repo.adminDeleteTable(tableId);
  if (error) throw error;
  return { removed: true };
}

export async function listReservations({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.adminListReservations(eventId);
  if (error) throw error;
  return data ?? [];
}

export async function setReservationStatus({ user, reservationId, status }) {
  if (!STATUSES.includes(status)) throw badRequest('Status inválido');
  const { data: r } = await repo.findReservationEvent(reservationId);
  if (!r) throw notFound('Reserva não encontrada');
  await assertEventAccess(user.id, r.event_id, ['manager']);
  const { data, error } = await repo.updateReservationStatus(reservationId, status);
  if (error) throw error;
  return data;
}
