import { env } from '../config/env.js';
import { logger } from './logger.js';

// ─────────────────────────────────────────────────────────────
// Integração opcional com Sentry. Só ativa se SENTRY_DSN estiver setado
// E o pacote @sentry/node estiver instalado. Caso contrário, no-op —
// o servidor sobe normalmente sem a dependência.
// ─────────────────────────────────────────────────────────────
let Sentry = null;
let enabled = false;

export async function initObservability() {
  if (!env.sentryDsn) {
    logger.info('observabilidade: Sentry desativado (sem SENTRY_DSN)');
    return;
  }
  try {
    Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: env.sentryDsn,
      environment: env.nodeEnv,
      tracesSampleRate: env.isProd ? 0.1 : 1.0,
    });
    enabled = true;
    logger.info('observabilidade: Sentry ativo', { env: env.nodeEnv });
  } catch {
    logger.warn('observabilidade: SENTRY_DSN setado mas @sentry/node não instalado — rode: npm i @sentry/node');
  }
}

/** Captura uma exceção no Sentry (se ativo) e sempre loga estruturado. */
export function captureException(err, context = {}) {
  logger.error(err?.message ?? 'erro', { ...context, stack: err?.stack });
  if (enabled && Sentry) {
    try { Sentry.captureException(err, { extra: context }); } catch { /* nunca quebra o fluxo */ }
  }
}
