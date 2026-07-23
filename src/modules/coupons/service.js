// modules/coupons/service.js — regra de cupons (criação/gestão pelo produtor).
// A REDENÇÃO (aplicar desconto) vive no módulo orders (checkout); aqui é só CRUD.
import { notFound, badRequest } from '../../utils/ApiError.js';
import { assertEventAccess } from '../identity/access.js';
import * as repo from './repo.js';

export async function createCoupon({ user, eventId, code, kind, value, maxUses, expiresAt }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const c = String(code || '').trim().toUpperCase();
  if (c.length < 3) throw badRequest('Código do cupom muito curto (mín. 3)');
  if (!['percent', 'fixed'].includes(kind)) throw badRequest('Tipo inválido (percent | fixed)');
  const v = Math.round(Number(value) || 0);
  if (v <= 0) throw badRequest('Valor inválido');
  if (kind === 'percent' && v > 100) throw badRequest('Percentual máximo é 100');

  const { data, error } = await repo.insertCoupon({
    event_id: eventId, code: c, kind, value: v,
    max_uses: maxUses != null ? Math.max(1, Math.round(Number(maxUses))) : null,
    expires_at: expiresAt || null, active: true,
  });
  if (error) {
    if (error.code === '23505' || String(error.message).includes('duplicate')) {
      throw badRequest('Já existe um cupom com esse código neste evento');
    }
    throw error;
  }
  return data;
}

export async function listCoupons({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.findCouponsByEvent(eventId);
  if (error) throw error;
  return data ?? [];
}

async function assertCouponAccess(user, couponId) {
  const { data: coupon } = await repo.findCouponEvent(couponId);
  if (!coupon) throw notFound('Cupom não encontrado');
  await assertEventAccess(user.id, coupon.event_id, ['manager']);
  return coupon;
}

export async function setCouponActive({ user, couponId, active }) {
  await assertCouponAccess(user, couponId);
  const { data, error } = await repo.updateCoupon(couponId, { active: Boolean(active) });
  if (error) throw error;
  return data;
}

export async function deleteCoupon({ user, couponId }) {
  await assertCouponAccess(user, couponId);
  const { error } = await repo.deleteCoupon(couponId);
  if (error) throw error;
  return { removed: true };
}
