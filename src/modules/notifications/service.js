import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import * as repo from './repo.js';

// ─────────────────────────────────────────────────────────────
// Entrega de ingresso por e-mail (QR + PDF). Tudo OPCIONAL e gated:
// - precisa de RESEND_API_KEY + EMAIL_FROM para enviar;
// - qrcode e pdfkit são carregados sob demanda (no-op se não instalados).
// Nunca quebra o fluxo de pagamento — falha de entrega só loga.
// ─────────────────────────────────────────────────────────────

export const deliveryEnabled = Boolean(env.email.resendApiKey && env.email.from);

/** Payload do QR igual ao lido na porta: PULSEPASS:<id>:<secret>. */
function qrPayload(ticket) {
  return `PULSEPASS:${ticket.id}:${ticket.qr_secret}`;
}

async function qrDataUrl(text) {
  try {
    const QR = await import('qrcode');
    return await QR.toDataURL(text, { margin: 1, width: 320 });
  } catch {
    return null; // qrcode não instalado
  }
}

async function buildPdf({ event, tickets, qrMap }) {
  let PDFDocument;
  try { ({ default: PDFDocument } = await import('pdfkit')); }
  catch { return null; } // pdfkit não instalado

  return await new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.fontSize(20).text('PulsePass', { continued: false });
    doc.moveDown(0.3).fontSize(14).fillColor('#444').text(event?.title ?? 'Ingresso');
    doc.moveDown(1);

    tickets.forEach((t, i) => {
      if (i > 0) doc.addPage();
      doc.fillColor('#000').fontSize(16).text(t.ticket_tiers?.name ?? 'Ingresso');
      doc.moveDown(0.2).fontSize(12).fillColor('#666').text(`Código: ${t.code}`);
      const dataUrl = qrMap[t.id];
      if (dataUrl) {
        const b64 = dataUrl.split(',')[1];
        doc.moveDown(1).image(Buffer.from(b64, 'base64'), { width: 220 });
      }
    });
    doc.end();
  });
}

/**
 * Envia o e-mail com os ingressos e REGISTRA o resultado.
 *
 * O registro é o ponto: antes, uma falha virava um logger.warn e sumia — o
 * cliente não recebia o ingresso e ninguém ficava sabendo até a fila do evento.
 * Agora toda tentativa (enviada, falha ou pulada) fica em email_deliveries,
 * então dá pra ver o que quebrou e reenviar.
 */
export async function deliverTickets({ to, event, tickets, orderId = null }) {
  if (!deliveryEnabled) {
    // "Pulado" também é registro: a produtora precisa enxergar que o e-mail
    // não saiu por falta de configuração, em vez de supor que saiu.
    logger.info('entrega: desativada (sem RESEND_API_KEY/EMAIL_FROM)');
    await record({ orderId, to, status: 'skipped', error: 'RESEND_API_KEY/EMAIL_FROM ausentes' });
    return { sent: false, reason: 'not_configured' };
  }
  if (!to || !tickets?.length) return { sent: false, reason: 'nothing_to_send' };

  // QR de cada ingresso
  const qrMap = {};
  for (const t of tickets) qrMap[t.id] = await qrDataUrl(qrPayload(t));

  const rows = tickets.map((t) => `
    <div style="margin:16px 0;padding:16px;border:1px solid #eee;border-radius:12px">
      <strong>${t.ticket_tiers?.name ?? 'Ingresso'}</strong><br/>
      <span style="font-family:monospace;color:#666">${t.code}</span><br/>
      ${qrMap[t.id] ? `<img src="${qrMap[t.id]}" width="180" alt="QR"/>` : ''}
    </div>`).join('');

  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:auto">
      <h2>Seus ingressos · ${event?.title ?? ''}</h2>
      <p>Apresente o QR na entrada. Bom evento!</p>
      ${rows}
      <p style="color:#999;font-size:12px">PulsePass</p>
    </div>`;

  const pdf = await buildPdf({ event, tickets, qrMap });

  const body = {
    from: env.email.from,
    to: [to],
    subject: `Seus ingressos · ${event?.title ?? 'PulsePass'}`,
    html,
    ...(pdf ? { attachments: [{ filename: 'ingressos.pdf', content: pdf.toString('base64') }] } : {}),
  };

  // Até 3 tentativas com espera crescente: instabilidade momentânea do
  // provedor não pode custar o ingresso do cliente.
  let ultimoErro = null;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.email.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        logger.info('entrega: ingressos enviados', { to, count: tickets.length, tentativa });
        await record({ orderId, to, status: 'sent', attempts: tentativa, providerId: json?.id ?? null });
        return { sent: true, attempts: tentativa };
      }
      const corpo = await res.text().catch(() => '');
      ultimoErro = `HTTP ${res.status} ${corpo.slice(0, 180)}`;
      // 4xx (chave inválida, remetente não verificado) não melhora com retry.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (err) {
      ultimoErro = err.message;
    }
    if (tentativa < 3) await new Promise((r) => setTimeout(r, 400 * tentativa));
  }

  logger.warn('entrega: falha no envio', { to, error: ultimoErro });
  await record({ orderId, to, status: 'failed', attempts: 3, error: ultimoErro });
  return { sent: false, reason: 'delivery_failed', error: ultimoErro };
}

/** Grava a tentativa. Nunca lança: registrar não pode derrubar uma venda paga. */
async function record({ orderId, to, status, attempts = 1, error = null, providerId = null }) {
  try {
    await repo.insertDelivery({
      order_id: orderId, to_email: to, kind: 'tickets',
      status, attempts, error: error ? String(error).slice(0, 500) : null, provider_id: providerId,
    });
  } catch (e) {
    logger.warn('entrega: não foi possível registrar a tentativa', { error: e.message });
  }
}

/** Entregas de um pedido — o suporte usa pra responder "não recebi meu ingresso". */
export async function deliveriesForOrder(orderId) {
  const { data } = await repo.findDeliveriesByOrder(orderId);
  return data ?? [];
}
