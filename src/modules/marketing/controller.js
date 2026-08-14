// modules/marketing/controller.js — HTTP das campanhas (montado sob /admin pelo cockpit).
import { z } from 'zod';
import * as service from './service.js';
import { badRequest } from '../../utils/ApiError.js';

const createSchema = z.object({
  subject: z.string().min(3).max(200),
  body: z.string().min(10).max(10000),
  segment: z.enum(['compradores', 'lista', 'sem_checkin', 'fila_espera']),
});

export async function segments(req, res) {
  res.json({ data: await service.listSegments({ user: req.user, eventId: req.params.id }) });
}

export async function list(req, res) {
  res.json({ data: await service.listCampaigns({ user: req.user, eventId: req.params.id }) });
}

export async function create(req, res) {
  const p = createSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({
    data: await service.createCampaign({
      user: req.user,
      eventId: req.params.id,
      subject: p.data.subject,
      body: p.data.body,
      segment: p.data.segment,
    }),
  });
}

export async function send(req, res) {
  res.json({ data: await service.sendCampaign({ user: req.user, campaignId: req.params.campaignId }) });
}
