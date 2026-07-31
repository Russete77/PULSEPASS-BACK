// modules/boxoffice/service.js — venda presencial na entrada do evento.
//
// Diferença essencial pro checkout online: aqui o dinheiro NÃO passa pelo Asaas.
// É cédula na mão, maquininha da própria casa ou Pix na chave do dono. Então o
// pedido nasce e é liquidado na mesma chamada, com trilha de quem vendeu.
import { badRequest, notFound, conflict } from '../../utils/ApiError.js';
import { logger } from '../../lib/logger.js';
import { assertEventAccess } from '../identity/access.js';
import { deliverTickets } from '../notifications/service.js';
import * as repo from './repo.js';

const METHODS = new Set(['cash', 'card_machine', 'pix_manual', 'courtesy']);

/** Erros das RPCs → mensagens que o bilheteiro entende no meio da fila. */
function mapDbError(message) {
  if (!message) return null;
  if (message.includes('EVENT_UNAVAILABLE')) return notFound('Evento indisponível');
  if (message.includes('INVALID_QTY')) return badRequest('Quantidade inválida');
  if (message.includes('TIER_INVALID')) return badRequest('Lote inválido para este evento');
  if (message.includes('TIER_NOT_ON_SALE')) return conflict('Lote não está à venda');
  if (message.includes('OVER_MAX')) return badRequest('Quantidade acima do máximo por pedido');
  if (message.includes('SOLD_OUT')) return conflict('Lote esgotado');
  if (message.includes('INSUFFICIENT_PAYMENT')) return badRequest('Valor recebido é menor que o total');
  if (message.includes('ORDER_NOT_PENDING')) return conflict('Pedido já foi liquidado');
  if (message.includes('ORDER_NOT_FOUND')) return notFound('Pedido não encontrado');
  return null;
}

/**
 * Resolve quem é o dono dos ingressos.
 *  · com e-mail  → conta do próprio comprador (ingresso vai pro app dele e por e-mail);
 *                   se ainda não tem conta, ela é criada aqui — ele assume depois por
 *                   "esqueci minha senha", que é como toda bilheteria funciona.
 *  · sem e-mail  → ingresso AO PORTADOR: fica no operador, valendo pelo código
 *                   impresso, com o nome do portador gravado no ingresso.
 */
async function resolveBuyer({ operatorId, email, name }) {
  if (!email) return { buyerId: operatorId, bearer: true, email: null };

  // findProfileByEmail devolve o perfil (ou null), não um envelope { data }.
  const found = await repo.findProfileByEmail(email);
  if (found?.id) return { buyerId: found.id, bearer: false, email };

  const { data: created, error } = await repo.createBuyerUser(email, name);
  if (error) {
    // Corrida: outro caixa criou a conta com o mesmo e-mail no mesmo instante.
    const retry = await repo.findProfileByEmail(email);
    if (retry?.id) return { buyerId: retry.id, bearer: false, email };
    throw badRequest(`Não foi possível criar a conta do comprador: ${error.message}`);
  }
  return { buyerId: created.user.id, bearer: false, email };
}

/** Lotes à venda + resumo do caixa — o que a tela da bilheteria carrega ao abrir. */
export async function openRegister({ user, eventId }) {
  const event = await assertEventAccess(user.id, eventId, ['manager', 'door']);
  const [{ data: tiers, error: tErr }, { data: report }, { data: sales }] = await Promise.all([
    repo.findTiers(eventId), repo.rpcReport(eventId), repo.listSales(eventId, { limit: 20 }),
  ]);
  if (tErr) throw tErr;
  return { event, tiers: tiers ?? [], report: report ?? {}, recent_sales: sales ?? [] };
}

/** Vende e liquida na hora: reserva estoque, marca pago, emite e registra o caixa. */
export async function sell({
  user, eventId, items, method, receivedCents, buyer = {}, note,
}) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Venda sem itens');
  if (!METHODS.has(method)) throw badRequest('Forma de pagamento inválida');

  await assertEventAccess(user.id, eventId, ['manager', 'door']);

  const { data: event } = await repo.findEvent(eventId);
  if (!event || event.status !== 'published') throw notFound('Evento indisponível');

  const { buyerId, bearer, email } = await resolveBuyer({
    operatorId: user.id, email: buyer.email?.trim() || null, name: buyer.name,
  });

  // 1) Reserva atômica de estoque (mesma RPC do checkout online).
  const { data: placed, error: pErr } = await repo.rpcPlaceOrder({ buyerId, eventId, items });
  if (pErr) throw mapDbError(pErr.message) ?? pErr;
  const row = Array.isArray(placed) ? placed[0] : placed;

  // 2) Liquida presencialmente: paga, emite ingressos e grava a venda no caixa.
  const { data: settled, error: sErr } = await repo.rpcSettleOffline({
    orderId: row.order_id, operatorId: user.id, method,
    receivedCents: method === 'courtesy' ? 0 : receivedCents,
    buyerName: buyer.name ?? null, buyerDoc: buyer.doc ?? null, note: note ?? null,
  });
  if (sErr) throw mapDbError(sErr.message) ?? sErr;

  const { data: tickets } = await repo.findOrderTickets(row.order_id);

  // 3) Se deu e-mail, os ingressos seguem por e-mail também. Falha aqui NÃO
  //    derruba a venda — o dinheiro já entrou e o ingresso já existe.
  if (email && tickets?.length) {
    try {
      await deliverTickets({ to: email, event, tickets });
    } catch (e) {
      logger.warn('bilheteria: falha ao enviar ingressos por e-mail', { error: e.message, orderId: row.order_id });
    }
  }

  return {
    order_id: row.order_id,
    total_cents: settled.total_cents,
    received_cents: settled.received_cents,
    change_cents: settled.change_cents,
    method,
    bearer,                    // true = ingresso ao portador (sem conta)
    emailed: Boolean(email),
    tickets: (tickets ?? []).map((t) => ({
      id: t.id, code: t.code, tier: t.ticket_tiers?.name ?? null, holder_name: t.holder_name,
    })),
  };
}

/** Fechamento do caixa da bilheteria: total, por forma de pagamento e por operador. */
export async function report({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager', 'door']);
  const { data, error } = await repo.rpcReport(eventId);
  if (error) throw error;
  const { data: sales } = await repo.listSales(eventId, { limit: 200 });
  return { ...(data ?? {}), sales: sales ?? [] };
}
