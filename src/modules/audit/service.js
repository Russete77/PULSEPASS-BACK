// modules/audit/service.js — registro de ações sensíveis.
//
// Regra que orienta o módulo: AUDITAR NUNCA DERRUBA A OPERAÇÃO. Se a trilha
// falhar no meio de uma venda, o dinheiro já entrou e o ingresso já existe —
// perder o registro é ruim, mas desfazer a venda por causa dele é pior. Por
// isso record() engole o erro e só loga.
//
// O oposto também vale: a trilha é imutável no banco (sem UPDATE/DELETE, nem
// para o service_role), então o que entra aqui não pode ser maquiado depois.
import { logger } from '../../lib/logger.js';
import { notFound } from '../../utils/ApiError.js';
import { assertEventAccess } from '../identity/access.js';
import * as repo from './repo.js';

/**
 * Registra uma ação sensível.
 * @param {object} p
 * @param {object} [p.req]      request Express (extrai autor e IP sozinho)
 * @param {string} p.action     'dominio.acao' — ex: 'box_office.sale'
 * @param {string} [p.entity]   tabela/domínio afetado
 * @param {string} [p.entityId]
 * @param {object} [p.before]   estado anterior (só os campos que importam)
 * @param {object} [p.after]    estado novo
 * @param {number} [p.amountCents] valor movimentado, quando houver
 */
export async function record({
  req, action, entity = null, entityId = null,
  eventId = null, organizationId = null,
  before = null, after = null, amountCents = null, note = null,
}) {
  try {
    await repo.insertEntry({
      actor_id: req?.user?.id ?? null,
      actor_email: req?.user?.email ?? null,
      actor_ip: clientIp(req),
      action,
      entity, entity_id: entityId ? String(entityId) : null,
      event_id: eventId, organization_id: organizationId,
      before, after, amount_cents: amountCents, note,
    });
  } catch (e) {
    // Nunca propaga: a trilha não pode ser motivo de falha numa venda paga.
    logger.warn('auditoria: não foi possível registrar', { action, error: e.message });
  }
}

/** IP real do cliente, respeitando proxy (Fly/Vercel colocam X-Forwarded-For). */
function clientIp(req) {
  if (!req) return null;
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip ?? null;
}

/** Trilha de um evento — quem mexeu no quê. Só a equipe de gestão enxerga. */
export async function eventTrail({ user, eventId, action, moneyOnly, limit }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.findEntries({
    eventId, action, moneyOnly, limit: Math.min(Number(limit) || 200, 500),
  });
  if (error) throw error;
  return { entries: data ?? [] };
}

/**
 * Casos de fraude do evento.
 *
 * São situações que o sistema não consegue desfazer sozinho: alguém entrou na
 * festa e depois estornou o pagamento, ou bebeu no bar e estornou a recarga.
 * A decisão (cobrar, bloquear, deixar passar) é da casa — nosso papel é não
 * deixar isso invisível.
 */
export async function fraudCases({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.findFraudCases(eventId);
  if (error) throw error;
  const casos = data ?? [];
  return {
    abertos: casos.filter((c) => !c.resolved_at).length,
    prejuizo_aberto_cents: casos.filter((c) => !c.resolved_at)
      .reduce((a, c) => a + (c.amount_cents ?? 0), 0),
    cases: casos,
  };
}

/** Marca o caso como resolvido — a casa decidiu o que fazer. */
export async function resolveFraudCase({ user, caseId }) {
  const { data: caso } = await repo.findFraudCase(caseId);
  if (!caso) throw notFound('Caso não encontrado');
  await assertEventAccess(user.id, caso.event_id, ['manager']);
  const { data, error } = await repo.resolveFraudCase(caseId);
  if (error) throw error;
  return data;
}
