#!/usr/bin/env node
// White-label da produtora e acompanhantes na lista.
//
// Duas funcionalidades que entraram testadas à mão e ficaram sem rede de
// proteção. O que este teste guarda:
//
//  · A marca é a da produtora, mas o PROCESSAMENTO continua sendo nosso. A
//    página pública precisa devolver só o que desenha o cabeçalho — devolver
//    a organização inteira exporia campos que não são da conta de quem está
//    comprando.
//  · A lista conta PESSOAS, não nomes. Quem chega com mais dois sem ter
//    avisado vira discussão na porta.
import 'dotenv/config';

const API = process.env.API_BASE || 'http://localhost:4000/api';
const SB = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_ANON_KEY;

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${label}${detail ? ' · ' + detail : ''}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ' · ' + detail : ''}`); }
};
const login = async (e) => {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email: e, password: 'Teste12345!' }),
  });
  return (await r.json()).access_token;
};
const api = async (m, p, { token, body } = {}) => {
  const chamada = () => fetch(API + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let r = await chamada();
  // 429 é o limitador de borda, não resposta do domínio. Rodando as suítes em
  // sequência do mesmo IP ele estoura, e um assert de autorização leria
  // "bloqueado" pelo motivo errado. Respira e tenta de novo.
  if (r.status === 429) {
    await new Promise((s) => setTimeout(s, 1500));
    r = await chamada();
  }
  let j = null; try { j = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, body: j, data: j?.data };
};

async function main() {
  console.log(`\n═══ Marca e acompanhantes · ${API} ═══\n`);
  const produtora = await login('e2e_produtora@pulsepass.test');
  const cliente = await login('e2e_cliente@pulsepass.test');
  const me = (await api('GET', '/admin/me', { token: produtora })).data;
  const org = me.organizations[0];

  console.log('1) A cor precisa ser hexadecimal');
  // Validado no service E no CHECK do banco. A duplicação é proposital: o
  // CHECK protege qualquer caminho que escreva na tabela; a validação no
  // service devolve mensagem que a pessoa entende.
  const ruim = await api('PATCH', `/admin/organizations/${org.id}/branding`, {
    token: produtora, body: { brand_color: 'azul' },
  });
  check('cor inválida é RECUSADA', ruim.status === 400, ruim.body?.error?.message?.slice(0, 40));

  const curta = await api('PATCH', `/admin/organizations/${org.id}/branding`, {
    token: produtora, body: { brand_color: '#FFF' },
  });
  check('hex de 3 dígitos também é recusado', curta.status === 400);

  console.log('\n2) Salvar a marca normaliza os links');
  const ok = await api('PATCH', `/admin/organizations/${org.id}/branding`, {
    token: produtora, body: { brand_color: '#FF3D88', site_url: 'suacasa.com.br', instagram: '@suacasa' },
  });
  check('marca salva', ok.status === 200, ok.data?.brand_color);
  // Sem protocolo, o link vira relativo e leva o visitante para dentro do
  // nosso domínio em vez do site da produtora.
  check('site ganha https://', ok.data?.site_url === 'https://suacasa.com.br', ok.data?.site_url);
  check('arroba do instagram é removida', ok.data?.instagram === 'suacasa', ok.data?.instagram);

  console.log('\n3) A página pública recebe a marca — e só o que precisa');
  const publico = await api('GET', '/events/festa-e2e');
  const marca = publico.data?.marca;
  check('detalhe público traz a marca', !!marca, marca?.nome);
  check('cor chega na página', marca?.cor === '#FF3D88');
  // Devolver a organização inteira exporia CNPJ, carteira Asaas e taxa
  // negociada para qualquer visitante.
  check('NÃO vaza campos internos da organização',
    !('cnpj' in (marca ?? {})) && !('asaas_wallet_id' in (marca ?? {})) && !('fee_bps' in (marca ?? {})),
    'sem cnpj, carteira ou taxa');

  console.log('\n4) Quem não é dono não mexe na marca');
  const intruso = await api('PATCH', `/admin/organizations/${org.id}/branding`, {
    token: cliente, body: { brand_color: '#000000' },
  });
  check('cliente é bloqueado', intruso.status === 403, `HTTP ${intruso.status}`);

  const logoAlheio = await api('POST', `/admin/organizations/${org.id}/logo`, {
    token: produtora, body: { path: '00000000-0000-0000-0000-000000000000/roubado.png' },
  });
  check('caminho de OUTRA organização é recusado', logoAlheio.status === 400,
    logoAlheio.body?.error?.message?.slice(0, 40));

  console.log('\n5) Acompanhantes na lista');
  const lista = await api('GET', '/lists/promoe2e');
  check('lista pública abre', lista.status === 200, lista.data?.promoter?.name);

  const sozinho = await api('POST', '/lists/promoe2e/signup', {
    body: { name: `Solo ${Date.now().toString(36)}`, email: 'solo@teste.test' },
  });
  check('sem informar, entra 1 pessoa', sozinho.status === 201 && (sozinho.data?.party_size ?? 1) === 1,
    `party_size ${sozinho.data?.party_size}`);

  const comGente = await api('POST', '/lists/promoe2e/signup', {
    body: { name: `Grupo ${Date.now().toString(36)}`, email: 'grupo@teste.test', party_size: 3 },
  });
  check('inscrição com +2 grava 3 pessoas', comGente.status === 201 && comGente.data?.party_size === 3,
    `party_size ${comGente.data?.party_size}`);

  const absurdo = await api('POST', '/lists/promoe2e/signup', {
    body: { name: 'Exagerado', email: 'x@teste.test', party_size: 999 },
  });
  check('grupo absurdo é recusado', absurdo.status === 400, `HTTP ${absurdo.status}`);

  console.log('\n6) O resumo da lista conta PESSOAS, não nomes');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const resumo = await api('GET', `/admin/events/${ev.id}/guests/summary`, { token: produtora });
  check('resumo responde', resumo.status === 200);
  // A prova de que conta gente e não nome: com acompanhantes na lista, o
  // total de PESSOAS tem que ser maior que o total de inscrições. Se contasse
  // nomes, a produtora dimensionaria a porta para menos gente do que aparece.
  const pessoas = resumo.data?.people_expected ?? 0;
  const nomes = resumo.data?.guests ?? 0;
  check('conta PESSOAS, não nomes', pessoas > nomes,
    `${nomes} inscrições valendo ${pessoas} pessoas`);

  // Devolve a marca ao estado neutro para não afetar outras suítes.
  await api('PATCH', `/admin/organizations/${org.id}/branding`, {
    token: produtora, body: { brand_color: null, site_url: null, instagram: null },
  });

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
