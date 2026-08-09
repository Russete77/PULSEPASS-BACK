#!/usr/bin/env node
// Guest list com acompanhantes (+N) e chegada parcial.
//
// O caso real: "João +2" chega em dois momentos — ele e a namorada primeiro, o
// amigo meia hora depois. Antes, o check-in era liga/desliga: o porteiro ou
// cadastrava três linhas na mão ou deixava entrar sem registro, e a contagem
// da casa ficava errada nos dois casos.
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
  console.log(`\n═══ Guest list com acompanhantes · ${API} ═══\n`);
  const porteiro = await login('e2e_porteiro@pulsepass.test');
  const ev = (await api('GET', '/events/festa-e2e')).data;
  const eventId = ev.id;

  console.log('1) Inscrição na lista com acompanhantes');
  const nome = `João Grupo ${Date.now()}`;
  const inscr = await api('POST', '/lists/promoe2e/signup', {
    body: { name: nome, email: `grupo_${Date.now()}@teste.com`, party_size: 3 },
  });
  check('cliente entra na lista como +2', inscr.status === 201 || inscr.status === 200,
    `party_size=${inscr.data?.party_size}`);
  check('grupo registrado com 3 pessoas', inscr.data?.party_size === 3);

  const guests = await api('GET', `/admin/events/${eventId}/guests`, { token: porteiro });
  const g = (guests.data ?? []).find((x) => x.name === nome);
  check('porta enxerga o grupo na lista', !!g, `${g?.name} · ${g?.party_size} pessoa(s)`);

  console.log('\n2) Chegada PARCIAL (2 de 3)');
  const p1 = await api('POST', `/admin/guests/${g.id}/checkin`, { token: porteiro, body: { people: 2 } });
  check('libera 2 pessoas', p1.data?.result === 'ok', p1.data?.message);
  check('conta 2 de 3 dentro', p1.data?.checked_in_count === 2 && p1.data?.remaining === 1,
    `${p1.data?.checked_in_count}/${p1.data?.party_size} · faltam ${p1.data?.remaining}`);
  check('grupo ainda não está completo', p1.data?.complete === false);

  console.log('\n3) O terceiro chega depois');
  const p2 = await api('POST', `/admin/guests/${g.id}/checkin`, { token: porteiro, body: { people: 1 } });
  check('libera o retardatário', p2.data?.result === 'ok', p2.data?.message);
  check('grupo fica completo', p2.data?.complete === true && p2.data?.remaining === 0,
    `${p2.data?.checked_in_count}/${p2.data?.party_size}`);

  console.log('\n4) Penetra não entra no vácuo do grupo');
  const p3 = await api('POST', `/admin/guests/${g.id}/checkin`, { token: porteiro, body: { people: 1 } });
  check('quarta pessoa é recusada', p3.data?.result === 'over_capacity', p3.data?.message);

  console.log('\n5) Convite individual continua funcionando (sem regressão)');
  const solo = `Maria Sozinha ${Date.now()}`;
  await api('POST', '/lists/promoe2e/signup', { body: { name: solo } });
  const guests2 = await api('GET', `/admin/events/${eventId}/guests`, { token: porteiro });
  const gs = (guests2.data ?? []).find((x) => x.name === solo);
  check('convite sem acompanhante nasce com 1', gs?.party_size === 1, `party_size=${gs?.party_size}`);
  const ps = await api('POST', `/admin/guests/${gs.id}/checkin`, { token: porteiro });
  check('check-in simples libera e completa', ps.data?.result === 'ok' && ps.data?.complete === true,
    ps.data?.message);
  const dup = await api('POST', `/admin/guests/${gs.id}/checkin`, { token: porteiro });
  check('segunda tentativa é recusada', dup.data?.result === 'over_capacity', dup.data?.message);

  console.log('\n6) Resumo em PESSOAS (é assim que a casa conta)');
  const sum = await api('GET', `/admin/events/${eventId}/guests/summary`, { token: porteiro });
  check('resumo responde', sum.status === 200, JSON.stringify(sum.data));
  check('conta pessoas esperadas e chegadas',
    sum.data?.people_expected >= sum.data?.people_arrived && sum.data?.people_arrived > 0,
    `${sum.data?.people_arrived} de ${sum.data?.people_expected} chegaram`);
  check('separa grupos completos de parciais',
    typeof sum.data?.groups_complete === 'number' && typeof sum.data?.groups_partial === 'number',
    `completos=${sum.data?.groups_complete} parciais=${sum.data?.groups_partial}`);

  console.log(`\n═══ ${pass} passaram · ${fail} falharam ═══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\n✖ ERRO FATAL:', e.message); process.exit(1); });
