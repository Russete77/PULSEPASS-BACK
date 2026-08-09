#!/usr/bin/env node
// Turno de caixa e margem do cardápio.
//
// O caixa nunca ABRIA: existia o relatório por operador, mas não o turno.
// Sem hora de abertura e sem fundo de troco, "sobrou R$ 300 na gaveta" não
// quer dizer nada — não há com o que comparar.
//
// O que este teste guarda é a conferência: o que o operador CONTOU tem que
// ficar separado do que o sistema calcula, e a diferença entre os dois é o
// achado. Se o cálculo somar cartão e Pix, toda gaveta acusa falta.
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
  console.log(`\n═══ Caixa e margem · ${API} ═══\n`);
  const produtora = await login('e2e_produtora@pulsepass.test');
  const barman = await login('e2e_barman@pulsepass.test');
  const cliente = await login('e2e_cliente@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;

  // Garante gaveta limpa: execução anterior pode ter deixado turno aberto.
  const pendente = await api('GET', `/admin/events/${ev.id}/turno`, { token: produtora });
  if (pendente.data?.id) {
    await api('POST', `/admin/turnos/${pendente.data.id}/fechar`, { token: produtora, body: { contado_cents: 0 } });
  }

  console.log('1) Abrir a gaveta com fundo de troco');
  const t1 = await api('POST', `/admin/events/${ev.id}/turno`, {
    token: produtora, body: { fundo_cents: 20000, station: 'Bar Central' },
  });
  check('turno aberto', t1.status === 201, `fundo ${t1.data?.opening_cents}`);
  check('praça registrada', t1.data?.station === 'Bar Central');

  // Dois toques no botão abririam duas gavetas, e a conferência do fim da
  // noite nunca fecharia. O índice único do banco é quem impede.
  const dup = await api('POST', `/admin/events/${ev.id}/turno`, {
    token: produtora, body: { fundo_cents: 5000 },
  });
  check('SEGUNDO turno do mesmo operador é RECUSADO', dup.status === 409,
    dup.body?.error?.message?.slice(0, 40));

  console.log('\n2) O turno aberto é encontrado');
  const aberto = await api('GET', `/admin/events/${ev.id}/turno`, { token: produtora });
  check('devolve o turno em aberto', aberto.data?.id === t1.data?.id);

  // Cada operador tem a sua gaveta: o barman abre a dele sem conflitar.
  const doBarman = await api('POST', `/admin/events/${ev.id}/turno`, {
    token: barman, body: { fundo_cents: 10000, station: 'Bar VIP' },
  });
  check('outro operador abre a PRÓPRIA gaveta', doBarman.status === 201,
    'misturar as duas esconderia a diferença que a conferência procura');
  const doBarmanVisto = await api('GET', `/admin/events/${ev.id}/turno`, { token: produtora });
  check('cada um vê só a sua', doBarmanVisto.data?.id === t1.data?.id);

  console.log('\n3) Fechar e conferir');
  const f = await api('POST', `/admin/turnos/${t1.data.id}/fechar`, {
    token: produtora, body: { contado_cents: 22000, notas: 'gaveta 1' },
  });
  check('fechamento responde', f.status === 200);
  check('esperado = fundo + vendas em dinheiro', f.data?.esperado_cents === 20000 + f.data?.vendas_cents);
  check('diferença calculada', f.data?.diferenca_cents === f.data.contado_cents - f.data.esperado_cents,
    `${f.data?.diferenca_cents}`);
  check('veredito legível', f.data?.veredito === 'sobrou', f.data?.veredito);

  const dobro = await api('POST', `/admin/turnos/${t1.data.id}/fechar`, {
    token: produtora, body: { contado_cents: 1 },
  });
  check('fechar DE NOVO é recusado', dobro.status === 409, dobro.body?.error?.message?.slice(0, 34));

  console.log('\n4) Quem não é da equipe não abre gaveta');
  const intruso = await api('POST', `/admin/events/${ev.id}/turno`, {
    token: cliente, body: { fundo_cents: 100 },
  });
  check('cliente é bloqueado', intruso.status === 403, `HTTP ${intruso.status}`);

  console.log('\n5) Margem do cardápio');
  const item = await api('POST', `/admin/events/${ev.id}/menu-items`, {
    token: produtora,
    body: { name: `Chopp teste ${Date.now().toString(36)}`, price_cents: 1200, cost_cents: 400, category: 'Bebidas' },
  });
  check('item criado com custo', item.status === 201, `custo ${item.data?.cost_cents}`);

  const semCusto = await api('POST', `/admin/events/${ev.id}/menu-items`, {
    token: produtora, body: { name: `Água teste ${Date.now().toString(36)}`, price_cents: 600 },
  });
  // Sem custo informado, a margem some da tela em vez de o sistema fingir
  // 100% de lucro — que é a mentira mais confortável que um cardápio conta.
  check('custo é opcional e fica nulo', semCusto.status === 201 && semCusto.data?.cost_cents == null);

  const lista = await api('GET', `/admin/events/${ev.id}/menu-items`, { token: produtora });
  const oItem = lista.data?.find((i) => i.id === item.data?.id);
  check('a listagem devolve o custo', oItem?.cost_cents === 400);

  // Limpa o que este teste criou.
  for (const id of [item.data?.id, semCusto.data?.id]) {
    if (id) await api('DELETE', `/admin/menu-items/${id}`, { token: produtora });
  }
  if (doBarman.data?.id) {
    await api('POST', `/admin/turnos/${doBarman.data.id}/fechar`, { token: barman, body: { contado_cents: 10000 } });
  }

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
