// Geração de QR (infra). Usa a lib `qrcode` (optionalDependency); se ausente,
// retorna null e o front cai no fallback — nunca quebra o fluxo.
import crypto from 'node:crypto';
import { env } from '../config/env.js';

/** Payload estático (legado/manual): PULSEPASS:<id>:<secret>. */
export function ticketQrPayload(ticket) {
  return `PULSEPASS:${ticket.id}:${ticket.qr_secret}`;
}

// ── QR ROTATIVO (anti-golpe) ──────────────────────────────────────────
// Token curto assinado que EXPIRA em ~30s. O app regenera sozinho, então
// um print vira inútil segundos depois. Formato: PPX:<id>:<exp>:<sig>
// sig = base64url(HMAC-SHA256("<id>.<exp>.<qr_secret>", TICKET_QR_SECRET))
// O qr_secret por-ingresso entra na assinatura: rotacioná-lo revoga todos os
// tokens daquele ingresso (útil em fraude/transferência).

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sign(id, exp, qrSecret) {
  return b64url(crypto.createHmac('sha256', env.tickets.qrSecret).update(`${id}.${exp}.${qrSecret}`).digest());
}

/** Emite um token rotativo para um ingresso. Retorna { token, exp, ttl }. */
export function signQrToken(ticket, ttlSeconds = env.tickets.qrTtlSeconds) {
  const exp = Date.now() + ttlSeconds * 1000;
  const sig = sign(ticket.id, exp, ticket.qr_secret);
  return { token: `PPX:${ticket.id}:${exp}:${sig}`, exp, ttl: ttlSeconds };
}

/**
 * Verifica um token rotativo. Precisa do qr_secret atual do ingresso (do banco).
 * Retorna { ok, id, reason }. reason: 'format' | 'bad_sig' | 'expired'.
 * Comparação em tempo constante (timingSafeEqual) contra timing attacks.
 */
export function verifyQrToken(token, lookupSecretById) {
  if (typeof token !== 'string' || !token.startsWith('PPX:')) return { ok: false, reason: 'format' };
  const [, id, expStr, sig] = token.split(':');
  if (!id || !expStr || !sig) return { ok: false, reason: 'format' };
  const qrSecret = lookupSecretById(id);
  if (!qrSecret) return { ok: false, id, reason: 'bad_sig' };
  const expected = sign(id, Number(expStr), qrSecret);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, id, reason: 'bad_sig' };
  if (Date.now() > Number(expStr)) return { ok: false, id, reason: 'expired' };
  return { ok: true, id };
}

/** True se a string é um token rotativo (PPX:...). */
export const isRotatingToken = (raw) => typeof raw === 'string' && raw.startsWith('PPX:');

/** QR como data-URL PNG (string) ou null se a lib não estiver instalada. */
export async function qrDataUrl(text) {
  try {
    const QR = await import('qrcode');
    return await QR.toDataURL(text, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
  } catch {
    return null;
  }
}
