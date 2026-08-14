// modules/loyalty/service.js — regras do programa de fidelidade.
//
// O programa nasce DESLIGADO e sem valores. Ponto é dinheiro com outro nome:
// quanto vale um ponto e quantos pontos um real gera são decisões comerciais
// da produtora. Um padrão inventado aqui viraria promessa que a casa só
// descobre no fechamento — depois de já ter prometido ao cliente.
import { badRequest, conflict, notFound } from '../../utils/ApiError.js';
import { assertOrgOwner } from '../identity/access.js';
import * as repo from './repo.js';

/** Config da produtora. Ausente = programa nunca configurado. */
export async function getConfig({ user, orgId }) {
  await assertOrgOwner(user.id, orgId);
  const { data, error } = await repo.findConfig(orgId);
  if (error) throw error;
  return data ?? {
    organization_id: orgId, ativo: false,
    pontos_por_real: 0, centavos_por_ponto: 0, minimo_resgate: 0,
  };
}

export async function setConfig({ user, orgId, ativo, pontosPorReal, centavosPorPonto, minimoResgate }) {
  await assertOrgOwner(user.id, orgId);

  // Ligar sem definir as duas pontas da regra deixaria o programa acumulando
  // ponto que não converte em nada — ou pior, convertendo em valor que
  // ninguém decidiu bancar.
  if (ativo && (!(pontosPorReal > 0) || !(centavosPorPonto > 0))) {
    throw badRequest(
      'Para ativar, defina quantos pontos cada real gera E quanto vale um ponto. '
      + 'Sem as duas pontas, o programa acumula ponto que não vira nada.',
    );
  }

  const { data, error } = await repo.upsertConfig({
    organization_id: orgId,
    ativo: Boolean(ativo),
    pontos_por_real: Number(pontosPorReal) || 0,
    centavos_por_ponto: Number(centavosPorPonto) || 0,
    minimo_resgate: Math.max(0, Math.round(Number(minimoResgate) || 0)),
    updated_at: new Date().toISOString(),
    updated_by: user.id,
  });
  if (error) throw error;
  return data;
}

/** Saldo + extrato do cliente numa produtora. */
export async function meuSaldo({ user, orgId }) {
  const { data: cfg } = await repo.findConfig(orgId);
  if (!cfg?.ativo) throw notFound('Esta produtora não tem programa de pontos ativo');

  const { data: saldo, error } = await repo.rpcSaldo(user.id, orgId);
  if (error) throw error;
  const { data: extrato } = await repo.findExtrato(user.id, orgId);

  return {
    saldo_pontos: saldo ?? 0,
    // O valor só existe se a produtora definiu quanto vale um ponto.
    valor_cents: Math.floor((saldo ?? 0) * Number(cfg.centavos_por_ponto || 0)),
    minimo_resgate: cfg.minimo_resgate,
    extrato: extrato ?? [],
  };
}

export async function resgatar({ user, orgId, pontos }) {
  const { data, error } = await repo.rpcResgatar(user.id, orgId, pontos);
  if (error) {
    const m = error.message ?? '';
    if (m.includes('PROGRAMA_INATIVO')) throw conflict('O programa de pontos desta produtora não está ativo.');
    if (m.includes('SEM_REGRA_DE_VALOR')) throw conflict('A produtora ainda não definiu quanto vale um ponto.');
    if (m.includes('ABAIXO_DO_MINIMO')) throw badRequest('Abaixo do mínimo para resgate.');
    if (m.includes('SALDO_INSUFICIENTE')) throw badRequest('Você não tem pontos suficientes.');
    if (m.includes('PONTOS_INVALIDOS')) throw badRequest('Informe quantos pontos quer resgatar.');
    throw error;
  }
  return data;
}

export async function programasAtivos() {
  const { data, error } = await repo.findProgramasAtivos();
  if (error) throw error;
  return (data ?? []).map((p) => ({
    organization_id: p.organization_id,
    nome: p.organizations?.name ?? null,
    slug: p.organizations?.slug ?? null,
    pontos_por_real: p.pontos_por_real,
    centavos_por_ponto: p.centavos_por_ponto,
    minimo_resgate: p.minimo_resgate,
  }));
}
