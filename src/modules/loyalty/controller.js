// modules/loyalty/controller.js — camada HTTP do programa de fidelidade.
import { z } from 'zod';
import * as service from './service.js';
import { badRequest } from '../../utils/ApiError.js';

const configSchema = z.object({
  ativo: z.boolean(),
  pontos_por_real: z.number().nonnegative(),
  centavos_por_ponto: z.number().nonnegative(),
  minimo_resgate: z.number().int().nonnegative().optional(),
});
const resgateSchema = z.object({ pontos: z.number().int().positive() });

export async function getConfig(req, res) {
  res.json({ data: await service.getConfig({ user: req.user, orgId: req.params.orgId }) });
}

export async function setConfig(req, res) {
  const p = configSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.json({
    data: await service.setConfig({
      user: req.user, orgId: req.params.orgId,
      ativo: p.data.ativo,
      pontosPorReal: p.data.pontos_por_real,
      centavosPorPonto: p.data.centavos_por_ponto,
      minimoResgate: p.data.minimo_resgate ?? 0,
    }),
  });
}

export async function meuSaldo(req, res) {
  res.json({ data: await service.meuSaldo({ user: req.user, orgId: req.params.orgId }) });
}

export async function resgatar(req, res) {
  const p = resgateSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Informe quantos pontos quer resgatar', p.error.flatten());
  res.json({ data: await service.resgatar({ user: req.user, orgId: req.params.orgId, pontos: p.data.pontos }) });
}

export async function programas(req, res) {
  res.json({ data: await service.programasAtivos() });
}
