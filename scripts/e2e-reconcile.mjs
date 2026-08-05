#!/usr/bin/env node
// Reconciliação: o que salva a operação quando a fila de webhook trava.
//
// A doc do Asaas é clara: 15 falhas consecutivas de entrega INTERROMPEM a fila
// e ela só volta com reativação manual no painel. Na prática, uma queda da API
// no sábado à noite faria clientes pagarem e não receberem ingresso — e nós
// nem saberíamos, porque "nenhuma venda" e "fila travada" parecem iguais.
//
// Este teste simula exatamente isso: o pagamento existe e está confirmado no
// provedor, mas o webhook nunca chegou.
import 'dotenv/config';
import { supabase as db } from '../src/config/supabase.js';
import { reconcilePending, webhookHealth } from '../src/modules/payments/reconcile.js';

const API = process.env.API_BASE || 'http://localhost:4000/api';
const SB = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_ANON_KEY;

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

async function main() {
  console.log(`\n═══ Reconciliação de pagamentos · ${API} ═══\n`);
  const cliente = await login('e2e_cliente@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const tier = ev.tiers[0];

  console.log('1) Cliente paga, mas o webhook NUNCA chega');
  const buy = await api('POST', '/orders', {
    token: cliente, headers: { 'idempotency-key': `rec-${Date.now()}` },
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: tier.id, quantity: 1 }], paymentMethod: 'pix' },
  });
  const orderId = buy.data.id;

  // Simula o estado real: no provedor a cobrança está CONFIRMED, e o pedido
  // está velho o bastante para já ter resolvido. O evento simplesmente não veio.
  // O id do mock carrega status E valor: a confirmação recusa cobrança com
  // valor divergente do pedido, e essa proteção precisa continuar valendo aqui.
  const totalCents = buy.data.total_cents;
  const pagamentoConfirmado = `pay_mock_CONFIRMED_${totalCents}_${Date.now()}`;
  await db.from('orders').update({
    asaas_payment_id: pagamentoConfirmado,
    created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
  }).eq('id', orderId);

  const { data: antes } = await db.from('orders').select('status').eq('id', orderId).single();
  const { data: tkAntes } = await db.from('tickets').select('id').eq('order_id', orderId);
  check('pedido continua pendente sem o webhook', antes.status === 'pending', `status=${antes.status}`);
  check('nenhum ingresso emitido', tkAntes.length === 0, `${tkAntes.length} ingresso(s)`);

  console.log('\n2) Saúde acusa pagamento pendente parado');
  // Simula a fila interrompida: nenhum evento recente. Envelhecer só o mais
  // novo não serve — o segundo mais novo assumiria o posto e continuaria
  // "recente". Por isso todos os recentes recuam no tempo.
  const CORTE = new Date(Date.now() - 90 * 60_000).toISOString();
  const { data: recentes } = await db.from('webhook_events')
    .select('id, created_at').gt('created_at', CORTE);
  for (const e of recentes ?? []) {
    await db.from('webhook_events').update({ created_at: CORTE }).eq('id', e.id);
  }

  const saude = await webhookHealth({ silenceMinutes: 30 });
  check('detecta pendência acumulada', saude.pending_payments >= 1,
    `${saude.pending_payments} pendente(s)`);
  check('marca a entrega como NÃO saudável', saude.healthy === false,
    `${saude.minutes_since_last_event} min sem evento`);
  check('explica o que fazer', !!saude.hint, saude.hint?.slice(0, 68));

  // Devolve os carimbos originais: o teste não pode deixar o banco alterado.
  for (const e of recentes ?? []) {
    await db.from('webhook_events').update({ created_at: e.created_at }).eq('id', e.id);
  }

  console.log('\n3) Reconciliação confirma o que o webhook perdeu');
  const resumo = await reconcilePending({ olderThanMinutes: 10 });
  check('varredura confirmou o pedido', resumo.confirmados >= 1, JSON.stringify(resumo));

  const { data: depois } = await db.from('orders').select('status').eq('id', orderId).single();
  const { data: tkDepois } = await db.from('tickets').select('id, status').eq('order_id', orderId);
  check('pedido virou PAGO', depois.status === 'paid', `status=${depois.status}`);
  check('ingresso foi emitido', tkDepois.length === 1 && tkDepois[0].status === 'valid',
    `${tkDepois.length} ingresso(s)`);

  console.log('\n4) Rodar de novo não duplica nada (idempotente)');
  const resumo2 = await reconcilePending({ olderThanMinutes: 10 });
  const { data: tkFinal } = await db.from('tickets').select('id').eq('order_id', orderId);
  check('segunda varredura não emite ingresso extra', tkFinal.length === 1,
    `${tkFinal.length} ingresso(s) · confirmados=${resumo2.confirmados}`);

  console.log('\n5) Estorno perdido também é recuperado');
  const buy2 = await api('POST', '/orders', {
    token: cliente, headers: { 'idempotency-key': `rec2-${Date.now()}` },
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: tier.id, quantity: 1 }], paymentMethod: 'pix' },
  });
  await db.from('orders').update({
    asaas_payment_id: `pay_mock_REFUNDED_${buy2.data.total_cents}_${Date.now()}`,
    created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
  }).eq('id', buy2.data.id);

  const resumo3 = await reconcilePending({ olderThanMinutes: 10 });
  const { data: ord2 } = await db.from('orders').select('status, reversal_kind').eq('id', buy2.data.id).single();
  check('estorno não entregue é aplicado', resumo3.revertidos >= 1 || ord2.reversal_kind === 'refund',
    `status=${ord2.status} kind=${ord2.reversal_kind}`);

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
