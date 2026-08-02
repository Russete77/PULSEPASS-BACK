// modules/notifications/repo.js — ÚNICA camada que fala com o banco neste módulo.
import { supabase } from '../../config/supabase.js';

export const insertDelivery = (row) => supabase.from('email_deliveries').insert(row);

export const findDeliveriesByOrder = (orderId) =>
  supabase.from('email_deliveries')
    .select('id, to_email, status, attempts, error, created_at')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });
