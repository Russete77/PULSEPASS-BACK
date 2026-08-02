#!/usr/bin/env node
// Entrega de ingresso por e-mail: prova que a falha deixou de ser SILENCIOSA.
//
// Sem RESEND_API_KEY o envio não acontece — isso é esperado. O que não pode
// acontecer é ninguém ficar sabendo: cada pedido tem que registrar a tentativa
// e o reenvio manual tem que existir, senão o cliente que não recebeu o
// ingresso só descobre na fila do evento.
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
  console.log(`\n═══ Entrega de ingressos · ${API} ═══\n`);
  const cliente = await login('e2e_cliente@pulsepass.test');
  const outro = await login('e2e_barman@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const tier = ev.tiers[0];

  console.log('1) Compra confirmada dispara a entrega');
  const buy = await api('POST', '/orders', {
    token: cliente, headers: { 'idempotency-key': `deliv-${Date.now()}` },
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: tier.id, quantity: 1 }], paymentMethod: 'pix' },
  });
  const orderId = buy.data?.id;
  check('pedido criado', buy.status === 201 && !!orderId);
  await api('POST', `/orders/${orderId}/simulate-paid`, { token: cliente });
  await new Promise((r) => setTimeout(r, 1500)); // entrega roda fora do request

  console.log('\n2) A tentativa fica REGISTRADA (não some num log)');
  const resend = await api('POST', `/orders/${orderId}/resend-tickets`, { token: cliente });
  check('endpoint de reenvio existe', resend.status === 200, `HTTP ${resend.status}`);
  const hist = resend.data?.history ?? [];
  check('histórico de entrega registrado', hist.length > 0, `${hist.length} tentativa(s)`);
  const st = hist[0]?.status;
  check('status é explícito (sent/failed/skipped)', ['sent', 'failed', 'skipped'].includes(st), `status=${st}`);
  if (st !== 'sent') {
    check('motivo da não-entrega é legível', !!hist[0]?.error, hist[0]?.error?.slice(0, 60));
  }

  console.log('\n3) Reenvio é do DONO do pedido');
  const roubo = await api('POST', `/orders/${orderId}/resend-tickets`, { token: outro });
  check('terceiro não reenvia ingresso alheio', roubo.status === 404, `HTTP ${roubo.status}`);

  console.log('\n4) Pedido não pago não tem o que enviar');
  const pend = await api('POST', '/orders', {
    token: cliente, headers: { 'idempotency-key': `deliv-p-${Date.now()}` },
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: tier.id, quantity: 1 }], paymentMethod: 'pix' },
  });
  const semPagar = await api('POST', `/orders/${pend.data.id}/resend-tickets`, { token: cliente });
  check('pedido pendente recusa reenvio', semPagar.status === 400, `HTTP ${semPagar.status}`);

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
