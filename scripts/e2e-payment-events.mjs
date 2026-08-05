#!/usr/bin/env node
// Eventos de pagamento do Asaas: o buraco que permitia golpe.
//
// Antes, o webhook só entendia "pago". Comprar, entrar na festa e pedir
// estorno pelo painel do Asaas deixava o ingresso VÁLIDO — o evento
// PAYMENT_REFUNDED chegava e era descartado.
//
// Este teste envia os eventos no formato real do provedor e confere o efeito
// em ingresso, estoque, carteira e casos de fraude.
import 'dotenv/config';
import { supabase as db } from '../src/config/supabase.js';

const API = process.env.API_BASE || 'http://localhost:4000/api';
const SB = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_ANON_KEY;
const WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN;

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${label}${detail ? ' · ' + detail : ''}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ' · ' + detail : ''}`); }
};
const login = async (e) => {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email: e, password: 'Teste12345!' }),
  });
  return (await r.json()).access_token;
};
const api = async (m, p, { token, body, headers = {} } = {}) => {
  const r = await fetch(API + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let j = null; try { j = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, body: j, data: j?.data };
};

/** Dispara um webhook no formato exato do Asaas. */
const webhook = (event, payment, id = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`) =>
  api('POST', '/webhooks/asaas', {
    headers: { 'asaas-access-token': WEBHOOK_TOKEN },
    body: { id, event, dateCreated: new Date().toISOString(), payment },
  });

/**
 * Move o saldo da carteira registrando a transação correspondente.
 * O sistema mantém o invariante `saldo = Σ transações` e a suíte verifica isso —
 * mexer no saldo por fora deixaria o ledger sem fechar e acusaria falso positivo.
 */
async function ajustarSaldo(profileId, novoSaldo, motivo) {
  const { data: w } = await db.from('wallets')
    .select('id, balance_cents').eq('profile_id', profileId).is('event_id', null).single();
  const delta = novoSaldo - w.balance_cents;
  if (delta === 0) return;
  await db.from('wallets').update({ balance_cents: novoSaldo }).eq('id', w.id);
  await db.from('wallet_transactions').insert({
    wallet_id: w.id, type: 'adjustment', amount_cents: delta, description: motivo,
  });
}

async function comprarEPagar(cliente, tierId, billingType = 'PIX') {
  const buy = await api('POST', '/orders', {
    token: cliente, headers: { 'idempotency-key': `pe-${Date.now()}-${Math.random()}` },
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: tierId, quantity: 1 }], paymentMethod: 'pix' },
  });
  const { data: order } = await db.from('orders')
    .select('id, asaas_payment_id, total_cents').eq('id', buy.data.id).single();
  await webhook('PAYMENT_CONFIRMED', {
    id: order.asaas_payment_id, value: order.total_cents / 100, billingType, status: 'CONFIRMED',
  });
  return order;
}

async function main() {
  console.log(`\n═══ Eventos de pagamento (Asaas) · ${API} ═══\n`);
  if (!WEBHOOK_TOKEN) { console.error('✖ ASAAS_WEBHOOK_TOKEN ausente no .env'); process.exit(1); }

  const cliente = await login('e2e_cliente@pulsepass.test');
  const porteiro = await login('e2e_porteiro@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const tier = ev.tiers[0];

  console.log('1) Webhook exige o token do provedor');
  const semToken = await api('POST', '/webhooks/asaas', {
    body: { id: 'evt_x', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_x', value: 1 } },
  });
  check('sem token é recusado', semToken.status === 403, `HTTP ${semToken.status}`);

  console.log('\n2) ESTORNO cancela o ingresso e devolve o estoque');
  const { data: antes } = await db.from('ticket_tiers').select('quantity_sold').eq('id', tier.id).single();
  const o1 = await comprarEPagar(cliente, tier.id);
  const { data: tk1 } = await db.from('tickets').select('id, status').eq('order_id', o1.id);
  check('ingresso emitido no pagamento', tk1.length === 1 && tk1[0].status === 'valid');

  await webhook('PAYMENT_REFUNDED', { id: o1.asaas_payment_id, value: o1.total_cents / 100, billingType: 'PIX' });
  await new Promise((r) => setTimeout(r, 900));

  const { data: tk1b } = await db.from('tickets').select('status').eq('order_id', o1.id);
  check('ingresso CANCELADO após estorno', tk1b[0].status === 'cancelled', `status=${tk1b[0].status}`);
  const { data: ord1 } = await db.from('orders').select('status, reversal_kind').eq('id', o1.id).single();
  check('pedido marcado como estornado', ord1.status === 'refunded' && ord1.reversal_kind === 'refund',
    `${ord1.status}/${ord1.reversal_kind}`);
  const { data: depois } = await db.from('ticket_tiers').select('quantity_sold').eq('id', tier.id).single();
  check('estoque devolvido ao lote', depois.quantity_sold === antes.quantity_sold,
    `${antes.quantity_sold} → ${depois.quantity_sold}`);

  console.log('\n3) O ingresso estornado NÃO entra mais na festa');
  const { data: tkCode } = await db.from('tickets').select('code').eq('order_id', o1.id).single();
  const tentativa = await api('POST', `/admin/events/${ev.id}/checkin`, {
    token: porteiro, body: { input: tkCode.code },
  });
  check('porta recusa ingresso cancelado', tentativa.data?.result === 'invalid', tentativa.data?.message);

  console.log('\n4) Quem JÁ ENTROU e depois estornou vira caso de fraude');
  const o2 = await comprarEPagar(cliente, tier.id);
  const { data: tk2 } = await db.from('tickets').select('code').eq('order_id', o2.id).single();
  const entrou = await api('POST', `/admin/events/${ev.id}/checkin`, {
    token: porteiro, body: { input: tk2.code },
  });
  check('entrou na festa', entrou.data?.result === 'ok');

  await webhook('PAYMENT_CHARGEBACK_REQUESTED', { id: o2.asaas_payment_id, value: o2.total_cents / 100, billingType: 'CREDIT_CARD' });
  await new Promise((r) => setTimeout(r, 900));

  const { data: caso } = await db.from('fraud_cases')
    .select('kind, amount_cents, detail').eq('order_id', o2.id).maybeSingle();
  check('caso de fraude aberto para a produtora', caso?.kind === 'entered_then_refunded',
    caso?.detail?.slice(0, 60));
  check('valor do prejuízo registrado', caso?.amount_cents === o2.total_cents,
    `${caso?.amount_cents} centavos`);

  console.log('\n5) Cartão CONFIRMADO não credita carteira (só no RECEIVED)');
  const rec = await api('POST', '/wallet/topups', {
    token: cliente, headers: { 'idempotency-key': `pe-top-${Date.now()}` },
    body: { amount_cents: 5000, paymentMethod: 'pix' },
  });
  const { data: top } = await db.from('wallet_topups')
    .select('id, asaas_payment_id, amount_cents').eq('id', rec.data.id).single();
  const saldoAntes = (await api('GET', '/wallet', { token: cliente })).data.balance_cents;

  await webhook('PAYMENT_CONFIRMED', { id: top.asaas_payment_id, value: 50, billingType: 'CREDIT_CARD' });
  await new Promise((r) => setTimeout(r, 700));
  const saldoCartaoConfirmado = (await api('GET', '/wallet', { token: cliente })).data.balance_cents;
  check('cartão só CONFIRMADO não credita', saldoCartaoConfirmado === saldoAntes,
    `saldo ${saldoCartaoConfirmado} (era ${saldoAntes})`);

  await webhook('PAYMENT_RECEIVED', { id: top.asaas_payment_id, value: 50, billingType: 'CREDIT_CARD' });
  await new Promise((r) => setTimeout(r, 700));
  const saldoRecebido = (await api('GET', '/wallet', { token: cliente })).data.balance_cents;
  check('RECEIVED credita a carteira', saldoRecebido === saldoAntes + 5000,
    `saldo ${saldoRecebido}`);

  console.log('\n6) Estorno de recarga JÁ GASTA deixa dívida e bloqueia a carteira');
  const { data: menu } = await db.from('menu_items').select('id, price_cents').eq('event_id', ev.id).limit(1).single();
  const { data: dono } = await db.from('wallet_topups').select('profile_id').eq('id', top.id).single();

  // Simula "o dinheiro já foi bebido": deixa na carteira MENOS do que a
  // recarga que será estornada. Gastar no bar de verdade esbarraria no estoque
  // do item e o teste mediria a coisa errada.
  //
  // O ajuste vai acompanhado de transação: o sistema mantém o invariante
  // saldo = Σ transações, e mexer no saldo "por fora" quebraria essa conta —
  // que é justamente uma das coisas que a suíte verifica.
  const SALDO_RESTANTE = 2000; // R$ 20 restantes de uma recarga de R$ 50
  await ajustarSaldo(dono.profile_id, SALDO_RESTANTE, 'teste: simula consumo no bar');

  await webhook('PAYMENT_REFUNDED', { id: top.asaas_payment_id, value: 50, billingType: 'CREDIT_CARD' });
  await new Promise((r) => setTimeout(r, 900));

  const { data: w } = await db.from('wallets')
    .select('balance_cents, blocked_at, block_reason')
    .eq('profile_id', dono.profile_id).is('event_id', null).single();

  check('recarga estornada sai da carteira mesmo sem saldo', w.balance_cents === SALDO_RESTANTE - 5000,
    `${SALDO_RESTANTE} − 5000 = ${w.balance_cents}`);
  check('saldo fica NEGATIVO (a dívida é real)', w.balance_cents < 0, `${w.balance_cents} centavos`);
  check('carteira é BLOQUEADA', !!w.blocked_at, w.block_reason);

  const barBloqueado = await api('POST', '/bar-orders', {
    token: cliente, headers: { 'idempotency-key': `pe-blk-${Date.now()}` },
    body: { eventSlug: 'festa-e2e', items: [{ menu_item_id: menu.id, quantity: 1 }] },
  });
  check('carteira bloqueada não compra no bar', barBloqueado.status >= 400, `HTTP ${barBloqueado.status}`);

  const { data: casoDivida } = await db.from('fraud_cases')
    .select('kind, detail').eq('kind', 'consumed_then_refunded')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  check('dívida vira caso para a produtora', !!casoDivida, casoDivida?.detail?.slice(0, 70));

  // devolve a carteira ao normal, também com transação, para os outros testes
  // encontrarem o ledger fechando.
  await ajustarSaldo(dono.profile_id, 0, 'teste: encerra cenário de dívida');
  await db.from('wallets').update({ blocked_at: null, block_reason: null })
    .eq('profile_id', dono.profile_id).is('event_id', null);

  console.log('\n7) Análise de risco NÃO emite ingresso');
  const buy3 = await api('POST', '/orders', {
    token: cliente, headers: { 'idempotency-key': `pe-risk-${Date.now()}` },
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: tier.id, quantity: 1 }], paymentMethod: 'pix' },
  });
  const { data: o3 } = await db.from('orders').select('asaas_payment_id').eq('id', buy3.data.id).single();
  await webhook('PAYMENT_AWAITING_RISK_ANALYSIS', { id: o3.asaas_payment_id, value: 55, billingType: 'CREDIT_CARD' });
  await new Promise((r) => setTimeout(r, 700));
  const { data: tk3 } = await db.from('tickets').select('id').eq('order_id', buy3.data.id);
  check('aguardando análise não emite ingresso', tk3.length === 0, `${tk3.length} ingresso(s)`);

  await webhook('PAYMENT_REPROVED_BY_RISK_ANALYSIS', { id: o3.asaas_payment_id, value: 55, billingType: 'CREDIT_CARD' });
  await new Promise((r) => setTimeout(r, 700));
  const { data: ord3 } = await db.from('orders').select('status, reversal_kind').eq('id', buy3.data.id).single();
  check('reprovado no risco cancela o pedido', ord3.reversal_kind === 'risk_reproved', `${ord3.status}`);

  console.log('\n8) Evento repetido não faz efeito duas vezes (at least once)');
  const idFixo = `evt_dup_${Date.now()}`;
  const o4 = await comprarEPagar(cliente, tier.id);
  const r1 = await webhook('PAYMENT_REFUNDED', { id: o4.asaas_payment_id, value: o4.total_cents / 100 }, idFixo);
  const r2 = await webhook('PAYMENT_REFUNDED', { id: o4.asaas_payment_id, value: o4.total_cents / 100 }, idFixo);
  check('reenvio do mesmo evento é ignorado', r2.body?.duplicated === true, JSON.stringify(r2.body));

  console.log('\n9) Evento informativo é aceito sem efeito colateral');
  const info = await webhook('PAYMENT_BANK_SLIP_VIEWED', { id: 'pay_qualquer', value: 10 });
  check('boleto visualizado responde 2xx', info.status === 200, `HTTP ${info.status}`);

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
