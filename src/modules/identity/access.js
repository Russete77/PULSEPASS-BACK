import { supabase } from '../../config/supabase.js';
import { notFound, forbidden } from '../../utils/ApiError.js';

/**
 * Autorização por evento com RBAC de equipe.
 * Garante que o usuário é DONO da organização OU staff do evento com um
 * dos papéis informados. Papéis: 'manager' | 'door' | 'bar'.
 *
 * @param {string} userId
 * @param {string} eventId
 * @param {string[]|null} roles  - papéis aceitos (além do dono). null = qualquer.
 * @returns {Promise<{id:string,title:string,slug:string,organization_id:string}>}
 */
export async function assertEventAccess(userId, eventId, roles = null) {
  const { data: event } = await supabase
    .from('events')
    .select('id, title, slug, organization_id')
    .eq('id', eventId)
    .maybeSingle();
  if (!event) throw notFound('Evento não encontrado');

  const { data: ok, error } = await supabase.rpc('has_event_access', {
    p_event: eventId,
    p_user: userId,
    p_roles: roles,
  });
  if (error) throw error;
  if (!ok) throw forbidden('Sem acesso a este evento');
  return event;
}
