#!/usr/bin/env node
// Transferência de ingresso.
//
// A transferência existia e trocava só o dono. O que este teste guarda é a
// parte que faltava e que é a razão de a funcionalidade existir: o QR do
// remetente tem que MORRER no instante da transferência.
//
// Sem isso, quem passa o ingresso adiante continua com um print que abre a
// porta — entra, e quem recebeu chega e ouve "já foi usado". O prejuízo é
// duplo: a casa deixa entrar quem não devia e barra quem devia.
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
const api = async (m, p, { token, body } = {}) => {
  const chamada = () => fetch(API + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let r = await chamada();
  if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500)); r = await chamada(); }
  let j = null; try { j = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, body: j, data: j?.data };
};

async function main() {
  console.log(`\n═══ Transferência de ingresso · ${API} ═══\n`);
  const cliente = await login('e2e_cliente@pulsepass.test');
  const outro = await login('e2e_promoter@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const lote = ev.tiers[0];

  console.log('1) Compra um ingresso para transferir');
  const pedido = await api('POST', '/orders', {
    token: cliente,
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: lote.id, quantity: 1 }] },
  });
  await api('POST', `/orders/${pedido.data.id}/simulate-paid`, { token: cliente });
  const meus = (await api('GET', '/tickets', { token: cliente })).data;
  const ing = meus?.[0];
  check('ingresso emitido', !!ing?.id, ing?.code);
  if (!ing) { console.log('\n✖ sem ingresso, o resto não faz sentido'); process.exit(1); }

  // Guarda o par que a portaria usa para validar ANTES da transferência.
  const { data: antes } = await db.from('tickets').select('code, qr_secret, owner_id').eq('id', ing.id).single();

  console.log('\n2) Transfere para quem já tem conta');
  const t = await api('POST', `/tickets/${ing.id}/transfer`, {
    token: cliente, body: { toEmail: 'e2e_promoter@pulsepass.test' },
  });
  check('transferência aceita', t.status === 200 && t.data?.delivered === true, t.data?.status);

  const { data: depois } = await db.from('tickets').select('code, qr_secret, owner_id').eq('id', ing.id).single();
  check('o dono mudou', depois.owner_id !== antes.owner_id);

  // ── O CORAÇÃO DO TESTE ──
  // Se qualquer um dos dois sobreviver, o ingresso antigo ainda entra: o
  // código curto é aceito na bilheteria e o qr_secret assina o QR rotativo.
  check('o CÓDIGO foi rotacionado', depois.code !== antes.code, `${antes.code} → ${depois.code}`);
  check('o QR_SECRET foi rotacionado', depois.qr_secret !== antes.qr_secret,
    'senão o print antigo continuaria abrindo a porta');

  console.log('\n3) Quem transferiu perde o acesso');
  const veAinda = await api('GET', `/tickets/${ing.id}`, { token: cliente });
  check('remetente não vê mais o ingresso', veAinda.status === 404, `HTTP ${veAinda.status}`);
  const doOutro = await api('GET', '/tickets', { token: outro });
  check('destinatário passou a ver', (doOutro.data ?? []).some((x) => x.id === ing.id));

  console.log('\n4) Não se transfere o que não é seu');
  const roubo = await api('POST', `/tickets/${ing.id}/transfer`, {
    token: cliente, body: { toEmail: 'e2e_cliente@pulsepass.test' },
  });
  check('ex-dono é RECUSADO', roubo.status === 404, `HTTP ${roubo.status}`);

  console.log('\n5) Depois da entrada não se transfere');
  await db.from('tickets').update({ checked_in_at: new Date().toISOString() }).eq('id', ing.id);
  const jaEntrou = await api('POST', `/tickets/${ing.id}/transfer`, {
    token: outro, body: { toEmail: 'e2e_cliente@pulsepass.test' },
  });
  check('ingresso já usado é RECUSADO', jaEntrou.status === 409,
    jaEntrou.body?.error?.message?.slice(0, 44));
  await db.from('tickets').update({ checked_in_at: null }).eq('id', ing.id);

  console.log('\n6) E-mail sem conta fica pendente — sem tirar o ingresso de ninguém');
  const pend = await api('POST', `/tickets/${ing.id}/transfer`, {
    token: outro, body: { toEmail: `ninguem-${Date.now().toString(36)}@teste.test` },
  });
  check('vira pendente', pend.status === 200 && pend.data?.delivered === false, pend.data?.status);
  const { data: durante } = await db.from('tickets').select('owner_id').eq('id', ing.id).single();
  check('o ingresso NÃO saiu do dono atual', durante.owner_id === depois.owner_id,
    'ninguém pode ficar sem nada enquanto a outra pessoa não se cadastra');

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
