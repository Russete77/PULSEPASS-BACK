import { getUserFromToken } from '../config/supabase.js';
import { unauthorized, forbidden } from '../utils/ApiError.js';
import { env } from '../config/env.js';

/**
 * Exige um Bearer token válido do Supabase Auth.
 * Popula req.user e req.accessToken.
 */
export async function requireAuth(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized('Token ausente'));

  const user = await getUserFromToken(token);
  if (!user) return next(unauthorized('Token inválido ou expirado'));

  req.user = user;
  req.accessToken = token;
  next();
}

/**
 * Exige um super-admin (PulseADM). requireAuth + e-mail em ADMIN_EMAILS.
 * God-mode da plataforma: todo acesso é auditável.
 */
export async function requireSuperAdmin(req, res, next) {
  await requireAuth(req, res, (err) => {
    if (err) return next(err);
    const email = (req.user?.email ?? '').toLowerCase();
    if (!email || !env.adminEmails.includes(email)) {
      return next(forbidden('Acesso restrito ao super-admin da plataforma'));
    }
    next();
  });
}

/**
 * Autenticação opcional — se houver token válido, popula req.user;
 * caso contrário segue sem usuário (útil p/ catálogo público).
 */
export async function optionalAuth(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    const user = await getUserFromToken(token);
    if (user) {
      req.user = user;
      req.accessToken = token;
    }
  }
  next();
}
