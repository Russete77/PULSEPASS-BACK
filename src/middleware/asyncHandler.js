/**
 * Wrapper opcional para handlers async.
 * Express 5 já encaminha promises rejeitadas ao errorHandler,
 * mas manter o wrapper deixa a intenção explícita e é compatível.
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
