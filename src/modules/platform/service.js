// modules/platform/service.js — agregações do god-mode (dados REAIS).
import * as repo from './repo.js';

const H24 = 24 * 60 * 60 * 1000;

async function loadRaw() {
  const [{ data: orgs }, { data: events }, { data: orders }, { data: bar }, tc] = await Promise.all([
    repo.allOrgs(), repo.allEventsLite(), repo.paidOrders(), repo.barOrdersLite(), repo.ticketsCount(),
  ]);
  return { orgs: orgs ?? [], events: events ?? [], orders: orders ?? [], bar: bar ?? [], ticketsTotal: tc?.count ?? 0 };
}

/** KPIs + top orgs da plataforma inteira. */
export async function platformStats() {
  const { orgs, events, orders, bar, ticketsTotal } = await loadRaw();
  const now = Date.now();
  const eventOrg = new Map(events.map((e) => [e.id, e.organization_id]));

  const sum = (rows) => rows.reduce((s, r) => s + (r.total_cents || 0), 0);
  const gmvTickets = sum(orders);
  const gmvBar = sum(bar);
  const gmv24h = sum(orders.filter((o) => now - Date.parse(o.created_at) < H24))
    + sum(bar.filter((o) => now - Date.parse(o.created_at) < H24));

  // GMV por org (ticket + bar), via event → org
  const perOrg = new Map();
  for (const o of [...orders, ...bar]) {
    const orgId = eventOrg.get(o.event_id);
    if (!orgId) continue;
    perOrg.set(orgId, (perOrg.get(orgId) || 0) + (o.total_cents || 0));
  }
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const eventsPerOrg = new Map();
  for (const e of events) eventsPerOrg.set(e.organization_id, (eventsPerOrg.get(e.organization_id) || 0) + 1);

  const topOrgs = [...perOrg.entries()]
    .map(([id, gmv]) => ({ id, name: orgName.get(id) ?? '—', gmv_cents: gmv, events: eventsPerOrg.get(id) ?? 0 }))
    .sort((a, b) => b.gmv_cents - a.gmv_cents).slice(0, 6);

  // GMV por cidade
  const perCity = new Map();
  const orderCity = (o) => events.find((e) => e.id === o.event_id)?.city ?? '—';
  for (const o of [...orders, ...bar]) perCity.set(orderCity(o), (perCity.get(orderCity(o)) || 0) + (o.total_cents || 0));
  const byCity = [...perCity.entries()].map(([city, gmv]) => ({ city, gmv_cents: gmv }))
    .sort((a, b) => b.gmv_cents - a.gmv_cents).slice(0, 6);

  const { data: drifts } = await repo.ledgerDrifts();

  return {
    gmv_total_cents: gmvTickets + gmvBar,
    gmv_tickets_cents: gmvTickets,
    gmv_bar_cents: gmvBar,
    gmv_24h_cents: gmv24h,
    orders_count: orders.length + bar.length,
    orgs_count: orgs.length,
    events_total: events.length,
    events_live: events.filter((e) => e.status === 'published').length,
    tickets_count: ticketsTotal,
    drift_count: (drifts ?? []).length,
    top_orgs: topOrgs,
    by_city: byCity,
  };
}

/** Lista todas as orgs com saúde (eventos, GMV, dono). */
export async function listOrgs() {
  const { orgs, events, orders, bar } = await loadRaw();
  const eventOrg = new Map(events.map((e) => [e.id, e.organization_id]));
  const perOrg = new Map();
  for (const o of [...orders, ...bar]) {
    const orgId = eventOrg.get(o.event_id);
    if (orgId) perOrg.set(orgId, (perOrg.get(orgId) || 0) + (o.total_cents || 0));
  }
  const eventsPerOrg = new Map();
  const cityPerOrg = new Map();
  for (const e of events) {
    eventsPerOrg.set(e.organization_id, (eventsPerOrg.get(e.organization_id) || 0) + 1);
    if (!cityPerOrg.has(e.organization_id) && e.city) cityPerOrg.set(e.organization_id, e.city);
  }

  const { data: owners } = await repo.profilesByIds(orgs.map((o) => o.owner_id).filter(Boolean));
  const ownerEmail = new Map((owners ?? []).map((p) => [p.id, p.email]));

  return orgs.map((o) => ({
    id: o.id, name: o.name, slug: o.slug,
    owner_email: ownerEmail.get(o.owner_id) ?? '—',
    city: cityPerOrg.get(o.id) ?? '—',
    events: eventsPerOrg.get(o.id) ?? 0,
    gmv_cents: perOrg.get(o.id) ?? 0,
    created_at: o.created_at,
  })).sort((a, b) => b.gmv_cents - a.gmv_cents);
}

/** Financeiro da plataforma: receita (taxas de serviço) + repasse por org. */
export async function financeStats() {
  const { orgs, events, orders, bar } = await loadRaw();
  const eventOrg = new Map(events.map((e) => [e.id, e.organization_id]));
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  const feeTotal = orders.reduce((s, o) => s + (o.service_fee_cents || 0), 0);
  const gmvTickets = orders.reduce((s, o) => s + (o.total_cents || 0), 0);
  const gmvBar = bar.reduce((s, o) => s + (o.total_cents || 0), 0);
  const gmv = gmvTickets + gmvBar;
  const netToProducers = gmv - feeTotal; // repasse líquido (GMV menos a taxa da plataforma)

  // Repasse por org (GMV da org menos as taxas dos pedidos dela)
  const perOrg = new Map();
  for (const o of orders) {
    const org = eventOrg.get(o.event_id); if (!org) continue;
    const cur = perOrg.get(org) ?? { gmv: 0, fee: 0 };
    cur.gmv += o.total_cents || 0; cur.fee += o.service_fee_cents || 0;
    perOrg.set(org, cur);
  }
  for (const o of bar) {
    const org = eventOrg.get(o.event_id); if (!org) continue;
    const cur = perOrg.get(org) ?? { gmv: 0, fee: 0 };
    cur.gmv += o.total_cents || 0;
    perOrg.set(org, cur);
  }
  const payouts = [...perOrg.entries()].map(([id, v]) => ({
    id, name: orgName.get(id) ?? '—', gmv_cents: v.gmv, fee_cents: v.fee, payout_cents: v.gmv - v.fee,
  })).sort((a, b) => b.payout_cents - a.payout_cents);

  const takeRate = gmv > 0 ? (feeTotal / gmv) * 100 : 0;
  return {
    gmv_cents: gmv, revenue_cents: feeTotal, net_to_producers_cents: netToProducers,
    take_rate_pct: Number(takeRate.toFixed(2)), payouts,
  };
}

/** Trilha de atividade REAL da plataforma (pagamentos, reembolsos, eventos). */
export async function activityFeed() {
  const [{ data: orders }, { data: events }, { data: orgs }] = await Promise.all([
    repo.recentOrders(30), repo.recentEvents(15), repo.allOrgs(),
  ]);
  const items = [];
  for (const o of orders ?? []) {
    items.push({
      at: o.paid_at ?? o.created_at, kind: o.status === 'refunded' ? 'refund' : 'payment',
      title: o.status === 'refunded' ? 'Reembolso' : 'Pagamento confirmado',
      detail: o.events?.title ?? 'Evento', amount_cents: o.total_cents,
    });
  }
  for (const e of events ?? []) {
    items.push({ at: e.created_at, kind: 'event', title: `Evento ${e.status === 'published' ? 'publicado' : 'criado'}`, detail: `${e.title} · ${e.organizations?.name ?? ''}`, amount_cents: null });
  }
  for (const o of (orgs ?? []).slice(-8)) {
    items.push({ at: o.created_at, kind: 'org', title: 'Organização cadastrada', detail: o.name, amount_cents: null });
  }
  return items.filter((i) => i.at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 40);
}

/** Sinais de integridade/fraude REAIS (divergência de ledger). */
export async function fraudSignals() {
  const [{ data: drifts }, { data: events }] = await Promise.all([repo.ledgerDrifts(), repo.allEventsLite()]);
  const title = new Map((events ?? []).map((e) => [e.id, e.title]));
  return (drifts ?? []).map((d) => ({
    wallet_id: d.wallet_id, event: title.get(d.event_id) ?? 'Carteira geral',
    balance_cents: d.balance_cents, ledger_cents: d.ledger_cents, drift_cents: d.drift_cents,
  }));
}
