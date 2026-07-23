-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Seed de DEMONSTRAÇÃO completo (substitui o 0002 antigo).
--
-- IMPORTANTE: profiles.id tem FK para auth.users — não dá pra criar
-- usuário fake via SQL. Então:
--   1) Crie sua conta no app (faça login no web :5173 OU admin :5174).
--   2) Troque o e-mail abaixo (v_email) pelo da sua conta.
--   3) Rode este arquivo no SQL Editor.
--
-- Cria: organização + 3 eventos publicados + lotes + cardápio do bar +
-- cupons + promoters com convidados + carteira com saldo + 1 pedido pago
-- com ingressos (QR). Tudo no SEU usuário, então aparece no front (RLS).
-- Idempotente: pode rodar de novo sem duplicar.
-- ═══════════════════════════════════════════════════════════════

do $$
declare
  v_email text := 'TROQUE_PELO_SEU_EMAIL@exemplo.com';  -- << EDITE AQUI
  v_uid   uuid;
  v_org   uuid := '0000d000-0000-0000-0000-0000000000a1';
  e1 uuid := '0000d000-0000-0000-0000-0000000000e1';
  e2 uuid := '0000d000-0000-0000-0000-0000000000e2';
  e3 uuid := '0000d000-0000-0000-0000-0000000000e3';
  t1 uuid := '0000d000-0000-0000-0000-0000000000a1';
  t2 uuid := '0000d000-0000-0000-0000-0000000000a2';
  t3 uuid := '0000d000-0000-0000-0000-0000000000a3';
  t4 uuid := '0000d000-0000-0000-0000-0000000000a4';
  pr1 uuid := '0000d000-0000-0000-0000-0000000000b1';
  pr2 uuid := '0000d000-0000-0000-0000-0000000000b2';
  v_order uuid := '0000d000-0000-0000-0000-0000000000c1';
  v_wallet uuid;
begin
  -- Resolve pelo auth.users (sempre tem e-mail) — funciona independente da ordem.
  select id into v_uid from auth.users where lower(email) = lower(v_email);
  if v_uid is null then
    raise notice '>> Usuário % não encontrado em auth.users. Faça login no app primeiro (ou ajuste v_email).', v_email;
    return;
  end if;

  -- garante o profile e marca como produtora
  insert into public.profiles (id) values (v_uid) on conflict (id) do nothing;
  update public.profiles set role = 'produtora' where id = v_uid;

  -- organização
  insert into public.organizations (id, owner_id, name, slug)
  values (v_org, v_uid, 'Casa Pulse', 'casa-pulse')
  on conflict (id) do update set owner_id = excluded.owner_id;

  -- eventos (publicados)
  insert into public.events (id, organization_id, title, slug, description, venue_name, address, city, state, starts_at, status)
  values
   (e1, v_org, 'Pulse Night · Open Air', 'pulse-night-open-air',
    'A maior open air da cidade. Line-up surpresa, estrutura cashless e zero fila no bar.',
    'Marina Club', 'Av. das Nações, 1000', 'São Paulo', 'SP', now() + interval '14 days', 'published'),
   (e2, v_org, 'Sunset Sessions', 'sunset-sessions',
    'Pôr do sol com house e disco clássico no rooftop.',
    'Rooftop 360', 'R. da Praia, 55', 'Rio de Janeiro', 'RJ', now() + interval '21 days', 'published'),
   (e3, v_org, 'Techno Bunker', 'techno-bunker',
    'Noite techno underground, line-up internacional.',
    'Galpão 7', 'R. Industrial, 700', 'Belo Horizonte', 'MG', now() + interval '30 days', 'published')
  on conflict (id) do nothing;

  -- lotes (com vendas simuladas p/ o dashboard parecer real)
  insert into public.ticket_tiers (id, event_id, name, price_cents, quantity_total, quantity_sold, max_per_order, position, status)
  values
   (t1, e1, '1º Lote · Pista', 6000, 200, 47, 6, 0, 'on_sale'),
   (t2, e1, 'Front Stage',    12000,  80, 12, 4, 1, 'on_sale'),
   (t3, e2, 'Pista',           5000, 150, 30, 6, 0, 'on_sale'),
   (t4, e3, 'Inteira',         8000, 120, 64, 6, 0, 'on_sale')
  on conflict (id) do nothing;

  -- cardápio do bar (evento 1)
  insert into public.menu_items (event_id, name, category, price_cents, position)
  values
   (e1, 'Cerveja Long Neck', 'Bebidas', 1200, 0),
   (e1, 'Gin Tônica',        'Drinks',  2200, 1),
   (e1, 'Caipirinha',        'Drinks',  1800, 2),
   (e1, 'Água',              'Bebidas',  600, 3),
   (e1, 'Energético',        'Bebidas', 1500, 4),
   (e1, 'Combo Gin (2)',     'Combos',  4000, 5)
  on conflict do nothing;

  -- cupons (evento 1)
  insert into public.coupons (event_id, code, kind, value, max_uses, active)
  values
   (e1, 'PULSE10', 'percent', 10, 100, true),
   (e1, 'VIP50',   'fixed',  5000,  20, true)
  on conflict (event_id, code) do nothing;

  -- promoters (evento 1) + convidados
  insert into public.promoters (id, organization_id, event_id, name, code, commission_cents)
  values
   (pr1, v_org, e1, 'Bruna (Lista VIP)', 'bruna-vip',  1000),
   (pr2, v_org, e1, 'Caio Promoter',     'caio-promo',  800)
  on conflict (id) do nothing;

  insert into public.guests (promoter_id, event_id, name, email, phone, status)
  values
   (pr1, e1, 'Marina Souza',  'marina@exemplo.com', '11999990001', 'checked_in'),
   (pr1, e1, 'Pedro Lima',    'pedro@exemplo.com',  '11999990002', 'confirmed'),
   (pr1, e1, 'Júlia Alves',   'julia@exemplo.com',  '11999990003', 'confirmed'),
   (pr2, e1, 'Rafael Dias',   'rafael@exemplo.com', '11999990004', 'checked_in'),
   (pr2, e1, 'Beatriz Rocha', 'bia@exemplo.com',    '11999990005', 'confirmed')
  on conflict do nothing;

  -- carteira cashless do usuário (evento 1) + extrato
  insert into public.wallets (profile_id, event_id, balance_cents)
  values (v_uid, e1, 8000)
  on conflict (profile_id, event_id) do update set balance_cents = excluded.balance_cents
  returning id into v_wallet;

  if not exists (select 1 from public.wallet_transactions wt where wt.wallet_id = v_wallet) then
    insert into public.wallet_transactions (wallet_id, type, amount_cents, description)
    values
     (v_wallet, 'topup',  10000, 'Recarga via Pix'),
     (v_wallet, 'spend',  -1200, 'Cerveja Long Neck'),
     (v_wallet, 'spend',   -800, 'Ajuste');
  end if;

  -- pedido PAGO + ingressos (só cria uma vez)
  if not exists (select 1 from public.orders o where o.id = v_order) then
    insert into public.orders (id, buyer_id, event_id, status, total_cents, paid_at)
    values (v_order, v_uid, e1, 'paid', 12000, now());

    insert into public.order_items (order_id, ticket_tier_id, unit_price_cents, quantity)
    values (v_order, t1, 6000, 2);

    insert into public.tickets (order_id, event_id, ticket_tier_id, owner_id, code, status)
    values
     (v_order, e1, t1, v_uid, public.gen_ticket_code(), 'valid'),
     (v_order, e1, t1, v_uid, public.gen_ticket_code(), 'valid');
  end if;

  raise notice '>> Seed aplicado para % (uid %). Eventos, bar, cupons, promoters, carteira e 2 ingressos criados.', v_email, v_uid;
end $$;
