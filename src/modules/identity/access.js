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

/**
 * Dono da organização. A checagem existia privada em identity/service.js;
 * mora aqui porque guarda de acesso usada por mais de um módulo tem que
 * viver num lugar só — duplicada, uma das cópias envelhece.
 */
export async function assertOrgOwner(userId, orgId) {
  const { data } = await supabase
    .from('organizations').select('id')
    .eq('id', orgId).eq('owner_id', userId).maybeSingle();
  if (!data) throw forbidden('Organização não pertence a você');
  return data;
}
