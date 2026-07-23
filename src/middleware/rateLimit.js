/**
 * Rate limiter simples em memória (janela fixa por IP).
 * Suficiente para 1 instância; em cluster, troque por Redis.
 */
export function rateLimit({ windowMs = 60_000, max = 120, key = 'global' } = {}) {
  const hits = new Map(); // ip -> { count, reset }
  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const id = `${key}:${ip}`;
    const now = Date.now();
    const rec = hits.get(id);
    if (!rec || rec.reset < now) {
      hits.set(id, { count: 1, reset: now + windowMs });
    } else {
      rec.count += 1;
      if (rec.count > max) {
        const retry = Math.ceil((rec.reset - now) / 1000);
        res.set('Retry-After', String(retry));
        return res.status(429).json({ error: { message: 'Muitas requisições. Tente em instantes.' } });
      }
    }
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    }
    next();
  };
}
