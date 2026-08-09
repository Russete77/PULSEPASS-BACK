// modules/cashless/service.js — regra do domínio Cashless (carteira + bar).
// Fachada do módulo: outros módulos importam funções daqui, nunca o repo.
import { notFound, badRequest, conflict } from '../../utils/ApiError.js';
import { externalRef } from '../../utils/codes.js';
import * as asaas from '../payments/provider.js';
import { assertEventAccess } from '../identity/access.js';
import * as repo from './repo.js';

// ═══════════════════════ CARTEIRA ═══════════════════════

/** Garante (e retorna) a carteira do usuário para um evento (ou geral). */
export async function getOrCreateWallet(userId, eventId = null) {
  const { data: existing } = await repo.findWallet(userId, eventId ?? null);
  if (existing) return existing;
  const { data, error } = await repo.insertWallet(userId, eventId ?? null);
  if (error) throw error;
  return data;
}

export async function getWallet({ user, eventId }) {
  const wallet = await getOrCreateWallet(user.id, eventId ?? null);
  const { data: txs, error } = await repo.findWalletTransactions(wallet.id);
  if (error) throw error;
  return { ...wallet, transactions: txs };
}

export async function createTopup({
  user, profile, eventId, amountCents,
  paymentMethod = 'pix', installmentCount, card, holderInfo, remoteIp,
  idempotencyKey = null,
}) {
  if (!Number.isInteger(amountCents) || amountCents < 500)
    throw badRequest('Valor mínimo de recarga é R$ 5,00');
  if (paymentMethod === 'card' && (!card || !holderInfo))
    throw badRequest('Pagamento no cartão exige dados do cartão e do titular');

  // Replay idempotente: mesma Idempotency-Key → devolve a recarga já criada.
  if (idempotencyKey) {
    const { data: existing } = await repo.findTopupByClientRequestId(idempotencyKey, user.id);
    if (existing) {
      return {
        id: existing.id, amount_cents: existing.amount_cents, status: existing.status,
        payment_method: existing.pix_payload ? 'pix' : 'card', idempotent_replay: true,
        ...(existing.pix_payload
          ? { pix: { payload: existing.pix_payload, qr_base64: existing.pix_qr_base64, expiration: existing.pix_expiration } }
          : {}),
      };
    }
  }

  const ref = externalRef('top');
  const value = Number((amountCents / 100).toFixed(2));
  const customer = await asaas.createCustomer({
    name: profile?.full_name || user.email || 'Cliente PulsePass',
    cpfCnpj: profile?.cpf || undefined,
    email: user.email,
    externalReference: user.id,
  });
  const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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
      customer: customer.id, value, dueDate,
      description: 'Recarga carteira PulsePass', externalReference: ref,
      installmentCount, remoteIp, creditCardToken: tok.creditCardToken,
    });

    const { data: topup, error } = await repo.insertTopup({
      profile_id: user.id, event_id: eventId ?? null, amount_cents: amountCents,
      status: 'pending', asaas_payment_id: payment.id, external_reference: ref,
      client_request_id: idempotencyKey ?? null,
    });
    if (error) throw error;

    let credited = false;
    if (['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'].includes(payment.status)) {
      await creditTopupByPaymentId(payment.id).catch(() => {});
      credited = true;
    }
    return {
      id: topup.id, amount_cents: topup.amount_cents,
      status: credited ? 'paid' : 'pending', payment_method: 'card',
      card: { brand: tok.creditCardBrand, last4: tok.creditCardNumber },
    };
  }

  // ── PIX (default) ──
  const payment = await asaas.createPixPayment({
    customer: customer.id, value, dueDate,
    description: 'Recarga carteira PulsePass', externalReference: ref,
  });
  const qr = await asaas.getPixQrCode(payment.id);

  const { data: topup, error } = await repo.insertTopup({
    profile_id: user.id, event_id: eventId ?? null, amount_cents: amountCents,
    status: 'pending', asaas_payment_id: payment.id, external_reference: ref,
    pix_payload: qr.payload, pix_qr_base64: qr.encodedImage, pix_expiration: qr.expirationDate,
    client_request_id: idempotencyKey ?? null,
  });
  if (error) throw error;

  return {
    id: topup.id, amount_cents: topup.amount_cents, status: topup.status,
    payment_method: 'pix',
    pix: { payload: qr.payload, qr_base64: qr.encodedImage, expiration: qr.expirationDate },
  };
}

export async function getTopup({ user, topupId }) {
  const { data, error } = await repo.findTopupForUser(topupId, user.id);
  if (error) throw error;
  if (!data) throw notFound('Recarga não encontrada');
  return data;
}

/** Estorna o saldo restante da carteira do usuário. */
export async function refundWallet({ user, eventId }) {
  const wallet = await getOrCreateWallet(user.id, eventId ?? null);
  const { data, error } = await repo.rpcRefundWallet(wallet.id);
  if (error) throw error;
  return { refunded_cents: data ?? 0 };
}

/** Credita a recarga (idempotente + atômico) via RPC transacional. */
export async function creditTopupByPaymentId(asaasPaymentId, paidValueCents = null) {
  const { data, error } = await repo.rpcCreditTopup(asaasPaymentId, paidValueCents);
  if (error) throw error;
  return data;
}

// ═══════════════════════ BAR ═══════════════════════

function mapBarError(message) {
  if (!message) return null;
  if (message.includes('EVENT_UNAVAILABLE')) return notFound('Evento indisponível');
  if (message.includes('INVALID_QTY')) return badRequest('Quantidade inválida');
  if (message.includes('ITEM_INVALID')) return badRequest('Item inválido para o evento');
  if (message.includes('ITEM_UNAVAILABLE')) return conflict('Item indisponível');
  if (message.includes('INSUFFICIENT_FUNDS')) return conflict('Saldo insuficiente. Recarregue a carteira.');
  if (message.includes('OUT_OF_STOCK')) return conflict('Item sem estoque');
  // Carteira negativa após estorno de recarga já consumida. Sem este mapa o
  // cliente recebe um 500 sem explicação e o barman não sabe o que dizer.
  if (message.includes('WALLET_BLOCKED')) {
    return conflict('Carteira bloqueada por pendência. Procure a organização do evento.');
  }
  return null;
}

// ═══════════════════════ CARDÁPIO (gestão pelo produtor) ═══════════════════════

export async function listAdminMenu({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.adminListMenu(eventId);
  if (error) throw error;
  return data ?? [];
}

export async function createMenuItem({ user, eventId, item }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.adminInsertMenuItem({
    event_id: eventId, name: item.name, category: item.category || 'Geral',
    price_cents: Math.max(0, Math.round(Number(item.price_cents) || 0)),
    // Custo é opcional. Nulo mantém a margem fora da tela em vez de fingir
    // 100% de lucro, que seria a mentira mais confortável possível.
    cost_cents: item.cost_cents != null && item.cost_cents !== ''
      ? Math.max(0, Math.round(Number(item.cost_cents))) : null,
    description: item.description || null,
    available: item.available !== false,
    stock: item.stock != null ? Math.max(0, Math.round(Number(item.stock))) : null,
    position: item.position ?? 0,
  });
  if (error) throw error;
  return data;
}

async function assertMenuItemAccess(user, itemId) {
  const { data: mi } = await repo.findMenuItemEvent(itemId);
  if (!mi) throw notFound('Item não encontrado');
  await assertEventAccess(user.id, mi.event_id, ['manager']);
}

export async function updateMenuItem({ user, itemId, patch }) {
  await assertMenuItemAccess(user, itemId);
  const clean = {};
  if (patch.name != null) clean.name = patch.name;
  if (patch.category != null) clean.category = patch.category;
  if (patch.price_cents != null) clean.price_cents = Math.max(0, Math.round(Number(patch.price_cents)));
  if (patch.description !== undefined) clean.description = patch.description || null;
  if (patch.available != null) clean.available = Boolean(patch.available);
  if (patch.stock !== undefined) clean.stock = patch.stock != null ? Math.max(0, Math.round(Number(patch.stock))) : null;
  const { data, error } = await repo.adminUpdateMenuItem(itemId, clean);
  if (error) throw error;
  return data;
}

export async function deleteMenuItem({ user, itemId }) {
  await assertMenuItemAccess(user, itemId);
  const { error } = await repo.adminDeleteMenuItem(itemId);
  if (error) throw error;
  return { removed: true };
}

/** Cardápio disponível de um evento (público). */
export async function getMenu(eventSlug) {
  const { data: event } = await repo.findEventBySlug(eventSlug);
  if (!event || event.status !== 'published') throw notFound('Evento indisponível');

  const { data, error } = await repo.findAvailableMenu(event.id);
  if (error) throw error;
  return { event_id: event.id, items: data };
}

/** Pedido no bar pago com saldo (cliente no app). */
export async function createBarOrder({ user, eventSlug, items, idempotencyKey = null }) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Pedido sem itens');
  const { data: event } = await repo.findEventBySlug(eventSlug);
  if (!event || event.status !== 'published') throw notFound('Evento indisponível');
  return placeBarOrder({ buyerId: user.id, eventId: event.id, items, idempotencyKey });
}

/** Núcleo reutilizável (cliente no app e PDV do operador). */
export async function placeBarOrder({ buyerId, eventId, items, idempotencyKey = null, operatorId = null }) {
  const { data, error } = await repo.rpcPlaceBarOrder({ buyerId, eventId, items, idempotencyKey });
  if (error) {
    const mapped = mapBarError(error.message);
    if (mapped) throw mapped;
    throw error;
  }
  // Registra o operador do PDV (metadado, best-effort; nunca em replay).
  if (operatorId && data.order_id && !data.idempotent_replay) {
    try { await repo.setBarOrderOperator(data.order_id, operatorId); } catch { /* best-effort */ }
  }
  return {
    id: data.order_id, status: 'paid', total_cents: data.total_cents,
    pickup_code: data.pickup_code, balance_cents: data.balance_cents, items: data.items,
  };
}

/** Integridade do ledger — carteiras com saldo divergente da soma das transações. */
export async function getLedgerCheck({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.findLedgerDrift(eventId);
  if (error) throw error;
  return { ok: (data ?? []).length === 0, drifts: data ?? [] };
}

/** Fechamento de caixa — total processado por operador de PDV. */
export async function getCashierReport({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.rpcCashierReport(eventId);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    operator_id: r.operator_id, name: r.operator_name, email: r.operator_email,
    orders: Number(r.orders), total_cents: Number(r.total_cents),
  }));
}

export async function listMyBarOrders({ user, limit = 50, offset = 0 }) {
  const { data, error } = await repo.findMyBarOrders(user.id, { limit, offset });
  if (error) throw error;
  return data;
}

// ═══════════════════ SERVIÇO DE BAR ═══════════════════
// Cozinha (KDS), garçom e totem. O ciclo paid → preparing → ready →
// delivered existia no banco desde a 0003 e nunca teve como ser percorrido:
// faltavam endpoint e tela. O pedido nascia pago e morria pago, e ninguém
// sabia se a cerveja tinha saído.

/** Minutos desde um instante — o dado que a cozinha realmente lê. */
function minutosDesde(iso) {
  if (!iso) return null;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

/**
 * Fila da cozinha.
 *
 * Papel 'bar' basta: quem está na chapa não é gerente, e exigir gerência
 * significaria a produtora emprestando a própria conta — que é como o
 * controle de acesso se perde na noite do evento.
 */
export async function getKitchenQueue({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['bar', 'manager']);
  const { data, error } = await repo.findKitchenQueue(eventId);
  if (error) throw error;

  return (data ?? []).map((o) => ({
    id: o.id,
    status: o.status,
    pickup_code: o.pickup_code,
    total_cents: o.total_cents,
    // A origem decide o que fazer com o prato pronto: mesa vai até a pessoa,
    // praça de bar espera retirada, app espera o código ser chamado.
    origem: o.event_tables
      ? { tipo: 'mesa', rotulo: `${o.event_tables.name}${o.event_tables.area ? ` · ${o.event_tables.area}` : ''}` }
      : o.station
        ? { tipo: 'praca', rotulo: o.station }
        : { tipo: 'app', rotulo: 'Pedido pelo app' },
    cliente: o.profiles?.full_name || o.profiles?.email || '—',
    itens: (o.bar_order_items ?? []).map((i) => ({ nome: i.name, qtd: i.quantity, obs: i.notes })),
    esperando_min: minutosDesde(o.created_at),
    em_preparo_min: minutosDesde(o.preparing_at),
    pronto_ha_min: minutosDesde(o.ready_at),
    created_at: o.created_at,
  }));
}

const ETAPAS = ['preparing', 'ready', 'delivered', 'cancelled'];

/** Move o pedido uma etapa. A validação da transição mora no banco (RPC). */
export async function advanceBarOrder({ user, orderId, para, station = null }) {
  if (!ETAPAS.includes(para)) throw badRequest(`Etapa inválida. Use: ${ETAPAS.join(', ')}`);

  const { data: pedido } = await repo.findBarOrderEvent(orderId);
  if (!pedido) throw notFound('Pedido não encontrado');
  await assertEventAccess(user.id, pedido.event_id, ['bar', 'manager']);

  const { data, error } = await repo.rpcAdvanceBarOrder({
    orderId, para, operadorId: user.id, station,
  });
  if (error) {
    // O banco recusa andar para trás. Traduzido, porque "TRANSICAO_INVALIDA:
    // delivered -> preparing" não diz nada a quem está no balcão com fila.
    if (/TRANSICAO_INVALIDA|ja entregue/.test(error.message)) {
      throw conflict(`Este pedido já passou dessa etapa (está em "${pedido.status}"). Atualize a tela.`);
    }
    if (/PEDIDO_NAO_ENCONTRADO/.test(error.message)) throw notFound('Pedido não encontrado');
    throw error;
  }
  return data;
}

/**
 * Mesas com o que cada uma tem em aberto — a tela do garçom.
 *
 * Uma consulta por mesa seria N+1 numa tela que se atualiza sozinha a cada
 * poucos segundos. São duas consultas e o agrupamento acontece aqui.
 */
export async function getWaiterBoard({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['bar', 'manager']);
  const [{ data: mesas }, { data: pedidos }] = await Promise.all([
    repo.findActiveTables(eventId),
    repo.findOpenOrdersByTable(eventId),
  ]);

  const porMesa = new Map();
  for (const p of pedidos ?? []) {
    if (!porMesa.has(p.table_id)) porMesa.set(p.table_id, []);
    porMesa.get(p.table_id).push(p);
  }

  return (mesas ?? []).map((m) => {
    const abertos = porMesa.get(m.id) ?? [];
    return {
      id: m.id, nome: m.name, area: m.area, capacidade: m.capacity,
      pedidos_abertos: abertos.length,
      prontos: abertos.filter((p) => p.status === 'ready').length,
      consumo_cents: abertos.reduce((s, p) => s + (p.total_cents ?? 0), 0),
      itens: abertos.flatMap((p) => (p.bar_order_items ?? []).map((i) => `${i.quantity}× ${i.name}`)),
    };
  });
}

/**
 * Pedido lançado pelo garçom na mesa.
 *
 * Reaproveita o mesmo caminho de dinheiro do PDV — mesma RPC, mesma
 * idempotência, mesmo razão. O que muda é só a ORIGEM gravada depois, e
 * essa gravação é best-effort de propósito: se falhar, o pedido continua
 * pago e válido. Perde-se a etiqueta da mesa, não o dinheiro.
 */
export async function placeWaiterOrder({
  user, eventId, tableId, buyerId, items, idempotencyKey = null, station = null,
}) {
  await assertEventAccess(user.id, eventId, ['bar', 'manager']);
  if (!buyerId) throw badRequest('Informe de quem é a comanda (buyer_id)');

  const pedido = await placeBarOrder({
    buyerId, eventId, items, idempotencyKey, operatorId: user.id,
  });

  try {
    await repo.setBarOrderOrigin(pedido.id, { tableId: tableId ?? null, waiterId: user.id, station });
  } catch { /* etiqueta é metadado; o pedido já está pago */ }

  return { ...pedido, table_id: tableId ?? null };
}

/** O id de cobrança pertence a uma recarga? Decide o caminho do webhook. */
export async function topupExists(asaasPaymentId) {
  const { data } = await repo.findTopupByPaymentId(asaasPaymentId);
  return Boolean(data);
}

/**
 * Reverte uma recarga estornada. Se o saldo já foi gasto no bar, a carteira
 * vai a NEGATIVO e é bloqueada — a bebida já foi consumida e a dívida é real.
 * Fingir que o prejuízo não existe só o transfere para a produtora.
 */
export async function reverseTopupByPaymentId(asaasPaymentId, kind, reason = null) {
  const { data, error } = await repo.rpcReverseTopup(asaasPaymentId, kind, reason);
  if (error) throw error;
  return data;
}

// ═══════════════════ TURNO DE CAIXA ═══════════════════
//
// O caixa nunca ABRIA. Existia o relatório por operador, mas não o turno:
// sem hora de abertura e sem fundo de troco, "sobrou R$ 300 na gaveta" não
// quer dizer nada — não há com o que comparar.

/** O turno aberto de quem está operando agora, se houver. */
export async function getTurnoAberto({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['bar', 'manager']);
  const { data } = await repo.findTurnoAberto(eventId, user.id);
  return data ?? null;
}

export async function abrirTurno({ user, eventId, fundoCents = 0, station = null }) {
  await assertEventAccess(user.id, eventId, ['bar', 'manager']);
  const fundo = Math.max(0, Math.round(Number(fundoCents) || 0));

  const { data, error } = await repo.abrirTurno({
    event_id: eventId, operator_id: user.id, opening_cents: fundo, station,
  });
  if (error) {
    // O índice único garante um turno aberto por operador. Dois toques no
    // botão abririam duas gavetas, e a conferência do fim da noite nunca
    // fecharia.
    if (/duplicate key|uq_turno_aberto/.test(error.message)) {
      throw conflict('Você já tem um turno aberto neste evento. Feche o anterior antes de abrir outro.');
    }
    throw error;
  }
  return data;
}

/**
 * Fecha e confere.
 *
 * O que o operador CONTOU fica separado do que o sistema calcula, de
 * propósito: a diferença entre os dois é justamente o achado da conferência.
 */
export async function fecharTurno({ user, turnoId, contadoCents, notas = null }) {
  const { data: turno } = await repo.findTurnoEvento(turnoId);
  if (!turno) throw notFound('Turno não encontrado');
  await assertEventAccess(user.id, turno.event_id, ['bar', 'manager']);
  // Gerente fecha o turno de qualquer um; operador só o próprio. Sem isso,
  // um barman fecharia a gaveta do colega e a responsabilidade se perderia.
  if (turno.operator_id !== user.id) {
    await assertEventAccess(user.id, turno.event_id, ['manager']);
  }
  if (contadoCents == null || Number.isNaN(Number(contadoCents))) {
    throw badRequest('Informe quanto foi contado na gaveta');
  }

  const { data, error } = await repo.rpcFecharTurno({
    turnoId, contado: Math.max(0, Math.round(Number(contadoCents))), notas,
  });
  if (error) {
    if (/TURNO_JA_FECHADO/.test(error.message)) throw conflict('Este turno já foi fechado.');
    throw error;
  }
  const r = Array.isArray(data) ? data[0] : data;
  return {
    esperado_cents: r.esperado_cents,
    contado_cents: r.contado_cents,
    diferenca_cents: r.diferenca_cents,
    vendas_cents: r.vendas_cents,
    fundo_cents: r.fundo_cents,
    // Quebra de caixa é o nome que a operação usa. Negativo = faltou.
    veredito: r.diferenca_cents === 0 ? 'bateu' : r.diferenca_cents > 0 ? 'sobrou' : 'faltou',
  };
}

export async function listarTurnos({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.findTurnosDoEvento(eventId);
  if (error) throw error;
  return (data ?? []).map((t) => ({
    id: t.id,
    operador: t.profiles?.full_name || t.profiles?.email || '—',
    praca: t.station,
    fundo_cents: t.opening_cents,
    contado_cents: t.counted_cents,
    aberto_em: t.opened_at,
    fechado_em: t.closed_at,
    notas: t.notes,
  }));
}
