#!/usr/bin/env node
// Conferência da integração com o Asaas — rodar assim que a chave entrar.
//
// Serve para separar "a chave está errada" de "o código está errado" ANTES de
// depurar o app inteiro. Toca a API de verdade, sem criar nada que custe:
// consulta o saldo, lista cobranças e — se você pedir — cria uma cobrança Pix
// de R$ 1,00 para ver o QR nascer.
//
// Uso:
//   npm run asaas:check              # só leitura, não cria nada
//   npm run asaas:check -- --pix     # cria uma cobrança Pix de R$ 1,00
import 'dotenv/config';
import { env } from '../src/config/env.js';

const criarPix = process.argv.includes('--pix');
let ok = 0, erro = 0;

const linha = (rotulo, valor) => console.log(`  ${rotulo.padEnd(26)} ${valor}`);
const bom = (m, d = '') => { ok++; console.log(`  ✓ ${m}${d ? ' · ' + d : ''}`); };
const ruim = (m, d = '') => { erro++; console.log(`  ✖ ${m}${d ? ' · ' + d : ''}`); };

async function chamar(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${env.asaas.baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      access_token: env.asaas.apiKey,
      'User-Agent': 'PulsePass/asaas-check',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const texto = await res.text();
  let dados = {};
  try { dados = texto ? JSON.parse(texto) : {}; } catch { dados = { raw: texto.slice(0, 200) }; }
  return { status: res.status, dados };
}

async function main() {
  console.log('\n═══ Conferência Asaas ═══\n');

  const chave = env.asaas.apiKey;
  if (!chave) {
    console.log('  A API está em modo MOCK: nenhuma chamada real acontece.');
    console.log('  Defina ASAAS_API_KEY no .env e rode de novo.\n');
    process.exit(1);
  }

  const ambiente = chave.startsWith('$aact_prod_') ? 'PRODUÇÃO'
    : chave.startsWith('$aact_hmlg_') ? 'sandbox' : 'desconhecido (prefixo fora do padrão)';
  linha('Endereço', env.asaas.baseUrl);
  linha('Ambiente da chave', ambiente);
  linha('Taxa da plataforma', 'definida no app (PulseADM → Taxas)');
  console.log('');

  if (ambiente === 'PRODUÇÃO') {
    console.log('  ATENÇÃO: chave de PRODUÇÃO. Qualquer cobrança criada aqui é dinheiro real.\n');
  }

  // 1. A chave abre a porta?
  const conta = await chamar('/myAccount');
  if (conta.status === 200) {
    bom('chave aceita', conta.dados?.name ?? conta.dados?.email ?? '');
    // Subconta só é permitida para conta CNPJ — vale conferir antes de tentar.
    const doc = conta.dados?.cpfCnpj ?? '';
    const ehCnpj = String(doc).replace(/\D/g, '').length === 14;
    if (ehCnpj) bom('conta é CNPJ (pode criar subcontas)');
    else ruim('conta NÃO é CNPJ', 'subcontas exigem CNPJ — o resto funciona normalmente');
  } else if (conta.status === 401) {
    ruim('chave RECUSADA (401)', 'confira se a chave e o endereço são do mesmo ambiente');
  } else {
    ruim(`consulta da conta retornou ${conta.status}`, JSON.stringify(conta.dados).slice(0, 120));
  }

  // 2. Saldo — prova que a leitura funciona ponta a ponta.
  const saldo = await chamar('/finance/balance');
  if (saldo.status === 200) bom('saldo consultado', `R$ ${saldo.dados?.balance ?? '?'}`);
  else ruim(`saldo retornou ${saldo.status}`);

  // 3. Webhooks configurados? Sem isso o pagamento não vira ingresso.
  const hooks = await chamar('/webhooks');
  if (hooks.status === 200) {
    const lista = hooks.dados?.data ?? [];
    if (lista.length === 0) {
      ruim('NENHUM webhook cadastrado', 'pagamento confirmado não viraria ingresso');
    } else {
      bom(`${lista.length} webhook(s) cadastrado(s)`);
      for (const h of lista) {
        const estado = h.enabled === false ? 'DESATIVADO' : 'ativo';
        const fila = h.interrupted ? ' · FILA INTERROMPIDA' : '';
        linha(`  ${estado}${fila}`, h.url ?? '');
      }
      const parado = lista.find((h) => h.interrupted);
      if (parado) {
        ruim('há fila de webhook INTERROMPIDA',
          'reative no painel — 15 falhas seguidas pausam a fila e os eventos somem em 14 dias');
      }
    }
  } else {
    ruim(`consulta de webhooks retornou ${hooks.status}`);
  }

  // 4. Cobrança Pix real (opcional).
  if (criarPix) {
    console.log('\n  Criando cobrança Pix de R$ 1,00…');
    const cliente = await chamar('/customers', {
      method: 'POST',
      body: { name: 'Teste PulsePass', cpfCnpj: '24971563792', email: 'teste@pulsepass.test' },
    });
    if (cliente.status >= 300) {
      ruim('não foi possível criar o cliente', JSON.stringify(cliente.dados).slice(0, 140));
    } else {
      bom('cliente criado', cliente.dados.id);
      const cobranca = await chamar('/payments', {
        method: 'POST',
        body: {
          customer: cliente.dados.id, billingType: 'PIX', value: 1.0,
          dueDate: new Date(Date.now() + 864e5).toISOString().slice(0, 10),
          description: 'Conferência de integração PulsePass',
        },
      });
      if (cobranca.status >= 300) {
        ruim('não foi possível criar a cobrança', JSON.stringify(cobranca.dados).slice(0, 140));
      } else {
        bom('cobrança criada', `${cobranca.dados.id} · status ${cobranca.dados.status}`);
        const qr = await chamar(`/payments/${cobranca.dados.id}/pixQrCode`);
        if (qr.status === 200 && qr.dados?.payload) {
          bom('QR Pix gerado', `${qr.dados.payload.slice(0, 42)}…`);
          console.log('\n  Copia-e-cola para testar o pagamento:\n');
          console.log(`  ${qr.dados.payload}\n`);
        } else {
          ruim('QR Pix não veio', JSON.stringify(qr.dados).slice(0, 120));
        }
      }
    }
  } else {
    console.log('\n  (rode com --pix para criar uma cobrança de R$ 1,00 e ver o QR)');
  }

  console.log(`\n═══ ${ok} ok · ${erro} problema(s) ═══\n`);
  process.exit(erro ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO:', e.message); process.exit(1); });
