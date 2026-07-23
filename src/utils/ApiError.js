/** Erro de aplicação com status HTTP — capturado pelo errorHandler. */
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, d) => new ApiError(400, msg, d);
export const unauthorized = (msg = 'Não autenticado') => new ApiError(401, msg);
export const forbidden = (msg = 'Sem permissão') => new ApiError(403, msg);
export const notFound = (msg = 'Não encontrado') => new ApiError(404, msg);
export const conflict = (msg, d) => new ApiError(409, msg, d);
