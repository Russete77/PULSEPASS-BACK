// modules/billing/controller.js — HTTP de taxa e transparência do repasse.
import { z } from 'zod';
import { badRequest } from '../../utils/ApiError.js';
import * as service from './service.js';
import * as audit from '../audit/service.js';

// ── Super-admin (PulseADM) ──

export async function settings(req, res) {
  res.json({ data: await service.getSettings() });
}

const feeSchema = z.object({ fee_bps: z.number().int().min(0).max(10000) });

export async function setDefaultFee(req, res) {
  const p = feeSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  const r = await service.setDefaultFee({ user: req.user, feeBps: p.data.fee_bps });

  // Taxa é receita: quem mudou, de quanto para quanto, fica na trilha imutável.
  await audit.record({
    req, action: 'platform.default_fee_change', entity: 'platform_settings',
    before: { fee_bps: r.before }, after: { fee_bps: r.after },
  });
  res.json({ data: r });
}

const orgFeeSchema = z.object({ fee_bps: z.number().int().min(0).max(10000).nullable() });

export async function setOrgFee(req, res) {
  const p = orgFeeSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  const r = await service.setOrgFee({ orgId: req.params.orgId, feeBps: p.data.fee_bps });

  await audit.record({
    req, action: 'platform.org_fee_change', entity: 'organizations', entityId: req.params.orgId,
    organizationId: req.params.orgId,
    before: { fee_bps: r.before }, after: { fee_bps: r.after },
    note: r.organization,
  });
  res.json({ data: r });
}

// ── Produtora ──

export async function transparency(req, res) {
  res.json({ data: await service.transparency({ user: req.user, orgId: req.params.orgId }) });
}
