// modules/door/repo.js — acesso a dados da porta/PDV (check-in, manifesto, menu, lookup).
import { supabase, findProfileByEmail } from '../../config/supabase.js';

const CHECKIN_COLS =
  'id, code, qr_secret, status, event_id, checked_in_at, profiles:owner_id(full_name), ticket_tiers(name)';

export function findTicketForCheckin({ id, secret, code }) {
  let q = supabase.from('tickets').select(CHECKIN_COLS);
  q = id ? q.eq('id', id).eq('qr_secret', secret) : q.eq('code', code);
  return q.maybeSingle();
}

/** Busca por id só (p/ validar o token rotativo, cuja assinatura usa o qr_secret do banco). */
export const findTicketById = (id) =>
  supabase.from('tickets').select(CHECKIN_COLS).eq('id', id).maybeSingle();

/**
 * Passagem na porta: registra o movimento e aplica a política de reentrada do
 * evento numa transação só. Decidir isso em JS abriria corrida entre dois
 * porteiros escaneando o mesmo ingresso em portões diferentes.
 */
export const rpcGatePass = ({ ticketId, eventId, operatorId, direction, gate }) =>
  supabase.rpc('gate_pass', {
    p_ticket: ticketId, p_event: eventId, p_operator: operatorId ?? null,
    p_direction: direction ?? null, p_gate: gate ?? null,
  });

/** Quantos estão DENTRO agora — o que segurança e bombeiro perguntam. */
export const rpcOccupancy = (eventId) => supabase.rpc('event_occupancy', { p_event: eventId });

export const findTicketMovements = (ticketId) =>
  supabase.from('gate_movements')
    .select('direction, gate, created_at')
    .eq('ticket_id', ticketId).order('created_at', { ascending: false }).limit(20);

/** Consome o ingresso de forma idempotente (só muda se status='valid'). */
export const consumeTicketRow = (ticketId, when) =>
  supabase.from('tickets')
    .update({ status: 'used', checked_in_at: when })
    .eq('id', ticketId).eq('status', 'valid').select('id').maybeSingle();

export const findManifestTickets = (eventId) =>
  supabase.from('tickets')
    .select('id, code, qr_secret, status, checked_in_at, profiles:owner_id(full_name), ticket_tiers(name)')
    .eq('event_id', eventId).order('code', { ascending: true });

export const findEventMenu = (eventId) =>
  supabase.from('menu_items')
    // `stock` no select: a RPC de venda já decrementa e recusa OUT_OF_STOCK,
    // mas o operador vendia às cegas — descobria o fim do estoque no erro,
    // com a fila formada. O número na tela evita a venda que vai falhar.
    .select('id, name, category, price_cents, available, position, stock')
    .eq('event_id', eventId).eq('available', true).order('position', { ascending: true });

// Carteira ÚNICA (0027): o saldo do cliente vive na carteira geral (event_id null).
export const findWalletBalance = (profileId) =>
  supabase.from('wallets').select('balance_cents')
    .eq('profile_id', profileId).is('event_id', null).maybeSingle();

// (legado — não usar; mantido só p/ compat se algo referenciar)
export const findWalletBalanceByEvent = (profileId, eventId) =>
  supabase.from('wallets').select('balance_cents')
    .eq('profile_id', profileId).eq('event_id', eventId).maybeSingle();

export { findProfileByEmail };
