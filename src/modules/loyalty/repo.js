// modules/loyalty/repo.js — acesso a dados do programa de fidelidade.
import { supabase } from '../../config/supabase.js';

export const findConfig = (orgId) =>
  supabase.from('fidelidade_config')
    .select('organization_id, ativo, pontos_por_real, centavos_por_ponto, minimo_resgate, updated_at')
    .eq('organization_id', orgId).maybeSingle();

export const upsertConfig = (row) =>
  supabase.from('fidelidade_config').upsert(row, { onConflict: 'organization_id' }).select().single();

export const rpcSaldo = (userId, orgId) =>
  supabase.rpc('fidelidade_saldo', { p_user: userId, p_org: orgId });

export const rpcResgatar = (userId, orgId, pontos) =>
  supabase.rpc('fidelidade_resgatar', { p_user: userId, p_org: orgId, p_pontos: pontos });

export const findExtrato = (userId, orgId, { limit = 50 } = {}) =>
  supabase.from('fidelidade_ledger')
    .select('id, tipo, pontos, descricao, created_at')
    .eq('user_id', userId).eq('organization_id', orgId)
    .order('created_at', { ascending: false }).limit(limit);

/** Produtoras com programa ativo — é o que a tela do cliente lista. */
export const findProgramasAtivos = () =>
  supabase.from('fidelidade_config')
    .select('organization_id, pontos_por_real, centavos_por_ponto, minimo_resgate, organizations(name, slug)')
    .eq('ativo', true);
