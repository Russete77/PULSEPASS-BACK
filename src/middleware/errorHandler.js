import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { captureException } from '../lib/observability.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { message: 'Rota não encontrada' } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const isApi = err instanceof ApiError;
  const status = isApi ? err.status : 500;

  // Erros 5xx (e não-ApiError) vão para o Sentry + log estruturado.
  if (!isApi || status >= 500) {
    captureException(err, { path: req?.originalUrl, method: req?.method, status });
  }

  res.status(status).json({
    error: {
      message: isApi ? err.message : 'Erro interno do servidor',
      ...(isApi && err.details ? { details: err.details } : {}),
      ...(env.isProd ? {} : { stack: isApi ? undefined : err.stack }),
    },
  });
}
