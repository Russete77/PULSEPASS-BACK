import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';

// Modo MOCK só é permitido fora de produção. Em produção sem chave, falha no boot.
const MOCK = !env.asaas.apiKey;
if (MOCK && env.isProd) {
  throw new Error('[asaas] ASAAS_API_KEY ausente em produção — recusando subir em modo mock.');
}

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${env.asaas.baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', access_token: env.asaas.apiKey, 'User-Agent': 'PulsePass/0.1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = data?.errors?.[0]?.description ?? `Asaas erro ${res.status}`;
    throw new ApiError(502, `Asaas: ${msg}`, data);
  }
  return data;
}

export async function createCustomer({ name, cpfCnpj, email, mobilePhone, externalReference }) {
  if (MOCK) return { id: `cus_mock_${Date.now()}`, name };
  return request('/customers', { method: 'POST', body: { name, cpfCnpj, email, mobilePhone, externalReference } });
}

export async function createPixPayment({ customer, value, dueDate, description, externalReference, split }) {
  if (MOCK) return { id: `pay_mock_${Date.now()}`, status: 'PENDING', value, billingType: 'PIX', externalReference };
  return request('/payments', {
    method: 'POST',
    body: { customer, billingType: 'PIX', value, dueDate, description, externalReference, ...(split ? { split } : {}) },
  });
}

/**
 * Tokeniza um cartão de crédito. O PAN não fica armazenado por nós — guardamos
 * só o token (por cliente), usado nas cobranças. remoteIp = IP do CLIENTE.
 * Doc: https://docs.asaas.com/reference/tokenizacao-de-cartao-de-credito
 */
export async function tokenizeCard({ customer, creditCard, creditCardHolderInfo, remoteIp }) {
  if (MOCK) {
    return {
      creditCardToken: `tok_mock_${Date.now()}`,
      creditCardNumber: String(creditCard?.number ?? '').slice(-4) || '0000',
      creditCardBrand: 'VISA',
    };
  }
  return request('/creditCard/tokenizeCreditCard', {
    method: 'POST',
    body: { customer, creditCard, creditCardHolderInfo, remoteIp },
  });
}

/**
 * Cobrança no CARTÃO DE CRÉDITO (parcelamento opcional + split).
 * Aceita um creditCardToken (preferido) OU os objetos creditCard/holderInfo.
 * Doc: https://docs.asaas.com/reference/criar-cobranca-com-cartao-de-credito
 */
export async function createCardPayment({
  customer, value, dueDate, description, externalReference,
  creditCard, creditCardHolderInfo, creditCardToken, remoteIp, installmentCount, split,
}) {
  if (MOCK) {
    return {
      id: `pay_mock_card_${Date.now()}`,
      status: 'CONFIRMED', value, billingType: 'CREDIT_CARD',
      externalReference, installmentCount: installmentCount ?? 1,
    };
  }
  const body = {
    customer, billingType: 'CREDIT_CARD', value, dueDate, description, externalReference, remoteIp,
    // token na raiz substitui creditCard + creditCardHolderInfo (doc oficial).
    ...(creditCardToken ? { creditCardToken } : { creditCard, creditCardHolderInfo }),
    ...(installmentCount && installmentCount > 1
      ? { installmentCount, installmentValue: Number((value / installmentCount).toFixed(2)) }
      : {}),
    ...(split ? { split } : {}),
  };
  return request('/payments', { method: 'POST', body });
}

/**
 * Monta o split do Asaas: a plataforma (dona da conta) retém feePercent% e
 * repassa o restante à carteira da produtora. Sem walletId → sem repasse.
 */
export function buildSplit(producerWalletId, feePercent = 0) {
  if (!producerWalletId) return undefined;
  const producerShare = Number(Math.max(0, 100 - Number(feePercent || 0)).toFixed(2));
  if (producerShare <= 0) return undefined;
  return [{ walletId: producerWalletId, percentualValue: producerShare }];
}

export async function getPixQrCode(paymentId) {
  if (MOCK) {
    const payload = `00020126MOCK-PIX-${paymentId}520400005303986540510.005802BR5909PulsePass6009SAO PAULO62070503***6304ABCD`;
    return {
      success: true,
      encodedImage: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mbut/MOCK==',
      payload,
      expirationDate: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
  }
  return request(`/payments/${paymentId}/pixQrCode`);
}

export async function getPayment(paymentId) {
  if (MOCK) {
    // Convenção do modo mock: `pay_mock_<STATUS>_<CENTAVOS>_...` devolve aquele
    // status e valor. Sem isso não haveria como exercitar a reconciliação — que
    // existe justamente para o caso em que o provedor diz "pago" e o webhook
    // nunca chegou. O valor importa: a confirmação recusa cobrança com valor
    // divergente do pedido, e um mock que devolve 0 esconderia essa proteção.
    const m = /^pay_mock_([A-Z_]+)_(\d+)_/.exec(String(paymentId));
    return {
      id: paymentId,
      status: m ? m[1] : 'PENDING',
      billingType: 'PIX',
      value: m ? Number(m[2]) / 100 : 0,
    };
  }
  return request(`/payments/${paymentId}`);
}

/** Estorna uma cobrança (PIX ou cartão). Doc: /payments/{id}/refund */
export async function refundPayment(paymentId, value) {
  if (MOCK) return { id: paymentId, status: 'REFUNDED', value };
  return request(`/payments/${paymentId}/refund`, {
    method: 'POST',
    ...(value ? { body: { value } } : {}),
  });
}

export const asaasMode = MOCK ? 'mock' : 'sandbox/live';
