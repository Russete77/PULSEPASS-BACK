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
/**
 * Transfere a titularidade do ingresso.
 *
 * A troca inteira mora numa RPC porque duas coisas precisam acontecer juntas
 * ou não acontecer: passar o dono e ROTACIONAR code + qr_secret. Antes disso
 * a aplicação só trocava o owner_id — e o print do QR no celular de quem
 * transferiu continuava abrindo a porta. Quem recebia chegava e ouvia "já
 * foi usado", porque o remetente tinha entrado com o mesmo ingresso.
 */
export async function transferTicket({ user, ticketId, toEmail }) {
  if (!toEmail || !toEmail.includes('@')) throw badRequest('E-mail inválido');

  const { data, error } = await repo.rpcTransferir(ticketId, user.id, toEmail);
  if (error) {
    const m = error.message ?? '';
    if (m.includes('INGRESSO_NAO_ENCONTRADO')) throw notFound('Ingresso não encontrado');
    if (m.includes('NAO_E_SEU')) throw notFound('Ingresso não encontrado');
    if (m.includes('JA_USADO')) throw conflict('Esse ingresso já entrou no evento — não dá para transferir depois da entrada.');
    if (m.includes('INGRESSO_INVALIDO')) throw conflict('Só ingresso válido pode ser transferido.');
    if (m.includes('PARA_SI_MESMO')) throw badRequest('Esse e-mail já é o seu.');
    throw error;
  }

  return {
    status: data.status,
    delivered: data.entregue,
    code_novo: data.code_novo ?? null,
    message: data.entregue
      ? `Ingresso transferido para ${data.para}. Seu QR antigo deixou de valer agora.`
      : 'Guardado para esse e-mail. O ingresso segue com você até a pessoa criar a conta — aí ele passa automaticamente.',
  };
}
