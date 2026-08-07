// modules/audit/repo.js — ÚNICA camada que fala com o banco neste módulo.
import { supabase } from '../../config/supabase.js';

export const insertEntry = (row) => supabase.from('audit_log').insert(row);

const COLS = `
  id, at, actor_id, actor_email, actor_ip, action, entity, entity_id,
  event_id, organization_id, before, after, amount_cents, note
`;

export function findEntries({ eventId, organizationId, actorId, action, moneyOnly, limit = 200 }) {
  let q = supabase.from('audit_log').select(COLS).order('at', { ascending: false }).limit(limit);
  if (eventId) q = q.eq('event_id', eventId);
  if (organizationId) q = q.eq('organization_id', organizationId);
  if (actorId) q = q.eq('actor_id', actorId);
  if (action) q = q.ilike('action', `${action}%`);
  if (moneyOnly) q = q.not('amount_cents', 'is', null);
  return q;
}

/**
 * Casos de fraude do evento — pagamento revertido depois do ingresso usado,
 * ou recarga estornada depois do consumo. Abrir caso que ninguem le e o mesmo
 * que nao abrir.
 */
export const findFraudCases = (eventId) =>
  supabase.from('fraud_cases')
    .select('id, order_id, ticket_id, profile_id, kind, amount_cents, detail, resolved_at, created_at')
    .eq('event_id', eventId)
    .order('created_at', { ascending: false })
    .limit(200);

export const resolveFraudCase = (id) =>
  supabase.from('fraud_cases').update({ resolved_at: new Date().toISOString() })
    .eq('id', id).select('id, resolved_at').single();

export const findFraudCase = (id) =>
  supabase.from('fraud_cases').select('id, event_id, resolved_at').eq('id', id).maybeSingle();
