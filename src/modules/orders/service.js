// modules/orders/service.js — checkout de ingressos (PIX/cartão/cupom/split),
// confirmação de pagamento, entrega e reembolso. Fala com o banco só via repo.
import { notFound, badRequest, conflict, ApiError } from '../../utils/ApiError.js';
import { externalRef } from '../../utils/codes.js';
import { env } from '../../config/env.js';
import * as asaas from '../payments/provider.js';
import { deliverTickets, deliveriesForOrder } from '../notifications/service.js';
import { issueForOrder, cancelForOrder as cancelFiscalForOrder } from '../fiscal/service.js';
import { inviteForOrder as inviteWaitlistForOrder } from '../waitlist/service.js';
import { despacharEmSegundoPlano } from '../integracoes/service.js';
import { logger } from '../../lib/logger.js';
import * as repo from './repo.js';

/** Mapeia erros das RPCs Postgres para mensagens HTTP amigáveis. */
function mapDbError(message) {
  if (!message) return null;
  if (message.includes('EVENT_UNAVAILABLE')) return notFound('Evento indisponível');
  if (message.includes('INVALID_QTY')) return badRequest('Quantidade inválida');
  if (message.includes('TIER_INVALID')) return badRequest('Lote inválido para este evento');
  if (message.includes('TIER_NOT_ON_SALE')) return conflict('Lote não está à venda');
  if (message.includes('OVER_MAX')) return badRequest('Quantidade acima do máximo por pedido');
  if (message.includes('SOLD_OUT')) return conflict('Lote esgotado');
  return null;
}

/** Aplica desconto do cupom sobre um total em centavos. */
function applyDiscount(totalCents, kind, value) {
  if (kind === 'percent') return Math.max(0, Math.round(totalCents * (1 - value / 100)));
  return Math.max(0, totalCents - value); // fixed (centavos)
}

export async function createOrder({
  user, profile, items, eventSlug, couponCode, seatIds = null,
  paymentMethod = 'pix', installmentCount, card, holderInfo, remoteIp,
  idempotencyKey = null,
}) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Pedido sem itens');
  if (paymentMethod === 'card' && (!card || !holderInfo)) {
    throw badRequest('Pagamento no cartão exige dados do cartão e do titular');
  }

  const { data: event, error: eErr } = await repo.findEventForCheckout(eventSlug);
  if (eErr) throw eErr;
  if (!event || event.status !== 'published') throw notFound('Evento indisponível');

  // Split/repasse: plataforma retém a taxa, produtora recebe o resto.
  //
  // A taxa é resolvida aqui e CONGELADA no pedido. Sem isso, mudar a taxa
  // amanhã reescreveria o resultado de todos os eventos já realizados — e o
  // relatório que a produtora conferiu na segunda mudaria sozinho na terça.
  const producerWalletId = event.organizations?.asaas_wallet_id ?? null;
  const { data: feeBps } = await repo.rpcEffectiveFee(event.organizations?.id ?? event.organization_id);
  const feePercent = Number(feeBps ?? env.asaas.platformFeePercent * 100) / 100;
  const split = asaas.buildSplit(producerWalletId, feePercent);

  // 1) reserva atômica + pedido pending (idempotente por Idempotency-Key)
  const { data: placed, error: pErr } = await repo.rpcPlaceOrder({
    buyerId: user.id, eventId: event.id, items, idempotencyKey,
  });
  if (pErr) {
    const mapped = mapDbError(pErr.message);
    if (mapped) throw mapped;
    throw pErr;
  }
  const row = Array.isArray(placed) ? placed[0] : placed;
  const orderId = row.order_id;
  let totalCents = row.total_cents;

  // Replay idempotente: devolve a cobrança criada antes, sem nova cobrança Asaas.
  if (row.is_replay) {
    const { data: existing } = await repo.findReplayOrder(orderId);
    const base = {
      id: existing.id, status: existing.status, total_cents: existing.total_cents,
      event_id: existing.event_id, idempotent_replay: true,
    };
    if (existing.pix_payload) {
      return { ...base, payment_method: 'pix',
        pix: { payload: existing.pix_payload, qr_base64: existing.pix_qr_base64, expiration: existing.pix_expiration } };
    }
    return { ...base, payment_method: 'card' };
  }

  // Congela a taxa aplicada nesta venda (ver comentário do split acima).
  await repo.setOrderFee(orderId, Math.round(feePercent * 100));

  try {
    // 1.4) assentos marcados — antes de qualquer cobrança.
    //
    // Vem primeiro de propósito: se a reserva de 8 minutos venceu enquanto a
    // pessoa preenchia o cartão, é melhor recusar aqui do que cobrar e só
    // então descobrir que a poltrona é de outro. O catch abaixo desfaz o
    // pedido pendente e devolve o estoque.
    if (Array.isArray(seatIds) && seatIds.length) {
      // A conta tem que fechar: um assento por ingresso.
      //
      // Sem esta checagem dava para reservar duas poltronas e comprar um
      // ingresso — a segunda ficaria vendida sem ninguém para sentar nela — ou
      // comprar cinco ingressos com duas poltronas, e três pessoas chegariam
      // na casa sem lugar. A tela de assentos não amarra isso porque a
      // quantidade é escolhida na página do evento, em outro passo.
      const ingressos = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
      if (ingressos !== seatIds.length) {
        throw badRequest(
          `Você escolheu ${seatIds.length} ${seatIds.length === 1 ? 'lugar' : 'lugares'} `
          + `e ${ingressos} ${ingressos === 1 ? 'ingresso' : 'ingressos'}. `
          + 'Em evento com lugar marcado os dois números precisam bater.',
        );
      }

      const { error: sErr } = await repo.rpcVincularAssentos({ orderId, userId: user.id, seatIds });
      if (sErr) {
        if (/RESERVA_EXPIRADA_OU_ALHEIA/.test(sErr.message)) {
          throw conflict('A reserva dos assentos expirou. Volte ao mapa e escolha de novo.');
        }
        throw sErr;
      }
    }

    // 1.5) cupom (redenção atômica) — ajusta o total a cobrar
    if (couponCode) {
      const { data: red, error: cErr } = await repo.rpcRedeemCoupon(event.id, couponCode);
      if (cErr) {
        const map = { COUPON_INVALID: 'Cupom inválido', COUPON_INACTIVE: 'Cupom inativo', COUPON_EXPIRED: 'Cupom expirado', COUPON_EXHAUSTED: 'Cupom esgotado' };
        const key = Object.keys(map).find((k) => cErr.message.includes(k));
        throw badRequest(key ? map[key] : 'Cupom inválido');
      }
      const c = Array.isArray(red) ? red[0] : red;
      const discounted = applyDiscount(totalCents, c.kind, c.value);
      const discountCents = totalCents - discounted;
      totalCents = discounted;
      await repo.updateOrderCoupon(orderId, { total_cents: totalCents, coupon_code: couponCode, discount_cents: discountCents });
    }

    // 2) cobrança Asaas
    const ref = externalRef('ord');
    const customer = await asaas.createCustomer({
      name: profile?.full_name || user.email || 'Cliente PulsePass',
      cpfCnpj: profile?.cpf || undefined,
      email: user.email,
      externalReference: user.id,
    });
    const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const value = Number((totalCents / 100).toFixed(2));
    const description = `Ingressos · ${event.title}`;

    // ── CARTÃO ──
    if (paymentMethod === 'card') {
      const tok = await asaas.tokenizeCard({
        customer: customer.id,
        creditCard: {
          holderName: card.holderName, number: card.number,
          expiryMonth: card.expiryMonth, expiryYear: card.expiryYear, ccv: card.ccv,
        },
        creditCardHolderInfo: holderInfo,
        remoteIp,
      });
      const payment = await asaas.createCardPayment({
        customer: customer.id, value, dueDate, description, externalReference: ref,
        installmentCount, remoteIp, split, creditCardToken: tok.creditCardToken,
      });

      const { error: aErr } = await repo.rpcAttachPayment({
        p_order: orderId, p_customer: customer.id, p_payment: payment.id, p_ref: ref,
        p_payload: null, p_qr: null, p_expiration: null,
      });
      if (aErr) throw aErr;

      let paid = false;
      if (['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'].includes(payment.status)) {
        await markOrderPaidByPaymentId(payment.id, totalCents).catch(() => {});
        paid = true;
      }
      return {
        id: orderId, status: paid ? 'paid' : 'pending', total_cents: totalCents,
        event_id: event.id, payment_method: 'card',
        installments: payment.installmentCount ?? installmentCount ?? 1,
        card: { brand: tok.creditCardBrand, last4: tok.creditCardNumber },
      };
    }

    // ── PIX (default) ──
    const payment = await asaas.createPixPayment({
      customer: customer.id, value, dueDate, description, externalReference: ref, split,
    });
    const qr = await asaas.getPixQrCode(payment.id);

    const { error: aErr } = await repo.rpcAttachPayment({
      p_order: orderId, p_customer: customer.id, p_payment: payment.id, p_ref: ref,
      p_payload: qr.payload, p_qr: qr.encodedImage, p_expiration: qr.expirationDate,
    });
    if (aErr) throw aErr;

    return {
      id: orderId, status: 'pending', total_cents: totalCents, event_id: event.id,
      payment_method: 'pix',
      pix: { payload: qr.payload, qr_base64: qr.encodedImage, expiration: qr.expirationDate },
    };
  } catch (err) {
    // Libera o estoque cedo, sem esperar o expiry.
    //
    // A limpeza vai no próprio try. O builder do Supabase não expõe `.catch`,
    // então `rpcExpirePending().catch(...)` lançava TypeError AQUI DENTRO, e
    // esse erro substituía o original. Na prática toda falha de checkout
    // chegava ao cliente como "Falha ao gerar cobrança" — inclusive as que
    // tinham mensagem própria: cupom inválido, lote esgotado, reserva de
    // assento vencida. O motivo real nunca saía do servidor.
    try {
      await repo.cancelPendingOrder(orderId);
      await repo.rpcExpirePending();
    } catch { /* best-effort; o expiry automático cobre o que sobrar */ }

    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'Falha ao gerar cobrança. Tente novamente.');
  }
}

export async function listMyOrders({ user, limit = 50, offset = 0 }) {
  const { data, error } = await repo.findMyOrders(user.id, { limit, offset });
  if (error) throw error;
  return data;
}

export async function getOrder({ user, orderId }) {
  const { data: order, error } = await repo.findOrderForUser(orderId, user.id);
  if (error) throw error;
  if (!order) throw notFound('Pedido não encontrado');
  return order;
}

/**
 * Confirma pagamento e emite ingressos (idempotente via RPC).
 * Opcional: reconciliação de valor (paidValueCents) — recusa se divergir.
 */
export async function markOrderPaidByPaymentId(asaasPaymentId, paidValueCents = null) {
  if (paidValueCents != null) {
    const { data: order } = await repo.findOrderByPaymentId(asaasPaymentId);
    if (order && order.status !== 'paid' && Math.abs(order.total_cents - paidValueCents) > 0) {
      logger.warn('webhook: valor divergente', { orderId: order.id, esperado: order.total_cents, pago: paidValueCents });
      return { found: true, mismatch: true };
    }
  }
  const { data, error } = await repo.rpcConfirmOrderPayment(asaasPaymentId);
  if (error) throw error;

  // Entrega os ingressos por e-mail só na PRIMEIRA confirmação (idempotente).
  if (data?.found && !data.alreadyProcessed && data.orderId) {
    deliverForOrder(data.orderId).catch((e) => logger.warn('entrega: falhou', { error: e.message }));

    // Nota fiscal: só quando a produtora liga FISCAL_AUTO_ISSUE. Emitir nota é
    // ato com efeito legal — não pode ser ligado por padrão sem a casa pedir.
    // Falha aqui não desfaz o pagamento: fica registrada e é reemitida depois.
    if (env.fiscal.autoIssue) {
      issueForOrder(data.orderId).catch((e) => logger.warn('fiscal: emissão automática falhou', { error: e.message }));
    }
  }
  return data;
}

/** Busca dados do pedido pago e envia os ingressos ao comprador. */
async function deliverForOrder(orderId) {
  const { data: order } = await repo.findOrderForDelivery(orderId);
  if (!order) return { sent: false, reason: 'order_not_found' };
  const { data: tickets } = await repo.findTicketsForDelivery(orderId);
  if (!tickets?.length) return { sent: false, reason: 'no_tickets' };
  return deliverTickets({
    to: order.profiles?.email,
    event: { title: order.events?.title },
    tickets,
    orderId,
  });
}

/**
 * Reenvia os ingressos de um pedido pago. É o que o suporte aciona quando o
 * cliente diz "não recebi" — sem isso a única saída era mexer no banco na mão.
 * Só o dono do pedido reenvia, e só para o próprio e-mail.
 */
export async function resendTickets({ user, orderId }) {
  const { data: order } = await repo.findOrderForDelivery(orderId);
  if (!order) throw notFound('Pedido não encontrado');
  if (order.buyer_id !== user.id) throw notFound('Pedido não encontrado');
  if (order.status !== 'paid') throw badRequest('Só pedidos pagos têm ingressos para enviar');

  const result = await deliverForOrder(orderId);
  return {
    sent: result.sent,
    reason: result.reason ?? null,
    history: await deliveriesForOrder(orderId),
  };
}

/** Reembolso de pedido pago (iniciado pelo comprador). */
export async function refundOrder({ user, orderId }) {
  const { data: order } = await repo.findOrderForRefund(orderId, user.id);
  if (!order) throw notFound('Pedido não encontrado');
  if (order.status === 'refunded') return { refunded: true, alreadyRefunded: true };
  if (order.status !== 'paid') throw badRequest('Só pedidos pagos podem ser reembolsados');

  if (order.asaas_payment_id) {
    await asaas.refundPayment(order.asaas_payment_id).catch((e) => {
      throw new ApiError(502, `Falha no estorno do pagamento: ${e.message}`);
    });
  }
  const { data, error } = await repo.rpcRefundOrder(orderId);
  if (error) throw error;

  // Dinheiro devolvido, nota cancelada. Deixar NFS-e ativa sobre venda
  // estornada é o tipo de inconsistência que aparece na apuração do mês.
  cancelFiscalForOrder(orderId, 'Pedido reembolsado')
    .catch((e) => logger.warn('fiscal: cancelamento falhou', { orderId, error: e.message }));

  // O estoque voltou: chama a fila de espera. Sem isso a vaga reabre de
  // madrugada, ninguém vê, e o ingresso morre encalhado.
  inviteWaitlistForOrder(orderId)
    .catch((e) => logger.warn('fila: convite após reembolso falhou', { orderId, error: e.message }));

  return data;
}

/**
 * Reverte um pedido cujo pagamento voltou (estorno, chargeback, reprovação de
 * risco). Cancela os ingressos ainda não usados e devolve o estoque ao lote.
 *
 * Para quem JÁ ENTROU no evento não existe desfazer: a RPC abre um caso de
 * fraude para a produtora decidir. Dizer que "cancelamos" seria mentira, e a
 * casa precisa saber que alguém assistiu ao show sem pagar.
 */
export async function reverseOrderByPaymentId(asaasPaymentId, kind, reason = null) {
  const { data, error } = await repo.rpcReverseOrder(asaasPaymentId, kind, reason);
  if (error) throw error;

  // Ingresso cancelado devolve vaga ao lote → chama a fila de espera.
  if (data?.found && data.tickets_cancelled > 0) {
    inviteWaitlistForOrder(data.order_id)
      .catch((e) => logger.warn('fila: convite após reversão falhou', { error: e.message }));
    cancelFiscalForOrder(data.order_id, `Pagamento revertido (${kind})`)
      .catch((e) => logger.warn('fiscal: cancelamento após reversão falhou', { error: e.message }));
  }
  return data;
}
