// modules/tickets/service.js — regras de negócio do domínio Ingressos.
// Fala com o banco só via repo.js (nunca supabase direto).
import { notFound, badRequest, conflict } from '../../utils/ApiError.js';
import { ticketQrPayload, qrDataUrl, signQrToken } from '../../lib/qr.js';
import * as repo from './repo.js';

export async function listMyTickets({ user, limit = 100, offset = 0 }) {
  const { data, error } = await repo.findMyTickets(user.id, { limit, offset });
  if (error) throw error;
  return data;
}

export async function getMyTicket({ user, ticketId }) {
  const { data, error } = await repo.findMyTicketById(user.id, ticketId);
  if (error) throw error;
  if (!data) throw notFound('Ingresso nao encontrado');
  // QR real (data-URL PNG) gerado no servidor — o front só renderiza <img>.
  data.qr_payload = ticketQrPayload(data);
  data.qr_data_url = await qrDataUrl(data.qr_payload);
  return data;
}

/**
 * Emite o QR ROTATIVO (anti-golpe): token curto assinado que expira em ~30s.
 * O app chama isto a cada ~15s e troca a imagem, então um print vira inútil.
 * Só o dono do ingresso, e só se estiver 'valid'.
 */
export async function getMyTicketQrToken({ user, ticketId }) {
  const { data, error } = await repo.findMyTicketById(user.id, ticketId);
  if (error) throw error;
  if (!data) throw notFound('Ingresso nao encontrado');
  if (data.status !== 'valid') throw conflict('Ingresso não está válido para entrada');
  const { token, exp, ttl } = signQrToken(data);
  return { token, qr_data_url: await qrDataUrl(token), exp, ttl_seconds: ttl };
}

/**
 * Transfere ingresso por e-mail. Lookup via profiles (sem listUsers paginado).
 * Se o destinatario tem conta, a posse muda na hora; senao fica pendente.
 */
export async function transferTicket({ user, ticketId, toEmail }) {
  if (!toEmail || !toEmail.includes('@')) throw badRequest('E-mail invalido');

  const { data: ticket, error } = await repo.findOwnedTicket(user.id, ticketId);
  if (error) throw error;
  if (!ticket) throw notFound('Ingresso nao encontrado');
  if (ticket.status !== 'valid') throw conflict('So e possivel transferir ingressos validos');

  const target = await repo.findProfileByEmail(toEmail);

  const { data: transfer, error: trErr } = await repo.insertTransfer({
    ticket_id: ticket.id, from_user: user.id, to_email: toEmail.toLowerCase(),
    to_user: target?.id ?? null, status: target ? 'accepted' : 'pending',
    accepted_at: target ? new Date().toISOString() : null,
  });
  if (trErr) throw trErr;

  if (target) {
    await repo.setTicketOwner(ticket.id, target.id);
  }

  return {
    status: transfer.status,
    delivered: Boolean(target),
    message: target
      ? 'Ingresso transferido com sucesso.'
      : 'Convite registrado. A pessoa recebera o ingresso ao criar a conta com esse e-mail.',
  };
}
