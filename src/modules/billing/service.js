// modules/billing/service.js — taxa da plataforma e transparência do repasse.
//
// Duas superfícies opostas no mesmo domínio:
//  · SUPER-ADMIN define a taxa (padrão da plataforma e exceção por produtora);
//  · PRODUTORA enxerga exatamente como o dinheiro dela é calculado.
//
// A segunda existe porque repasse que a casa não consegue conferir vira
// desconfiança — e desconfiança sobre dinheiro encerra parceria.
import { badRequest, notFound, forbidden } from '../../utils/ApiError.js';
import { fiscalMode } from '../fiscal/service.js';
import * as repo from './repo.js';

/** Percentual legível a partir de pontos-base (1000 → "10%"). */
const pct = (bps) => Number((bps / 100).toFixed(2));

/** Configuração atual da plataforma + taxa de cada produtora. */
export async function getSettings() {
  const { data: settings } = await repo.findSettings();
  const { data: orgs } = await repo.listOrgFees();
  return {
    default_fee_bps: settings?.default_fee_bps ?? 1000,
    default_fee_percent: pct(settings?.default_fee_bps ?? 1000),
    updated_at: settings?.updated_at ?? null,
    organizations: (orgs ?? []).map((o) => ({
      id: o.id, name: o.name,
      fee_bps: o.fee_bps,
      fee_percent: o.fee_bps == null ? null : pct(o.fee_bps),
      usa_padrao: o.fee_bps == null,
      asaas_wallet_id: o.asaas_wallet_id,
      // Sem carteira não há split: a venda inteira fica na conta da plataforma
      // e o repasse vira transferência manual. A produtora precisa saber.
      repasse_automatico: Boolean(o.asaas_wallet_id),
    })),
  };
}

/** Muda a taxa padrão da plataforma (vale para quem não tem taxa própria). */
export async function setDefaultFee({ user, feeBps }) {
  assertFee(feeBps);
  const { data: antes } = await repo.findSettings();
  const { data, error } = await repo.updateDefaultFee(feeBps, user.id);
  if (error) throw error;
  return { before: antes?.default_fee_bps ?? null, after: data.default_fee_bps };
}

/** Define (ou remove) a taxa negociada de uma produtora. */
export async function setOrgFee({ orgId, feeBps }) {
  if (feeBps !== null) assertFee(feeBps);
  const { data: org } = await repo.findOrg(orgId);
  if (!org) throw notFound('Organização não encontrada');
  const { data, error } = await repo.updateOrgFee(orgId, feeBps);
  if (error) throw error;
  return { organization: org.name, before: org.fee_bps, after: data.fee_bps };
}

function assertFee(feeBps) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) {
    throw badRequest('Taxa inválida: informe pontos-base entre 0 e 10000 (1000 = 10%)');
  }
}

/**
 * Transparência do repasse para a produtora.
 *
 * Explica a mecânica REAL, não uma aproximação. Os dois pontos que mais geram
 * discussão e que precisam estar escritos:
 *
 *  · a taxa do provedor sai ANTES da divisão, então o nosso percentual incide
 *    sobre o líquido — a produtora que faz a conta sobre o bruto acha que
 *    recebeu menos do que devia;
 *  · estorno reverte o split. Se ela já sacou, o saldo dela fica negativo no
 *    provedor. Descobrir isso depois do primeiro estorno é péssimo.
 */
export async function transparency({ user, orgId }) {
  const { data: org } = await repo.findOrgOwned(orgId, user.id);
  if (!org) throw forbidden('Organização não pertence a você');

  const { data: feeBps } = await repo.rpcEffectiveFee(orgId);
  const taxa = feeBps ?? 1000;

  // Exemplo com valor redondo: número concreto explica melhor que fórmula.
  const exemploBruto = 10000; // R$ 100,00
  const taxaProvedorEstimada = Math.round(exemploBruto * 0.0099) + 49; // ~0,99% + R$0,49 (Pix/cartão variam)
  const liquido = exemploBruto - taxaProvedorEstimada;
  const nossa = Math.round(liquido * (taxa / 10000));
  const produtora = liquido - nossa;

  return {
    organization: { id: org.id, name: org.name },
    fee_bps: taxa,
    fee_percent: pct(taxa),
    fee_origem: org.fee_bps == null ? 'padrão da plataforma' : 'negociada com esta produtora',
    repasse_automatico: Boolean(org.asaas_wallet_id),
    carteira_configurada: Boolean(org.asaas_wallet_id),
    fiscal_mode: fiscalMode,
    como_funciona: [
      'O cliente paga o valor do ingresso mais a taxa de serviço do evento, se você configurar uma.',
      'O provedor de pagamento (Asaas) desconta a taxa dele sobre o valor recebido.',
      `Sobre o valor LÍQUIDO — depois da taxa do provedor — a plataforma retém ${pct(taxa)}%.`,
      'O restante é repassado automaticamente para a carteira Asaas da sua produtora, no momento em que a cobrança é recebida.',
      'Pix cai praticamente na hora. Cartão de crédito leva cerca de 32 dias entre a confirmação e o dinheiro ficar disponível.',
      'Se uma venda for estornada, o split também é revertido: o valor repassado volta. Se você já tiver sacado, o saldo fica negativo até compensar.',
      'Vendas na bilheteria (dinheiro, maquininha, Pix na sua chave) não passam pelo provedor e não sofrem split — o dinheiro é seu desde a hora.',
    ],
    exemplo: {
      descricao: 'Venda de R$ 100,00 no Pix (valores do provedor são aproximados)',
      bruto_cents: exemploBruto,
      taxa_provedor_cents: taxaProvedorEstimada,
      liquido_cents: liquido,
      plataforma_cents: nossa,
      produtora_cents: produtora,
    },
    avisos: org.asaas_wallet_id ? [] : [
      'Sua carteira Asaas ainda não está configurada. Sem ela não há repasse automático: o valor das vendas online fica retido na conta da plataforma até ser transferido manualmente.',
    ],
  };
}
