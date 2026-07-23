import crypto from 'node:crypto';

/** Gera um código de ingresso legível, ex: PP-7F3K-9QX2 */
export function ticketCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I
  const block = (n) =>
    Array.from({ length: n }, () =>
      alphabet[crypto.randomInt(alphabet.length)],
    ).join('');
  return `PP-${block(4)}-${block(4)}`;
}

/** Referência externa única para conciliar com o Asaas. */
export function externalRef(prefix = 'ord') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}
