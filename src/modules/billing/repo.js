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
    .select('id, name, fee_bps, asaas_wallet_id')
    .order('name', { ascending: true });

export const findOrg = (orgId) =>
  supabase.from('organizations').select('id, name, fee_bps').eq('id', orgId).maybeSingle();

export const findOrgOwned = (orgId, userId) =>
  supabase.from('organizations')
    .select('id, name, fee_bps, asaas_wallet_id')
    .eq('id', orgId).eq('owner_id', userId).maybeSingle();

export const updateOrgFee = (orgId, feeBps) =>
  supabase.from('organizations').update({ fee_bps: feeBps }).eq('id', orgId).select('fee_bps').single();

export const rpcEffectiveFee = (orgId) => supabase.rpc('effective_fee_bps', { p_org: orgId });
