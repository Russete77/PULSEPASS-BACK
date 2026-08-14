// modules/integracoes/repo.js — acesso a dados de chaves de API e webhooks.
//
// Uma regra atravessa este arquivo inteiro: NENHUM select devolve `hash`
// (chave de API) ou `secret_enc` (segredo do webhook) para caminho que termina
// em tela. Os dois únicos lugares que os leem são a conferência da chave e o
// despachante — e ambos estão marcados abaixo.
import { supabase } from '../../config/supabase.js';

/** Campos de chave que podem ser mostrados. Sem `hash`, de propósito. */
const CHAVE_PUBLICA = 'id, nome, prefixo, escopos, ultimo_uso_em, revogada_em, created_at';
/** Campos de assinatura que podem ser mostrados. Sem `secret_enc`. */
const ASSINATURA_PUBLICA = 'id, url, eventos, ativa, created_at';

export const findOrgOwned = (orgId, userId) =>
  supabase.from('organizations').select('id, name')
    .eq('id', orgId).eq('owner_id', userId).maybeSingle();

// ── Chaves de API ──

export const listChaves = (orgId) =>
  supabase.from('api_keys').select(CHAVE_PUBLICA)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

export const insertChave = (row) =>
  supabase.from('api_keys').insert(row).select(CHAVE_PUBLICA).single();

/**
 * Revogar é um UPDATE condicionado a `revogada_em is null`: revogar duas vezes
 * não reescreve a data da primeira, que é o registro de quando a chave
 * realmente parou de valer.
 */
export const revogarChave = (id, orgId) =>
  supabase.from('api_keys')
    .update({ revogada_em: new Date().toISOString() })
    .eq('id', id).eq('organization_id', orgId).is('revogada_em', null)
    .select(CHAVE_PUBLICA).maybeSingle();

export const findChaveRevogada = (id, orgId) =>
  supabase.from('api_keys').select(CHAVE_PUBLICA)
    .eq('id', id).eq('organization_id', orgId).maybeSingle();

/**
 * ÚNICO lugar que lê o hash. Busca pelo prefixo (índice único) — o resto da
 * conferência é tempo constante, no access.js.
 */
export const findChavePorPrefixo = (prefixo) =>
  supabase.from('api_keys').select('id, organization_id, hash, escopos, revogada_em')
    .eq('prefixo', prefixo).maybeSingle();

export const tocarChave = (id) =>
  supabase.from('api_keys').update({ ultimo_uso_em: new Date().toISOString() }).eq('id', id);

// ── Assinaturas de webhook ──

export const listAssinaturas = (orgId) =>
  supabase.from('webhook_assinaturas').select(ASSINATURA_PUBLICA)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

export const insertAssinatura = (row) =>
  supabase.from('webhook_assinaturas').insert(row).select(ASSINATURA_PUBLICA).single();

export const findAssinatura = (id, orgId) =>
  supabase.from('webhook_assinaturas').select(ASSINATURA_PUBLICA)
    .eq('id', id).eq('organization_id', orgId).maybeSingle();

export const setAssinaturaAtiva = (id, orgId, ativa) =>
  supabase.from('webhook_assinaturas').update({ ativa })
    .eq('id', id).eq('organization_id', orgId)
    .select(ASSINATURA_PUBLICA).maybeSingle();

export const trocarSecret = (id, orgId, secretEnc) =>
  supabase.from('webhook_assinaturas').update({ secret_enc: secretEnc })
    .eq('id', id).eq('organization_id', orgId)
    .select(ASSINATURA_PUBLICA).maybeSingle();

export const deleteAssinatura = (id, orgId) =>
  supabase.from('webhook_assinaturas').delete()
    .eq('id', id).eq('organization_id', orgId).select('id').maybeSingle();

// ── Entregas ──

/**
 * `payload` fica de fora da listagem de propósito: são dezenas de KB por linha
 * e a tela mostra status, não o corpo. `resposta` entra porque é o que explica
 * a falha — e já vem truncada em 500 caracteres pelo banco.
 */
export const listEntregas = (assinaturaIds, limite = 50) =>
  supabase.from('webhook_entregas')
    .select('id, assinatura_id, evento, status, tentativas, http_status, resposta, erro, proxima_tentativa_em, entregue_em, created_at')
    .in('assinatura_id', assinaturaIds)
    .order('created_at', { ascending: false })
    .limit(limite);

/** ÚNICO lugar que lê `secret_enc` — o despachante precisa dele pra assinar. */
export const rpcReservarEntregas = (limite, orgId = null) =>
  supabase.rpc('reservar_entregas_webhook', { p_limit: limite, p_org: orgId });

export const rpcConcluirEntrega = (id, ok, httpStatus, resposta, erro) =>
  supabase.rpc('concluir_entrega_webhook', {
    p_id: id, p_ok: ok, p_http_status: httpStatus, p_resposta: resposta, p_erro: erro,
  });

export const rpcReenfileirar = (assinaturaId) =>
  supabase.rpc('reenfileirar_entregas_webhook', { p_assinatura: assinaturaId });

// ── Leituras da API pública ──
// Só leitura, e sempre recortada pela organização dona da chave.

export const eventosDaOrg = (orgId) =>
  supabase.from('events')
    .select('id, slug, title, status, category, city, state, venue_name, address, starts_at, ends_at, cover_url')
    .eq('organization_id', orgId)
    .order('starts_at', { ascending: false })
    .limit(200);

export const idsDeEventosDaOrg = (orgId) =>
  supabase.from('events').select('id').eq('organization_id', orgId);

export const pedidosDosEventos = (eventIds, limite = 100) =>
  supabase.from('orders')
    .select('id, event_id, status, total_cents, service_fee_cents, discount_cents, coupon_code, created_at, paid_at')
    .in('event_id', eventIds)
    .order('created_at', { ascending: false })
    .limit(limite);

/**
 * `qr_secret` NÃO está nesta lista e não pode entrar: quem tem o segredo gera
 * um QR válido e entra no lugar do comprador. O `code` (conferível na porta
 * por um humano) é o suficiente pra conciliar do lado de fora.
 */
export const ingressosDoEvento = (eventId, limite = 500) =>
  supabase.from('tickets')
    .select('id, order_id, event_id, ticket_tier_id, code, holder_name, status, checked_in_at, created_at')
    .eq('event_id', eventId)
    .order('created_at', { ascending: false })
    .limit(limite);

export const findEventoDaOrg = (eventId, orgId) =>
  supabase.from('events').select('id, slug, title')
    .eq('id', eventId).eq('organization_id', orgId).maybeSingle();

export const findOrg = (orgId) =>
  supabase.from('organizations').select('id, name, slug').eq('id', orgId).maybeSingle();
