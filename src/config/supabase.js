import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

/**
 * Cliente Supabase com service_role — uso EXCLUSIVO no servidor.
 * Bypassa RLS. Nunca exponha esta chave no frontend.
 */
export const supabase = createClient(
  env.supabase.url,
  env.supabase.serviceRoleKey,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/**
 * Cache curto de validação de token -> user, para não bater no Supabase
 * Auth a cada requisição. TTL de 60s; tokens expirados saem naturalmente.
 */
const tokenCache = new Map(); // token -> { user, exp }
const TOKEN_TTL_MS = 60_000;

export async function getUserFromToken(accessToken) {
  const now = Date.now();
  const cached = tokenCache.get(accessToken);
  if (cached && cached.exp > now) return cached.user;

  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error) return null;
  const user = data.user ?? null;
  if (user) {
    tokenCache.set(accessToken, { user, exp: now + TOKEN_TTL_MS });
    if (tokenCache.size > 5000) tokenCache.clear(); // poda simples
  }
  return user;
}

/** Lookup de perfil por e-mail (substitui listUsers paginado). */
export async function findProfileByEmail(email) {
  if (!email) return null;
  const { data } = await supabase
    .from('profiles')
    .select('id, email, full_name')
    .ilike('email', email.trim())
    .maybeSingle();
  return data ?? null;
}
