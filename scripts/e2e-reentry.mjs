#!/usr/bin/env node
// Reentrada controlada + lotação em tempo real.
//
// Dois riscos opostos que este teste protege:
//  · sem reentrada, quem sai pra fumar volta e é barrado — discussão na porta;
//  · com reentrada solta, um entra, sai e passa o celular pro amigo.
// Por isso a política é por evento, o mesmo ingresso não entra duas vezes sem
// ter saído, e existe limite. A lotação sai de graça dos movimentos.
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

/** Compra e paga um ingresso, devolvendo o código. */
async function novoIngresso(cliente, slug, tierId) {
  const buy = await api('POST', '/orders', {
    token: cliente, headers: { 'idempotency-key': `re-${Date.now()}-${Math.round(Math.random() * 1e6)}` },
    body: { eventSlug: slug, items: [{ ticket_tier_id: tierId, quantity: 1 }], paymentMethod: 'pix' },
  });
  await api('POST', `/orders/${buy.data.id}/simulate-paid`, { token: cliente });
  const tks = await api('GET', '/tickets', { token: cliente });
  return (tks.data.tickets ?? tks.data).find((t) => t.order_id === buy.data.id);
}

async function main() {
  console.log(`\n═══ Reentrada + lotação · ${API} ═══\n`);
  const cliente = await login('e2e_cliente@pulsepass.test');
  const porteiro = await login('e2e_porteiro@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const eventId = ev.id;
  const tier = ev.tiers[0];

  const passar = (code, direction) => api('POST', `/admin/events/${eventId}/checkin`, {
    token: porteiro, body: { input: code, ...(direction ? { direction } : {}) },
  });

  // ── Evento SEM reentrada (padrão) ──
  await db.from('events').update({ reentry_enabled: false, reentry_max: null }).eq('id', eventId);
  console.log('1) Evento sem reentrada (padrão) — comportamento antigo preservado');
  const t1 = await novoIngresso(cliente, 'festa-e2e', tier.id);
  const e1 = await passar(t1.code);
  check('primeira entrada libera', e1.data?.result === 'ok', e1.data?.message);
  const e2 = await passar(t1.code);
  check('segunda passagem é barrada', e2.data?.result === 'already_used', e2.data?.message);

  // ── Evento COM reentrada, limite 2 ──
  await db.from('events').update({ reentry_enabled: true, reentry_max: 2 }).eq('id', eventId);
  console.log('\n2) Evento com reentrada (limite 2)');
  const t2 = await novoIngresso(cliente, 'festa-e2e', tier.id);

  const a = await passar(t2.code);
  check('entrada 1 libera', a.data?.result === 'ok' && a.data?.inside === true, `entradas=${a.data?.entries}`);

  const b = await passar(t2.code);
  check('estando dentro, a passagem vira SAÍDA', b.data?.result === 'ok' && b.data?.direction === 'out',
    b.data?.message);

  const c = await passar(t2.code);
  check('depois de sair, reentrada libera', c.data?.result === 'ok' && c.data?.direction === 'in',
    `${c.data?.message} · entradas=${c.data?.entries}`);

  // Já usou as 2 entradas: sai e tenta voltar → limite estoura.
  await passar(t2.code);                         // saída
  const d = await passar(t2.code);               // tentativa de 3ª entrada
  check('limite de reentradas é respeitado', d.data?.result === 'already_used', d.data?.message);

  console.log('\n3) Ingresso emprestado não passa (não entra 2x sem sair)');
  const t3 = await novoIngresso(cliente, 'festa-e2e', tier.id);
  await passar(t3.code, 'in');
  const dobrado = await passar(t3.code, 'in');
  check('segunda ENTRADA explícita sem ter saído é barrada',
    dobrado.data?.result === 'already_used', dobrado.data?.message);

  console.log('\n4) Saída de quem não está dentro é recusada');
  const t4 = await novoIngresso(cliente, 'festa-e2e', tier.id);
  const saidaFalsa = await passar(t4.code, 'out');
  check('saída sem entrada é inválida', saidaFalsa.data?.result === 'invalid', saidaFalsa.data?.message);

  console.log('\n5) Lotação em tempo real');
  const occ = await api('GET', `/admin/events/${eventId}/occupancy`, { token: porteiro });
  check('endpoint de lotação responde', occ.status === 200, JSON.stringify(occ.data));
  check('conta quem está dentro', typeof occ.data?.inside === 'number', `dentro=${occ.data?.inside}`);
  check('conta quem saiu', typeof occ.data?.left === 'number', `saíram=${occ.data?.left}`);
  check('total de entradas ≥ pessoas dentro', occ.data?.total_entries >= occ.data?.inside,
    `${occ.data?.total_entries} entradas · ${occ.data?.inside} dentro`);

  console.log('\n6) Lotação é da equipe do evento');
  const golpe = await api('GET', `/admin/events/${eventId}/occupancy`, { token: cliente });
  check('cliente não vê lotação', golpe.status === 403, `HTTP ${golpe.status}`);

  // Devolve o evento ao padrão pra não afetar os outros testes.
  await db.from('events').update({ reentry_enabled: false, reentry_max: null }).eq('id', eventId);

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
