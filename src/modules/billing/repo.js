// modules/billing/repo.js — ÚNICA camada que fala com o banco neste módulo.
import { supabase } from '../../config/supabase.js';

export const findSettings = () =>
  supabase.from('platform_settings').select('default_fee_bps, updated_at, updated_by').eq('id', true).maybeSingle();

export const updateDefaultFee = (feeBps, userId) =>
  supabase.from('platform_settings')
    .update({ default_fee_bps: feeBps, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('id', true).select('default_fee_bps').single();

export const listOrgFees = () =>
  supabase.from('organizations')
    .select('id, name, fee_bps, asaas_wallet_id, asaas_account_id, asaas_account_status')
    .order('name', { ascending: true });

export const findOrg = (orgId) =>
  supabase.from('organizations').select('id, name, fee_bps').eq('id', orgId).maybeSingle();

export const findOrgOwned = (orgId, userId) =>
  supabase.from('organizations')
    // asaas_api_key_enc NUNCA entra no select: e segredo que da acesso total a
    // conta da produtora e nenhuma rota precisa dele.
    .select('id, name, fee_bps, asaas_wallet_id, asaas_account_id, asaas_account_status, asaas_onboarding_url')
    .eq('id', orgId).eq('owner_id', userId).maybeSingle();

/** Grava os dados da subconta. A apiKey chega ja cifrada pelo service. */
export const saveSubaccount = (orgId, patch) =>
  supabase.from('organizations').update(patch).eq('id', orgId);

export const updateOrgFee = (orgId, feeBps) =>
  supabase.from('organizations').update({ fee_bps: feeBps }).eq('id', orgId).select('fee_bps').single();

export const rpcEffectiveFee = (orgId) => supabase.rpc('effective_fee_bps', { p_org: orgId });
