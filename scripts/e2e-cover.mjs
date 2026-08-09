#!/usr/bin/env node
// Capa do evento: envio direto ao Storage com URL assinada.
//
// A auditoria de design fechou com o achado que nenhuma folha de estilo
// resolve: o hero é um gradiente genérico. As referências do setor convergem
// em que a IMAGEM é a peça principal — evento sem foto é evento sem desejo.
//
// O que este teste guarda: quem não é da produtora não sobe capa, e ninguém
// grava no evento uma imagem que subiu para o caminho de outro.
import 'dotenv/config';
import { supabase as db } from '../src/config/supabase.js';

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

/** PNG 1×1 válido — o Storage recusa arquivo que não bate com o tipo. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  console.log(`\n═══ Capa do evento · ${API} ═══\n`);
  const produtora = await login('e2e_produtora@pulsepass.test');
  const cliente = await login('e2e_cliente@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const eventId = ev.id;

  console.log('1) A produtora pede autorização para enviar');
  const autoriza = await api('POST', `/admin/events/${eventId}/cover-upload`, {
    token: produtora, body: { content_type: 'image/png' },
  });
  check('backend assina o envio', autoriza.status === 200 && !!autoriza.data?.signed_url,
    autoriza.data?.path);
  check('caminho é do próprio evento', autoriza.data?.path?.startsWith(`${eventId}/`));

  console.log('\n2) Formato não aceito é recusado antes de assinar');
  const gif = await api('POST', `/admin/events/${eventId}/cover-upload`, {
    token: produtora, body: { content_type: 'image/gif' },
  });
  check('GIF recusado', gif.status === 400, gif.body?.error?.message?.slice(0, 50));

  console.log('\n3) Quem não é da produtora não envia');
  const golpe = await api('POST', `/admin/events/${eventId}/cover-upload`, {
    token: cliente, body: { content_type: 'image/png' },
  });
  check('cliente é bloqueado', golpe.status === 403, `HTTP ${golpe.status}`);

  console.log('\n4) Envio direto ao Storage com a URL assinada');
  const envio = await fetch(autoriza.data.signed_url, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: PNG_1X1,
  });
  check('arquivo aceito pelo Storage', envio.ok, `HTTP ${envio.status}`);

  console.log('\n5) Confirmação grava a capa no evento');
  const confirma = await api('POST', `/admin/events/${eventId}/cover`, {
    token: produtora, body: { path: autoriza.data.path },
  });
  check('cover_url gravada', confirma.status === 200 && !!confirma.data?.cover_url,
    confirma.data?.cover_url?.slice(-42));

  console.log('\n6) A capa aparece na vitrine PÚBLICA');
  // A vitrine tem cache de 30s; o detalhe do evento não tem.
  const publico = await api('GET', '/events/festa-e2e');
  check('detalhe público traz a capa', !!publico.data?.cover_url, publico.data?.cover_url?.slice(-30));

  const img = await fetch(publico.data.cover_url);
  check('imagem abre sem autenticação', img.ok && img.headers.get('content-type')?.includes('image'),
    `HTTP ${img.status} · ${img.headers.get('content-type')}`);

  console.log('\n7) Não dá pra roubar a capa de outro evento');
  const roubo = await api('POST', `/admin/events/${eventId}/cover`, {
    token: produtora, body: { path: '00000000-0000-0000-0000-000000000000/roubada.png' },
  });
  check('caminho de outro evento é recusado', roubo.status === 400,
    roubo.body?.error?.message?.slice(0, 46));

  console.log('\n8) Remover volta ao fundo padrão');
  const remove = await api('DELETE', `/admin/events/${eventId}/cover`, { token: produtora });
  check('capa removida', remove.status === 200 && !remove.data?.cover_url);

  console.log('\n9) A troca fica na trilha de auditoria');
  const { data: trilha } = await db.from('audit_log')
    .select('action, after').eq('action', 'event.cover_change')
    .order('at', { ascending: false }).limit(1).maybeSingle();
  check('troca de capa auditada', !!trilha?.after?.cover_url);

  console.log('\n10) BLOQUEIO — publicar sem capa');
  // O evento ficou sem capa no passo 8. A tentativa vai DIRETO pela API, que é
  // o caminho de quem contornaria o botão desabilitado na tela: a regra tem que
  // morar no servidor, não no clique.
  const estadoOriginal = (await api('GET', `/admin/events/${eventId}`, { token: produtora })).data?.status;
  await api('PATCH', `/admin/events/${eventId}/status`, { token: produtora, body: { status: 'draft' } });

  const semCapa = await api('PATCH', `/admin/events/${eventId}/status`, {
    token: produtora, body: { status: 'published' },
  });
  check('publicar sem capa é RECUSADO pelo servidor', semCapa.status === 400,
    semCapa.body?.error?.message?.slice(0, 52));

  const rascunho = await api('PATCH', `/admin/events/${eventId}/status`, {
    token: produtora, body: { status: 'draft' },
  });
  check('rascunho continua livre sem capa', rascunho.status === 200);

  // Com capa, publica normalmente — o bloqueio não pode virar prisão.
  const nova = await api('POST', `/admin/events/${eventId}/cover-upload`, {
    token: produtora, body: { content_type: 'image/png' },
  });
  await fetch(nova.data.signed_url, {
    method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG_1X1,
  });
  await api('POST', `/admin/events/${eventId}/cover`, { token: produtora, body: { path: nova.data.path } });

  const comCapa = await api('PATCH', `/admin/events/${eventId}/status`, {
    token: produtora, body: { status: 'published' },
  });
  check('com capa, publica normalmente', comCapa.status === 200, `status=${comCapa.data?.status}`);

  // Devolve o evento ao estado em que estava, pra não afetar os outros testes.
  if (estadoOriginal && estadoOriginal !== 'published') {
    await api('PATCH', `/admin/events/${eventId}/status`, { token: produtora, body: { status: estadoOriginal } });
  }

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
