// modules/notifications/controller.js — camada HTTP da central de avisos.
import { z } from 'zod';
import * as service from './service.js';
import { badRequest } from '../../utils/ApiError.js';

const idsSchema = z.object({ ids: z.array(z.string().uuid()).optional() });

export async function listar(req, res) {
  res.json({ data: await service.listarMinhas({ user: req.user }) });
}

export async function naoLidas(req, res) {
  res.json({ data: await service.contarNaoLidas({ user: req.user }) });
}

export async function marcarLidas(req, res) {
  const p = idsSchema.safeParse(req.body ?? {});
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.json({ data: await service.marcarLidas({ user: req.user, ids: p.data.ids ?? null }) });
}
