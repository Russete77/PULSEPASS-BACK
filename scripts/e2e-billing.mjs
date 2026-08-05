#!/usr/bin/env node
// Taxa da plataforma editável + transparência do repasse.
//
// Dois riscos que este teste guarda:
//  · a produtora conseguir mexer na própria taxa (seria o mesmo que não ter taxa);
//  · mudar a taxa hoje reescrever o resultado de eventos já realizados — o
//    relatório que a casa conferiu na segunda mudaria sozinho na terça.
import 'dotenv/config';
import { supabase as db } from '../src/config/supabase.js';

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
  console.log(`\n═══ Taxa da plataforma e repasse · ${API} ═══\n`);
  // e2e_produtora está em ADMIN_EMAILS no ambiente de dev → é super-admin aqui.
  const admin = await login('e2e_produtora@pulsepass.test');
  const cliente = await login('e2e_cliente@pulsepass.test');
  const me = await api('GET', '/admin/me', { token: admin });
  const orgId = me.data.organizations[0].id;

  console.log('1) Configuração atual');
  const cfg = await api('GET', '/platform/billing', { token: admin });
  check('super-admin lê a configuração', cfg.status === 200,
    `padrão ${cfg.data?.default_fee_percent}%`);
  check('taxa padrão é 10%', cfg.data?.default_fee_bps === 1000, `${cfg.data?.default_fee_bps} bps`);
  check('lista as produtoras com a taxa de cada uma', Array.isArray(cfg.data?.organizations),
    `${cfg.data?.organizations?.length ?? 0} produtora(s)`);
  const minha = cfg.data.organizations.find((o) => o.id === orgId);
  check('produtora sem taxa própria usa o padrão', minha?.usa_padrao === true);

  console.log('\n2) Cliente e produtora NÃO editam a taxa');
  const golpe = await api('PATCH', '/platform/billing/default-fee', {
    token: cliente, body: { fee_bps: 0 },
  });
  check('cliente é bloqueado', golpe.status === 403, `HTTP ${golpe.status}`);

  console.log('\n3) Taxa negociada por produtora');
  const negociada = await api('PATCH', `/platform/billing/orgs/${orgId}/fee`, {
    token: admin, body: { fee_bps: 700 },
  });
  check('define 7% para esta produtora', negociada.status === 200,
    `${negociada.data?.before ?? 'padrão'} → ${negociada.data?.after} bps`);

  const cfg2 = await api('GET', '/platform/billing', { token: admin });
  const minha2 = cfg2.data.organizations.find((o) => o.id === orgId);
  check('exceção aparece na configuração', minha2?.fee_percent === 7 && minha2?.usa_padrao === false,
    `${minha2?.fee_percent}%`);

  console.log('\n4) A venda CONGELA a taxa aplicada');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const compra = await api('POST', '/orders', {
    token: cliente, headers: { 'idempotency-key': `bill-${Date.now()}` },
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: ev.tiers[0].id, quantity: 1 }], paymentMethod: 'pix' },
  });
  const { data: pedido } = await db.from('orders')
    .select('platform_fee_bps').eq('id', compra.data.id).single();
  check('pedido guarda a taxa daquele momento', pedido.platform_fee_bps === 700,
    `${pedido.platform_fee_bps} bps`);

  // Muda a taxa DEPOIS da venda: o pedido antigo não pode mudar.
  await api('PATCH', `/platform/billing/orgs/${orgId}/fee`, { token: admin, body: { fee_bps: 1500 } });
  const { data: pedidoDepois } = await db.from('orders')
    .select('platform_fee_bps').eq('id', compra.data.id).single();
  check('mudar a taxa NÃO reescreve venda antiga', pedidoDepois.platform_fee_bps === 700,
    `continua ${pedidoDepois.platform_fee_bps} bps`);

  const compra2 = await api('POST', '/orders', {
    token: cliente, headers: { 'idempotency-key': `bill2-${Date.now()}` },
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: ev.tiers[0].id, quantity: 1 }], paymentMethod: 'pix' },
  });
  const { data: pedido2 } = await db.from('orders')
    .select('platform_fee_bps').eq('id', compra2.data.id).single();
  check('venda nova já usa a taxa nova', pedido2.platform_fee_bps === 1500, `${pedido2.platform_fee_bps} bps`);

  console.log('\n5) Mudança de taxa fica na trilha de auditoria');
  const { data: trilha } = await db.from('audit_log')
    .select('action, before, after').eq('action', 'platform.org_fee_change')
    .order('at', { ascending: false }).limit(1).maybeSingle();
  check('troca de taxa auditada com antes e depois',
    trilha?.after?.fee_bps === 1500 && trilha?.before?.fee_bps === 700,
    `${trilha?.before?.fee_bps} → ${trilha?.after?.fee_bps}`);

  console.log('\n6) Transparência para a produtora');
  const t = await api('GET', `/admin/organizations/${orgId}/repasse`, { token: admin });
  check('produtora enxerga o próprio repasse', t.status === 200, `taxa ${t.data?.fee_percent}%`);
  check('diz de onde vem a taxa', t.data?.fee_origem === 'negociada com esta produtora', t.data?.fee_origem);
  check('explica a mecânica em texto', (t.data?.como_funciona?.length ?? 0) >= 5,
    `${t.data?.como_funciona?.length} pontos`);
  check('avisa que a taxa incide sobre o LÍQUIDO',
    t.data.como_funciona.some((l) => /l[íi]quido/i.test(l)));
  check('avisa que estorno reverte o repasse',
    t.data.como_funciona.some((l) => /estorn/i.test(l)));
  check('avisa o prazo do cartão',
    t.data.como_funciona.some((l) => /32 dias/i.test(l)));
  check('traz exemplo com números', t.data?.exemplo?.produtora_cents > 0,
    `de R$100 → produtora ${(t.data.exemplo.produtora_cents / 100).toFixed(2)} · plataforma ${(t.data.exemplo.plataforma_cents / 100).toFixed(2)}`);

  console.log('\n7) Produtora não lê repasse de outra');
  const outra = await api('GET', '/admin/organizations/00000000-0000-0000-0000-000000000000/repasse', { token: admin });
  check('organização alheia é bloqueada', outra.status === 403, `HTTP ${outra.status}`);

  // devolve a taxa ao padrão
  await api('PATCH', `/platform/billing/orgs/${orgId}/fee`, { token: admin, body: { fee_bps: null } });

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
