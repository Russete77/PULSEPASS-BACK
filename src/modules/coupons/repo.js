// modules/coupons/repo.js — acesso a dados de cupons (gestão pelo produtor).
import { supabase } from '../../config/supabase.js';

export const insertCoupon = (row) =>
  supabase.from('coupons').insert(row).select().single();

export const findCouponsByEvent = (eventId) =>
  supabase.from('coupons')
    .select('id, code, kind, value, max_uses, used_count, active, expires_at, created_at')
    .eq('event_id', eventId).order('created_at', { ascending: false });

export const findCouponEvent = (couponId) =>
  supabase.from('coupons').select('id, event_id').eq('id', couponId).maybeSingle();

export const updateCoupon = (couponId, patch) =>
  supabase.from('coupons').update(patch).eq('id', couponId).select('id, code, active').single();

export const deleteCoupon = (couponId) =>
  supabase.from('coupons').delete().eq('id', couponId);
