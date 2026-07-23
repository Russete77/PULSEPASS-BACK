// modules/door/service.js — porta (check-in online/offline) + PDV do bar.
import { notFound, badRequest } from '../../utils/ApiError.js';
import { placeBarOrder } from '../cashless/service.js';
import { assertEventAccess } from '../identity/access.js';
import { isRotatingToken, verifyQrToken } from '../../lib/qr.js';
import * as repo from './repo.js';

// Papéis por superfície operacional (dono sempre tem acesso).
const ROLE_DOOR = ['door', 'manager'];
const ROLE_BAR = ['bar', 'manager'];

/**
 * Valida e CONSOME um ingresso (uso interno — sem checagem de acesso).
 * Idempotente: o update condicional por status='valid' evita dupla entrada.
 */
async function consumeTicket(eventId, input, when) {
  if (!input) return { result: 'invalid', message: 'Código vazio' };

  const raw = String(input).trim();
  let ticket, error, tokenCheck;

  if (isRotatingToken(raw)) {
    // QR ROTATIVO: busca por id, valida assinatura+expiração com o qr_secret do banco.
    const id = raw.split(':')[1];
    ({ data: ticket, error } = await repo.findTicketById(id));
    if (error) throw error;
    if (ticket) tokenCheck = verifyQrToken(raw, () => ticket.qr_secret);
  } else if (raw.startsWith('PULSEPASS:')) {
    const [, id, secret] = raw.split(':');
    ({ data: ticket, error } = await repo.findTicketForCheckin({ id, secret }));
    if (error) throw error;
  } else {
    ({ data: ticket, error } = await repo.findTicketForCheckin({ code: raw.toUpperCase() }));
    if (error) throw error;
  }

  if (!ticket) return { result: 'invalid', message: 'Ingresso não encontrado' };
  if (tokenCheck && !tokenCheck.ok) {
    if (tokenCheck.reason === 'expired')
      return { result: 'expired', message: 'QR expirado — peça o cliente atualizar a tela' };
    return { result: 'invalid', message: 'QR inválido' };
  }
  if (ticket.event_id !== eventId) return { result: 'wrong_event', message: 'Ingresso de outro evento' };
  if (ticket.status === 'used')
    return { result: 'already_used', message: 'Ingresso já utilizado',
             checked_in_at: ticket.checked_in_at, holder: ticket.profiles?.full_name, tier: ticket.ticket_tiers?.name };
  if (ticket.status !== 'valid') return { result: 'invalid', message: `Ingresso ${ticket.status}` };

  const now = when || new Date().toISOString();
  const { data: updated, error: uErr } = await repo.consumeTicketRow(ticket.id, now);
  if (uErr) throw uErr;
  if (!updated) return { result: 'already_used', message: 'Ingresso já utilizado' };

  return { result: 'ok', message: 'Entrada liberada', code: ticket.code,
           holder: ticket.profiles?.full_name, tier: ticket.ticket_tiers?.name, checked_in_at: now };
}

/** Check-in na porta. Aceita código (PP-XXXX-XXXX) ou payload PULSEPASS:<id>:<secret>. */
export async function checkIn({ user, eventId, input }) {
  await assertEventAccess(user.id, eventId, ROLE_DOOR);
  return consumeTicket(eventId, input);
}

/** MODO OFFLINE — manifesto do evento (todos os ingressos p/ validação local). */
export async function eventManifest({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ROLE_DOOR);
  const { data, error } = await repo.findManifestTickets(eventId);
  if (error) throw error;
  return {
    event_id: eventId,
    generated_at: new Date().toISOString(),
    count: data?.length ?? 0,
    tickets: (data ?? []).map((t) => ({
      id: t.id, code: t.code, qr_secret: t.qr_secret, status: t.status,
      holder: t.profiles?.full_name ?? null, tier: t.ticket_tiers?.name ?? null,
    })),
  };
}

/** MODO OFFLINE — sincroniza a fila de check-ins feitos sem internet. */
export async function checkInBatch({ user, eventId, scans }) {
  await assertEventAccess(user.id, eventId, ROLE_DOOR);
  if (!Array.isArray(scans) || scans.length === 0) return { processed: 0, results: [] };

  const results = [];
  for (const s of scans) {
    try {
      const r = await consumeTicket(eventId, s.input, s.scanned_at);
      results.push({ client_id: s.client_id ?? null, ...r });
    } catch (err) {
      results.push({ client_id: s.client_id ?? null, result: 'error', message: err.message });
    }
  }
  return { processed: results.length, results };
}

export async function eventMenu({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ROLE_BAR);
  const { data, error } = await repo.findEventMenu(eventId);
  if (error) throw error;
  return data ?? [];
}

export async function walletLookup({ user, eventId, email }) {
  await assertEventAccess(user.id, eventId, ROLE_BAR);
  if (!email) throw badRequest('Informe o e-mail do cliente');
  const target = await repo.findProfileByEmail(email);
  if (!target) throw notFound('Cliente não encontrado com esse e-mail');

  const { data: wallet } = await repo.findWalletBalance(target.id);
  return { customer_id: target.id, email: target.email, balance_cents: wallet?.balance_cents ?? 0 };
}

/** PDV: operador debita o saldo do cliente (RPC transacional, idempotente). */
export async function pdvCharge({ user, eventId, email, items, idempotencyKey = null }) {
  await assertEventAccess(user.id, eventId, ROLE_BAR);
  const target = await repo.findProfileByEmail(email);
  if (!target) throw notFound('Cliente não encontrado');
  // operatorId = o staff que operou o PDV (para o fechamento de caixa).
  return placeBarOrder({ buyerId: target.id, eventId, items, idempotencyKey, operatorId: user.id });
}
