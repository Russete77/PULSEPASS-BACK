import { supabase } from '../../config/supabase.js';
import { notFound, forbidden } from '../../utils/ApiError.js';

/**
 * Autorização por evento: dono da organização, papel na equipe, OU permissão
 * específica concedida a essa pessoa.
 *
 * A permissão é um caminho ALTERNATIVO ao papel, nunca uma restrição. Quem
 * já entra pelo papel continua entrando; a permissão só acrescenta. O
 * contrário transformaria a lista vazia — o padrão de todo mundo hoje — em
 * bloqueio geral.
 *
 * @param {string} userId
 * @param {string} eventId
 * @param {string[]|null} roles  papéis aceitos (além do dono). null = qualquer.
 * @param {string|null} permissao  permissão que também destrava (ex.: 'finance:view')
 */
export async function assertEventAccess(userId, eventId, roles = null, permissao = null) {
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
    p_perm: permissao,
  });
  if (error) throw error;
  if (!ok) throw forbidden('Sem acesso a este evento');
  return event;
}
