#!/usr/bin/env node
// Fila de espera: recupera a receita que hoje evapora.
//
// Cenário real: o lote esgota, o cliente fecha a aba. De madrugada alguém
// reembolsa e o ingresso volta ao estoque sem ninguém para comprá-lo. A fila
// liga as duas pontas — e o PRAZO do convite é o que impede o primeiro da
// lista de travar a vaga para sempre.
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
  console.log(`\n═══ Fila de espera · ${API} ═══\n`);
  const cliente = await login('e2e_cliente@pulsepass.test');
  const produtora = await login('e2e_produtora@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const eventId = ev.id;

  // Lote dedicado com 1 vaga: o jeito honesto de testar esgotamento.
  const marca = Date.now();
  const { data: tier } = await db.from('ticket_tiers').insert({
    event_id: eventId, name: `Fila ${marca}`, price_cents: 4000,
    quantity_total: 1, quantity_sold: 0, status: 'on_sale', position: 99,
  }).select('id, name, quantity_total, quantity_sold').single();

  console.log('1) Lote com ingresso disponível NÃO aceita fila');
  const cedo = await api('POST', '/events/festa-e2e/waitlist', {
    body: { ticket_tier_id: tier.id, email: `cedo_${marca}@teste.com` },
  });
  check('recusa fila com estoque disponível', cedo.status === 409, `HTTP ${cedo.status}`);

  console.log('\n2) Esgota o lote');
  const buy = await api('POST', '/orders', {
    token: cliente, headers: { 'idempotency-key': `wl-${marca}` },
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: tier.id, quantity: 1 }], paymentMethod: 'pix' },
  });
  await api('POST', `/orders/${buy.data.id}/simulate-paid`, { token: cliente });
  const { data: t2 } = await db.from('ticket_tiers').select('quantity_sold, quantity_total').eq('id', tier.id).single();
  check('lote esgotado', t2.quantity_sold >= t2.quantity_total, `${t2.quantity_sold}/${t2.quantity_total}`);

  console.log('\n3) Fila aceita inscrição e informa a posição');
  const a = await api('POST', '/events/festa-e2e/waitlist', {
    body: { ticket_tier_id: tier.id, email: `primeiro_${marca}@teste.com`, name: 'Primeiro' },
  });
  check('primeiro entra na fila', a.status === 201 && a.data?.status === 'waiting',
    `${a.data?.ahead} na frente`);
  check('primeiro está no topo', a.data?.ahead === 0);

  const b = await api('POST', '/events/festa-e2e/waitlist', {
    body: { ticket_tier_id: tier.id, email: `segundo_${marca}@teste.com`, name: 'Segundo' },
  });
  check('segundo entra atrás do primeiro', b.data?.ahead === 1, `${b.data?.ahead} na frente`);

  console.log('\n4) Clicar duas vezes não duplica a posição');
  const dup = await api('POST', '/events/festa-e2e/waitlist', {
    body: { ticket_tier_id: tier.id, email: `primeiro_${marca}@teste.com` },
  });
  check('segunda inscrição devolve a mesma vaga', dup.data?.already === true && dup.data?.id === a.data.id);

  console.log('\n5) Reembolso devolve o estoque e CONVIDA a fila');
  const ref = await api('POST', `/orders/${buy.data.id}/refund`, { token: cliente });
  check('reembolso aceito', ref.status === 200, `HTTP ${ref.status}`);
  await new Promise((r) => setTimeout(r, 1500)); // convite roda fora do request

  const { data: fila } = await db.from('waitlist')
    .select('email, status, invite_expires_at').eq('ticket_tier_id', tier.id)
    .order('position', { ascending: true });
  const primeiro = fila.find((f) => f.email.startsWith('primeiro'));
  const segundo = fila.find((f) => f.email.startsWith('segundo'));
  check('PRIMEIRO da fila foi convidado', primeiro?.status === 'invited', `status=${primeiro?.status}`);
  check('convite tem PRAZO', !!primeiro?.invite_expires_at,
    primeiro?.invite_expires_at ? new Date(primeiro.invite_expires_at).toLocaleString('pt-BR') : '-');
  check('segundo continua esperando (só 1 vaga abriu)', segundo?.status === 'waiting',
    `status=${segundo?.status}`);

  console.log('\n6) Convite vencido devolve a vez a quem está atrás');
  await db.from('waitlist')
    .update({ invite_expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('email', primeiro.email);
  const { data: expirados } = await db.rpc('waitlist_expire_invites');
  check('convite vencido expira', expirados >= 1, `${expirados} expirado(s)`);

  const { data: convite2 } = await db.rpc('waitlist_invite', { p_tier: tier.id, p_slots: null, p_ttl_minutes: 60 });
  check('vaga passa para o próximo da fila', convite2?.invited === 1,
    `convidados=${convite2?.invited}`);
  const { data: fila2 } = await db.from('waitlist').select('email, status').eq('ticket_tier_id', tier.id);
  check('segundo agora está convidado',
    fila2.find((f) => f.email.startsWith('segundo'))?.status === 'invited');

  console.log('\n7) Gestão enxerga a fila');
  const gestao = await api('GET', `/admin/events/${eventId}/waitlist`, { token: produtora });
  check('produtora lê a fila', gestao.status === 200,
    `esperando=${gestao.data?.waiting} convidados=${gestao.data?.invited}`);
  const golpe = await api('GET', `/admin/events/${eventId}/waitlist`, { token: cliente });
  check('cliente não lê a fila', golpe.status === 403, `HTTP ${golpe.status}`);

  // limpeza do lote de teste
  await db.from('waitlist').delete().eq('ticket_tier_id', tier.id);
  await db.from('ticket_tiers').delete().eq('id', tier.id);

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
