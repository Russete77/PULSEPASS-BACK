#!/usr/bin/env node
// Programa de fidelidade.
//
// Ponto é dinheiro com outro nome: no momento do resgate, alguém paga a
// diferença. O que este teste guarda são as três regras que impedem a
// plataforma de pagar por engano:
//
//  · o programa NASCE DESLIGADO e não acumula nada até a produtora decidir
//    quanto vale um ponto;
//  · estorno de pedido ESTORNA OS PONTOS — senão comprar, ganhar, resgatar e
//    pedir o dinheiro de volta vira o golpe mais fácil do sistema;
//  · reprocessar um pagamento não credita duas vezes.
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
  console.log(`\n═══ Fidelidade · ${API} ═══\n`);
  const produtora = await login('e2e_produtora@pulsepass.test');
  const cliente = await login('e2e_cliente@pulsepass.test');
  const me = (await api('GET', '/admin/me', { token: produtora })).data;
  const org = me.organizations[0];
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const lote = ev.tiers[0];

  // Estado limpo: execução anterior pode ter deixado regra e pontos.
  const { data: perfil } = await db.from('profiles').select('id').eq('email', 'e2e_cliente@pulsepass.test').single();
  await db.from('fidelidade_ledger').delete().eq('user_id', perfil.id).eq('organization_id', org.id);
  await db.from('fidelidade_config').delete().eq('organization_id', org.id);

  console.log('1) O programa nasce DESLIGADO');
  const cfg0 = await api('GET', `/admin/organizations/${org.id}/fidelidade`, { token: produtora });
  check('config responde mesmo sem nunca ter sido criada', cfg0.status === 200);
  check('nasce inativo', cfg0.data?.ativo === false);
  check('e sem valor sugerido', Number(cfg0.data?.pontos_por_real) === 0 && Number(cfg0.data?.centavos_por_ponto) === 0,
    'quanto vale um ponto é decisão comercial, não padrão de código');

  // A prova de que desligado não acumula: compra paga NÃO gera ponto.
  const p0 = await api('POST', '/orders', {
    token: cliente, body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: lote.id, quantity: 1 }] },
  });
  await api('POST', `/orders/${p0.data.id}/simulate-paid`, { token: cliente });
  const { data: semPontos } = await db.rpc('fidelidade_saldo', { p_user: perfil.id, p_org: org.id });
  check('compra paga NÃO gera ponto com o programa desligado', (semPontos ?? 0) === 0);

  console.log('\n2) Ativar exige as DUAS pontas da regra');
  const meio = await api('PATCH', `/admin/organizations/${org.id}/fidelidade`, {
    token: produtora, body: { ativo: true, pontos_por_real: 1, centavos_por_ponto: 0 },
  });
  check('ativar sem dizer quanto vale o ponto é RECUSADO', meio.status === 400,
    'senão acumularia ponto que não vira nada');

  const ok = await api('PATCH', `/admin/organizations/${org.id}/fidelidade`, {
    token: produtora, body: { ativo: true, pontos_por_real: 1, centavos_por_ponto: 10, minimo_resgate: 10 },
  });
  check('com a regra completa, ativa', ok.status === 200 && ok.data?.ativo === true);

  console.log('\n3) Acúmulo na compra');
  const p1 = await api('POST', '/orders', {
    token: cliente, body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: lote.id, quantity: 1 }] },
  });
  const valor = p1.data.total_cents;
  await api('POST', `/orders/${p1.data.id}/simulate-paid`, { token: cliente });
  const saldo1 = (await api('GET', `/fidelidade/${org.id}/saldo`, { token: cliente })).data;
  const esperado = Math.floor(valor / 100);
  check('pontos creditados na proporção definida', saldo1?.saldo_pontos === esperado,
    `R$ ${(valor / 100).toFixed(2)} → ${saldo1?.saldo_pontos} pts`);
  check('o valor em dinheiro sai da regra da produtora', saldo1?.valor_cents === esperado * 10);

  console.log('\n4) Reprocessar o pagamento NÃO credita de novo');
  await db.from('orders').update({ status: 'pending' }).eq('id', p1.data.id);
  await db.from('orders').update({ status: 'paid' }).eq('id', p1.data.id);
  const saldo2 = (await api('GET', `/fidelidade/${org.id}/saldo`, { token: cliente })).data;
  check('saldo não dobrou', saldo2?.saldo_pontos === esperado,
    'o índice único por pedido é quem impede');

  console.log('\n5) Estorno devolve os pontos');
  await api('POST', `/orders/${p1.data.id}/refund`, { token: cliente });
  const saldo3 = (await api('GET', `/fidelidade/${org.id}/saldo`, { token: cliente })).data;
  check('pontos da compra estornada somem', saldo3?.saldo_pontos === 0,
    'sem isto: comprar, ganhar, resgatar e pedir o dinheiro de volta');

  console.log('\n6) Resgate');
  const p2 = await api('POST', '/orders', {
    token: cliente, body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: lote.id, quantity: 1 }] },
  });
  await api('POST', `/orders/${p2.data.id}/simulate-paid`, { token: cliente });
  const disponivel = (await api('GET', `/fidelidade/${org.id}/saldo`, { token: cliente })).data?.saldo_pontos;

  const demais = await api('POST', `/fidelidade/${org.id}/resgatar`, {
    token: cliente, body: { pontos: disponivel + 1000 },
  });
  check('resgatar mais do que tem é RECUSADO', demais.status === 400, demais.body?.error?.message?.slice(0, 34));

  const migalha = await api('POST', `/fidelidade/${org.id}/resgatar`, { token: cliente, body: { pontos: 1 } });
  check('abaixo do mínimo é recusado', migalha.status === 400,
    'resgate de centavos custa mais em taxa do que vale');

  const bom = await api('POST', `/fidelidade/${org.id}/resgatar`, { token: cliente, body: { pontos: 10 } });
  check('resgate válido passa', bom.status === 200, `${bom.data?.pontos_resgatados} pts = R$ ${(bom.data?.valor_cents / 100).toFixed(2)}`);
  check('saldo desconta o resgatado', bom.data?.saldo_restante === disponivel - 10);

  console.log('\n7) Quem não é dono não mexe na regra');
  const intruso = await api('PATCH', `/admin/organizations/${org.id}/fidelidade`, {
    token: cliente, body: { ativo: false, pontos_por_real: 0, centavos_por_ponto: 0 },
  });
  check('cliente é bloqueado', intruso.status === 403, `HTTP ${intruso.status}`);

  // Devolve o programa ao estado neutro para não afetar outras suítes.
  await db.from('fidelidade_ledger').delete().eq('user_id', perfil.id).eq('organization_id', org.id);
  await db.from('fidelidade_config').delete().eq('organization_id', org.id);

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
