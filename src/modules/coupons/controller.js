// modules/coupons/controller.js — HTTP dos cupons (montado sob /admin pelo cockpit).
import { z } from 'zod';
import * as service from './service.js';
import { badRequest } from '../../utils/ApiError.js';

const createSchema = z.object({
  code: z.string().min(3),
  kind: z.enum(['percent', 'fixed']),
  value: z.number().int().positive(),          // percent: 1..100 | fixed: centavos
  max_uses: z.number().int().positive().nullable().optional(),
  expires_at: z.string().nullable().optional(),
});

export async function create(req, res) {
  const p = createSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({
    data: await service.createCoupon({
      user: req.user, eventId: req.params.id,
      code: p.data.code, kind: p.data.kind, value: p.data.value,
      maxUses: p.data.max_uses ?? null, expiresAt: p.data.expires_at ?? null,
    }),
  });
}

export async function list(req, res) {
  res.json({ data: await service.listCoupons({ user: req.user, eventId: req.params.id }) });
}

export async function setActive(req, res) {
  const active = req.body?.active !== false;
  res.json({ data: await service.setCouponActive({ user: req.user, couponId: req.params.couponId, active }) });
}

export async function remove(req, res) {
  res.json({ data: await service.deleteCoupon({ user: req.user, couponId: req.params.couponId }) });
}
