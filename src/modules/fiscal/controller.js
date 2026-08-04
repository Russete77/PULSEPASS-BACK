// modules/fiscal/controller.js — HTTP do módulo fiscal (valida e delega).
import { z } from 'zod';
import { badRequest } from '../../utils/ApiError.js';
import * as service from './service.js';

export async function list(req, res) {
  res.json({ data: await service.eventDocuments({ user: req.user, eventId: req.params.id }) });
}

const issueSchema = z.object({ order_id: z.string().uuid() });
export async function issue(req, res) {
  const p = issueSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  const r = await service.issueManually({
    user: req.user, eventId: req.params.id, orderId: p.data.order_id,
  });
  res.status(r.already ? 200 : 201).json({ data: r });
}
