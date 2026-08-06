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

// ── Subconta Asaas (produtora cria a própria conta pelo cockpit) ──

const subaccountSchema = z.object({
  // Campos exigidos pelo Asaas em POST /accounts.
  name: z.string().min(2).max(120),
  email: z.string().email(),
  cpfCnpj: z.string().min(11).max(18),
  mobilePhone: z.string().min(10).max(20),
  incomeValue: z.number().positive(),        // faturamento mensal
  address: z.string().min(3),
  addressNumber: z.string().min(1),
  province: z.string().min(2),               // bairro
  postalCode: z.string().min(8).max(9),
  // Opcionais
  birthDate: z.string().optional(),          // pessoa física
  companyType: z.enum(['MEI', 'LIMITED', 'INDIVIDUAL', 'ASSOCIATION']).optional(),
  complement: z.string().optional(),
  site: z.string().optional(),
});

export async function createSubaccount(req, res) {
  const p = subaccountSchema.safeParse(req.body);
  if (!p.success) throw badRequest('Payload inválido', p.error.flatten());
  const r = await service.createSubaccount({ user: req.user, orgId: req.params.orgId, dados: p.data });

  // Conta bancária nova para receber dinheiro: entra na trilha imutável.
  // A apiKey não aparece aqui nem em lugar nenhum.
  await audit.record({
    req, action: 'organization.asaas_subaccount_created',
    entity: 'organizations', entityId: req.params.orgId, organizationId: req.params.orgId,
    after: { account_id: r.account_id, wallet_id: r.wallet_id, status: r.status },
  });

  res.status(201).json({ data: r });
}

export async function refreshSubaccount(req, res) {
  res.json({ data: await service.refreshSubaccount({ user: req.user, orgId: req.params.orgId }) });
}
