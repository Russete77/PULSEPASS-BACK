// modules/marketing/service.js — campanhas de e-mail para o público do evento.
import { badRequest, notFound, conflict } from '../../utils/ApiError.js';
import { assertEventAccess } from '../identity/access.js';
import * as notifications from '../notifications/service.js';
import { logger } from '../../lib/logger.js';
import * as repo from './repo.js';

/**
 * Os quatro segmentos são consultas sobre dado que já existe — a regra de
 * quem entra em cada um vive na RPC marketing_publico (migration 0053).
 * Nada aqui é lista importada nem estimativa.
 */
export const SEGMENTOS = [
  { id: 'compradores', label: 'Compradores',      descricao: 'Quem tem pedido pago neste evento.' },
  { id: 'lista',       label: 'Lista de promoter', descricao: 'Nomes na lista, com e-mail, que não foram cancelados.' },
  { id: 'sem_checkin', label: 'Não compareceu',   descricao: 'Tem ingresso válido e nenhum check-in no evento.' },
  { id: 'fila_espera', label: 'Fila de espera',   descricao: 'Ainda aguardando vaga.' },
];

const IDS_SEGMENTO = SEGMENTOS.map((s) => s.id);

/**
 * Teto de destinatários por envio. Não existe fila de jobs no backend, então o
 * envio acontece dentro da requisição — sem teto, uma campanha grande vira um
 * request que nunca responde. Quando entrar uma fila, isto sai.
 */
const MAX_DESTINATARIOS = 1000;

const escaparHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** O corpo é texto puro escrito pela produtora — escapado antes de virar HTML. */
function montarHtml({ subject, body, eventTitle }) {
  const paragrafos = escaparHtml(body).split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br/>')}</p>`).join('');
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;color:#222">
      <h2 style="margin:0 0 4px">${escaparHtml(subject)}</h2>
      <p style="margin:0 0 18px;color:#888;font-size:13px">${escaparHtml(eventTitle ?? '')}</p>
      ${paragrafos}
      <p style="color:#999;font-size:12px;margin-top:24px">PulsePass</p>
    </div>`;
}

const paraDto = (c) => ({
  id: c.id,
  event_id: c.event_id,
  subject: c.subject,
  body: c.body,
  segment: c.segment,
  status: c.status,
  mode: c.mode,
  audience_count: c.audience_count,
  sent_count: c.sent_count,
  failed_count: c.failed_count,
  mock_count: c.mock_count,
  created_at: c.created_at,
  sent_at: c.sent_at,
});

/** Tamanho real de cada segmento agora — o mesmo número que o envio vai usar. */
export async function listSegments({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.rpcSegmentos(eventId);
  if (error) throw error;
  const contagens = data ?? {};
  return {
    delivery_enabled: notifications.deliveryEnabled,
    segments: SEGMENTOS.map((s) => ({ ...s, size: Number(contagens[s.id] ?? 0) })),
  };
}

export async function listCampaigns({ user, eventId }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  const { data, error } = await repo.findCampaignsByEvent(eventId);
  if (error) throw error;
  return {
    delivery_enabled: notifications.deliveryEnabled,
    campaigns: (data ?? []).map(paraDto),
  };
}

export async function createCampaign({ user, eventId, subject, body, segment }) {
  const event = await assertEventAccess(user.id, eventId, ['manager']);

  const assunto = String(subject ?? '').trim();
  const corpo = String(body ?? '').trim();
  if (assunto.length < 3) throw badRequest('Assunto muito curto (mín. 3 caracteres)');
  if (corpo.length < 10) throw badRequest('Corpo do e-mail muito curto (mín. 10 caracteres)');
  if (!IDS_SEGMENTO.includes(segment)) throw badRequest('Segmento inválido');

  const { data, error } = await repo.insertCampaign({
    event_id: eventId,
    organization_id: event.organization_id,
    subject: assunto,
    body: corpo,
    segment,
    status: 'draft',
    created_by: user.id,
  });
  if (error) throw error;
  return paraDto(data);
}

/**
 * Envia a campanha.
 *
 * A ordem importa: trava o status ANTES de materializar o público, para que
 * dois cliques não gerem dois envios. Depois materializa (idempotente) e só
 * então fala com o provedor.
 *
 * Sem RESEND_API_KEY nada sai: os destinatários são marcados 'mock' em lote e
 * a campanha guarda mode='mock' para sempre. O histórico precisa distinguir
 * "mandei" de "simulei" muito depois do envio.
 */
export async function sendCampaign({ user, campaignId }) {
  const { data: campanha, error: erroBusca } = await repo.findCampaign(campaignId);
  if (erroBusca) throw erroBusca;
  if (!campanha) throw notFound('Campanha não encontrada');

  const event = await assertEventAccess(user.id, campanha.event_id, ['manager']);

  if (campanha.status === 'sending') throw conflict('Esta campanha já está sendo enviada');
  if (campanha.status === 'sent') throw conflict('Esta campanha já foi enviada');

  const { data: travada, error: erroTrava } = await repo.claimCampaign(campaignId);
  if (erroTrava) throw erroTrava;
  if (!travada) throw conflict('Esta campanha já está sendo enviada');

  let statusJaRestaurado = false;
  try {
    const { data: total, error: erroPublico } = await repo.rpcMaterializar(campaignId);
    if (erroPublico) throw erroPublico;

    const publico = Number(total ?? 0);
    if (publico === 0) {
      // Segmento vazio não é falha da campanha — devolve pra rascunho, não pra 'failed'.
      await repo.updateCampaign(campaignId, { status: 'draft', audience_count: 0 });
      statusJaRestaurado = true;
      throw badRequest('Nenhum destinatário neste segmento — a campanha continua como rascunho');
    }

    const modo = notifications.deliveryEnabled ? 'resend' : 'mock';
    let enviados = 0;
    let falhas = 0;
    let mocks = 0;

    if (modo === 'mock') {
      // Lote único: sem provedor configurado não há por que percorrer e-mail a e-mail.
      const { error } = await repo.markPendingAs(campaignId, {
        status: 'mock',
        error: 'RESEND_API_KEY/EMAIL_FROM ausentes — envio simulado',
        sent_at: new Date().toISOString(),
      });
      if (error) throw error;
      const { count } = await repo.countRecipientsByStatus(campaignId, 'mock');
      mocks = count ?? publico;
      logger.info('marketing: campanha simulada (sem provedor de e-mail)', { campaignId, publico });
    } else {
      const { data: pendentes, error } = await repo.findPendingRecipients(campaignId, MAX_DESTINATARIOS);
      if (error) throw error;

      const html = montarHtml({ subject: campanha.subject, body: campanha.body, eventTitle: event.title });
      for (const destinatario of pendentes ?? []) {
        const r = await notifications.sendEmail({
          to: destinatario.email, subject: campanha.subject, html, kind: 'campanha',
        });
        await repo.updateRecipient(destinatario.id, {
          status: r.sent ? 'sent' : 'failed',
          error: r.sent ? null : String(r.error ?? r.reason ?? 'falha no envio').slice(0, 500),
          provider_id: r.providerId ?? null,
          sent_at: new Date().toISOString(),
        });
        if (r.sent) enviados += 1; else falhas += 1;
      }
    }

    const { data: final, error: erroFinal } = await repo.updateCampaign(campaignId, {
      status: 'sent',
      mode: modo,
      audience_count: publico,
      sent_count: enviados,
      failed_count: falhas,
      mock_count: mocks,
      sent_at: new Date().toISOString(),
    });
    if (erroFinal) throw erroFinal;

    return {
      campaign: paraDto(final),
      mode: modo,
      // A tela mostra isto como está: é a frase que impede alguém de achar que o e-mail saiu.
      message: modo === 'mock'
        ? `Envio simulado: ${mocks} destinatário(s) registrados, nenhum e-mail saiu de verdade (RESEND_API_KEY não configurada).`
        : `${enviados} e-mail(s) enviados${falhas ? `, ${falhas} falha(s)` : ''}.`,
      truncated: modo === 'resend' && publico > MAX_DESTINATARIOS,
    };
  } catch (err) {
    // Deixar a campanha presa em 'sending' a tornaria impossível de reenviar.
    if (!statusJaRestaurado) {
      await repo.updateCampaign(campaignId, { status: 'failed' }).catch(() => {});
    }
    throw err;
  }
}
