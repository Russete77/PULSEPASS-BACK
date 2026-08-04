// modules/fiscal/service.js — emissão e controle de NFS-e dos pedidos.
//
// Regra que orienta tudo aqui: o sistema NUNCA finge que emitiu. Se o emissor
// está fora, sem credencial, ou recusou, a nota fica registrada como pendente
// ou falha, com o motivo — porque documento fiscal que "sumiu" vira problema
// com o contador e com a prefeitura, não um aviso no log.
import { badRequest, notFound, conflict } from '../../utils/ApiError.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { assertEventAccess } from '../identity/access.js';
import * as provider from './provider.js';
import * as repo from './repo.js';

export const fiscalMode = provider.fiscalMode;

/**
 * Emite a NFS-e de um pedido pago. Idempotente: se já existe documento ativo
 * (pendente ou emitido) para o pedido, devolve o que existe em vez de emitir
 * de novo — nota duplicada é problema fiscal sério.
 */
export async function issueForOrder(orderId) {
  const { data: existing } = await repo.findByOrder(orderId);
  if (existing && ['issued', 'pending'].includes(existing.status)) {
    return { document: existing, already: true };
  }

  const { data: order } = await repo.findOrderForInvoice(orderId);
  if (!order) throw notFound('Pedido não encontrado');
  if (order.status !== 'paid') throw badRequest('Só pedidos pagos geram nota fiscal');

  const buyer = {
    name: order.profiles?.full_name ?? null,
    doc: (order.profiles?.cpf ?? '').replace(/\D/g, '') || null,
    email: order.profiles?.email ?? null,
  };

  // O registro nasce ANTES da chamada ao emissor: se o provedor responder e o
  // processo cair em seguida, a nota não fica órfã — dá pra reconciliar depois.
  const { data: doc, error: insErr } = await repo.insertDoc({
    order_id: order.id,
    organization_id: order.events.organization_id,
    status: 'pending',
    provider: provider.fiscalMode,
    amount_cents: order.total_cents,
    service_code: env.fiscal.serviceCode || null,
    buyer_name: buyer.name, buyer_doc: buyer.doc, buyer_email: buyer.email,
    attempts: 1,
  });
  if (insErr) {
    // Índice único por pedido: outra emissão entrou no mesmo instante.
    if (String(insErr.message).includes('uq_fiscal_order_ativo')) {
      const { data: agora } = await repo.findByOrder(orderId);
      return { document: agora, already: true };
    }
    throw insErr;
  }

  try {
    const result = await provider.issueInvoice({
      reference: order.id,
      amountCents: order.total_cents,
      description: `Ingresso · ${order.events.title}`,
      buyer,
      serviceCode: env.fiscal.serviceCode,
    });
    const { data: updated } = await repo.updateDoc(doc.id, {
      status: result.status,
      provider_ref: result.provider_ref,
      numero: result.numero,
      codigo_verificacao: result.codigo_verificacao,
      pdf_url: result.pdf_url,
      xml_url: result.xml_url,
      issued_at: result.status === 'issued' ? new Date().toISOString() : null,
      error: null,
    });
    return { document: updated, already: false };
  } catch (e) {
    logger.warn('fiscal: emissão falhou', { orderId, error: e.message });
    const { data: falhou } = await repo.updateDoc(doc.id, {
      status: 'failed', error: String(e.message).slice(0, 500),
    });
    return { document: falhou, already: false, error: e.message };
  }
}

/** Reconsulta o provedor (emissão real é assíncrona) e atualiza o registro. */
export async function refresh(documentId) {
  const { data: doc } = await repo.findById(documentId);
  if (!doc) throw notFound('Documento fiscal não encontrado');
  if (doc.status === 'cancelled') return doc;

  const r = await provider.fetchInvoice(doc.provider_ref ?? doc.order_id);
  const { data: updated } = await repo.updateDoc(doc.id, {
    status: r.status,
    numero: r.numero ?? doc.numero,
    codigo_verificacao: r.codigo_verificacao ?? doc.codigo_verificacao,
    pdf_url: r.pdf_url ?? doc.pdf_url,
    xml_url: r.xml_url ?? doc.xml_url,
    error: r.error ?? null,
    issued_at: r.status === 'issued' && !doc.issued_at ? new Date().toISOString() : doc.issued_at,
  });
  return updated;
}

/** Cancela a nota — usado no reembolso. */
export async function cancelForOrder(orderId, justificativa = 'Pedido reembolsado') {
  const { data: doc } = await repo.findByOrder(orderId);
  if (!doc) return null;
  if (doc.status === 'cancelled') return doc;
  if (doc.status !== 'issued') {
    // Nota que nunca foi autorizada não precisa de cancelamento formal.
    const { data: d } = await repo.updateDoc(doc.id, {
      status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: justificativa,
    });
    return d;
  }
  await provider.cancelInvoice(doc.provider_ref ?? orderId, justificativa);
  const { data: updated } = await repo.updateDoc(doc.id, {
    status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: justificativa,
  });
  return updated;
}

// ── Superfície do cockpit ──────────────────────────────────────

export async function eventDocuments({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const [{ data: docs }, { data: summary }] = await Promise.all([
    repo.listByEvent(eventId), repo.rpcSummary(eventId),
  ]);
  return { mode: provider.fiscalMode, summary: summary ?? {}, documents: docs ?? [] };
}

export async function issueManually({ user, eventId, orderId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data: order } = await repo.findOrderForInvoice(orderId);
  if (!order) throw notFound('Pedido não encontrado');
  if (order.event_id !== eventId) throw conflict('Pedido não pertence a este evento');
  return issueForOrder(orderId);
}
