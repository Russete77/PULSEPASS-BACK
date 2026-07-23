#!/usr/bin/env node
// Seed catálogo — popula eventos demo variados para a homepage (estilo Sympla) ter vida.
// Idempotente: remove eventos slug demo-* antes de recriar. NÃO mexe nas fixtures e2e_*.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('faltam SUPABASE_URL/SERVICE_ROLE'); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });

const now = Date.now();
const D = (days, h = 22) => new Date(now + days * 864e5).setHours(h, 0, 0, 0);
const iso = (t) => new Date(t).toISOString();

const EVENTS = [
  { slug: 'demo-festival-sol', title: 'Festival do Sol — edição equinócio', cat: 'Festas', venue: 'Audio Club', city: 'São Paulo', st: 'SP', d: 9, from: 9000 },
  { slug: 'demo-kvsh-audio', title: 'KVSH no Audio', cat: 'Shows', venue: 'Audio Club', city: 'São Paulo', st: 'SP', d: 5, from: 7000 },
  { slug: 'demo-tropical-heat', title: 'Tropical Heat Rooftop', cat: 'Festas', venue: 'Cobertura 22', city: 'Rio de Janeiro', st: 'RJ', d: 2, from: 12000 },
  { slug: 'demo-standup-noite', title: 'Stand-up: Noite do Riso', cat: 'Stand-up', venue: 'Teatro Jardins', city: 'São Paulo', st: 'SP', d: 3, from: 6000 },
  { slug: 'demo-boate-roxa', title: 'Boate Roxa edição 7', cat: 'Festas', venue: 'Roxa Club', city: 'Belo Horizonte', st: 'MG', d: 1, from: 5000 },
  { slug: 'demo-sunset-bar', title: 'Sunset Bar — DJ Mau Mau', cat: 'Shows', venue: 'Praia Grande', city: 'Rio de Janeiro', st: 'RJ', d: 6, from: 0 },
];

async function main() {
  // dono demo: reusa e2e_produtora se existir, senão cria um dono demo
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 300 });
  let owner = (list?.users || []).find((u) => u.email === 'e2e_produtora@pulsepass.test');
  if (!owner) {
    const { data } = await db.auth.admin.createUser({ email: 'demo_produtora@pulsepass.test', password: 'Teste12345!', email_confirm: true });
    owner = data.user;
  }

  const { data: org } = await db.from('organizations')
    .upsert({ owner_id: owner.id, name: 'PulsePass Demo', slug: 'pulsepass-demo' }, { onConflict: 'slug' })
    .select('id').single();

  // limpa demo-* antigos
  const { data: old } = await db.from('events').select('id').like('slug', 'demo-%');
  const oldIds = (old || []).map((e) => e.id);
  if (oldIds.length) {
    for (const t of ['ticket_tiers', 'menu_items']) await db.from(t).delete().in('event_id', oldIds);
    await db.from('events').delete().in('id', oldIds);
  }

  let ok = 0;
  for (const e of EVENTS) {
    const row = {
      organization_id: org.id, title: e.title, slug: e.slug,
      description: `${e.cat} · ${e.venue}. Ingressos, lista e bar cashless no PulsePass.`,
      venue_name: e.venue, address: 'Endereço demo', city: e.city, state: e.st,
      starts_at: iso(D(e.d)), status: 'published', service_fee_bps: 1000,
    };
    // category é opcional (só grava se a coluna existir — migration 0027)
    let res = await db.from('events').insert({ ...row, category: e.cat }).select('id').single();
    if (res.error) res = await db.from('events').insert(row).select('id').single();
    if (res.error) { console.log('falhou', e.slug, res.error.message.slice(0, 50)); continue; }
    const evId = res.data.id;
    await db.from('ticket_tiers').insert([
      { event_id: evId, name: 'Pista', price_cents: e.from || 5000, half_price_cents: Math.round((e.from || 5000) / 2), quantity_total: 200, quantity_sold: Math.floor(Math.random() * 150), max_per_order: 6, position: 0, status: 'on_sale' },
      { event_id: evId, name: 'VIP', price_cents: (e.from || 5000) * 2 + 6000, quantity_total: 40, quantity_sold: Math.floor(Math.random() * 30), max_per_order: 4, position: 1, status: 'on_sale' },
    ]);
    ok++;
  }
  console.log(`\n✓ ${ok}/${EVENTS.length} eventos demo publicados (org PulsePass Demo).`);
  console.log('  Home:', EVENTS.map((e) => e.city).filter((v, i, a) => a.indexOf(v) === i).join(', '));
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
