// modules/integracoes/service.js — regra de negócio de chaves e webhooks.
import { randomBytes } from 'node:crypto';
import { notFound, forbidden, badRequest, conflict } from '../../utils/ApiError.js';
import { seal, secretBoxReady } from '../../lib/secretBox.js';
import * as chaves from './chaves.js';
import { validar as validarDestino } from './destino.js';
import { despachar } from './despachante.js';
import * as repo from './repo.js';

/**
 * Fachada do despacho para os outros módulos. Existe pra que `orders` e `door`
 * não importem `despachante.js` direto — módulo fala com módulo pelo service.
 */
export { despacharEmSegundoPlano } from './despachante.js';

/** Catálogo do que existe. A tela lê daqui — não mantém uma cópia própria. */
export const EVENTOS = [
  { id: 'pedido.pago', titulo: 'Pedido pago', descricao: 'O pagamento foi confirmado e os ingressos existem.' },
  { id: 'ingresso.emitido', titulo: 'Ingresso emitido', descricao: 'Um aviso por ingresso, com o código conferível na porta.' },
  { id: 'checkin.registrado', titulo: 'Check-in registrado', descricao: 'Passagem na porta — entrada, saída e reentrada.' },
  { id: 'pedido.estornado', titulo: 'Pedido estornado', descricao: 'Reembolso ao cliente ou reversão vinda do provedor.' },
];

export const ESCOPOS = [
  { id: 'eventos:ler', titulo: 'Ler eventos', descricao: 'Agenda, status e local dos seus eventos.' },
  { id: 'pedidos:ler', titulo: 'Ler pedidos', descricao: 'Vendas, valores e taxas.' },
  { id: 'ingressos:ler', titulo: 'Ler ingressos', descricao: 'Ingressos emitidos e check-in. Nunca o segredo do QR.' },
];

const IDS_EVENTO = new Set(EVENTOS.map((e) => e.id));
const IDS_ESCOPO = new Set(ESCOPOS.map((e) => e.id));

async function assertOrgOwner(userId, orgId) {
  const { data } = await repo.findOrgOwned(orgId, userId);
  // A chave abre a porta do dado financeiro da casa. Quem emite é quem
  // responde pela casa — não o gerente escalado num evento.
  if (!data) throw forbidden('Organização não pertence a você');
  return data;
}

// ═══════════════════════════════════════════
// Chaves de API
// ═══════════════════════════════════════════

export async function listarChaves({ user, orgId }) {
  await assertOrgOwner(user.id, orgId);
  const { data, error } = await repo.listChaves(orgId);
  if (error) throw error;
  return { chaves: data ?? [], escopos: ESCOPOS };
}

/**
 * Cria a chave e devolve o valor em claro UMA VEZ.
 *
 * O campo `chave` desta resposta é o único momento da vida do sistema em que
 * ele existe. Não há rota de "mostrar de novo", e isso é decisão de projeto:
 * ver o cabeçalho da migration 0055.
 */
export async function criarChave({ user, orgId, nome, escopos }) {
  await assertOrgOwner(user.id, orgId);

  const limpo = String(nome ?? '').trim();
  if (limpo.length < 2) throw badRequest('Dê um nome que diga onde a chave vai ser usada.');

  const pedidos = [...new Set(escopos ?? [])];
  if (!pedidos.length) throw badRequest('Escolha pelo menos um escopo.');
  const invalido = pedidos.find((e) => !IDS_ESCOPO.has(e));
  if (invalido) throw badRequest(`Escopo desconhecido: ${invalido}`);

  const { chave, prefixo, hash } = chaves.gerar();

  const { data, error } = await repo.insertChave({
    organization_id: orgId,
    nome: limpo,
    prefixo,
    hash,
    escopos: pedidos,
    criada_por: user.id,
  });
  if (error) throw error;

  return { ...data, chave, aviso: 'Copie agora. Esta é a única vez que a chave aparece.' };
}

export async function revogarChave({ user, orgId, chaveId }) {
  await assertOrgOwner(user.id, orgId);

  const { data, error } = await repo.revogarChave(chaveId, orgId);
  if (error) throw error;
  if (data) return data;

  // Não achou no update: ou já estava revogada (idempotente, devolve a linha)
  // ou não é dessa produtora (404 — não confirmamos que o id existe).
  const { data: existente } = await repo.findChaveRevogada(chaveId, orgId);
  if (!existente) throw notFound('Chave não encontrada');
  return existente;
}

// ═══════════════════════════════════════════
// Webhooks
// ═══════════════════════════════════════════

/** 32 bytes. O segredo compartilhado precisa da mesma força da chave de API. */
const gerarSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

export async function listarWebhooks({ user, orgId }) {
  await assertOrgOwner(user.id, orgId);

  const { data: assinaturas, error } = await repo.listAssinaturas(orgId);
  if (error) throw error;

  const ids = (assinaturas ?? []).map((a) => a.id);
  let entregas = [];
  if (ids.length) {
    const { data, error: e2 } = await repo.listEntregas(ids, 60);
    if (e2) throw e2;
    entregas = data ?? [];
  }

  return { assinaturas: assinaturas ?? [], entregas, eventos: EVENTOS };
}

export async function criarWebhook({ user, orgId, url, eventos }) {
  await assertOrgOwner(user.id, orgId);

  if (!secretBoxReady()) {
    // Sem a chave de cifra o segredo iria em claro para o banco. Recusar é
    // melhor que gravar um webhook cujo segredo vaza com o primeiro dump.
    throw conflict('SECRET_BOX_KEY não configurada no servidor — webhooks estão indisponíveis.');
  }

  const pedidos = [...new Set(eventos ?? [])];
  if (!pedidos.length) throw badRequest('Escolha pelo menos um evento para assinar.');
  const invalido = pedidos.find((e) => !IDS_EVENTO.has(e));
  if (invalido) throw badRequest(`Evento desconhecido: ${invalido}`);

  const destino = await validarDestino(url);
  const secret = gerarSecret();

  const { data, error } = await repo.insertAssinatura({
    organization_id: orgId,
    url: destino,
    eventos: pedidos,
    secret_enc: seal(secret),
    criada_por: user.id,
  });
  if (error) throw error;

  return { ...data, secret, aviso: 'Guarde o segredo agora — ele não é exibido de novo.' };
}

export async function pausarWebhook({ user, orgId, assinaturaId, ativa }) {
  await assertOrgOwner(user.id, orgId);
  const { data, error } = await repo.setAssinaturaAtiva(assinaturaId, orgId, Boolean(ativa));
  if (error) throw error;
  if (!data) throw notFound('Webhook não encontrado');
  return data;
}

export async function removerWebhook({ user, orgId, assinaturaId }) {
  await assertOrgOwner(user.id, orgId);
  const { data, error } = await repo.deleteAssinatura(assinaturaId, orgId);
  if (error) throw error;
  if (!data) throw notFound('Webhook não encontrado');
  return { removido: true, id: data.id };
}

/**
 * Sorteia um segredo novo. É a única saída para quem perdeu o antigo — e é
 * também o que se faz quando ele vaza. Quebra as verificações do lado do
 * cliente até ele trocar, e a tela avisa isso.
 */
export async function rotacionarSecret({ user, orgId, assinaturaId }) {
  await assertOrgOwner(user.id, orgId);
  if (!secretBoxReady()) throw conflict('SECRET_BOX_KEY não configurada no servidor.');

  const secret = gerarSecret();
  const { data, error } = await repo.trocarSecret(assinaturaId, orgId, seal(secret));
  if (error) throw error;
  if (!data) throw notFound('Webhook não encontrado');

  return { ...data, secret, aviso: 'O segredo anterior parou de valer agora.' };
}

/**
 * Reprocesso manual. Existe porque não há fila: quando o endpoint do cliente
 * volta ao ar, é isto que tira da parede o que ficou parado.
 */
export async function reprocessar({ user, orgId, assinaturaId }) {
  await assertOrgOwner(user.id, orgId);

  const { data: assinatura } = await repo.findAssinatura(assinaturaId, orgId);
  if (!assinatura) throw notFound('Webhook não encontrado');

  const { data: reenfileiradas, error } = await repo.rpcReenfileirar(assinaturaId);
  if (error) throw error;

  const resultado = await despachar({ orgId, limite: 50 });
  return { reenfileiradas: reenfileiradas ?? 0, ...resultado };
}

// ═══════════════════════════════════════════
// API pública (autenticada por chave)
// ═══════════════════════════════════════════

/** "Minha chave funciona?" — a primeira chamada de todo integrador. */
export async function quemSou({ apiKey }) {
  const { data: org } = await repo.findOrg(apiKey.organizationId);
  return {
    organizacao: org ? { id: org.id, nome: org.name, slug: org.slug } : null,
    escopos: apiKey.escopos,
  };
}

export async function eventosPublicos({ apiKey }) {
  const { data, error } = await repo.eventosDaOrg(apiKey.organizationId);
  if (error) throw error;
  return data ?? [];
}

export async function pedidosPublicos({ apiKey, limite = 100 }) {
  const { data: eventos, error } = await repo.idsDeEventosDaOrg(apiKey.organizationId);
  if (error) throw error;

  const ids = (eventos ?? []).map((e) => e.id);
  if (!ids.length) return [];

  const { data, error: e2 } = await repo.pedidosDosEventos(ids, limite);
  if (e2) throw e2;
  return data ?? [];
}

export async function ingressosPublicos({ apiKey, eventId, limite = 500 }) {
  // O recorte por organização é feito ANTES de ler os ingressos: sem isso,
  // uma chave válida leria o evento de qualquer outra produtora só trocando
  // o id na URL.
  const { data: evento } = await repo.findEventoDaOrg(eventId, apiKey.organizationId);
  if (!evento) throw notFound('Evento não encontrado');

  const { data, error } = await repo.ingressosDoEvento(eventId, limite);
  if (error) throw error;
  return data ?? [];
}
