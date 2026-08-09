#!/usr/bin/env node
// Trilha de auditoria: existe, registra o que importa e NÃO PODE SER ALTERADA.
//
// O teste que realmente vale é o de imutabilidade. Trilha que o próprio
// sistema consegue reescrever não serve como prova — se o backend puder dar
// UPDATE, qualquer registro incômodo some e a auditoria vira teatro.
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
  // 429 é o limitador de borda, não resposta do domínio. Rodando as suítes em
  // sequência do mesmo IP ele estoura, e um assert de autorização leria
  // "bloqueado" pelo motivo errado. Respira e tenta de novo.
  if (r.status === 429) {
    await new Promise((s) => setTimeout(s, 1500));
    r = await chamada();
  }
  let j = null; try { j = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, body: j, data: j?.data };
};

async function main() {
  console.log(`\n═══ Trilha de auditoria · ${API} ═══\n`);
  const produtora = await login('e2e_produtora@pulsepass.test');
  const porteiro = await login('e2e_porteiro@pulsepass.test');
  const cliente = await login('e2e_cliente@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const eventId = ev.id;

  console.log('1) Venda na bilheteria entra na trilha');
  const open = await api('GET', `/admin/events/${eventId}/box-office`, { token: porteiro });
  const tier = open.data.tiers.find((t) => t.price_cents > 0);
  const venda = await api('POST', `/admin/events/${eventId}/box-office/sales`, {
    token: porteiro,
    body: { items: [{ ticket_tier_id: tier.id, quantity: 1 }], method: 'cash',
            received_cents: tier.price_cents * 3, buyer: { name: 'Auditoria Teste' } },
  });
  check('venda realizada', venda.status === 201, `pedido ${venda.data?.order_id?.slice(0, 8)}`);

  await new Promise((r) => setTimeout(r, 600));
  const trilha = await api('GET', `/admin/events/${eventId}/audit`, { token: produtora });
  check('trilha responde para a gestão', trilha.status === 200,
    `${trilha.data?.entries?.length ?? 0} registro(s)`);

  const reg = (trilha.data?.entries ?? []).find((e) => e.entity_id === venda.data.order_id);
  check('a venda está registrada', !!reg, reg?.action);
  check('registra QUEM vendeu', reg?.actor_email === 'e2e_porteiro@pulsepass.test', reg?.actor_email);
  check('registra QUANTO', reg?.amount_cents === venda.data.total_cents,
    `${reg?.amount_cents} centavos`);
  check('registra o CONTEXTO da venda', reg?.after?.method === 'cash' && reg?.after?.change_cents >= 0,
    `forma=${reg?.after?.method} troco=${reg?.after?.change_cents}`);
  check('registra o IP de origem', !!reg?.actor_ip, reg?.actor_ip);

  console.log('\n2) Filtro por dinheiro (a consulta de auditoria mais comum)');
  const money = await api('GET', `/admin/events/${eventId}/audit?money=1`, { token: produtora });
  const todosComValor = (money.data?.entries ?? []).every((e) => e.amount_cents !== null);
  check('filtro traz só o que moveu dinheiro', todosComValor,
    `${money.data?.entries?.length ?? 0} registro(s)`);

  console.log('\n3) IMUTABILIDADE — nem o backend consegue mexer');
  // Estas chamadas usam service_role: é o backend tentando adulterar a trilha.
  const { error: upErr } = await db.from('audit_log')
    .update({ amount_cents: 1 }).eq('id', reg.id);
  check('UPDATE é recusado pelo banco', !!upErr, upErr?.message?.slice(0, 70));

  const { error: delErr } = await db.from('audit_log').delete().eq('id', reg.id);
  check('DELETE é recusado pelo banco', !!delErr, delErr?.message?.slice(0, 70));

  const { data: aindaLa } = await db.from('audit_log')
    .select('id, amount_cents').eq('id', reg.id).maybeSingle();
  check('o registro continua íntegro', aindaLa?.amount_cents === reg.amount_cents,
    `${aindaLa?.amount_cents} centavos (inalterado)`);

  console.log('\n4) Troca da carteira de repasse é rastreada');
  const me = await api('GET', '/admin/me', { token: produtora });
  const orgId = me.data?.organizations?.[0]?.id;
  if (orgId) {
    const novo = `wallet_teste_${Date.now()}`;
    await api('PATCH', `/admin/organizations/${orgId}/asaas-wallet`, {
      token: produtora, body: { asaas_wallet_id: novo },
    });
    await new Promise((r) => setTimeout(r, 500));
    const { data: w } = await db.from('audit_log')
      .select('action, before, after').eq('action', 'organization.wallet_change')
      .order('at', { ascending: false }).limit(1).maybeSingle();
    check('mudança de destino do dinheiro registrada', w?.after?.asaas_wallet_id === novo,
      `${w?.before?.asaas_wallet_id ?? 'vazio'} → ${w?.after?.asaas_wallet_id}`);
    // devolve ao estado anterior
    await api('PATCH', `/admin/organizations/${orgId}/asaas-wallet`, {
      token: produtora, body: { asaas_wallet_id: w?.before?.asaas_wallet_id ?? null },
    });
  } else {
    check('mudança de destino do dinheiro registrada', false, 'org não encontrada');
  }

  console.log('\n5) Trilha não é pública');
  const golpe = await api('GET', `/admin/events/${eventId}/audit`, { token: cliente });
  check('cliente não lê a trilha', golpe.status === 403, `HTTP ${golpe.status}`);
  const porta = await api('GET', `/admin/events/${eventId}/audit`, { token: porteiro });
  check('porteiro também não lê (só gestão)', porta.status === 403, `HTTP ${porta.status}`);

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
