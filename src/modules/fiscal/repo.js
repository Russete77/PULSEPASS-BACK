// modules/fiscal/repo.js — ÚNICA camada que fala com o banco neste módulo.
import { supabase } from '../../config/supabase.js';

const COLS = `
  id, order_id, organization_id, status, provider, provider_ref, numero,
  codigo_verificacao, pdf_url, xml_url, amount_cents, tax_cents,
  buyer_name, buyer_doc, buyer_email, error, attempts, issued_at, cancelled_at, created_at
`;

export const findByOrder = (orderId) =>
  supabase.from('fiscal_documents').select(COLS).eq('order_id', orderId).maybeSingle();

export const findById = (id) =>
  supabase.from('fiscal_documents').select(COLS).eq('id', id).maybeSingle();

export const insertDoc = (row) =>
  supabase.from('fiscal_documents').insert(row).select(COLS).single();

export const updateDoc = (id, patch) =>
  supabase.from('fiscal_documents').update(patch).eq('id', id).select(COLS).single();

export const listByEvent = (eventId, { limit = 200 } = {}) =>
  supabase.from('fiscal_documents')
    .select(`${COLS}, orders!inner(event_id)`)
    .eq('orders.event_id', eventId)
    .order('created_at', { ascending: false })
    .limit(limit);

export const rpcSummary = (eventId) => supabase.rpc('fiscal_summary', { p_event: eventId });

/** Dados do pedido pago necessários para montar a nota. */
export const findOrderForInvoice = (orderId) =>
  supabase.from('orders')
    .select(`
      id, status, total_cents, event_id, buyer_id,
      events!inner(id, title, organization_id),
      profiles:buyer_id(full_name, cpf, email)
    `)
    .eq('id', orderId).maybeSingle();
