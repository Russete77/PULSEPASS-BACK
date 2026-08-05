// modules/waitlist/service.js — fila de espera de lote esgotado.
//
// O ciclo: cliente entra na fila → alguém reembolsa (ou o pedido expira) e o
// estoque volta → os primeiros da fila são convidados por e-mail com PRAZO →
// quem não comprar a tempo perde a vez para o próximo.
//
// O prazo é o que faz a fila funcionar. Sem ele o primeiro da lista trava a
// vaga indefinidamente e ninguém atrás é chamado.
import { badRequest, notFound, conflict } from '../../utils/ApiError.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { assertEventAccess } from '../identity/access.js';
import { notifyWaitlistInvite } from '../notifications/service.js';
import * as repo from './repo.js';

const TTL_MINUTES = 60;

/** Entrar na fila de um lote esgotado. */
export async function join({ user, eventSlug, tierId, email, name, quantity = 1 }) {
  const { data: tier } = await repo.findEventTier(eventSlug, tierId);
  if (!tier) throw notFound('Lote não encontrado');
  if (tier.events.status !== 'published') throw notFound('Evento indisponível');

  const restam = (tier.quantity_total ?? 0) - (tier.quantity_sold ?? 0);
  if (restam > 0) {
    // Ainda tem ingresso: mandar pra fila seria absurdo — que compre.
    throw conflict('Este lote ainda tem ingressos disponíveis');
  }

  const destinatario = (email ?? user?.email ?? '').trim();
  if (!destinatario) throw badRequest('Informe um e-mail para ser avisado');

  const { data, error } = await repo.rpcJoin({
    eventId: tier.events.id, tierId: tier.id, email: destinatario,
    name: name ?? null, quantity, profileId: user?.id ?? null,
  });
  if (error) throw error;
  return { ...data, tier: tier.name, event: tier.events.title };
}

/**
 * Convida os primeiros da fila para as vagas que abriram num lote.
 * Chamado quando estoque volta. Nunca lança para fora: a devolução de estoque
 * já aconteceu e não pode ser desfeita porque o convite falhou.
 */
export async function inviteForTier(tierId, slots = null) {
  try {
    const { data, error } = await repo.rpcInvite({ tierId, slots, ttlMinutes: TTL_MINUTES });
    if (error) throw error;
    if (!data?.invited) return data;

    for (const g of data.guests ?? []) {
      notifyWaitlistInvite({ to: g.email, name: g.name, quantity: g.quantity, ttlMinutes: TTL_MINUTES })
        .catch((e) => logger.warn('fila: falha ao avisar convidado', { error: e.message }));
    }
    logger.info('fila: convites enviados', { tierId, invited: data.invited });
    return data;
  } catch (e) {
    logger.warn('fila: não foi possível convidar', { tierId, error: e.message });
    return { invited: 0, error: e.message };
  }
}

/** Estoque devolvido por um pedido → chama a fila de cada lote envolvido. */
export async function inviteForOrder(orderId) {
  const { data: itens } = await repo.findOrderTiers(orderId);
  for (const item of itens ?? []) {
    await inviteForTier(item.ticket_tier_id, item.quantity);
  }
}

/** Expira convites vencidos, devolvendo a vez a quem está atrás. */
export async function expireInvites() {
  const { data, error } = await repo.rpcExpireInvites();
  if (error) throw error;
  return { expired: data ?? 0 };
}

/** Fila do evento (gestão): quem está esperando e quem já foi convidado. */
export async function listForEvent({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.listByEvent(eventId);
  if (error) throw error;
  const entries = data ?? [];
  return {
    waiting: entries.filter((e) => e.status === 'waiting').length,
    invited: entries.filter((e) => e.status === 'invited').length,
    converted: entries.filter((e) => e.status === 'converted').length,
    entries,
  };
}

export const inviteTtlMinutes = TTL_MINUTES;
export const emailEnabled = Boolean(env.email.resendApiKey && env.email.from);
