// modules/platform/repo.js — acesso a dados do god-mode (super-admin).
// Consultas globais (todas as orgs). Só o service agrega.
import { supabase } from '../../config/supabase.js';

export const allOrgs = () =>
  supabase.from('organizations').select('id, name, slug, owner_id, created_at').order('created_at', { ascending: true });

export const allEventsLite = () =>
  supabase.from('events').select('id, organization_id, title, status, city, starts_at');

export const paidOrders = () =>
  supabase.from('orders').select('id, event_id, total_cents, service_fee_cents, created_at').eq('status', 'paid');

// Atividade recente da plataforma (trilha): pagamentos e reembolsos.
export const recentOrders = (limit = 40) =>
  supabase.from('orders')
    .select('id, status, total_cents, event_id, created_at, paid_at, events(title)')
    .in('status', ['paid', 'refunded']).order('created_at', { ascending: false }).limit(limit);

export const recentEvents = (limit = 20) =>
  supabase.from('events').select('id, title, status, created_at, organizations(name)').order('created_at', { ascending: false }).limit(limit);

export const barOrdersLite = () =>
  supabase.from('bar_orders').select('id, event_id, total_cents, created_at').eq('status', 'paid');

export const ticketsCount = () =>
  supabase.from('tickets').select('id', { count: 'exact', head: true });

export const profilesByIds = (ids) =>
  ids.length ? supabase.from('profiles').select('id, email, full_name').in('id', ids) : Promise.resolve({ data: [] });

// Sinal de fraude/integridade REAL: carteiras cujo saldo diverge do ledger.
export const ledgerDrifts = () =>
  supabase.from('wallet_reconciliation')
    .select('wallet_id, profile_id, event_id, balance_cents, ledger_cents, drift_cents')
    .neq('drift_cents', 0);
