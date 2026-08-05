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
