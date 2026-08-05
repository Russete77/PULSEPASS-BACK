#!/usr/bin/env node
// Seed E2E — cria um cenário completo de teste + contas por role, no Supabase.
// Uso: node scripts/seed-e2e.mjs   (usa SUPABASE_URL/SERVICE_ROLE do .env)
// Idempotente: limpa fixtures e2e_*@pulsepass.test antes de recriar.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('faltam SUPABASE_URL/SERVICE_ROLE'); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });

const PW = 'Teste12345!';
const EMAILS = {
  cliente: 'e2e_cliente@pulsepass.test',
  produtora: 'e2e_produtora@pulsepass.test',
  porteiro: 'e2e_porteiro@pulsepass.test',
  barman: 'e2e_barman@pulsepass.test',
  promoter: 'e2e_promoter@pulsepass.test',
};
const SLUG = 'festa-e2e';
const iso = (d) => new Date(d).toISOString();
const now = Date.now();

async function cleanup() {
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 300 });
  const ours = (list?.users || []).filter((u) => Object.values(EMAILS).includes(u.email));
  const ids = ours.map((u) => u.id);
  const { data: orgs } = ids.length ? await db.from('organizations').select('id').in('owner_id', ids) : { data: [] };
  const orgIds = (orgs || []).map((o) => o.id);
  const { data: evts } = orgIds.length ? await db.from('events').select('id').in('organization_id', orgIds) : { data: [] };
  const evtIds = (evts || []).map((e) => e.id);
  const del = async (t, c, v) => { if (v.length) { try { await db.from(t).delete().in(c, v); } catch (e) { /* noop */ } } };
  for (const t of ['table_reservations', 'event_tables', 'guests', 'promoters', 'coupons', 'wallet_topups', 'bar_orders', 'orders', 'wallets', 'menu_items', 'ticket_tiers', 'event_staff']) {
    await del(t, 'event_id', evtIds);
  }
  await del('events', 'id', evtIds);
  await del('organizations', 'id', orgIds);
  for (const id of ids) { try { await db.auth.admin.deleteUser(id); } catch (e) { /* noop */ } }
}

async function makeUser(email, role) {
  const { data, error } = await db.auth.admin.createUser({ email, password: PW, email_confirm: true, user_metadata: { full_name: email.split('@')[0] } });
  if (error) throw new Error(`${email}: ${error.message}`);
  if (role) await db.from('profiles').update({ role }).eq('id', data.user.id);
  return data.user.id;
}

async function main() {
  console.log('limpando fixtures antigas…');
  await cleanup();

  console.log('criando usuários…');
  const cliente = await makeUser(EMAILS.cliente, 'cliente');
  const produtora = await makeUser(EMAILS.produtora, 'produtora');
  const porteiro = await makeUser(EMAILS.porteiro, 'cliente');
  const barman = await makeUser(EMAILS.barman, 'cliente');
  const promoterU = await makeUser(EMAILS.promoter, 'cliente');

  console.log('criando organização + evento publicado…');
  const { data: org } = await db.from('organizations').insert({ owner_id: produtora, name: 'Produtora E2E', slug: 'produtora-e2e-' + now.toString(36) }).select('id').single();
  const { data: ev } = await db.from('events').insert({
    organization_id: org.id, title: 'Festa E2E', slug: SLUG,
    description: 'Evento de teste ponta a ponta.', venue_name: 'Arena Teste', address: 'Rua 1',
    // 60 dias à frente: a vitrine só lista evento futuro, e uma fixture que
    // vence no meio do desenvolvimento faz o teste falhar por idade do dado,
    // não por defeito no código.
    city: 'São Paulo', state: 'SP', starts_at: iso(now + 60 * 864e5), status: 'published', service_fee_bps: 1000,
  }).select('id').single();

  console.log('lotes (inteira/meia)…');
  // Estoque generoso de proposito: a suite compra ingresso a cada execucao e
  // um lote apertado faria o teste falhar por dado consumido, nao por bug.
  await db.from('ticket_tiers').insert([
    { event_id: ev.id, name: 'Pista', price_cents: 5000, half_price_cents: 2500, quantity_total: 100000, quantity_sold: 0, max_per_order: 6, position: 0, status: 'on_sale' },
    { event_id: ev.id, name: 'VIP', price_cents: 12000, quantity_total: 100000, quantity_sold: 0, max_per_order: 4, position: 1, status: 'on_sale' },
  ]);

  console.log('cardápio (com estoque)…');
  await db.from('menu_items').insert([
    { event_id: ev.id, name: 'Chopp', category: 'Bebidas', price_cents: 1200, available: true, position: 0, stock: 50 },
    { event_id: ev.id, name: 'Água', category: 'Bebidas', price_cents: 600, available: true, position: 1, stock: null },
    { event_id: ev.id, name: 'Combo Amigos', category: 'Combos', price_cents: 3000, available: true, position: 2, stock: 10 },
  ]);

  console.log('cupom…');
  await db.from('coupons').insert({ event_id: ev.id, code: 'VIP10', kind: 'percent', value: 10, active: true });

  console.log('promoter (vinculado) + staff porta/bar…');
  const promoterRow = { organization_id: org.id, event_id: ev.id, name: 'Promoter E2E', code: 'promoe2e', commission_cents: 500, profile_id: promoterU, goal_checkins: 20 };
  // list_type/free_until só se a 0024 estiver aplicada; senão insere base (checa error, não throw).
  let pErr = (await db.from('promoters').insert({ ...promoterRow, list_type: 'free_until', free_until: iso(now + 6 * 36e5) })).error;
  if (pErr) { pErr = (await db.from('promoters').insert(promoterRow)).error; }
  console.log('promoter:', pErr ? 'FALHOU ' + pErr.message.slice(0, 40) : 'ok');
  await db.from('event_staff').insert([
    { event_id: ev.id, user_id: porteiro, role: 'door', created_by: produtora },
    { event_id: ev.id, user_id: barman, role: 'bar', created_by: produtora },
  ]);

  // camarote (só se 0025 aplicada)
  let camarote = 'pulado (0025 não aplicada?)';
  try {
    const { error } = await db.from('event_tables').insert({ event_id: ev.id, name: 'Camarote A', area: 'Camarote', capacity: 8, min_spend_cents: 50000, active: true, position: 0 });
    camarote = error ? 'FALHOU: ' + error.message.slice(0, 40) : 'ok';
  } catch (e) { camarote = 'FALHOU: ' + e.message.slice(0, 40); }

  console.log('\n════════ CENÁRIO E2E PRONTO ════════');
  console.log('Senha (todos):', PW);
  console.log('Cliente   :', EMAILS.cliente);
  console.log('Produtora :', EMAILS.produtora);
  console.log('Porteiro  :', EMAILS.porteiro, '(role door)');
  console.log('Barman    :', EMAILS.barman, '(role bar)');
  console.log('Promoter  :', EMAILS.promoter);
  console.log('Evento    : /eventos/' + SLUG, '| lista: /lista/promoe2e | cupom: VIP10');
  console.log('Camarote  :', camarote);
  console.log('event_id  :', ev.id);
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
