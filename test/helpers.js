// Helpers de teste — cria/destrói fixtures reais no Supabase de TESTE.
// Usa TEST_SUPABASE_* se existir; senão cai pro SUPABASE_* (CUIDADO em prod).
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.TEST_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

export const hasDb = Boolean(url && key);

export const db = hasDb
  ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

const rnd = () => Math.random().toString(36).slice(2, 8);

/**
 * Cria um cenário completo: usuário + organização + evento publicado + lote.
 * @param {object} opts
 * @param {number} opts.quantityTotal  estoque do lote (default 5)
 * @param {number} opts.priceCents      preço do lote (default 1000)
 * @param {number} opts.maxPerOrder     limite por pedido (default 10)
 */
export async function makeScenario({ quantityTotal = 5, priceCents = 1000, maxPerOrder = 10 } = {}) {
  const email = `test_${rnd()}@pulsepass.test`;
  const { data: u, error: uErr } = await db.auth.admin.createUser({
    email, password: `Pw_${rnd()}${rnd()}`, email_confirm: true,
  });
  if (uErr) throw uErr;
  const userId = u.user.id;

  const { data: org, error: oErr } = await db
    .from('organizations')
    .insert({ owner_id: userId, name: `Org ${rnd()}`, slug: `org-${rnd()}` })
    .select('id').single();
  if (oErr) throw oErr;

  const { data: event, error: eErr } = await db
    .from('events')
    .insert({
      organization_id: org.id, title: `Evt ${rnd()}`, slug: `evt-${rnd()}`,
      city: 'São Paulo', state: 'SP', starts_at: new Date(Date.now() + 86400000).toISOString(),
      status: 'published',
    })
    .select('id').single();
  if (eErr) throw eErr;

  const { data: tier, error: tErr } = await db
    .from('ticket_tiers')
    .insert({
      event_id: event.id, name: 'Pista', price_cents: priceCents,
      quantity_total: quantityTotal, quantity_sold: 0, max_per_order: maxPerOrder,
      position: 0, status: 'on_sale',
    })
    .select('id').single();
  if (tErr) throw tErr;

  return {
    userId, orgId: org.id, eventId: event.id, tierId: tier.id,
    async cleanup() {
      // PostgrestFilterBuilder é thenable mas NÃO tem .catch — usar try/catch.
      // Apaga os dependentes do evento antes do próprio evento (FKs sem cascade).
      const byEvent = ['orders', 'bar_orders', 'wallet_topups', 'wallets', 'menu_items', 'ticket_tiers', 'guests', 'promoters'];
      for (const t of byEvent) {
        try { await db.from(t).delete().eq('event_id', event.id); } catch { /* best-effort */ }
      }
      try { await db.from('events').delete().eq('id', event.id); } catch { /* best-effort */ }
      try { await db.from('organizations').delete().eq('id', org.id); } catch { /* best-effort */ }
      try { await db.auth.admin.deleteUser(userId); } catch { /* best-effort */ }
    },
  };
}

export async function tierStock(tierId) {
  const { data } = await db.from('ticket_tiers')
    .select('quantity_total, quantity_sold, status').eq('id', tierId).single();
  return data;
}
