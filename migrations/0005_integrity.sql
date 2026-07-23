-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0005 — Integridade transacional & hardening
-- Resolve: oversell, débito sem pedido, recarga com corrida,
-- lookup de e-mail, agregação em memória, RLS de promoters.
-- Aplicar após 0001..0004.
-- ═══════════════════════════════════════════════════════════════

-- ── profiles.email (para lookup sem listUsers paginado) ──
alter table public.profiles add column if not exists email text;
create unique index if not exists idx_profiles_email on public.profiles (lower(email));

create or replace function public.handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$ language plpgsql security definer;

update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id and p.email is null;

-- ── gerador de código de ingresso ──
create or replace function public.gen_ticket_code() returns text as $$
declare a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; r text := 'PP-'; i int;
begin
  for i in 1..4 loop r := r || substr(a, 1 + floor(random()*length(a))::int, 1); end loop;
  r := r || '-';
  for i in 1..4 loop r := r || substr(a, 1 + floor(random()*length(a))::int, 1); end loop;
  return r;
end;
$$ language plpgsql;

-- ─────────────────────────────────────────────────────────────────
-- place_order — reserva estoque ATOMICAMENTE e cria pedido pending.
-- Tudo numa transação: sem oversell, sem pedido órfão.
-- p_items: [{ "ticket_tier_id": uuid, "quantity": int }]
-- ─────────────────────────────────────────────────────────────────
create or replace function public.place_order(p_buyer uuid, p_event uuid, p_items jsonb)
returns table(order_id uuid, total_cents int) as $$
declare it jsonb; v_tier public.ticket_tiers; v_qty int; v_total int := 0; v_order uuid;
begin
  perform 1 from public.events where id = p_event and status = 'published';
  if not found then raise exception 'EVENT_UNAVAILABLE'; end if;

  insert into public.orders (buyer_id, event_id, status, total_cents, expires_at)
  values (p_buyer, p_event, 'pending', 0, now() + interval '30 minutes')
  returning id into v_order;

  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'quantity')::int;
    if v_qty is null or v_qty < 1 then raise exception 'INVALID_QTY'; end if;

    select * into v_tier from public.ticket_tiers
      where id = (it->>'ticket_tier_id')::uuid and event_id = p_event
      for update;
    if not found then raise exception 'TIER_INVALID'; end if;
    if v_tier.status <> 'on_sale' then raise exception 'TIER_NOT_ON_SALE:%', v_tier.name; end if;
    if v_qty > v_tier.max_per_order then raise exception 'OVER_MAX:%', v_tier.name; end if;
    if v_tier.quantity_sold + v_qty > v_tier.quantity_total then raise exception 'SOLD_OUT:%', v_tier.name; end if;

    update public.ticket_tiers
       set quantity_sold = quantity_sold + v_qty,
           status = case when quantity_sold + v_qty >= quantity_total then 'sold_out'::tier_status else status end
     where id = v_tier.id;

    insert into public.order_items (order_id, ticket_tier_id, unit_price_cents, quantity)
    values (v_order, v_tier.id, v_tier.price_cents, v_qty);

    v_total := v_total + v_tier.price_cents * v_qty;
  end loop;

  update public.orders set total_cents = v_total where id = v_order;
  return query select v_order, v_total;
end;
$$ language plpgsql security definer;

-- ── atualiza dados do Pix no pedido (após criar cobrança no Asaas) ──
create or replace function public.attach_order_payment(
  p_order uuid, p_customer text, p_payment text, p_ref text,
  p_payload text, p_qr text, p_expiration timestamptz
) returns void as $$
begin
  update public.orders
     set asaas_customer_id = p_customer, asaas_payment_id = p_payment,
         external_reference = p_ref, pix_payload = p_payload,
         pix_qr_base64 = p_qr, pix_expiration = p_expiration, expires_at = p_expiration
   where id = p_order;
end;
$$ language plpgsql security definer;

-- ─────────────────────────────────────────────────────────────────
-- confirm_order_payment — emite ingressos (idempotente, transacional).
-- Estoque já foi reservado no place_order; aqui só emite.
-- ─────────────────────────────────────────────────────────────────
create or replace function public.confirm_order_payment(p_payment_id text)
returns jsonb as $$
declare v_order public.orders; v_item public.order_items; n int; v_count int := 0;
begin
  select * into v_order from public.orders where asaas_payment_id = p_payment_id for update;
  if not found then return jsonb_build_object('found', false); end if;
  if v_order.status = 'paid' then
    return jsonb_build_object('found', true, 'alreadyProcessed', true, 'orderId', v_order.id);
  end if;

  update public.orders set status = 'paid', paid_at = now() where id = v_order.id;

  for v_item in select * from public.order_items where order_id = v_order.id loop
    for n in 1..v_item.quantity loop
      insert into public.tickets (order_id, event_id, ticket_tier_id, owner_id, code, status)
      values (v_order.id, v_order.event_id, v_item.ticket_tier_id, v_order.buyer_id, public.gen_ticket_code(), 'valid');
      v_count := v_count + 1;
    end loop;
  end loop;

  return jsonb_build_object('found', true, 'alreadyProcessed', false, 'orderId', v_order.id, 'emitted', v_count);
end;
$$ language plpgsql security definer;

-- ── expira pedidos pending e DEVOLVE o estoque reservado ──
create or replace function public.expire_pending_orders()
returns int as $$
declare v_order public.orders; v_item public.order_items; v_n int := 0;
begin
  for v_order in select * from public.orders where status = 'pending' and expires_at < now() for update loop
    update public.orders set status = 'expired' where id = v_order.id;
    for v_item in select * from public.order_items where order_id = v_order.id loop
      update public.ticket_tiers
         set quantity_sold = greatest(0, quantity_sold - v_item.quantity),
             status = case when status = 'sold_out' and (quantity_sold - v_item.quantity) < quantity_total
                           then 'on_sale'::tier_status else status end
       where id = v_item.ticket_tier_id;
    end loop;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$ language plpgsql security definer;

-- ─────────────────────────────────────────────────────────────────
-- place_bar_order — débito de saldo + pedido no bar (transacional).
-- Sem risco de debitar sem pedido. p_buyer pode ser cliente (PDV).
-- ─────────────────────────────────────────────────────────────────
create or replace function public.place_bar_order(p_buyer uuid, p_event uuid, p_items jsonb)
returns jsonb as $$
declare it jsonb; v_item public.menu_items; v_qty int; v_total int := 0;
        v_wallet uuid; v_balance int; v_order uuid; v_pickup text; v_items jsonb := '[]'::jsonb;
begin
  perform 1 from public.events where id = p_event and status = 'published';
  if not found then raise exception 'EVENT_UNAVAILABLE'; end if;

  select id into v_wallet from public.wallets where profile_id = p_buyer and event_id = p_event;
  if v_wallet is null then
    insert into public.wallets (profile_id, event_id, balance_cents)
    values (p_buyer, p_event, 0) returning id into v_wallet;
  end if;

  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'quantity')::int;
    if v_qty is null or v_qty < 1 then raise exception 'INVALID_QTY'; end if;
    select * into v_item from public.menu_items where id = (it->>'menu_item_id')::uuid and event_id = p_event;
    if not found then raise exception 'ITEM_INVALID'; end if;
    if not v_item.available then raise exception 'ITEM_UNAVAILABLE:%', v_item.name; end if;
    v_total := v_total + v_item.price_cents * v_qty;
    v_items := v_items || jsonb_build_object(
      'menu_item_id', v_item.id, 'name', v_item.name,
      'unit_price_cents', v_item.price_cents, 'quantity', v_qty);
  end loop;

  -- débito atômico
  update public.wallets set balance_cents = balance_cents - v_total, updated_at = now()
   where id = v_wallet and balance_cents >= v_total
   returning balance_cents into v_balance;
  if not found then raise exception 'INSUFFICIENT_FUNDS'; end if;

  v_pickup := 'B' || (1000 + floor(random()*9000)::int)::text;
  insert into public.bar_orders (buyer_id, event_id, wallet_id, status, total_cents, pickup_code)
  values (p_buyer, p_event, v_wallet, 'paid', v_total, v_pickup) returning id into v_order;

  insert into public.bar_order_items (bar_order_id, menu_item_id, name, unit_price_cents, quantity)
  select v_order, (e->>'menu_item_id')::uuid, e->>'name', (e->>'unit_price_cents')::int, (e->>'quantity')::int
    from jsonb_array_elements(v_items) e;

  insert into public.wallet_transactions (wallet_id, type, amount_cents, description)
  values (v_wallet, 'spend', -v_total, 'Pedido no bar · ' || v_pickup);

  return jsonb_build_object('order_id', v_order, 'pickup_code', v_pickup,
    'total_cents', v_total, 'balance_cents', v_balance, 'items', v_items);
end;
$$ language plpgsql security definer;

-- ─────────────────────────────────────────────────────────────────
-- credit_topup — credita recarga (idempotente, atômico).
-- ─────────────────────────────────────────────────────────────────
create or replace function public.credit_topup(p_payment_id text)
returns jsonb as $$
declare v_top public.wallet_topups; v_wallet uuid; v_balance int;
begin
  select * into v_top from public.wallet_topups where asaas_payment_id = p_payment_id for update;
  if not found then return jsonb_build_object('found', false); end if;
  if v_top.status = 'paid' then return jsonb_build_object('found', true, 'alreadyProcessed', true); end if;

  select id into v_wallet from public.wallets
   where profile_id = v_top.profile_id and event_id is not distinct from v_top.event_id;
  if v_wallet is null then
    insert into public.wallets (profile_id, event_id, balance_cents)
    values (v_top.profile_id, v_top.event_id, 0) returning id into v_wallet;
  end if;

  update public.wallets set balance_cents = balance_cents + v_top.amount_cents, updated_at = now()
   where id = v_wallet returning balance_cents into v_balance;
  insert into public.wallet_transactions (wallet_id, type, amount_cents, description)
  values (v_wallet, 'topup', v_top.amount_cents, 'Recarga via Pix');
  update public.wallet_topups set status = 'paid', paid_at = now() where id = v_top.id;

  return jsonb_build_object('found', true, 'credited', v_top.amount_cents, 'balance_cents', v_balance);
end;
$$ language plpgsql security definer;

-- ─────────────────────────────────────────────────────────────────
-- Agregações de dashboard em SQL (não em memória no Node)
-- ─────────────────────────────────────────────────────────────────
create or replace function public.event_dashboard(p_event uuid)
returns jsonb as $$
declare v_sold int; v_checked int; v_trev int; v_brev int; v_orders int;
begin
  select count(*) into v_sold from public.tickets where event_id = p_event;
  select count(*) into v_checked from public.tickets where event_id = p_event and status = 'used';
  select coalesce(sum(total_cents),0), count(*) into v_trev, v_orders
    from public.orders where event_id = p_event and status = 'paid';
  select coalesce(sum(total_cents),0) into v_brev
    from public.bar_orders where event_id = p_event and status = 'paid';
  return jsonb_build_object(
    'tickets_sold', v_sold, 'checked_in', v_checked,
    'ticket_revenue_cents', v_trev, 'bar_revenue_cents', v_brev,
    'total_revenue_cents', v_trev + v_brev, 'orders_paid', v_orders);
end;
$$ language plpgsql security definer;

create or replace function public.event_promoters(p_event uuid)
returns table(id uuid, name text, code text, commission_cents int,
              confirmed bigint, checked_in bigint, commission_due_cents bigint) as $$
  select p.id, p.name, p.code, p.commission_cents,
         count(g.id) as confirmed,
         count(g.id) filter (where g.status = 'checked_in') as checked_in,
         count(g.id) filter (where g.status = 'checked_in') * p.commission_cents as commission_due_cents
    from public.promoters p
    left join public.guests g on g.promoter_id = p.id
   where p.event_id = p_event
   group by p.id
   order by p.created_at;
$$ language sql security definer;

-- ── RLS: remove leitura pública dos promoters (vaza comissão/org) ──
drop policy if exists "promoters_public_read" on public.promoters;
-- Acesso a promoters passa a ser exclusivamente via backend (service_role).

-- ═══════════════════════════════════════════════════════════════
