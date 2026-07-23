import { env } from '../config/env.js';

// ─────────────────────────────────────────────────────────────
// Logger estruturado mínimo (JSON em produção, legível em dev).
// Sem dependências. Substitui console.* espalhado.
// ─────────────────────────────────────────────────────────────
function emit(level, msg, meta) {
  const base = { level, ts: new Date().toISOString(), msg };
  const rec = meta ? { ...base, ...meta } : base;
  if (env.isProd) {
    // linha única JSON — fácil de ingerir em qualquer coletor de logs.
    (level === 'error' ? console.error : console.log)(JSON.stringify(rec));
  } else {
    const tag = { info: 'ℹ', warn: '⚠', error: '✖', debug: '·' }[level] ?? '·';
    (level === 'error' ? console.error : console.log)(`${tag} ${msg}`, meta ?? '');
  }
}

export const logger = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  debug: (msg, meta) => { if (!env.isProd) emit('debug', msg, meta); },
};
