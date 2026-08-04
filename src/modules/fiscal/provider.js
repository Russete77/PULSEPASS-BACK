// modules/fiscal/provider.js — adapter do emissor de NFS-e.
//
// Mesma ideia do provider do Asaas: o resto do sistema fala com UMA interface e
// não sabe qual emissor está atrás. Trocar de provedor (ou de município) não
// deve reescrever regra de negócio.
//
// Sem credencial roda em MOCK: registra a nota com número simulado e não manda
// nada para a prefeitura. É o que permite testar o fluxo inteiro sem risco de
// emitir documento fiscal de verdade em ambiente de desenvolvimento.
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../lib/logger.js';

export const fiscalMode = env.fiscal.apiToken ? env.fiscal.provider : 'mock';
const MOCK = fiscalMode === 'mock';

/**
 * Emite uma NFS-e.
 * @returns {{provider_ref, numero, codigo_verificacao, pdf_url, xml_url, status}}
 */
export async function issueInvoice({ reference, amountCents, description, buyer, serviceCode }) {
  if (MOCK) {
    // Número determinístico pela referência: reemitir o mesmo pedido em teste
    // devolve o mesmo "documento", como aconteceria com idempotência real.
    const seq = String(Math.abs(hash(reference)) % 1_000_000).padStart(6, '0');
    logger.info('fiscal: emissão simulada (modo mock)', { reference, amountCents });
    return {
      status: 'issued',
      provider_ref: `mock_${reference}`,
      numero: seq,
      codigo_verificacao: `MOCK${seq}`,
      pdf_url: null,
      xml_url: null,
    };
  }

  // Focus NFe: emissão é assíncrona — o POST aceita e a nota fica "processando".
  const res = await fetch(`${env.fiscal.baseUrl}/v2/nfse?ref=${encodeURIComponent(reference)}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.fiscal.apiToken}:`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data_emissao: new Date().toISOString(),
      servico: {
        discriminacao: description,
        valor_servicos: amountCents / 100,
        item_lista_servico: serviceCode || env.fiscal.serviceCode,
      },
      tomador: {
        cpf: buyer?.doc?.length === 11 ? buyer.doc : undefined,
        cnpj: buyer?.doc?.length === 14 ? buyer.doc : undefined,
        razao_social: buyer?.name,
        email: buyer?.email,
      },
    }),
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = data?.mensagem ?? data?.erros?.[0]?.mensagem ?? `erro ${res.status}`;
    throw new ApiError(502, `Emissor fiscal: ${msg}`, data);
  }
  return {
    status: data.status === 'autorizado' ? 'issued' : 'pending',
    provider_ref: reference,
    numero: data.numero ?? null,
    codigo_verificacao: data.codigo_verificacao ?? null,
    pdf_url: data.url ?? data.caminho_danfse ?? null,
    xml_url: data.caminho_xml_nota_fiscal ?? null,
  };
}

/** Consulta o andamento (emissão em provedor real é assíncrona). */
export async function fetchInvoice(reference) {
  if (MOCK) return { status: 'issued', numero: null };
  const res = await fetch(`${env.fiscal.baseUrl}/v2/nfse/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${env.fiscal.apiToken}:`).toString('base64')}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(502, `Emissor fiscal: consulta falhou (${res.status})`, data);
  return {
    status: data.status === 'autorizado' ? 'issued'
      : data.status === 'cancelado' ? 'cancelled'
        : data.status === 'erro_autorizacao' ? 'failed' : 'pending',
    numero: data.numero ?? null,
    codigo_verificacao: data.codigo_verificacao ?? null,
    pdf_url: data.url ?? null,
    xml_url: data.caminho_xml_nota_fiscal ?? null,
    error: data.erros?.[0]?.mensagem ?? null,
  };
}

/** Cancela a nota (estorno/reembolso). */
export async function cancelInvoice(reference, justificativa) {
  if (MOCK) {
    logger.info('fiscal: cancelamento simulado (modo mock)', { reference });
    return { status: 'cancelled' };
  }
  const res = await fetch(`${env.fiscal.baseUrl}/v2/nfse/${encodeURIComponent(reference)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.fiscal.apiToken}:`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ justificativa }),
  });
  if (!res.ok && res.status !== 202) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(502, `Emissor fiscal: cancelamento falhou (${res.status})`, data);
  }
  return { status: 'cancelled' };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
