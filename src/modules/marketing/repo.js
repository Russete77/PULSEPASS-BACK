// modules/marketing/repo.js — acesso a dados das campanhas de e-mail.
import { supabase } from '../../config/supabase.js';

// organization_id e created_by ficam de fora: são de uso interno do serviço.
const CAMPOS = `
  id, event_id, subject, body, segment, status, mode,
  audience_count, sent_count, failed_count, mock_count, created_at, sent_at`;

export const insertCampaign = (row) =>
  supabase.from('marketing_campaigns').insert(row).select(CAMPOS).single();

export const findCampaignsByEvent = (eventId) =>
  supabase.from('marketing_campaigns').select(CAMPOS)
    .eq('event_id', eventId).order('created_at', { ascending: false });

export const findCampaign = (id) =>
  supabase.from('marketing_campaigns')
    .select(`${CAMPOS}, organization_id`).eq('id', id).maybeSingle();

export const updateCampaign = (id, patch) =>
  supabase.from('marketing_campaigns').update(patch).eq('id', id).select(CAMPOS).single();

/**
 * Trava a campanha para envio. O `.in('status', [...])` é o que impede dois
 * cliques no botão de mandarem a campanha duas vezes: o segundo update não
 * encontra linha e volta null.
 */
export const claimCampaign = (id) =>
  supabase.from('marketing_campaigns')
    .update({ status: 'sending' })
    .eq('id', id).in('status', ['draft', 'failed'])
    .select('id').maybeSingle();

export const rpcSegmentos = (eventId) =>
  supabase.rpc('marketing_segmentos', { p_event: eventId });

export const rpcMaterializar = (campaignId) =>
  supabase.rpc('marketing_materializar', { p_campaign: campaignId });

export const findPendingRecipients = (campaignId, limite) =>
  supabase.from('marketing_recipients')
    .select('id, email, name').eq('campaign_id', campaignId).eq('status', 'pending')
    .order('created_at', { ascending: true }).limit(limite);

export const updateRecipient = (id, patch) =>
  supabase.from('marketing_recipients').update(patch).eq('id', id);

/** Modo mock: marca o lote inteiro de uma vez, sem passar de e-mail em e-mail. */
export const markPendingAs = (campaignId, patch) =>
  supabase.from('marketing_recipients').update(patch)
    .eq('campaign_id', campaignId).eq('status', 'pending');

export const countRecipientsByStatus = (campaignId, status) =>
  supabase.from('marketing_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId).eq('status', status);
