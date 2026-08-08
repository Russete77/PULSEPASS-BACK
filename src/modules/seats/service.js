// modules/seats/service.js — regra do assento marcado.
import { notFound, badRequest, conflict } from '../../utils/ApiError.js';
import { assertEventAccess } from '../identity/access.js';
import * as repo from './repo.js';

/** Minutos que a reserva dura. O desenho pede 8 e é o que a tela mostra. */
const MINUTOS_RESERVA = 8;

/**
 * Mapa para desenhar.
 *
 * Agrupa por setor e devolve o preço do lote junto. Libera os vencidos
 * ANTES de ler: sem isso o mapa mostraria como ocupada uma poltrona que já
 * voltou a estar livre, e a pessoa desistiria de um lugar que existe.
 */
export async function getSeatMap({ eventSlug, user = null }) {
  const { data: evento } = await repo.findEventPublished(eventSlug);
  if (!evento || evento.status !== 'published') throw notFound('Evento não encontrado');

  await repo.rpcLiberarVencidos(evento.id);
  const { data, error } = await repo.findSeatMap(evento.id);
  if (error) throw error;

  const setores = new Map();
  for (const s of data ?? []) {
    if (!setores.has(s.setor)) {
      setores.set(s.setor, {
        nome: s.setor,
        lote: s.ticket_tiers?.name ?? null,
        preco_cents: s.ticket_tiers?.price_cents ?? null,
        meia_cents: s.ticket_tiers?.half_price_cents ?? null,
        tier_id: s.tier_id,
        fileiras: new Map(),
        livres: 0,
        total: 0,
      });
    }
    const setor = setores.get(s.setor);
    if (!setor.fileiras.has(s.fileira)) setor.fileiras.set(s.fileira, []);
    // "meu" separa o que EU segurei do que outra pessoa segurou. Sem essa
    // distinção a tela pintaria de ocupado o assento que a própria pessoa
    // acabou de escolher.
    const meu = Boolean(
      user && s.status === 'held' && s.held_by === user.id
      && s.held_until && new Date(s.held_until) > new Date(),
    );
    setor.fileiras.get(s.fileira).push({
      id: s.id, numero: s.numero, col: s.col, status: s.status, meu,
    });
    setor.total += 1;
    if (s.status === 'free') setor.livres += 1;
  }

  return {
    evento: { id: evento.id, titulo: evento.title, casa: evento.venue_name },
    minutos_reserva: MINUTOS_RESERVA,
    setores: [...setores.values()].map((s) => ({
      ...s,
      fileiras: [...s.fileiras.entries()].map(([fileira, assentos]) => ({ fileira, assentos })),
    })),
  };
}

/** Segura os assentos escolhidos. Vence sozinho — ver a RPC. */
export async function holdSeats({ user, eventSlug, seatIds }) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) throw badRequest('Escolha ao menos um assento');
  if (seatIds.length > 10) throw badRequest('No máximo 10 assentos por vez');

  const { data: evento } = await repo.findEventPublished(eventSlug);
  if (!evento || evento.status !== 'published') throw notFound('Evento não encontrado');

  const { data, error } = await repo.rpcReservar({
    eventId: evento.id, seatIds, userId: user.id, minutos: MINUTOS_RESERVA,
  });
  if (error) {
    // A recusa é esperada e frequente: numa estreia, duas pessoas tocam a
    // mesma poltrona no mesmo segundo. Precisa sair como conflito com
    // instrução, não como erro genérico.
    if (/ASSENTO_INDISPONIVEL/.test(error.message)) {
      throw conflict('Alguém pegou esse lugar antes. Atualize o mapa e escolha outro.');
    }
    throw error;
  }
  return {
    assentos: data ?? [],
    expira_em: data?.[0]?.held_until ?? null,
    minutos: MINUTOS_RESERVA,
  };
}

export async function releaseSeats({ user, eventSlug }) {
  const { data: evento } = await repo.findEventPublished(eventSlug);
  if (!evento) throw notFound('Evento não encontrado');
  const { data } = await repo.rpcSoltar({ eventId: evento.id, userId: user.id });
  return { soltos: data ?? 0 };
}

/**
 * Gera a grade de um setor.
 *
 * A produtora não desenha poltrona por poltrona: informa fileiras e assentos
 * por fileira, e o sistema monta. Planta livre — corredor no meio, fileira
 * curva — é o que justificaria um editor gráfico, e não é o que esta grade
 * se propõe a fazer.
 */
export async function generateSeats({ user, eventId, setor, tierId, fileiras, porFileira }) {
  await assertEventAccess(user.id, eventId, ['manager']);
  if (!setor?.trim()) throw badRequest('Informe o nome do setor');
  if (!tierId) throw badRequest('Informe a qual lote o setor pertence (é ele que tem o preço)');

  const nFileiras = Math.min(40, Math.max(1, Number(fileiras) || 0));
  const nPorFileira = Math.min(60, Math.max(1, Number(porFileira) || 0));
  if (!nFileiras || !nPorFileira) throw badRequest('Informe fileiras e assentos por fileira');

  const linhas = [];
  for (let f = 0; f < nFileiras; f++) {
    // A, B, … Z, AA, AB — como toda casa de espetáculo nomeia.
    const nome = f < 26
      ? String.fromCharCode(65 + f)
      : String.fromCharCode(65 + Math.floor(f / 26) - 1) + String.fromCharCode(65 + (f % 26));
    for (let c = 0; c < nPorFileira; c++) {
      linhas.push({
        event_id: eventId, tier_id: tierId, setor: setor.trim(),
        fileira: nome, numero: c + 1, col: c, row_idx: f, status: 'free',
      });
    }
  }

  const { data, error } = await repo.insertSeats(linhas);
  if (error) {
    if (/duplicate key/.test(error.message)) {
      throw conflict(`O setor "${setor}" já tem assentos. Escolha outro nome ou apague os existentes.`);
    }
    throw error;
  }
  return { criados: data?.length ?? 0, setor: setor.trim() };
}
