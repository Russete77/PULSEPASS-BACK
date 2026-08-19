// modules/integracoes/access.js — autenticação por chave de API.
//
// Diferente do `requireAuth`, que valida um token de PESSOA no Supabase Auth,
// aqui o portador é um SISTEMA e o que ele prova é ser dono de uma chave da
// produtora. O resultado é sempre o mesmo: `req.apiKey.organizationId`, e todo
// dado devolvido depois é recortado por ele.
import { unauthorized, forbidden } from '../../utils/ApiError.js';
import { logger } from '../../lib/logger.js';
import { confere, prefixoDe, HASH_INEXISTENTE } from './chaves.js';
import * as repo from './repo.js';

/**
 * Aceita os dois formatos que integrador espera encontrar:
 *   Authorization: Bearer pp_live_…
 *   X-PulsePass-Key: pp_live_…
 *
 * O Bearer é o hábito universal; o header próprio existe pra quem já usa o
 * Authorization para outra coisa no meio do caminho (gateway, proxy).
 */
function extrair(req) {
  const proprio = req.headers['x-pulsepass-key'];
  if (typeof proprio === 'string' && proprio.trim()) return proprio.trim();

  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

/**
 * @param {string} [escopo] escopo exigido pela rota (ex.: 'pedidos:ler').
 */
export function requireApiKey(escopo = null) {
  return async function apiKeyAuth(req, _res, next) {
    const apresentada = extrair(req);
    if (!apresentada) {
      return next(unauthorized('Chave de API ausente. Envie "Authorization: Bearer pp_live_…".'));
    }

    const prefixo = prefixoDe(apresentada);
    // Formato errado ainda paga o custo de um hash: ver comentário abaixo.
    const { data: chave } = prefixo ? await repo.findChavePorPrefixo(prefixo) : { data: null };

    // A conferência acontece SEMPRE, com um hash de mentira quando a linha não
    // existe. Se a função retornasse cedo no "não achei", o tempo de resposta
    // diria ao atacante quais prefixos existem — e prefixo válido é meio
    // caminho pra saber onde vale insistir.
    const bate = confere(apresentada, chave?.hash ?? HASH_INEXISTENTE);
    if (!chave || !bate) return next(unauthorized('Chave de API inválida'));

    if (chave.revogada_em) return next(unauthorized('Chave de API revogada'));

    if (escopo && !(chave.escopos ?? []).includes(escopo)) {
      return next(forbidden(`Esta chave não tem o escopo "${escopo}".`));
    }

    req.apiKey = {
      id: chave.id,
      organizationId: chave.organization_id,
      escopos: chave.escopos ?? [],
    };

    // Registrar o uso não pode atrasar a resposta nem derrubá-la: é telemetria
    // ("essa chave ainda está viva?"), não parte da autorização.
    repo.tocarChave(chave.id).then(
      () => {},
      (e) => logger.warn('api-key: falhou ao registrar uso', { error: e.message }),
    );

    next();
  };
}
