// modules/integracoes/despachante.js — entrega os webhooks pendentes.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ LIMITAÇÃO CONHECIDA — LEIA ANTES DE MEXER                                ║
// ║                                                                          ║
// ║ Não existe fila de jobs neste projeto. Sem BullMQ, sem worker separado,  ║
// ║ sem pg_net. O que existe é:                                              ║
// ║                                                                          ║
// ║   1. gatilhos no banco que ENFILEIRAM a entrega numa tabela durável      ║
// ║      (0055) — isso nunca falha e nunca se perde;                         ║
// ║   2. esta função, chamada em MELHOR ESFORÇO logo depois das ações que    ║
// ║      geram evento (confirmação de pagamento, check-in, estorno);         ║
// ║   3. um endpoint de reprocesso que a produtora aciona pela tela.         ║
// ║                                                                          ║
// ║ CONSEQUÊNCIA: a entrega pode ATRASAR. Se o processo morre entre o        ║
// ║ gatilho e o POST, a linha fica 'pendente' até a próxima venda ou até     ║
// ║ alguém apertar "reprocessar". O que NÃO acontece é perder o evento.      ║
// ║                                                                          ║
// ║ Trocar isso por entrega pontual exige um agendador chamando `despachar`  ║
// ║ a cada minuto (pg_cron existe no banco, mas não alcança HTTP; o caminho  ║
// ║ realista é um cron externo batendo numa rota). A tela diz isso ao        ║
// ║ integrador, com estas mesmas palavras.                                   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
import { logger } from '../../lib/logger.js';
import { open } from '../../lib/secretBox.js';
import { assinar, CABECALHO } from './assinatura.js';
import { validar } from './destino.js';
import * as repo from './repo.js';

/** Endpoint lento não pode segurar o nosso processo. */
const TIMEOUT_MS = 10_000;
/** Corpo de resposta guardado só o suficiente pra depurar. */
const RESPOSTA_MAX = 500;

/**
 * Entrega um lote de pendentes.
 *
 * @param {{ orgId?: string|null, limite?: number }} opts
 * @returns {Promise<{ processadas: number, entregues: number, falhas: number }>}
 */
export async function despachar({ orgId = null, limite = 20 } = {}) {
  const { data: lote, error } = await repo.rpcReservarEntregas(limite, orgId);
  if (error) throw error;
  if (!lote?.length) return { processadas: 0, entregues: 0, falhas: 0 };

  // Em paralelo: endpoints diferentes não têm por que esperar uns pelos outros,
  // e um destino de 10s travaria o lote inteiro em série.
  const resultados = await Promise.all(lote.map((entrega) => entregar(entrega)));

  const entregues = resultados.filter(Boolean).length;
  return { processadas: resultados.length, entregues, falhas: resultados.length - entregues };
}

async function entregar(entrega) {
  const corpo = JSON.stringify({
    // `id` da entrega vai no corpo E no header: é a chave de idempotência do
    // lado de quem recebe. Retentativa nossa repete o mesmo id, então o ERP
    // sabe que é a mesma venda em vez de criar um segundo pedido.
    id: entrega.id,
    evento: entrega.evento,
    criado_em: new Date().toISOString(),
    dados: entrega.payload,
  });

  let ok = false;
  let httpStatus = null;
  let resposta = null;
  let erro = null;

  try {
    const secret = open(entrega.secret_enc);
    if (!secret) throw new Error('segredo da assinatura indisponível');

    // Revalidado a cada envio: o DNS do domínio pode ter sido repontado para a
    // rede interna depois do cadastro. Ver destino.js.
    const url = await validar(entrega.url);
    const { header } = assinar(corpo, secret);

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CABECALHO]: header,
        'X-PulsePass-Event': entrega.evento,
        'X-PulsePass-Delivery': entrega.id,
        'user-agent': 'PulsePass-Webhooks/1.0',
      },
      body: corpo,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Redirecionamento é caminho de fuga do SSRF: o destino validado responde
      // 302 para 169.254.169.254 e o fetch segue alegremente.
      redirect: 'manual',
    });

    httpStatus = r.status;
    resposta = (await r.text().catch(() => '')).slice(0, RESPOSTA_MAX);
    ok = r.status >= 200 && r.status < 300;
    if (!ok) erro = `destino respondeu ${r.status}`;
  } catch (e) {
    // Timeout, DNS, TLS, destino recusado pela validação — tudo cai aqui e
    // vira retentativa, não exceção que derruba o lote.
    erro = e.name === 'TimeoutError' ? `sem resposta em ${TIMEOUT_MS / 1000}s` : e.message;
  }

  const { error } = await repo.rpcConcluirEntrega(entrega.id, ok, httpStatus, resposta, erro);
  if (error) logger.warn('webhook: falhou ao registrar resultado', { entrega: entrega.id, error: error.message });

  if (!ok) logger.warn('webhook: entrega falhou', { entrega: entrega.id, evento: entrega.evento, erro });
  return ok;
}

/**
 * Disparo de melhor esforço, para chamar DEPOIS de uma ação que gera evento.
 *
 * Não devolve promise pra quem chama esperar: a resposta ao comprador não pode
 * depender do ERP da produtora estar de pé. Se falhar, a linha continua na
 * fila e sai no próximo passe.
 */
export function despacharEmSegundoPlano(orgId = null) {
  despachar({ orgId, limite: 20 })
    .catch((e) => logger.warn('webhook: despacho em segundo plano falhou', { error: e.message }));
}
