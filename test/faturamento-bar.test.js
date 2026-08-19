// ═══════════════════════════════════════════════════════════════
// O faturamento do bar não pode encolher conforme a cozinha entrega.
//
// `bar_orders.status` carrega duas coisas ao mesmo tempo: se a comanda foi
// paga e em que ponto do preparo ela está (paid → preparing → ready →
// delivered). Relatório que soma só `status = 'paid'` tira a comanda do
// caixa no instante em que o barman começa a preparar — quanto melhor a
// operação, menor o faturamento exibido. No fim da noite, tudo entregue,
// o bar aparece zerado.
//
// Cada teste aqui monta a MESMA comanda em estados diferentes do ciclo e
// exige o mesmo total. `cancelled` é o único estado que não é venda.
//
// Requer um Supabase de TESTE (TEST_SUPABASE_URL/KEY). Sem isso, pula.
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, hasDb, makeScenario } from './helpers.js';

const maybe = hasDb ? test : test.skip;
if (!hasDb) {
  console.warn('\n⚠  Sem TEST_SUPABASE_URL/KEY — testes de faturamento do bar PULADOS.\n');
}

// Uma comanda em cada estágio do ciclo de serviço, com preços distintos para
// que um total errado aponte QUAL estágio sumiu, em vez de só não bater.
const CICLO = [
  { status: 'paid',      total: 1100 },
  { status: 'preparing', total: 1300 },
  { status: 'ready',     total: 1700 },
  { status: 'delivered', total: 1900 },
];
const CANCELADA = { status: 'cancelled', total: 9900 };
const ESPERADO = CICLO.reduce((s, c) => s + c.total, 0); // 6000 — sem a cancelada

/** Cria as 5 comandas do cenário. `operador` vira operator_id (PDV). */
async function semearComandas(sc, operador = null) {
  const linhas = [...CICLO, CANCELADA].map((c, i) => ({
    buyer_id: sc.userId,
    event_id: sc.eventId,
    status: c.status,
    total_cents: c.total,
    pickup_code: `T${1000 + i}`,
    ...(operador ? { operator_id: operador } : {}),
  }));
  const { error } = await db.from('bar_orders').insert(linhas);
  if (error) throw error;
}

const limpar = async (sc) => {
  try { await db.from('bar_orders').delete().eq('event_id', sc.eventId); } catch { /* best-effort */ }
  await sc.cleanup();
};

// ── Painel ao vivo ──
maybe('event_dashboard soma comanda entregue como receita', async () => {
  const sc = await makeScenario();
  try {
    await semearComandas(sc);
    const { data, error } = await db.rpc('event_dashboard', { p_event: sc.eventId });
    assert.equal(error, null, 'RPC não deve falhar');
    assert.equal(
      data.bar_revenue_cents, ESPERADO,
      'preparing/ready/delivered são comandas PAGAS — só cancelled sai do caixa',
    );
    assert.equal(data.total_revenue_cents, data.ticket_revenue_cents + ESPERADO, 'total inclui o bar inteiro');
  } finally {
    await limpar(sc);
  }
});

// ── Conciliação financeira ──
maybe('event_reconciliation soma comanda entregue como receita', async () => {
  const sc = await makeScenario();
  try {
    await semearComandas(sc);
    const { data, error } = await db.rpc('event_reconciliation', { p_event: sc.eventId });
    assert.equal(error, null, 'RPC não deve falhar');
    assert.equal(data.bar_gross_cents, ESPERADO, 'conciliação não pode perder o que a cozinha entregou');
  } finally {
    await limpar(sc);
  }
});

// ── Fechamento de caixa por operador ──
// O mesmo furo com consequência pior: aqui o número vira acusação. Se o
// sistema só conta 'paid', a gaveta do operador "falta" dinheiro que ele
// nunca deixou de receber — ele responde por uma diferença inexistente.
maybe('cashier_report soma comanda entregue pelo operador', async () => {
  const sc = await makeScenario();
  try {
    await semearComandas(sc, sc.userId);
    const { data, error } = await db.rpc('cashier_report', { p_event: sc.eventId });
    assert.equal(error, null, 'RPC não deve falhar');

    const linha = (data ?? []).find((l) => l.operator_id === sc.userId);
    assert.ok(linha, 'o operador precisa aparecer no fechamento');
    assert.equal(Number(linha.total_cents), ESPERADO, 'gaveta do operador conta tudo que não foi cancelado');
    assert.equal(Number(linha.orders), CICLO.length, 'conta as comandas do ciclo, menos a cancelada');
  } finally {
    await limpar(sc);
  }
});

// ── Rede de segurança: cancelada NUNCA entra ──
// Sem isto, trocar o filtro por "conta tudo" passaria nos testes acima.
maybe('comanda cancelada fica fora de todos os relatórios', async () => {
  const sc = await makeScenario();
  try {
    const { error } = await db.from('bar_orders').insert([{
      buyer_id: sc.userId, event_id: sc.eventId, status: 'cancelled',
      total_cents: CANCELADA.total, pickup_code: 'T9999', operator_id: sc.userId,
    }]);
    if (error) throw error;

    const { data: painel } = await db.rpc('event_dashboard', { p_event: sc.eventId });
    assert.equal(painel.bar_revenue_cents, 0, 'painel ignora cancelada');

    const { data: conc } = await db.rpc('event_reconciliation', { p_event: sc.eventId });
    assert.equal(conc.bar_gross_cents, 0, 'conciliação ignora cancelada');

    const { data: caixa } = await db.rpc('cashier_report', { p_event: sc.eventId });
    const linha = (caixa ?? []).find((l) => l.operator_id === sc.userId);
    assert.equal(linha, undefined, 'operador só com cancelada não aparece na gaveta');
  } finally {
    await limpar(sc);
  }
});
