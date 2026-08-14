#!/usr/bin/env node
// Roda TODAS as suítes e2e numa tacada só, contra uma API de verdade.
//
// Por que isto existe: os ~198 asserts e2e viviam em treze scripts avulsos que
// ninguém disparava. O `npm test` cobria só a suíte de dinheiro, então um push
// podia passar verde no CI com bilheteria, portaria ou split quebrados.
//
// Decisões que valem explicar:
//
//  · SERIAL, não paralelo. Doze das treze suítes usam o MESMO evento semeado —
//    a de capa despublica o evento, a de reentrada liga e desliga a reentrada,
//    a de fila esgota o lote. Em paralelo elas se atropelariam e o resultado
//    seria ruído, não sinal.
//
//  · NÃO para na primeira falha. Parar economiza segundos e custa a visão do
//    todo: é melhor saber que quebraram três áreas do que descobrir uma por
//    execução.
//
//  · A API sobe aqui dentro e morre aqui dentro. Suíte que depende de alguém
//    ter lembrado de subir o servidor é suíte que não roda no CI.
import { spawn } from 'node:child_process';
import { setTimeout as espera } from 'node:timers/promises';
import process from 'node:process';

/** Ordem pensada: o que semeia e valida o básico primeiro. */
const SUITES = [
  ['http', 'fluxo principal (catálogo → pedido → ingresso)'],
  ['boxoffice', 'bilheteria física'],
  ['delivery', 'entrega de ingresso por e-mail'],
  ['reentry', 'reentrada na porta'],
  ['companions', 'acompanhantes na lista'],
  ['waitlist', 'fila de espera'],
  ['bar-service', 'garçom, cozinha e totem'],
  ['caixa', 'turno de caixa e margem'],
  ['fiscal', 'notas fiscais'],
  ['audit', 'trilha de auditoria'],
  ['payment-events', 'estorno, chargeback e risco'],
  ['reconcile', 'reconciliação por polling'],
  ['billing', 'split e taxa da plataforma'],
  ['subaccount', 'subcontas Asaas'],
  ['cover', 'capa do evento'],
  ['marca', 'white-label e acompanhantes'],
  ['seats', 'assento marcado e reserva temporária'],
  ['transferencia', 'transferir ingresso e matar o QR antigo'],
];

const PORTA = Number(process.env.PORT || 4000);
const BASE = process.env.API_BASE || `http://localhost:${PORTA}/api`;
const SEMEAR = process.env.E2E_SKIP_SEED !== '1';
const USAR_API_EXTERNA = Boolean(process.env.API_BASE);

const cor = (c, t) => (process.stdout.isTTY ? `\x1b[${c}m${t}\x1b[0m` : t);
const verde = (t) => cor('32', t);
const vermelho = (t) => cor('31', t);
const cinza = (t) => cor('90', t);

/** Roda um script filho herdando o terminal, e devolve o código de saída. */
function rodar(args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: 'inherit', ...opts });
    p.on('close', (code) => resolve(code ?? 1));
    p.on('error', () => resolve(1));
  });
}

/** Espera a API responder. Sem isto a primeira suíte falha por corrida. */
async function esperarSaude(tentativas = 40) {
  const url = BASE.replace(/\/api$/, '') + '/api/health';
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* ainda subindo */ }
    await espera(500);
  }
  return false;
}

async function main() {
  const inicio = Date.now();
  console.log(`\n${'═'.repeat(58)}`);
  console.log(`  SUÍTE E2E COMPLETA · ${SUITES.length} áreas · ${BASE}`);
  console.log(`${'═'.repeat(58)}`);

  // ── API ──
  let api = null;
  if (USAR_API_EXTERNA) {
    console.log(cinza(`\n→ usando API já no ar em ${BASE}`));
  } else {
    console.log(cinza('\n→ subindo a API…'));
    api = spawn(process.execPath, ['src/server.js'], {
      stdio: ['ignore', 'ignore', 'inherit'],   // stdout calado, erro visível
      env: { ...process.env, PORT: String(PORTA) },
    });
  }

  const encerrar = () => { if (api && !api.killed) api.kill('SIGTERM'); };
  process.on('exit', encerrar);
  process.on('SIGINT', () => { encerrar(); process.exit(130); });

  if (!(await esperarSaude())) {
    console.error(vermelho('\n✖ a API não respondeu em /api/health. Abortando.'));
    encerrar();
    process.exit(1);
  }
  console.log(verde('  API no ar.'));

  // ── Semeadura ──
  // Recria o cenário do zero. Sem isto a segunda execução herda ingresso já
  // usado, lote esgotado e evento despublicado da execução anterior.
  if (SEMEAR) {
    console.log(cinza('\n→ semeando o cenário de teste…'));
    const cod = await rodar(['scripts/seed-e2e.mjs']);
    if (cod !== 0) {
      console.error(vermelho('\n✖ a semeadura falhou. As suítes rodariam sobre dados inconsistentes.'));
      encerrar();
      process.exit(1);
    }
  } else {
    console.log(cinza('\n→ semeadura pulada (E2E_SKIP_SEED=1)'));
  }

  // ── Suítes ──
  const resultados = [];
  for (const [nome, descricao] of SUITES) {
    console.log(`\n${'─'.repeat(58)}\n▶ ${nome} — ${descricao}\n${'─'.repeat(58)}`);
    const t = Date.now();
    const codigo = await rodar([`scripts/e2e-${nome}.mjs`], {
      env: { ...process.env, API_BASE: BASE },
    });
    resultados.push({ nome, descricao, ok: codigo === 0, segundos: ((Date.now() - t) / 1000).toFixed(1) });
  }

  encerrar();

  // ── Placar ──
  const quebradas = resultados.filter((r) => !r.ok);
  console.log(`\n${'═'.repeat(58)}`);
  console.log('  PLACAR');
  console.log(`${'═'.repeat(58)}`);
  for (const r of resultados) {
    const marca = r.ok ? verde('✓') : vermelho('✖');
    console.log(`  ${marca} ${r.nome.padEnd(16)} ${cinza(r.segundos + 's')}  ${cinza(r.descricao)}`);
  }
  const total = ((Date.now() - inicio) / 1000).toFixed(0);
  console.log(`${'═'.repeat(58)}`);
  if (quebradas.length) {
    console.log(vermelho(`  ${quebradas.length} de ${resultados.length} áreas QUEBRADAS`)
      + cinza(` · ${total}s`));
    console.log(cinza(`  reproduza uma delas com: node scripts/e2e-${quebradas[0].nome}.mjs`));
  } else {
    console.log(verde(`  as ${resultados.length} áreas passaram`) + cinza(` · ${total}s`));
  }
  console.log(`${'═'.repeat(58)}\n`);

  process.exit(quebradas.length ? 1 : 0);
}

main().catch((e) => { console.error(vermelho('\n✖ ERRO FATAL: ' + e.message)); process.exit(1); });
