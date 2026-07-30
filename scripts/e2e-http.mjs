#!/usr/bin/env node
// Driver E2E por HTTP — exercita a API REAL como o front faz: login no Supabase Auth,
// Bearer token nas chamadas, e o fluxo completo do super-app de ponta a ponta:
//
//   descoberta → compra (Pix) → ingresso + QR rotativo → recarga → pedido no bar
//   → check-in na porta → conferência de saldo/ledger
//
// Uso: node scripts/e2e-http.mjs        (API precisa estar no ar em API_BASE)
import 'dotenv/config';

const API = process.env.API_BASE || 'http://localhost:4000/api';
const SB = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const PASS = 'Teste12345!';
const U = {
  cliente: 'e2e_cliente@pulsepass.test',
  porteiro: 'e2e_porteiro@pulsepass.test',
  barman: 'e2e_barman@pulsepass.test',
};

let pass = 0, fail = 0;
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}${detail ? ' · ' + detail : ''}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ' · ' + detail : ''}`); }
  return ok;
}

async function login(email) {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login falhou (${email}): ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token;
}

async function api(method, path, { token, body, headers = {} } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let j = null;
  try { j = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, body: j, data: j?.data };
}

async function main() {
  if (!SB || !ANON) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY ausentes no .env');
  console.log(`\n═══ E2E HTTP · ${API} · projeto ${SB.replace('https://', '').split('.')[0]} ═══\n`);

  // ── 0. saúde
  console.log('0) Saúde da API');
  const h = await api('GET', '/health');
  check('GET /health', h.status === 200 && h.body?.status === 'ok', `asaas=${h.body?.asaas}`);

  // ── 1. descoberta (público, sem token)
  console.log('\n1) Descoberta pública (vitrine tipo Sympla)');
  const list = await api('GET', '/events');
  const events = list.data?.events ?? list.data ?? [];
  check('GET /events lista eventos', list.status === 200 && Array.isArray(events) && events.length > 0,
    `${events.length} evento(s)`);
  const ev = await api('GET', '/events/festa-e2e');
  const tiers = ev.data?.ticket_tiers ?? ev.data?.tiers ?? [];
  check('GET /events/festa-e2e detalhe + lotes', ev.status === 200 && tiers.length > 0,
    `${tiers.length} lote(s)`);
  const eventId = ev.data?.id;
  const tier = tiers[0];

  // ── 2. login cliente
  console.log('\n2) Login (Supabase Auth, igual o front)');
  const cliente = await login(U.cliente);
  check('cliente autenticado', !!cliente);
  const me = await api('GET', '/wallet', { token: cliente });
  check('GET /wallet autorizado', me.status === 200, `saldo ${brl(me.data?.balance_cents ?? 0)}`);
  const saldoInicial = me.data?.balance_cents ?? 0;

  // ── 3. compra de ingresso via Pix
  console.log('\n3) Compra de ingresso (Pix)');
  const buy = await api('POST', '/orders', {
    token: cliente,
    headers: { 'idempotency-key': `e2e-order-${Date.now()}` },
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: tier.id, quantity: 2 }], paymentMethod: 'pix' },
  });
  const orderId = buy.data?.id ?? buy.data?.order?.id;
  check('POST /orders cria pedido', buy.status === 201 && !!orderId,
    `total ${brl(buy.data?.total_cents ?? buy.data?.order?.total_cents ?? 0)}`);
  check('pedido traz cobrança Pix', !!(buy.data?.payment || buy.data?.pix || buy.data?.qr_code || buy.data?.asaas_payment_id));

  const paid = await api('POST', `/orders/${orderId}/simulate-paid`, { token: cliente });
  check('webhook de pagamento confirma pedido', paid.status === 200);
  const ord = await api('GET', `/orders/${orderId}`, { token: cliente });
  check('pedido fica status=paid', ord.data?.status === 'paid', `status=${ord.data?.status}`);

  // ── 4. ingresso emitido + QR rotativo
  console.log('\n4) Ingresso emitido + QR rotativo anti-golpe');
  const tks = await api('GET', '/tickets', { token: cliente });
  const tickets = (tks.data?.tickets ?? tks.data ?? []).filter((t) => t.order_id === orderId);
  check('GET /tickets emite 2 ingressos', tickets.length === 2, `${tickets.length} ingresso(s)`);
  const ticket = tickets[0];

  const q1 = await api('GET', `/tickets/${ticket.id}/qr-token`, { token: cliente });
  const t1 = q1.data?.token;
  check('GET qr-token entrega token assinado', q1.status === 200 && /^PPX:/.test(t1 || ''),
    `expira em ${q1.data?.ttl_seconds ?? '?'}s`);
  await new Promise((r) => setTimeout(r, 1100));
  const q2 = await api('GET', `/tickets/${ticket.id}/qr-token`, { token: cliente });
  check('token ROTACIONA (2ª leitura difere)', !!q2.data?.token && q2.data.token !== t1);

  // outro usuário não consegue token do meu ingresso
  const barman = await login(U.barman);
  const roubo = await api('GET', `/tickets/${ticket.id}/qr-token`, { token: barman });
  check('terceiro NÃO obtém meu qr-token', roubo.status === 403 || roubo.status === 404, `HTTP ${roubo.status}`);

  // ── 5. recarga da carteira
  console.log('\n5) Recarga da carteira (Pix)');
  const RECARGA = 10000;
  const top = await api('POST', '/wallet/topups', {
    token: cliente,
    headers: { 'idempotency-key': `e2e-top-${Date.now()}` },
    body: { amount_cents: RECARGA, paymentMethod: 'pix' },
  });
  const topId = top.data?.id;
  check('POST /wallet/topups cria recarga', top.status === 201 && !!topId, brl(RECARGA));
  const topPaid = await api('POST', `/wallet/topups/${topId}/simulate-paid`, { token: cliente });
  check('recarga confirmada credita saldo', topPaid.status === 200);
  const w2 = await api('GET', '/wallet', { token: cliente });
  check('saldo = inicial + recarga (carteira ÚNICA)', w2.data?.balance_cents === saldoInicial + RECARGA,
    `${brl(saldoInicial)} + ${brl(RECARGA)} = ${brl(w2.data?.balance_cents ?? 0)}`);

  // ── 6. pedido no bar (cashless tipo Zig)
  console.log('\n6) Pedido no bar (cashless, debita a carteira)');
  const menu = await api('GET', '/events/festa-e2e/menu', { token: cliente });
  const items = menu.data?.items ?? menu.data ?? [];
  check('GET cardápio do evento', menu.status === 200 && items.length > 0, `${items.length} item(ns)`);
  const drink = items[0];

  const idem = `e2e-bar-${Date.now()}`;
  const barBody = { eventSlug: 'festa-e2e', items: [{ menu_item_id: drink.id, quantity: 2 }] };
  const bar = await api('POST', '/bar-orders', {
    token: cliente, headers: { 'idempotency-key': idem }, body: barBody,
  });
  const gasto = bar.data?.total_cents ?? 0;
  check('POST /bar-orders cobra e gera código', (bar.status === 200 || bar.status === 201) && !!bar.data?.pickup_code,
    `${brl(gasto)} · retirada ${bar.data?.pickup_code}`);
  check('saldo DESCONTA na hora', bar.data?.balance_cents === saldoInicial + RECARGA - gasto,
    `saldo ${brl(bar.data?.balance_cents ?? 0)}`);

  // replay com a MESMA chave: não cobra de novo
  const dup = await api('POST', '/bar-orders', {
    token: cliente, headers: { 'idempotency-key': idem }, body: barBody,
  });
  check('replay idempotente NÃO cobra em dobro',
    dup.data?.order_id === bar.data?.order_id && dup.data?.balance_cents === bar.data?.balance_cents,
    'mesmo pedido devolvido');

  const w3 = await api('GET', '/wallet', { token: cliente });
  check('carteira reflete o gasto', w3.data?.balance_cents === saldoInicial + RECARGA - gasto,
    brl(w3.data?.balance_cents ?? 0));

  // ── 7. check-in na porta (AzList)
  console.log('\n7) Check-in na porta (QR rotativo validado pelo porteiro)');
  const porteiro = await login(U.porteiro);
  const qFresh = await api('GET', `/tickets/${ticket.id}/qr-token`, { token: cliente });
  // Contrato do scanner: HTTP 200 sempre, com result = ok|invalid|expired|wrong_event|already_used
  // (a porta precisa de semáforo instantâneo, não de erro HTTP).
  const ci = await api('POST', `/admin/events/${eventId}/checkin`, {
    token: porteiro, body: { input: qFresh.data.token },
  });
  check('porteiro valida token e libera entrada', ci.data?.result === 'ok', `result=${ci.data?.result}`);

  const ci2 = await api('POST', `/admin/events/${eventId}/checkin`, {
    token: porteiro, body: { input: qFresh.data.token },
  });
  check('mesmo QR NÃO entra 2x (anti-passback)', ci2.data?.result === 'already_used', `result=${ci2.data?.result}`);

  const roubado = await api('POST', `/admin/events/${eventId}/checkin`, {
    token: porteiro, body: { input: 'PPX:00000000-0000-0000-0000-000000000000:9999999999:deadbeef' },
  });
  check('QR forjado é REJEITADO (assinatura HMAC)', roubado.data?.result === 'invalid',
    `result=${roubado.data?.result}`);

  // ingresso de OUTRO evento não entra aqui
  const outro = await api('POST', '/admin/events/00000000-0000-0000-0000-000000000000/checkin', {
    token: porteiro, body: { input: qFresh.data.token },
  });
  check('porteiro sem vínculo com o evento é barrado', outro.status === 403 || outro.data?.result !== 'ok',
    `HTTP ${outro.status} result=${outro.data?.result ?? '-'}`);

  const cliQr = await api('POST', `/admin/events/${eventId}/checkin`, {
    token: cliente, body: { input: qFresh.data.token },
  });
  check('cliente NÃO pode dar check-in (RBAC)', cliQr.status === 403, `HTTP ${cliQr.status}`);

  // ── 8. integridade do ledger
  console.log('\n8) Integridade financeira');
  const txs = await api('GET', '/wallet', { token: cliente });
  const soma = (txs.data?.transactions ?? []).reduce((a, t) => a + t.amount_cents, 0);
  check('ledger fecha: saldo = Σ transações', soma === txs.data?.balance_cents,
    `Σ=${brl(soma)} saldo=${brl(txs.data?.balance_cents ?? 0)}`);

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
