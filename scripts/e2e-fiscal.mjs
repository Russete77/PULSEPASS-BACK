#!/usr/bin/env node
// Módulo fiscal (NFS-e) ponta a ponta.
//
// O que precisa ser verdade: nota única por pedido, emissão só de pedido pago,
// cancelamento automático quando o dinheiro é devolvido, e nada disso acessível
// a quem não é da produtora. Nota duplicada ou nota viva sobre venda estornada
// vira problema na apuração — por isso o banco também recusa, não só o código.
import 'dotenv/config';

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
  console.log(`\n═══ Fiscal (NFS-e) · ${API} ═══\n`);
  const produtora = await login('e2e_produtora@pulsepass.test');
  const cliente = await login('e2e_cliente@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const tier = ev.tiers[0];

  console.log('1) Pedido pago é pré-requisito');
  const pend = await api('POST', '/orders', {
    token: cliente, headers: { 'idempotency-key': `fisc-p-${Date.now()}` },
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: tier.id, quantity: 1 }], paymentMethod: 'pix' },
  });
  const semPagar = await api('POST', `/admin/events/${ev.id}/fiscal/issue`, {
    token: produtora, body: { order_id: pend.data.id },
  });
  check('pedido pendente NÃO gera nota', semPagar.status === 400, `HTTP ${semPagar.status}`);

  console.log('\n2) Emissão de pedido pago');
  const buy = await api('POST', '/orders', {
    token: cliente, headers: { 'idempotency-key': `fisc-${Date.now()}` },
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: tier.id, quantity: 1 }], paymentMethod: 'pix' },
  });
  const orderId = buy.data.id;
  await api('POST', `/orders/${orderId}/simulate-paid`, { token: cliente });

  const emit = await api('POST', `/admin/events/${ev.id}/fiscal/issue`, {
    token: produtora, body: { order_id: orderId },
  });
  const doc = emit.data?.document;
  check('nota emitida', emit.status === 201 && !!doc, `status=${doc?.status} nº=${doc?.numero}`);
  check('valor da nota = total do pedido', doc?.amount_cents === buy.data.total_cents,
    `${doc?.amount_cents} vs ${buy.data.total_cents}`);
  check('provedor registrado', !!doc?.provider, doc?.provider);

  console.log('\n3) Nota NÃO duplica (idempotente)');
  const dup = await api('POST', `/admin/events/${ev.id}/fiscal/issue`, {
    token: produtora, body: { order_id: orderId },
  });
  check('segunda emissão devolve a mesma nota', dup.data?.already === true
    && dup.data?.document?.id === doc.id, `id ${dup.data?.document?.id === doc.id ? 'igual' : 'DIFERENTE'}`);

  console.log('\n4) Listagem e resumo para o contador');
  const lista = await api('GET', `/admin/events/${ev.id}/fiscal`, { token: produtora });
  check('lista de documentos do evento', lista.status === 200 && Array.isArray(lista.data?.documents),
    `${lista.data?.documents?.length ?? 0} documento(s)`);
  check('resumo traz contagem de emitidas', typeof lista.data?.summary?.issued_count === 'number',
    `emitidas=${lista.data?.summary?.issued_count}`);
  check('modo do emissor é explícito', !!lista.data?.mode, `modo=${lista.data?.mode}`);

  console.log('\n5) Reembolso CANCELA a nota');
  const ref = await api('POST', `/orders/${orderId}/refund`, { token: cliente });
  check('reembolso aceito', ref.status === 200, `HTTP ${ref.status}`);
  await new Promise((r) => setTimeout(r, 1200)); // cancelamento roda fora do request
  const depois = await api('GET', `/admin/events/${ev.id}/fiscal`, { token: produtora });
  const alvo = (depois.data?.documents ?? []).find((d) => d.order_id === orderId);
  check('nota fica cancelada após estorno', alvo?.status === 'cancelled', `status=${alvo?.status}`);

  console.log('\n6) Fiscal é só da produtora');
  const golpe = await api('GET', `/admin/events/${ev.id}/fiscal`, { token: cliente });
  check('cliente não vê documentos fiscais', golpe.status === 403, `HTTP ${golpe.status}`);

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
