#!/usr/bin/env node
// Promove um usuário a promoter de um evento, com inscritos + presenças reais,
// para o Portal do Promoter mostrar dados. Idempotente para (profile, evento).
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const USER_ID = process.argv[2] || '41411303-c2d9-4d16-ad3f-3d60b69d0e13'; // erickrussomat@gmail.com
const SLUG = process.argv[3] || 'festa-e2e';

const NAMES = ['Marina Alves', 'João Pedro', 'Camila Souza', 'Rafael Lima', 'Beatriz Nunes', 'Lucas Martins',
  'Aline Costa', 'Diego Rocha', 'Fernanda Dias', 'Gustavo Reis', 'Patrícia Melo', 'Thiago Barros'];

async function main() {
  const { data: ev } = await db.from('events').select('id, organization_id, title').eq('slug', SLUG).maybeSingle();
  if (!ev) { console.error('evento não encontrado:', SLUG); process.exit(1); }

  // limpa promoter anterior desse usuário nesse evento (+ guests)
  const { data: old } = await db.from('promoters').select('id').eq('profile_id', USER_ID).eq('event_id', ev.id);
  for (const p of old || []) { await db.from('guests').delete().eq('promoter_id', p.id); }
  if (old?.length) await db.from('promoters').delete().eq('profile_id', USER_ID).eq('event_id', ev.id);

  // cria o promoter vinculado à conta (habilita o portal)
  const promoterRow = {
    organization_id: ev.organization_id, event_id: ev.id, profile_id: USER_ID,
    name: 'Erick', code: 'erickvip', commission_cents: 1000, goal_checkins: 20,
    list_type: 'vip', clicks: 47,
  };
  let { data: promoter, error } = await db.from('promoters').insert(promoterRow).select('id').single();
  if (error) { // fallback se coluna clicks/list_type ausente
    delete promoterRow.clicks; delete promoterRow.list_type;
    ({ data: promoter, error } = await db.from('promoters').insert(promoterRow).select('id').single());
    if (error) { console.error('falhou promoter:', error.message); process.exit(1); }
    await db.from('promoters').update({ clicks: 47 }).eq('id', promoter.id).then(() => {}, () => {});
  }

  // 12 inscritos: 8 presentes (checked_in) + 4 só inscritos (confirmed)
  const guests = NAMES.map((name, i) => ({
    promoter_id: promoter.id, event_id: ev.id, name,
    status: i < 8 ? 'checked_in' : 'confirmed',
  }));
  const { error: gErr } = await db.from('guests').insert(guests);
  if (gErr) { console.error('falhou guests:', gErr.message); process.exit(1); }

  console.log('✓ Você agora é PROMOTER de', ev.title);
  console.log('  code: erickvip · link: /lista/erickvip');
  console.log('  47 cliques · 12 inscritos · 8 presentes · comissão devida R$ 80,00 · meta 8/20');
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
