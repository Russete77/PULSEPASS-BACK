// modules/identity/repo.js — acesso a dados de perfil, organização, evento (gestão) e equipe.
import { supabase, findProfileByEmail } from '../../config/supabase.js';

// Perfil / organização
export const findProfile = (userId) =>
  supabase.from('profiles').select('id, full_name, role, email').eq('id', userId).maybeSingle();

export const findOrgsByOwner = (userId) =>
  supabase.from('organizations').select('id, name, slug, cnpj, created_at')
    .eq('owner_id', userId).order('created_at', { ascending: true });

export const insertOrg = (row) => supabase.from('organizations').insert(row).select().single();

export const setProfileRole = (userId, role) =>
  supabase.from('profiles').update({ role }).eq('id', userId);

export const findOrgOwned = (orgId, userId) =>
  supabase.from('organizations').select('id').eq('id', orgId).eq('owner_id', userId).maybeSingle();

export const findOrgWallet = (orgId) =>
  supabase.from('organizations').select('id, name, asaas_wallet_id').eq('id', orgId).maybeSingle();

export const updateOrgWallet = (orgId, walletId) =>
  supabase.from('organizations').update({ asaas_wallet_id: walletId })
    .eq('id', orgId).select('id, name, asaas_wallet_id').single();

// Eventos (gestão do produtor)
export const findEventWithOwner = (eventId) =>
  supabase.from('events').select('*, organizations!inner(owner_id)').eq('id', eventId).maybeSingle();

export const findEvent = (eventId) =>
  supabase.from('events').select('*').eq('id', eventId).maybeSingle();

export const insertEvent = (row) => supabase.from('events').insert(row).select().single();

export const insertTiers = (rows) => supabase.from('ticket_tiers').insert(rows);

export const findTiersByEvent = (eventId) =>
  supabase.from('ticket_tiers')
    .select('id, name, price_cents, half_price_cents, quantity_total, quantity_sold, status, position, sales_start, sales_end')
    .eq('event_id', eventId).order('position', { ascending: true });

export const findOrgIdsByOwner = (userId) =>
  supabase.from('organizations').select('id').eq('owner_id', userId);

export const findEventsByOrgs = (orgIds, { limit, offset }) =>
  supabase.from('events')
    .select('id, title, slug, city, state, starts_at, status, created_at')
    .in('organization_id', orgIds)
    .order('starts_at', { ascending: true }).range(offset, offset + limit - 1);

export const updateEventStatus = (eventId, status) =>
  supabase.from('events').update({ status }).eq('id', eventId).select().single();

export const rpcEventDashboard = (eventId) => supabase.rpc('event_dashboard', { p_event: eventId });

export const rpcEventReconciliation = (eventId) => supabase.rpc('event_reconciliation', { p_event: eventId });

export const findRecentPaidOrders = (eventId) =>
  supabase.from('orders').select('id, total_cents, created_at')
    .eq('event_id', eventId).eq('status', 'paid')
    .order('created_at', { ascending: false }).limit(8);

// Equipe (RBAC)
export const findEventStaff = (eventId) =>
  supabase.from('event_staff')
    .select('id, role, created_at, profiles:user_id(id, full_name, email)')
    .eq('event_id', eventId).order('created_at', { ascending: true });

export const upsertEventStaff = (row) =>
  supabase.from('event_staff')
    .upsert(row, { onConflict: 'event_id,user_id,role' })
    .select('id, role, profiles:user_id(id, full_name, email)').single();

export const deleteEventStaff = (staffId, eventId) =>
  supabase.from('event_staff').delete().eq('id', staffId).eq('event_id', eventId);

// Escalações do próprio usuário — porteiro/barman precisa saber ONDE trabalha
// pra cair direto na tela de operação em vez do onboarding de produtora.
export const findMyStaffAssignments = (userId) =>
  supabase.from('event_staff')
    .select('role, events!inner(id, title, slug, city, state, starts_at, status)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

/**
 * URL assinada para a produtora enviar a capa DIRETO ao Storage.
 *
 * O arquivo nao passa pelo nosso servidor de proposito: imagem de 5 MB
 * subindo pela API ocuparia processo que devia estar validando ingresso na
 * porta. O backend so decide QUEM pode enviar e por qual caminho.
 */
export const createCoverUploadUrl = (path) =>
  supabase.storage.from('event-covers').createSignedUploadUrl(path);

export const publicCoverUrl = (path) =>
  supabase.storage.from('event-covers').getPublicUrl(path);

export const removeCover = (paths) =>
  supabase.storage.from('event-covers').remove(paths);

// ── Marca da produtora (white-label) ──

export const findOrgBranding = (orgId) =>
  supabase.from('organizations')
    .select('id, name, slug, logo_url, brand_color, site_url, instagram')
    .eq('id', orgId).maybeSingle();

export const updateOrgBranding = (orgId, patch) =>
  supabase.from('organizations').update(patch).eq('id', orgId)
    .select('id, name, slug, logo_url, brand_color, site_url, instagram').single();

export const createLogoUploadUrl = (path) =>
  supabase.storage.from('org-logos').createSignedUploadUrl(path);

export const publicLogoUrl = (path) =>
  supabase.storage.from('org-logos').getPublicUrl(path);

export const removeLogo = (paths) =>
  supabase.storage.from('org-logos').remove(paths);

export const updateEventCover = (eventId, coverUrl) =>
  supabase.from('events').update({ cover_url: coverUrl }).eq('id', eventId)
    .select('id, cover_url').single();

export { findProfileByEmail };
