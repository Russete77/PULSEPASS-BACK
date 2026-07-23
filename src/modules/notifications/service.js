import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

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

/** Envia o e-mail com os ingressos. to = e-mail do comprador. */
export async function deliverTickets({ to, event, tickets }) {
  if (!deliveryEnabled) { logger.info('entrega: desativada (sem RESEND_API_KEY/EMAIL_FROM)'); return { sent: false }; }
  if (!to || !tickets?.length) return { sent: false };

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

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.email.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { logger.warn('entrega: falha no envio', { status: res.status }); return { sent: false }; }
    logger.info('entrega: ingressos enviados', { to, count: tickets.length });
    return { sent: true };
  } catch (err) {
    logger.warn('entrega: erro de rede no envio', { error: err.message });
    return { sent: false };
  }
}
