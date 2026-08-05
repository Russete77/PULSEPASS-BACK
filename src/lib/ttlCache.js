// lib/ttlCache.js — cache em memória com validade curta.
//
// Serve a UM problema específico: a vitrine é a página mais acessada e, quando
// o evento abre vendas, centenas de pessoas entram no mesmo minuto pedindo
// exatamente a mesma lista. Sem cache, cada uma vira uma consulta ao banco.
//
// Deliberadamente simples e por processo — não é Redis. Com várias instâncias
// cada uma mantém sua cópia, o que é aceitável para dado público de leitura.
// Se um dia precisar de invalidação coordenada, aí sim entra cache externo.
const store = new Map();

/**
 * Busca do cache ou executa a função, guardando o resultado.
 * @param {string} key
 * @param {number} ttlMs validade
 * @param {() => Promise<any>} fn
 */
export async function cached(key, ttlMs, fn) {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const value = await fn();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });

  // Poda oportunista: sem isso, chaves de busca (?q=) acumulam para sempre.
  if (store.size > 500) {
    const agora = Date.now();
    for (const [k, v] of store) if (v.expiresAt <= agora) store.delete(k);
  }
  return value;
}

/** Limpa tudo (ou o que casar com o prefixo). Usado em teste e em invalidação. */
export function clearCache(prefix = null) {
  if (!prefix) return store.clear();
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

export const cacheSize = () => store.size;
