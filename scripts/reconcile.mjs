#!/usr/bin/env node
// Reconciliação de pagamentos — roda de tempos em tempos (cron/scheduler).
//
// Existe porque a fila de webhook do Asaas é interrompida após 15 falhas
// consecutivas de entrega e só volta com reativação manual no painel. Sem esta
// varredura, uma queda da API no sábado à noite significaria clientes pagando
// e não recebendo ingresso — sem ninguém saber.
//
// Uso:
//   node scripts/reconcile.mjs              # últimos pendentes (>10 min)
//   node scripts/reconcile.mjs --minutes=60
//
// Sugestão de agendamento: a cada 5 minutos.
import 'dotenv/config';
import { reconcilePending, webhookHealth } from '../src/modules/payments/reconcile.js';

const arg = (nome, padrao) => {
  const m = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return m ? Number(m.split('=')[1]) : padrao;
};

const saude = await webhookHealth();
console.log('Entrega de webhooks:', JSON.stringify(saude, null, 2));

const resumo = await reconcilePending({ olderThanMinutes: arg('minutes', 10) });
console.log('Reconciliação:', JSON.stringify(resumo, null, 2));

// Sai com código 1 quando corrigiu algo que o webhook deveria ter entregue:
// o agendador transforma isso em alerta em vez de sucesso silencioso.
const houveFalhaDeEntrega = resumo.confirmados > 0 || resumo.revertidos > 0 || !saude.healthy;
process.exit(houveFalhaDeEntrega ? 1 : 0);
