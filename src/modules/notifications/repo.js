// modules/notifications/repo.js — acesso a dados do domínio Notificações.
import { supabase } from '../../config/supabase.js';

/** Entregas de e-mail de um pedido (usado pela conciliação de entrega). */
export const findDeliveriesByOrder = (orderId) =>
  supabase.from('ticket_deliveries')
    .select('id, to_email, status, provider_id, error, created_at')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });

export const insertDelivery = (row) =>
  supabase.from('ticket_deliveries').insert(row).select().single();

// ── Central de notificações (0054) ──

/** As minhas, mais recentes primeiro. */
export const findMine = (userId, { limit = 50 } = {}) =>
  supabase.from('notificacoes')
    .select('id, tipo, titulo, corpo, destino, event_id, lida_em, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

/** Contador do sininho — roda em toda navegação, por isso só o count. */
export const countUnread = (userId) =>
  supabase.from('notificacoes')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('lida_em', null);

export const rpcMarcarLidas = (userId, ids = null) =>
  supabase.rpc('marcar_notificacoes_lidas', { p_user: userId, p_ids: ids });
