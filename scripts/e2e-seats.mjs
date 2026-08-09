#!/usr/bin/env node
// Assento marcado: mapa, reserva temporária e vínculo com o pedido.
//
// O que este teste guarda é a única coisa que não pode falhar num teatro:
// duas pessoas não saem com a mesma poltrona. E o corolário, que é o erro
// mais fácil de cometer — o assento pago não pode voltar ao mapa quando a
// reserva de 8 minutos vencer.
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
  const r = await fetch(API + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let j = null; try { j = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, body: j, data: j?.data };
};

async function main() {
  console.log(`\n═══ Assento marcado · ${API} ═══\n`);
  const produtora = await login('e2e_produtora@pulsepass.test');
  const cliente = await login('e2e_cliente@pulsepass.test');
  const outro = await login('e2e_promoter@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const lote = ev.tiers[0];

  console.log('1) A produtora gera a grade do setor');
  const setorNome = `Plateia ${Date.now().toString(36)}`;
  const grade = await api('POST', `/admin/events/${ev.id}/assentos`, {
    token: produtora, body: { setor: setorNome, tier_id: lote.id, fileiras: 3, por_fileira: 6 },
  });
  check('grade criada', grade.status === 201, `${grade.data?.criados} assentos`);
  check('conta bate (3 × 6)', grade.data?.criados === 18);

  const repetido = await api('POST', `/admin/events/${ev.id}/assentos`, {
    token: produtora, body: { setor: setorNome, tier_id: lote.id, fileiras: 3, por_fileira: 6 },
  });
  check('setor repetido é recusado', repetido.status === 409, repetido.body?.error?.message?.slice(0, 42));

  console.log('\n2) O mapa é público — ver antes de criar conta');
  const publico = await api('GET', '/events/festa-e2e/assentos');
  check('mapa abre sem login', publico.status === 200, `${publico.data?.setores?.length} setor(es)`);
  const setor = publico.data.setores.find((s) => s.nome === setorNome);
  check('preço vem do lote', setor?.preco_cents === lote.price_cents, `${setor?.preco_cents}`);
  check('reserva declara a duração', publico.data?.minutos_reserva === 8);

  const livres = setor.fileiras.flatMap((f) => f.assentos).filter((a) => a.status === 'free');
  const alvo = livres.slice(0, 2).map((a) => a.id);

  console.log('\n3) A reserva temporária');
  const r1 = await api('POST', '/events/festa-e2e/assentos/reservar', {
    token: cliente, body: { seat_ids: alvo },
  });
  check('cliente reserva 2 assentos', r1.status === 200, `expira ${r1.data?.expira_em?.slice(11, 19)}`);

  // A regra que sustenta a tela inteira: ninguém mais pega o mesmo lugar.
  const r2 = await api('POST', '/events/festa-e2e/assentos/reservar', {
    token: outro, body: { seat_ids: alvo },
  });
  check('OUTRA pessoa no mesmo lugar é RECUSADA', r2.status === 409,
    r2.body?.error?.message?.slice(0, 44));

  const meuMapa = (await api('GET', '/events/festa-e2e/assentos', { token: cliente })).data;
  const meus = meuMapa.setores.find((s) => s.nome === setorNome)
    .fileiras.flatMap((f) => f.assentos).filter((a) => a.meu);
  check('o mapa marca quais são MEUS', meus.length === 2);

  const mapaDoOutro = (await api('GET', '/events/festa-e2e/assentos', { token: outro })).data;
  const meusDoOutro = mapaDoOutro.setores.find((s) => s.nome === setorNome)
    .fileiras.flatMap((f) => f.assentos).filter((a) => a.meu);
  check('para a outra pessoa aparecem ocupados, não "meus"', meusDoOutro.length === 0);

  console.log('\n4) Trocar de assento solta o anterior');
  const outros = livres.slice(2, 3).map((a) => a.id);
  await api('POST', '/events/festa-e2e/assentos/reservar', { token: cliente, body: { seat_ids: outros } });
  const { data: antigos } = await db.from('event_seats').select('status').in('id', alvo);
  check('os dois primeiros voltaram a livre', (antigos ?? []).every((s) => s.status === 'free'),
    'senão a pessoa travaria a fileira inteira sozinha');

  console.log('\n5) Comprar sem reservar antes é recusado');
  await api('POST', '/events/festa-e2e/assentos/soltar', { token: cliente });
  const semReserva = await api('POST', '/orders', {
    token: cliente,
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: lote.id, quantity: 1 }], seat_ids: [alvo[0]] },
  });
  check('pedido sem reserva viva é RECUSADO', semReserva.status === 409,
    semReserva.body?.error?.message?.slice(0, 44));

  console.log('\n6) Pagar prende o assento de vez');
  await api('POST', '/events/festa-e2e/assentos/reservar', { token: cliente, body: { seat_ids: alvo } });
  const pedido = await api('POST', '/orders', {
    token: cliente,
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: lote.id, quantity: 2 }], seat_ids: alvo },
  });
  check('pedido criado com assentos', pedido.status === 201, `R$ ${(pedido.data?.total_cents / 100).toFixed(2)}`);

  await api('POST', `/orders/${pedido.data.id}/simulate-paid`, { token: cliente });
  const { data: pagos } = await db.from('event_seats')
    .select('status, held_until, order_id').in('id', alvo);
  check('assentos viraram vendidos', (pagos ?? []).every((s) => s.status === 'sold'));
  // O erro mais fácil de cometer: o assento pago voltaria ao mapa 8 minutos
  // depois, porque a reserva continuaria vencendo.
  check('a reserva deixou de vencer', (pagos ?? []).every((s) => s.held_until === null),
    'senão o lugar pago voltaria ao mapa');
  check('ficaram ligados ao pedido', (pagos ?? []).every((s) => s.order_id === pedido.data.id));

  console.log('\n7) Estornar devolve o lugar ao mapa');
  const estorno = await api('POST', `/orders/${pedido.data.id}/refund`, { token: cliente });
  const { data: soltos } = await db.from('event_seats')
    .select('status, order_id, held_by').in('id', alvo);
  check('estorno aceito', estorno.status === 200);
  check('voltaram a livre', (soltos ?? []).every((s) => s.status === 'free'));
  check('desvinculados do pedido', (soltos ?? []).every((s) => !s.order_id && !s.held_by),
    'o gatilho cuida disso, não a aplicação');

  console.log('\n7.5) Assentos e ingressos precisam bater');
  // Sem esta checagem dava para reservar duas poltronas e comprar UM ingresso
  // — a segunda ficaria vendida sem ninguém para sentar nela — ou comprar
  // cinco ingressos com duas poltronas, e três pessoas chegariam sem lugar.
  await api('POST', '/events/festa-e2e/assentos/reservar', { token: cliente, body: { seat_ids: alvo } });
  const desalinhado = await api('POST', '/orders', {
    token: cliente,
    body: { eventSlug: 'festa-e2e', items: [{ ticket_tier_id: lote.id, quantity: 1 }], seat_ids: alvo },
  });
  check('2 lugares com 1 ingresso é RECUSADO', desalinhado.status === 400,
    desalinhado.body?.error?.message?.slice(0, 46));
  await api('POST', '/events/festa-e2e/assentos/soltar', { token: cliente });

  console.log('\n8) Quem não é da produtora não gera grade');
  const intruso = await api('POST', `/admin/events/${ev.id}/assentos`, {
    token: cliente, body: { setor: 'Pirata', tier_id: lote.id, fileiras: 2, por_fileira: 2 },
  });
  check('cliente é bloqueado', intruso.status === 403, `HTTP ${intruso.status}`);

  // Limpa o setor criado, para a próxima execução não acumular plateia.
  await db.from('event_seats').delete().eq('event_id', ev.id).eq('setor', setorNome);

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
