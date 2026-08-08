#!/usr/bin/env node
// Serviço de bar: garçom, cozinha (KDS) e totem.
//
// O que este teste guarda: o ciclo paid → preparing → ready → delivered
// existia no enum desde a migration 0003 e ficou anos sem nada que o
// percorresse. Um pedido nascia pago e morria pago — ninguém sabia se a
// cerveja tinha saído.
//
// A regra que mais importa aqui é a que NÃO deixa andar para trás: dois
// toques na tela da cozinha devolveriam um pedido entregue para "em preparo",
// e a chapa refaria o prato.
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
const api = async (m, p, { token, body } = {}) => {
  const r = await fetch(API + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let j = null; try { j = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, body: j, data: j?.data };
};

async function main() {
  console.log(`\n═══ Serviço de bar · ${API} ═══\n`);
  const produtora = await login('e2e_produtora@pulsepass.test');
  const cliente = await login('e2e_cliente@pulsepass.test');
  const barman = await login('e2e_barman@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;

  console.log('1) O cliente precisa de saldo para a comanda existir');
  const recarga = await api('POST', '/wallet/topups', {
    token: cliente, body: { event_slug: 'festa-e2e', amount_cents: 8000 },
  });
  if (recarga.data?.id) await api('POST', `/wallet/topups/${recarga.data.id}/simulate-paid`, { token: cliente });
  const carteira = (await api('GET', `/admin/events/${ev.id}/wallet-lookup?email=e2e_cliente@pulsepass.test`,
    { token: produtora })).data;
  check('carteira do cliente encontrada', !!carteira?.customer_id, `saldo ${carteira?.balance_cents}`);

  const menu = (await api('GET', `/admin/events/${ev.id}/menu`, { token: produtora })).data;
  check('cardápio disponível', menu?.length > 0, `${menu?.length} itens`);

  console.log('\n2) Salão: as mesas do garçom');
  const mesas = await api('GET', `/admin/events/${ev.id}/waiter`, { token: produtora });
  check('quadro de mesas responde', mesas.status === 200, `${mesas.data?.length} mesa(s)`);
  const mesa = mesas.data?.[0];

  console.log('\n3) O garçom lança o pedido na mesa');
  const pedido = await api('POST', `/admin/events/${ev.id}/waiter-orders`, {
    token: produtora,
    body: { buyer_id: carteira.customer_id, table_id: mesa?.id, items: [{ menu_item_id: menu[0].id, quantity: 2 }] },
  });
  check('pedido criado e pago', pedido.status === 201, `código ${pedido.data?.pickup_code}`);
  const pedidoId = pedido.data?.id;
  if (!pedidoId) { console.log('\n✖ sem pedido, o resto não faz sentido'); process.exit(1); }

  console.log('\n4) O pedido aparece na cozinha com a origem certa');
  const fila = (await api('GET', `/admin/events/${ev.id}/kds`, { token: produtora })).data;
  const naFila = fila?.find((p) => p.id === pedidoId);
  check('está na fila da cozinha', !!naFila, `status ${naFila?.status}`);
  // A origem é o que diz à cozinha o que fazer com o prato pronto: mesa vai
  // até a pessoa, praça de bar espera retirada, app espera chamarem o código.
  check('origem é MESA (não app nem praça)', naFila?.origem?.tipo === 'mesa', naFila?.origem?.rotulo);
  check('cronômetro de espera existe', typeof naFila?.esperando_min === 'number', `${naFila?.esperando_min}min`);

  console.log('\n5) O barman percorre o ciclo');
  for (const etapa of ['preparing', 'ready', 'delivered']) {
    const r = await api('PATCH', `/admin/bar-orders/${pedidoId}/status`, {
      token: barman, body: { para: etapa },
    });
    check(`avança para ${etapa}`, r.status === 200, r.body?.error?.message?.slice(0, 40));
  }

  console.log('\n6) Entregue sai da fila — a cozinha não precisa mais dele');
  const filaDepois = (await api('GET', `/admin/events/${ev.id}/kds`, { token: produtora })).data;
  check('sumiu da fila', !filaDepois?.some((p) => p.id === pedidoId));

  console.log('\n7) NÃO se anda para trás');
  const retrocesso = await api('PATCH', `/admin/bar-orders/${pedidoId}/status`, {
    token: barman, body: { para: 'preparing' },
  });
  check('voltar de entregue para preparo é RECUSADO', retrocesso.status === 409,
    retrocesso.body?.error?.message?.slice(0, 46));

  const inventado = await api('PATCH', `/admin/bar-orders/${pedidoId}/status`, {
    token: barman, body: { para: 'voando' },
  });
  check('etapa inventada é recusada', inventado.status === 400);

  console.log('\n8) Quem não é da equipe não mexe na cozinha');
  const intruso = await api('GET', `/admin/events/${ev.id}/kds`, { token: cliente });
  check('cliente é bloqueado no KDS', intruso.status === 403, `HTTP ${intruso.status}`);
  const intruso2 = await api('PATCH', `/admin/bar-orders/${pedidoId}/status`, {
    token: cliente, body: { para: 'cancelled' },
  });
  check('cliente não avança pedido', intruso2.status === 403, `HTTP ${intruso2.status}`);

  console.log('\n9) Totem: pedido sem mesa, com praça marcada');
  const doTotem = await api('POST', `/admin/events/${ev.id}/waiter-orders`, {
    token: produtora,
    body: { buyer_id: carteira.customer_id, station: 'Totem', items: [{ menu_item_id: menu[0].id, quantity: 1 }] },
  });
  check('pedido do totem criado', doTotem.status === 201, `código ${doTotem.data?.pickup_code}`);
  const filaTotem = (await api('GET', `/admin/events/${ev.id}/kds`, { token: produtora })).data;
  const oTotem = filaTotem?.find((p) => p.id === doTotem.data?.id);
  check('origem é PRAÇA, não mesa', oTotem?.origem?.tipo === 'praca', oTotem?.origem?.rotulo);

  // Limpa: deixa a fila vazia para a próxima execução não herdar pedido aberto.
  if (doTotem.data?.id) {
    await api('PATCH', `/admin/bar-orders/${doTotem.data.id}/status`, { token: barman, body: { para: 'cancelled' } });
  }

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
