// ═══════════════════════════════════════════════════════════════
// Testes de integração das RPCs de dinheiro (o item #1 de risco).
// Exercita: anti-oversell, corrida, saldo insuficiente, idempotência
// de confirmação e devolução de estoque na expiração.
//
// Requer um Supabase de TESTE (TEST_SUPABASE_URL/KEY). Sem isso, pula.
// Rodar: npm test   (no diretório api/)
// ═══════════════════════════════════════════════════════════════
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, hasDb, makeScenario, tierStock } from './helpers.js';

const maybe = hasDb ? test : test.skip;
if (!hasDb) {
  console.warn('\n⚠  Sem TEST_SUPABASE_URL/KEY — testes de dinheiro PULADOS.\n');
}

// ── place_order: não vende mais que o estoque ──
maybe('place_order respeita o estoque (anti-oversell)', async () => {
  const sc = await makeScenario({ quantityTotal: 2 });
  try {
    const ok = await db.rpc('place_order', {
      p_buyer: sc.userId, p_event: sc.eventId,
      p_items: [{ ticket_tier_id: sc.tierId, quantity: 2 }],
    });
    assert.equal(ok.error, null, 'primeiro pedido deve passar');

    const over = await db.rpc('place_order', {
      p_buyer: sc.userId, p_event: sc.eventId,
      p_items: [{ ticket_tier_id: sc.tierId, quantity: 1 }],
    });
    assert.notEqual(over.error, null, 'pedido além do estoque deve falhar');
    // Lote esgotado vira status='sold_out' → o próximo pedido é recusado como
    // TIER_NOT_ON_SALE (a checagem de status vem antes do SOLD_OUT). Ambos são
    // 409 "indisponível"; o que importa é que a compra é recusada (anti-oversell).
    assert.match(over.error.message, /SOLD_OUT|TIER_NOT_ON_SALE/, 'lote esgotado deve recusar a compra');

    const stock = await tierStock(sc.tierId);
    assert.equal(stock.quantity_sold, 2, 'vendidos = total');
    assert.equal(stock.status, 'sold_out', 'lote marcado como esgotado');
  } finally {
    await sc.cleanup();
  }
});

// ── place_order: corrida — soma vendida nunca passa do total ──
maybe('place_order sob concorrência não estoura o estoque', async () => {
  const sc = await makeScenario({ quantityTotal: 5, maxPerOrder: 5 });
  try {
    const tries = Array.from({ length: 10 }, () =>
      db.rpc('place_order', {
        p_buyer: sc.userId, p_event: sc.eventId,
        p_items: [{ ticket_tier_id: sc.tierId, quantity: 1 }],
      }),
    );
    const results = await Promise.all(tries);
    const sucessos = results.filter((r) => !r.error).length;
    const stock = await tierStock(sc.tierId);

    assert.ok(stock.quantity_sold <= 5, `vendidos (${stock.quantity_sold}) não pode passar de 5`);
    assert.equal(stock.quantity_sold, sucessos, 'vendidos = nº de pedidos que passaram');
  } finally {
    await sc.cleanup();
  }
});

// ── spend_wallet: nunca deixa saldo negativo ──
maybe('spend_wallet recusa débito acima do saldo', async () => {
  const sc = await makeScenario();
  try {
    const { data: w } = await db.from('wallets')
      .insert({ profile_id: sc.userId, event_id: sc.eventId, balance_cents: 1000 })
      .select('id').single();

    const insf = await db.rpc('spend_wallet', { p_wallet: w.id, p_amount: 2000 });
    assert.equal(insf.data, null, 'débito acima do saldo retorna NULL');

    const ok = await db.rpc('spend_wallet', { p_wallet: w.id, p_amount: 600 });
    assert.equal(ok.data, 400, 'débito válido retorna novo saldo');

    const { data: w2 } = await db.from('wallets').select('balance_cents').eq('id', w.id).single();
    assert.equal(w2.balance_cents, 400, 'saldo final correto, nunca negativo');
  } finally {
    await sc.cleanup();
  }
});

// ── confirm_order_payment: idempotente (emite ingressos uma vez só) ──
maybe('confirm_order_payment é idempotente', async () => {
  const sc = await makeScenario({ quantityTotal: 5 });
  try {
    const placed = await db.rpc('place_order', {
      p_buyer: sc.userId, p_event: sc.eventId,
      p_items: [{ ticket_tier_id: sc.tierId, quantity: 2 }],
    });
    const orderId = (Array.isArray(placed.data) ? placed.data[0] : placed.data).order_id;
    const payId = `pay_test_${Date.now()}`;
    await db.rpc('attach_order_payment', {
      p_order: orderId, p_customer: 'cus_test', p_payment: payId, p_ref: 'ref_test',
      p_payload: null, p_qr: null, p_expiration: null,
    });

    const first = await db.rpc('confirm_order_payment', { p_payment_id: payId });
    const second = await db.rpc('confirm_order_payment', { p_payment_id: payId });
    assert.equal(first.data.emitted, 2, 'primeira confirmação emite 2 ingressos');
    assert.equal(second.data.alreadyProcessed, true, 'segunda confirmação é no-op');

    const { count } = await db.from('tickets')
      .select('id', { count: 'exact', head: true }).eq('order_id', orderId);
    assert.equal(count, 2, 'apenas 2 ingressos no total (sem duplicar)');
  } finally {
    await sc.cleanup();
  }
});

// ── expire_pending_orders: devolve o estoque reservado ──
maybe('expire_pending_orders devolve estoque de pedidos vencidos', async () => {
  const sc = await makeScenario({ quantityTotal: 3 });
  try {
    const placed = await db.rpc('place_order', {
      p_buyer: sc.userId, p_event: sc.eventId,
      p_items: [{ ticket_tier_id: sc.tierId, quantity: 3 }],
    });
    const orderId = (Array.isArray(placed.data) ? placed.data[0] : placed.data).order_id;
    assert.equal((await tierStock(sc.tierId)).quantity_sold, 3, 'reservou tudo');

    // força o vencimento
    await db.from('orders').update({ expires_at: new Date(Date.now() - 60000).toISOString() }).eq('id', orderId);
    await db.rpc('expire_pending_orders');

    const stock = await tierStock(sc.tierId);
    assert.equal(stock.quantity_sold, 0, 'estoque devolvido');
    assert.equal(stock.status, 'on_sale', 'lote volta a vender');
  } finally {
    await sc.cleanup();
  }
});

// ── place_order: idempotente por Idempotency-Key (F0.7) ──
maybe('place_order é idempotente por Idempotency-Key', async () => {
  const sc = await makeScenario({ quantityTotal: 5 });
  try {
    const key = `idem_${Date.now()}`;
    const a = await db.rpc('place_order', {
      p_buyer: sc.userId, p_event: sc.eventId,
      p_items: [{ ticket_tier_id: sc.tierId, quantity: 2 }], p_idempotency_key: key,
    });
    const b = await db.rpc('place_order', {
      p_buyer: sc.userId, p_event: sc.eventId,
      p_items: [{ ticket_tier_id: sc.tierId, quantity: 2 }], p_idempotency_key: key,
    });
    const rowA = Array.isArray(a.data) ? a.data[0] : a.data;
    const rowB = Array.isArray(b.data) ? b.data[0] : b.data;
    assert.equal(rowA.is_replay, false, 'primeira chamada cria o pedido');
    assert.equal(rowB.is_replay, true, 'segunda chamada é replay');
    assert.equal(rowA.order_id, rowB.order_id, 'mesmo pedido');
    assert.equal((await tierStock(sc.tierId)).quantity_sold, 2, 'estoque debitado só uma vez');
  } finally {
    await sc.cleanup();
  }
});

// ── place_order: meia-entrada + taxa de serviço (F2.4) ──
maybe('place_order aplica meia-entrada e taxa de serviço', async () => {
  const sc = await makeScenario({ quantityTotal: 10, priceCents: 10000 });
  try {
    // meia = R$50,00; taxa de serviço = 10% (1000 bps)
    await db.from('ticket_tiers').update({ half_price_cents: 5000 }).eq('id', sc.tierId);
    await db.from('events').update({ service_fee_bps: 1000 }).eq('id', sc.eventId);

    // 1 inteira (10000) + 1 meia (5000) = subtotal 15000; taxa 10% = 1500; total 16500
    const r = await db.rpc('place_order', {
      p_buyer: sc.userId, p_event: sc.eventId,
      p_items: [
        { ticket_tier_id: sc.tierId, quantity: 1, half: false },
        { ticket_tier_id: sc.tierId, quantity: 1, half: true },
      ],
    });
    assert.equal(r.error, null, 'pedido deve passar');
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    assert.equal(row.total_cents, 16500, 'inteira + meia + taxa de 10%');

    const { data: order } = await db.from('orders').select('service_fee_cents').eq('id', row.order_id).single();
    assert.equal(order.service_fee_cents, 1500, 'taxa de serviço registrada');
  } finally {
    await sc.cleanup();
  }
});

// ── place_bar_order: respeita o estoque do item (F4.3) ──
maybe('place_bar_order respeita o estoque do item', async () => {
  const sc = await makeScenario();
  try {
    const { data: item } = await db.from('menu_items')
      .insert({ event_id: sc.eventId, name: 'Água', price_cents: 500, available: true, stock: 1 })
      .select('id').single();
    await db.from('wallets').insert({ profile_id: sc.userId, event_id: null, balance_cents: 5000 });

    const over = await db.rpc('place_bar_order', {
      p_buyer: sc.userId, p_event: sc.eventId, p_items: [{ menu_item_id: item.id, quantity: 2 }],
    });
    assert.notEqual(over.error, null, 'acima do estoque deve falhar');
    assert.match(over.error.message, /OUT_OF_STOCK/, 'erro deve ser OUT_OF_STOCK');

    const ok = await db.rpc('place_bar_order', {
      p_buyer: sc.userId, p_event: sc.eventId, p_items: [{ menu_item_id: item.id, quantity: 1 }],
    });
    assert.equal(ok.error, null, 'dentro do estoque passa');
    const { data: mi } = await db.from('menu_items').select('stock').eq('id', item.id).single();
    assert.equal(mi.stock, 0, 'estoque decrementado para 0');
  } finally {
    try { await db.from('bar_orders').delete().eq('event_id', sc.eventId); } catch { /* best-effort */ }
    try { await db.from('wallets').delete().eq('profile_id', sc.userId); } catch { /* best-effort */ }
    try { await db.from('menu_items').delete().eq('event_id', sc.eventId); } catch { /* best-effort */ }
    await sc.cleanup();
  }
});

// ── place_bar_order: idempotente — não cobra em dobro no retry (F0.3) ──
maybe('place_bar_order é idempotente (não cobra em dobro)', async () => {
  const sc = await makeScenario();
  try {
    const { data: item } = await db.from('menu_items')
      .insert({ event_id: sc.eventId, name: 'Cerveja', price_cents: 1000, available: true })
      .select('id').single();
    await db.from('wallets').insert({ profile_id: sc.userId, event_id: null, balance_cents: 5000 });

    const key = `baridem_${Date.now()}`;
    const a = await db.rpc('place_bar_order', {
      p_buyer: sc.userId, p_event: sc.eventId,
      p_items: [{ menu_item_id: item.id, quantity: 1 }], p_idempotency_key: key,
    });
    const b = await db.rpc('place_bar_order', {
      p_buyer: sc.userId, p_event: sc.eventId,
      p_items: [{ menu_item_id: item.id, quantity: 1 }], p_idempotency_key: key,
    });
    assert.equal(a.error, null, 'primeira cobrança passa');
    assert.equal(b.error, null, 'replay não erra');
    assert.equal(a.data.order_id, b.data.order_id, 'mesmo pedido no replay');
    assert.equal(b.data.idempotent_replay, true, 'segunda chamada marcada como replay');

    const { data: w } = await db.from('wallets')
      .select('balance_cents').eq('profile_id', sc.userId).is('event_id', null).single();
    assert.equal(w.balance_cents, 4000, 'debitou 1 cerveja (1000), não duas');
  } finally {
    try { await db.from('bar_orders').delete().eq('event_id', sc.eventId); } catch { /* best-effort */ }
    try { await db.from('wallets').delete().eq('profile_id', sc.userId); } catch { /* best-effort */ }
    try { await db.from('menu_items').delete().eq('event_id', sc.eventId); } catch { /* best-effort */ }
    await sc.cleanup();
  }
});
