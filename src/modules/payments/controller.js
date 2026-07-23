// modules/payments/controller.js — HTTP do webhook (valida token e delega).
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { forbidden } from '../../utils/ApiError.js';
import * as service from './service.js';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Webhook do Asaas. Valida o token próprio (constant-time) e delega ao service.
 * Doc: https://docs.asaas.com/docs/webhook-para-cobrancas
 */
export async function asaas(req, res) {
  const token = req.headers['asaas-access-token'];
  // Fail-closed: sem token configurado, recusa o webhook (em prod o boot já barra).
  if (!env.asaas.webhookToken || !safeEqual(token, env.asaas.webhookToken)) {
    throw forbidden('Token de webhook inválido');
  }
  const result = await service.processAsaasEvent(req.body);
  if (result.duplicated) return res.json({ ok: true, duplicated: true });
  res.json({ ok: true });
}
