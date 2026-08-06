#!/usr/bin/env node
// Subconta Asaas criada pelo cockpit.
//
// O teste que mais importa aqui é o de SEGREDO: a apiKey devolvida pelo Asaas
// dá acesso total à conta da produtora — movimentar dinheiro, sacar, emitir
// cobrança. Ela não pode aparecer em resposta de API nem em texto claro no
// banco. Se aparecer, um vazamento nosso vira acesso à conta bancária de todos
// os clientes.
import 'dotenv/config';
import { supabase as db } from '../src/config/supabase.js';
import { open as unseal } from '../src/lib/secretBox.js';

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
  const r = await fetch(API + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const texto = await r.text();
  let j = null; try { j = JSON.parse(texto); } catch { /* sem corpo */ }
  return { status: r.status, raw: texto, body: j, data: j?.data };
};

const CADASTRO = {
  name: 'Produtora Subconta Teste',
  email: `subconta_${Date.now()}@pulsepass.test`,
  cpfCnpj: '12345678000199',
  mobilePhone: '11999998888',
  incomeValue: 30000,
  address: 'Rua das Festas',
  addressNumber: '100',
  province: 'Centro',
  postalCode: '01001000',
  companyType: 'LIMITED',
};

async function main() {
  console.log(`\n═══ Subconta Asaas · ${API} ═══\n`);
  const produtora = await login('e2e_produtora@pulsepass.test');
  const cliente = await login('e2e_cliente@pulsepass.test');
  const me = await api('GET', '/admin/me', { token: produtora });
  const orgId = me.data.organizations[0].id;

  // Estado limpo: o teste cria a conta do zero.
  await db.from('organizations').update({
    asaas_account_id: null, asaas_wallet_id: null, asaas_account_status: null,
    asaas_onboarding_url: null, asaas_api_key_enc: null,
  }).eq('id', orgId);

  console.log('1) Antes: sem carteira, o repasse não é automático');
  const antes = await api('GET', `/admin/organizations/${orgId}/repasse`, { token: produtora });
  check('transparência avisa que falta carteira', antes.data?.repasse_automatico === false
    && antes.data?.avisos?.length > 0, antes.data?.avisos?.[0]?.slice(0, 58));
  check('ainda não há subconta', antes.data?.subconta === null);

  console.log('\n2) Criação da subconta pelo cockpit');
  const criada = await api('POST', `/admin/organizations/${orgId}/asaas-subaccount`, {
    token: produtora, body: CADASTRO,
  });
  check('subconta criada', criada.status === 201, `conta ${criada.data?.account_id}`);
  check('walletId volta pronto para o split', !!criada.data?.wallet_id, criada.data?.wallet_id);
  check('status da conta informado', !!criada.data?.status, criada.data?.status);

  console.log('\n3) A apiKey NUNCA aparece');
  check('resposta da API não contém apiKey',
    !/apiKey|api_key|aact_/i.test(criada.raw),
    'nenhuma ocorrência no corpo');
  const transp = await api('GET', `/admin/organizations/${orgId}/repasse`, { token: produtora });
  check('transparência também não vaza a apiKey', !/apiKey|api_key|aact_/i.test(transp.raw));

  const { data: orgRow } = await db.from('organizations')
    .select('asaas_api_key_enc, asaas_wallet_id, asaas_account_id').eq('id', orgId).single();
  check('no banco a apiKey está CIFRADA', !!orgRow.asaas_api_key_enc
    && orgRow.asaas_api_key_enc.startsWith('v1:')
    && !/aact_/i.test(orgRow.asaas_api_key_enc),
    orgRow.asaas_api_key_enc.slice(0, 22) + '…');
  check('e continua legível com a chave certa', unseal(orgRow.asaas_api_key_enc).length > 5,
    'decifrada apenas com SECRET_BOX_KEY');

  console.log('\n4) A carteira passa a valer para o split');
  const depois = await api('GET', `/admin/organizations/${orgId}/repasse`, { token: produtora });
  check('repasse vira automático', depois.data?.repasse_automatico === true);
  check('sem mais aviso de carteira faltando', depois.data?.avisos?.length === 0);
  check('subconta aparece na transparência', depois.data?.subconta?.account_id === criada.data.account_id,
    `status=${depois.data?.subconta?.status}`);

  console.log('\n5) Não recria conta em cima de conta existente');
  const dupe = await api('POST', `/admin/organizations/${orgId}/asaas-subaccount`, {
    token: produtora, body: CADASTRO,
  });
  check('segunda criação é recusada', dupe.status === 409, dupe.body?.error?.message?.slice(0, 62));

  console.log('\n6) Só o dono da organização cria');
  const golpe = await api('POST', `/admin/organizations/${orgId}/asaas-subaccount`, {
    token: cliente, body: CADASTRO,
  });
  check('terceiro é bloqueado', golpe.status === 403, `HTTP ${golpe.status}`);

  console.log('\n7) Cadastro incompleto é recusado antes de chamar o provedor');
  await db.from('organizations').update({ asaas_account_id: null }).eq('id', orgId);
  const incompleto = await api('POST', `/admin/organizations/${orgId}/asaas-subaccount`, {
    token: produtora, body: { name: 'X', email: 'nao-e-email' },
  });
  check('validação barra payload incompleto', incompleto.status === 400, `HTTP ${incompleto.status}`);

  console.log('\n8) Criação fica na trilha de auditoria');
  const { data: trilha } = await db.from('audit_log')
    .select('action, after').eq('action', 'organization.asaas_subaccount_created')
    .order('at', { ascending: false }).limit(1).maybeSingle();
  check('conta bancária nova auditada', trilha?.after?.wallet_id === criada.data.wallet_id,
    `wallet ${trilha?.after?.wallet_id}`);
  check('trilha também não guarda a apiKey', !/aact_|apiKey/i.test(JSON.stringify(trilha ?? {})));

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
