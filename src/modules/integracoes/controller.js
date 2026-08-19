// modules/integracoes/controller.js — HTTP de chaves, webhooks e da API pública.
//
// As rotas de GESTÃO (criar chave, criar webhook) são montadas sob /admin pelo
// cockpit e autenticam PESSOA. As rotas da API PÚBLICA vivem em routes.js e
// autenticam CHAVE. Os dois grupos moram no mesmo controller porque são a
// mesma feature vista dos dois lados.
import { z } from 'zod';
import { badRequest } from '../../utils/ApiError.js';
import * as service from './service.js';

const escopo = z.enum(['eventos:ler', 'pedidos:ler', 'ingressos:ler']);
const evento = z.enum(['pedido.pago', 'ingresso.emitido', 'checkin.registrado', 'pedido.estornado']);

const criarChaveSchema = z.object({
  nome: z.string().min(2).max(60),
  escopos: z.array(escopo).min(1),
});

const criarWebhookSchema = z.object({
  url: z.string().url().max(500),
  eventos: z.array(evento).min(1),
});

const pausarSchema = z.object({ ativa: z.boolean() });

// ── Gestão (cockpit da produtora) ──

export async function listarChaves(req, res) {
  res.json({ data: await service.listarChaves({ user: req.user, orgId: req.params.orgId }) });
}

export async function criarChave(req, res) {
  const p = criarChaveSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({
    data: await service.criarChave({
      user: req.user, orgId: req.params.orgId, nome: p.data.nome, escopos: p.data.escopos,
    }),
  });
}

export async function revogarChave(req, res) {
  res.json({
    data: await service.revogarChave({
      user: req.user, orgId: req.params.orgId, chaveId: req.params.chaveId,
    }),
  });
}

export async function listarWebhooks(req, res) {
  res.json({ data: await service.listarWebhooks({ user: req.user, orgId: req.params.orgId }) });
}

export async function criarWebhook(req, res) {
  const p = criarWebhookSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.status(201).json({
    data: await service.criarWebhook({
      user: req.user, orgId: req.params.orgId, url: p.data.url, eventos: p.data.eventos,
    }),
  });
}

export async function pausarWebhook(req, res) {
  const p = pausarSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  res.json({
    data: await service.pausarWebhook({
      user: req.user, orgId: req.params.orgId, assinaturaId: req.params.assinaturaId, ativa: p.data.ativa,
    }),
  });
}

export async function removerWebhook(req, res) {
  res.json({
    data: await service.removerWebhook({
      user: req.user, orgId: req.params.orgId, assinaturaId: req.params.assinaturaId,
    }),
  });
}

export async function rotacionarSecret(req, res) {
  res.json({
    data: await service.rotacionarSecret({
      user: req.user, orgId: req.params.orgId, assinaturaId: req.params.assinaturaId,
    }),
  });
}

export async function reprocessar(req, res) {
  res.json({
    data: await service.reprocessar({
      user: req.user, orgId: req.params.orgId, assinaturaId: req.params.assinaturaId,
    }),
  });
}

// ── API pública (autenticada por chave) ──

export async function pubQuemSou(req, res) {
  res.json({ data: await service.quemSou({ apiKey: req.apiKey }) });
}

export async function pubEventos(req, res) {
  res.json({ data: await service.eventosPublicos({ apiKey: req.apiKey }) });
}

export async function pubPedidos(req, res) {
  const limite = Math.min(Math.max(Number(req.query.limite) || 100, 1), 200);
  res.json({ data: await service.pedidosPublicos({ apiKey: req.apiKey, limite }) });
}

export async function pubIngressos(req, res) {
  const limite = Math.min(Math.max(Number(req.query.limite) || 500, 1), 1000);
  res.json({
    data: await service.ingressosPublicos({ apiKey: req.apiKey, eventId: req.params.id, limite }),
  });
}
