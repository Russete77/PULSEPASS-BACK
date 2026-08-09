#!/usr/bin/env node
// Bilheteria física ponta a ponta, contra a API real.
//
// Cobre o que de fato acontece na entrada de um evento: venda em dinheiro com
// troco, venda com e-mail (a pessoa passa a ter conta e ingresso no app),
// cortesia, recusa de pagamento insuficiente, e o fechamento do caixa que a
// produtora usa às 4h da manhã pra bater com o dinheiro na mão.
import 'dotenv/config';

const API = process.env.API_BASE || 'http://localhost:4000/api';
const SB = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const PASS = 'Teste12345!';

let pass = 0, fail = 0;
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${label}${detail ? ' · ' + detail : ''}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ' · ' + detail : ''}`); }
};

async function login(email) {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login falhou (${email})`);
  return j.access_token;
}
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
  console.log(`\n═══ Bilheteria física · ${API} ═══\n`);
  const porteiro = await login('e2e_porteiro@pulsepass.test');
  const cliente = await login('e2e_cliente@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const eventId = ev.id;

  console.log('1) Abrir a bilheteria');
  const open = await api('GET', `/admin/events/${eventId}/box-office`, { token: porteiro });
  check('bilheteiro abre o caixa', open.status === 200 && open.data?.tiers?.length > 0,
    `${open.data?.tiers?.length ?? 0} lote(s)`);
  const tier = open.data.tiers.find((t) => t.price_cents > 0);
  const caixaAntes = open.data?.report?.total_cents ?? 0;

  console.log('\n2) Venda em DINHEIRO com troco (sem cadastro → ao portador)');
  const preco = tier.price_cents;
  // Entregue MAIS que o preço de face: o total real inclui a taxa de serviço do
  // evento, então o troco é conferido contra o total cobrado, não contra o lote.
  const entregue = preco * 2 + 5000;
  const venda = await api('POST', `/admin/events/${eventId}/box-office/sales`, {
    token: porteiro,
    body: {
      items: [{ ticket_tier_id: tier.id, quantity: 2 }],
      method: 'cash', received_cents: entregue,
      buyer: { name: 'Maria da Porta' }, note: 'venda de teste',
    },
  });
  check('venda liquidada na hora', venda.status === 201 && !!venda.data?.order_id,
    `${brl(venda.data?.total_cents ?? 0)}`);
  check('troco = recebido − total cobrado',
    venda.data?.change_cents === entregue - venda.data?.total_cents,
    `${brl(entregue)} − ${brl(venda.data?.total_cents ?? 0)} = ${brl(venda.data?.change_cents ?? 0)}`);
  check('2 ingressos emitidos na hora', venda.data?.tickets?.length === 2,
    (venda.data?.tickets ?? []).map((t) => t.code).join(' '));
  check('ingresso AO PORTADOR com nome do comprador', venda.data?.bearer === true
    && venda.data?.tickets?.[0]?.holder_name === 'Maria da Porta');

  console.log('\n3) O ingresso vendido na porta ENTRA no evento');
  const code = venda.data.tickets[0].code;
  const ci = await api('POST', `/admin/events/${eventId}/checkin`, { token: porteiro, body: { input: code } });
  check('check-in do ingresso de bilheteria', ci.data?.result === 'ok', `result=${ci.data?.result}`);

  console.log('\n4) Pagamento insuficiente é RECUSADO');
  const curto = await api('POST', `/admin/events/${eventId}/box-office/sales`, {
    token: porteiro,
    body: { items: [{ ticket_tier_id: tier.id, quantity: 1 }], method: 'cash', received_cents: 1 },
  });
  check('recebeu menos que o total → recusa', curto.status >= 400, `HTTP ${curto.status}`);

  console.log('\n5) Venda COM e-mail (comprador ganha conta e ingresso no app)');
  const emailNovo = `e2e_porta_${Date.now()}@pulsepass.test`;
  const comEmail = await api('POST', `/admin/events/${eventId}/box-office/sales`, {
    token: porteiro,
    body: {
      items: [{ ticket_tier_id: tier.id, quantity: 1 }],
      method: 'card_machine',
      buyer: { name: 'João Cadastrado', email: emailNovo },
    },
  });
  check('venda na maquininha liquidada', comEmail.status === 201, brl(comEmail.data?.total_cents ?? 0));
  check('não é ao portador (tem dono de verdade)', comEmail.data?.bearer === false);

  console.log('\n6) Cortesia (valor zero, rastreada)');
  const cortesia = await api('POST', `/admin/events/${eventId}/box-office/sales`, {
    token: porteiro,
    body: { items: [{ ticket_tier_id: tier.id, quantity: 1 }], method: 'courtesy', buyer: { name: 'Convidado da Casa' } },
  });
  check('cortesia emite ingresso', cortesia.status === 201 && cortesia.data?.tickets?.length === 1);
  check('cortesia NÃO entra dinheiro no caixa', cortesia.data?.total_cents === 0,
    brl(cortesia.data?.total_cents ?? -1));

  console.log('\n7) Fechamento do caixa');
  const rep = await api('GET', `/admin/events/${eventId}/box-office/report`, { token: porteiro });
  const total = rep.data?.total_cents ?? 0;
  // dinheiro + maquininha + cortesia(0) — cobrados COM taxa de serviço.
  const esperado = caixaAntes + venda.data.total_cents + comEmail.data.total_cents + 0;
  check('caixa soma todas as vendas', total > caixaAntes, brl(total));
  check('quebra por forma de pagamento', !!rep.data?.by_method?.cash && !!rep.data?.by_method?.card_machine,
    Object.keys(rep.data?.by_method ?? {}).join(', '));
  check('quebra por operador (quem vendeu)', Array.isArray(rep.data?.by_operator) && rep.data.by_operator.length > 0);
  check('total bate com a soma das vendas', total === esperado, `${brl(total)} vs esperado ${brl(esperado)}`);

  console.log('\n8) Cliente comum NÃO pode vender na bilheteria');
  const golpe = await api('POST', `/admin/events/${eventId}/box-office/sales`, {
    token: cliente, body: { items: [{ ticket_tier_id: tier.id, quantity: 1 }], method: 'courtesy' },
  });
  check('venda por não-staff é bloqueada', golpe.status === 403, `HTTP ${golpe.status}`);

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
