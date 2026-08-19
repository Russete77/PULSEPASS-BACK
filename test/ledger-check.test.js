// ═══════════════════════════════════════════════════════════════
// Conferência de carteira do fechamento — a checagem que não checava nada.
//
// A migration 0027 passou o sistema para CARTEIRA ÚNICA por usuário
// (`wallets.event_id` = NULL). A tela de Fechamento continuou consultando
// `wallet_reconciliation` com `where event_id = :evento`, filtro que desde
// então NUNCA casa: a tela dizia "sem divergências" mesmo com o saldo de
// uma carteira fora do extrato.
//
// O que este teste guarda:
//   1. o escopo é real — a carteira de quem consumiu no evento é conferida;
//   2. uma divergência REAL aparece;
//   3. o filtro antigo (por event_id) não vê nada — o motivo do bug.
//
// Requer um Supabase de TESTE (TEST_SUPABASE_URL/KEY). Sem isso, pula.
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, hasDb, makeScenario } from './helpers.js';

const maybe = hasDb ? test : test.skip;
if (!hasDb) {
  console.warn('\n⚠  Sem TEST_SUPABASE_URL/KEY — teste de conferência de carteira PULADO.\n');
}

maybe('conferência de carteira enxerga divergência de quem consumiu no evento', async () => {
  const sc = await makeScenario();
  let walletId = null;
  let orderId = null;
  try {
    // Carteira ÚNICA do comprador (event_id null), saldo coerente com o extrato.
    const { data: w, error: wErr } = await db.from('wallets')
      .insert({ profile_id: sc.userId, event_id: null, balance_cents: 5000 })
      .select('id').single();
    assert.equal(wErr, null, 'carteira criada');
    walletId = w.id;
    await db.from('wallet_transactions')
      .insert({ wallet_id: walletId, type: 'topup', amount_cents: 5000, description: 'Recarga de teste' });

    const { data: item } = await db.from('menu_items')
      .insert({ event_id: sc.eventId, name: 'Cerveja', price_cents: 1500, available: true, position: 0 })
      .select('id').single();

    // O consumo é o que liga a carteira única a ESTE evento.
    const { data: ordem, error: oErr } = await db.rpc('place_bar_order', {
      p_buyer: sc.userId, p_event: sc.eventId,
      p_items: [{ menu_item_id: item.id, quantity: 1 }], p_idempotency_key: null,
    });
    assert.equal(oErr, null, 'pedido de bar aceito');
    orderId = ordem.order_id;

    // 1) Escopo real: a carteira que consumiu entra na conferência.
    const limpo = await db.rpc('conferencia_carteiras_evento', { p_event: sc.eventId });
    assert.equal(limpo.error, null, 'RPC de conferência existe');
    assert.equal(limpo.data.carteiras_conferidas, 1, 'a carteira que consumiu tem que ser conferida');
    assert.equal(limpo.data.drifts.length, 0, 'saldo coerente com o extrato → sem divergência');

    // 2) Divergência REAL: mexe no saldo sem lançar nada no extrato.
    await db.from('wallets').update({ balance_cents: 9999 }).eq('id', walletId);

    const achou = await db.rpc('conferencia_carteiras_evento', { p_event: sc.eventId });
    assert.equal(achou.data.drifts.length, 1, 'a divergência tem que aparecer');
    assert.equal(achou.data.drifts[0].wallet_id, walletId);
    assert.equal(achou.data.drifts[0].drift_cents, 9999 - 3500, 'saldo 9999 vs extrato 3500');

    // 3) O motivo do bug: com carteira única, o filtro por evento não casa.
    const { data: antiga } = await db.from('wallet_reconciliation')
      .select('wallet_id').eq('event_id', sc.eventId).neq('drift_cents', 0);
    assert.equal(antiga.length, 0, 'filtro por event_id não vê a divergência — por isso saiu de cena');
  } finally {
    // A carteira única não tem event_id: o cleanup por evento não a alcança.
    if (orderId) { try { await db.from('bar_order_items').delete().eq('bar_order_id', orderId); } catch { /* best-effort */ } }
    if (walletId) {
      try { await db.from('bar_orders').delete().eq('wallet_id', walletId); } catch { /* best-effort */ }
      try { await db.from('wallet_transactions').delete().eq('wallet_id', walletId); } catch { /* best-effort */ }
      try { await db.from('wallets').delete().eq('id', walletId); } catch { /* best-effort */ }
    }
    await sc.cleanup();
  }
});
