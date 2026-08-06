// modules/billing/service.js — taxa da plataforma e transparência do repasse.
//
// Duas superfícies opostas no mesmo domínio:
//  · SUPER-ADMIN define a taxa (padrão da plataforma e exceção por produtora);
//  · PRODUTORA enxerga exatamente como o dinheiro dela é calculado.
//
// A segunda existe porque repasse que a casa não consegue conferir vira
// desconfiança — e desconfiança sobre dinheiro encerra parceria.
import { badRequest, notFound, forbidden, conflict } from '../../utils/ApiError.js';
import { fiscalMode } from '../fiscal/service.js';
import { seal, secretBoxReady } from '../../lib/secretBox.js';
import * as asaas from '../payments/provider.js';
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
    // Estado da subconta criada pela plataforma (quando foi por esse caminho).
    subconta: org.asaas_account_id ? {
      account_id: org.asaas_account_id,
      status: org.asaas_account_status,
      // Enquanto houver link de onboarding, faltam documentos — e conta sem
      // documento aprovado não recebe.
      onboarding_url: org.asaas_onboarding_url,
      pendente_documentos: Boolean(org.asaas_onboarding_url),
    } : null,
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

// ═══════════════════ SUBCONTA ASAAS ═══════════════════

/**
 * Cria a conta Asaas da produtora e já guarda o walletId para o split.
 *
 * Sem isto, ela teria que abrir conta por fora, achar o walletId no painel e
 * colar no cockpit. Cada passo desses é uma chance de desistir — e, enquanto
 * não cola, a venda dela fica retida na nossa conta.
 *
 * Sobre a apiKey devolvida: ela dá acesso TOTAL à conta da produtora e o Asaas
 * só a entrega uma vez. Fica cifrada no banco (chave em variável de ambiente) e
 * nunca sai por nenhuma rota — nem para o super-admin. O que o cockpit precisa
 * é do walletId, e é só isso que ele vê.
 */
export async function createSubaccount({ user, orgId, dados }) {
  if (!secretBoxReady()) {
    // Falha explícita: guardar a apiKey em texto claro seria pior que não criar.
    throw badRequest('SECRET_BOX_KEY não configurada — não é seguro criar subconta sem ela.');
  }

  const { data: org } = await repo.findOrgOwned(orgId, user.id);
  if (!org) throw forbidden('Organização não pertence a você');
  if (org.asaas_account_id) {
    throw conflict('Esta organização já tem conta Asaas. Recriar deixaria a conta antiga órfã com o dinheiro preso.');
  }

  const criada = await asaas.createSubaccount({
    name: dados.name,
    email: dados.email,
    cpfCnpj: String(dados.cpfCnpj).replace(/\D/g, ''),
    mobilePhone: String(dados.mobilePhone).replace(/\D/g, ''),
    incomeValue: dados.incomeValue,
    address: dados.address,
    addressNumber: dados.addressNumber,
    province: dados.province,
    postalCode: String(dados.postalCode).replace(/\D/g, ''),
    birthDate: dados.birthDate,
    companyType: dados.companyType,
    complement: dados.complement,
    site: dados.site,
  });

  await repo.saveSubaccount(orgId, {
    asaas_account_id: criada.id,
    asaas_wallet_id: criada.walletId,
    asaas_account_status: (criada.status ?? 'PENDING').toLowerCase(),
    asaas_onboarding_url: criada.onboardingUrl ?? null,
    asaas_api_key_enc: seal(criada.apiKey),
    asaas_account_created_at: new Date().toISOString(),
  });

  return {
    account_id: criada.id,
    wallet_id: criada.walletId,          // é o que o split usa
    status: (criada.status ?? 'PENDING').toLowerCase(),
    onboarding_url: criada.onboardingUrl ?? null,
    account_number: criada.accountNumber ?? null,
    // apiKey NÃO entra na resposta, de propósito.
    aviso: criada.onboardingUrl
      ? 'A conta foi criada, mas só recebe depois do envio dos documentos no link de onboarding.'
      : null,
  };
}

/** Reconsulta o status da subconta (aprovação/documentos pendentes). */
export async function refreshSubaccount({ user, orgId }) {
  const { data: org } = await repo.findOrgOwned(orgId, user.id);
  if (!org) throw forbidden('Organização não pertence a você');
  if (!org.asaas_account_id) throw notFound('Esta organização não tem subconta Asaas');

  const conta = await asaas.getSubaccount(org.asaas_account_id);
  const status = String(conta.accountStatus ?? conta.status ?? 'pending').toLowerCase();
  await repo.saveSubaccount(orgId, {
    asaas_account_status: status,
    asaas_onboarding_url: conta.onboardingUrl ?? org.asaas_onboarding_url ?? null,
  });
  return { status, onboarding_url: conta.onboardingUrl ?? org.asaas_onboarding_url ?? null };
}
