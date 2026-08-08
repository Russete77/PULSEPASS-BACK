// modules/seats/controller.js — assento marcado.
import { z } from 'zod';
import * as service from './service.js';
import { badRequest } from '../../utils/ApiError.js';

const holdSchema = z.object({
  seat_ids: z.array(z.string().uuid()).min(1).max(10),
});

const gerarSchema = z.object({
  setor: z.string().min(1).max(60),
  tier_id: z.string().uuid(),
  fileiras: z.number().int().positive().max(40),
  por_fileira: z.number().int().positive().max(60),
});

/** Mapa público — quem ainda não tem conta precisa ver o que sobrou. */
export async function map(req, res) {
  res.json({ data: await service.getSeatMap({ eventSlug: req.params.slug, user: req.user ?? null }) });
}

export async function hold(req, res) {
  const p = holdSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.json({ data: await service.holdSeats({ user: req.user, eventSlug: req.params.slug, seatIds: p.data.seat_ids }) });
}

export async function release(req, res) {
  res.json({ data: await service.releaseSeats({ user: req.user, eventSlug: req.params.slug }) });
}

export async function generate(req, res) {
  const p = gerarSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({
    data: await service.generateSeats({
      user: req.user, eventId: req.params.id,
      setor: p.data.setor, tierId: p.data.tier_id,
      fileiras: p.data.fileiras, porFileira: p.data.por_fileira,
    }),
  });
}
