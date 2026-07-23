-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0015 — FASE 0: hardening de segurança & dinheiro
-- Resolve os achados críticos da Auditoria v3 (_PLANO_90/00_AUDITORIA_v3.md):
--   F0.1 auto-escalação de role      F0.2 vazamento de cupons
--   F0.3 idempotência do bar         F0.4 cupom em carrinho abandonado
--   F0.5 refund_order sem guarda     F0.6 spend_wallet sem ledger
--   F0.7 idempotência pedido/recarga F0.8 índices críticos
-- Aplicar após 0001..0014.
-- Redefine funções com search_path fixado (preserva hardening da 0007).
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- F0.1 — Impede o usuário de alterar o próprio profiles.role
-- (auto-escalação a 'adm'/'produtora'). O WITH CHECK compara o valor
-- NOVO com o valor JÁ GRAVADO; service_role continua livre (bypassa RLS).
-- ─────────────────────────────────────────────────────────────────
drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update" on public.profiles
  for update using (auth.uid() = id)
  with check (
    auth.uid() = id
    and role = (select p.role from public.profiles p where p.id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────
-- F0.2 — Remove leitura pública de cupons (vazava código+valor a anônimos).
-- Validação passa a ser exclusivamente server-side via redeem_coupon.
-- ─────────────────────────────────────────────────────────────────
drop policy if exists "coupons_public_read" on public.coupons;

-- Restringe a faixa de percentual (comentário dizia 1..100, sem constraint).
alter table public.coupons drop constraint if exists chk_coupon_value;
alter table public.coupons add constraint chk_coupon_value check (
  value > 0 and (kind <> 'percent' or value <= 100)
);

-- ─────────────────────────────────────────────────────────────────
-- F0.3 / F0.7 — Chaves de idempotência para writes do cliente.
-- Uma mesma Idempotency-Key nunca gera dois pedidos/duas cobranças.
-- ─────────────────────────────────────────────────────────────────
alter table public.orders        add column if not exists client_request_id text;
alter table public.wallet_topups add column if not exists client_request_id text;
alter table public.bar_orders    add column if not exists client_request_id text;

create unique index if not exists idx_orders_idem  on public.orders(client_request_id)        where client_request_id is not null;
create unique index if not exists idx_topups_idem  on public.wallet_topups(client_request_id)  where client_request_id is not null;
create unique index if not exists idx_bar_idem     on public.bar_orders(client_request_id)      where client_request_id is not null;

-- ─────────────────────────────────────────────────────────────────
-- F0.8 — Índices críticos.
--   Partial index mata o full-scan do cron expire (a cada 2 min).
--   FKs sem índice: parent-delete e agregações de dashboard.
-- ─────────────────────────────────────────────────────────────────
create index if not exists idx_orders_pending_expiry on public.orders(expires_at) where status = 'pending';
create index if not exists idx_orders_event          on public.orders(event_id);
create index if not exists idx_tickets_order         on public.tickets(order_id);
create index if not exists idx_tickets_tier          on public.tickets(ticket_tier_id);
create index if not exists idx_bar_items_menu        on public.bar_order_items(menu_item_id);
-- lookup case-insensitive de cupom por (evento, código)
create index if not exists idx_coupons_event_code    on public.coupons(event_id, lower(code));

-- ─────────────────────────────────────────────────────────────────
-- F0.7 — place_order com idempotência.
-- Se a Idempotency-Key já existe, devolve o pedido criado antes
-- (is_replay=true) e o backend NÃO cria nova cobrança no Asaas.
-- (drop da assinatura antiga: muda o tipo de retorno e ganha 1 parâmetro)
-- ─────────────────────────────────────────────────────────────────
drop function if exists public.place_order(uuid, uuid, jsonb);
create or replace function public.place_order(
  p_buyer uuid, p_event uuid, p_items jsonb, p_idempotency_key text default null
)
returns table(order_id uuid, total_cents int, is_replay boolean) as $$
declare it jsonb; v_tier public.ticket_tiers; v_qty int; v_total int := 0; v_order uuid; v_existing public.orders;
begin
  -- replay idempotente
  if p_idempotency_key is not null then
    select * into v_existing from public.orders where client_request_id = p_idempotency_key;
    if found then
      return query select v_existing.id, v_existing.total_cents, true;
      return;
    end if;
  end if;

  perform 1 from public.events where id = p_event and status = 'published';
  if not found then raise exception 'EVENT_UNAVAILABLE'; end if;

  insert into public.orders (buyer_id, event_id, status, total_cents, expires_at, client_request_id)
  values (p_buyer, p_event, 'pending', 0, now() + interval '30 minutes', p_idempotency_key)
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
  return query select v_order, v_total, false;
exception
  -- corrida com mesma chave: o índice único barra o 2º insert → devolve o existente
  when unique_violation then
    select * into v_existing from public.orders where client_request_id = p_idempotency_key;
    return query select v_existing.id, v_existing.total_cents, true;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.place_order(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant  execute on function public.place_order(uuid, uuid, jsonb, text) to service_role;

-- ─────────────────────────────────────────────────────────────────
-- F0.3 — place_bar_order com idempotência (mata cobrança em dobro no
-- retry do PDV/app). Replay devolve o pedido já criado, sem novo débito.
-- (drop da assinatura antiga: ganha 1 parâmetro p_idempotency_key)
-- ─────────────────────────────────────────────────────────────────
drop function if exists public.place_bar_order(uuid, uuid, jsonb);
create or replace function public.place_bar_order(
  p_buyer uuid, p_event uuid, p_items jsonb, p_idempotency_key text default null
)
returns jsonb as $$
declare it jsonb; v_item public.menu_items; v_qty int; v_total int := 0;
        v_wallet uuid; v_balance int; v_order uuid; v_pickup text; v_items jsonb := '[]'::jsonb;
        v_existing public.bar_orders;
begin
  -- replay idempotente
  if p_idempotency_key is not null then
    select * into v_existing from public.bar_orders where client_request_id = p_idempotency_key;
    if found then
      return jsonb_build_object('order_id', v_existing.id, 'pickup_code', v_existing.pickup_code,
        'total_cents', v_existing.total_cents,
        'balance_cents', (select balance_cents from public.wallets where id = v_existing.wallet_id),
        'items', '[]'::jsonb, 'idempotent_replay', true);
    end if;
  end if;

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
  insert into public.bar_orders (buyer_id, event_id, wallet_id, status, total_cents, pickup_code, client_request_id)
  values (p_buyer, p_event, v_wallet, 'paid', v_total, v_pickup, p_idempotency_key) returning id into v_order;

  insert into public.bar_order_items (bar_order_id, menu_item_id, name, unit_price_cents, quantity)
  select v_order, (e->>'menu_item_id')::uuid, e->>'name', (e->>'unit_price_cents')::int, (e->>'quantity')::int
    from jsonb_array_elements(v_items) e;

  insert into public.wallet_transactions (wallet_id, type, amount_cents, description)
  values (v_wallet, 'spend', -v_total, 'Pedido no bar · ' || v_pickup);

  return jsonb_build_object('order_id', v_order, 'pickup_code', v_pickup,
    'total_cents', v_total, 'balance_cents', v_balance, 'items', v_items);
exception
  -- corrida com mesma chave: devolve o pedido já criado (sem novo débito)
  when unique_violation then
    select * into v_existing from public.bar_orders where client_request_id = p_idempotency_key;
    return jsonb_build_object('order_id', v_existing.id, 'pickup_code', v_existing.pickup_code,
      'total_cents', v_existing.total_cents,
      'balance_cents', (select balance_cents from public.wallets where id = v_existing.wallet_id),
      'items', '[]'::jsonb, 'idempotent_replay', true);
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.place_bar_order(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant  execute on function public.place_bar_order(uuid, uuid, jsonb, text) to service_role;

-- ─────────────────────────────────────────────────────────────────
-- F0.4 — expire_pending_orders devolve o USO do cupom em carrinho
-- abandonado (além de devolver o estoque).
-- ─────────────────────────────────────────────────────────────────
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
    -- devolve o uso do cupom (F0.4)
    if v_order.coupon_code is not null then
      update public.coupons set used_count = greatest(0, used_count - 1)
       where event_id = v_order.event_id and lower(code) = lower(v_order.coupon_code);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.expire_pending_orders() from public, anon, authenticated;
grant  execute on function public.expire_pending_orders() to service_role;

-- ─────────────────────────────────────────────────────────────────
-- F0.5 — refund_order só devolve estoque se o pedido estava PAGO
-- (evita corromper quantity_sold ao reembolsar pedido expirado/cancelado).
-- F0.4 — também devolve o uso do cupom no reembolso.
-- ─────────────────────────────────────────────────────────────────
create or replace function public.refund_order(p_order uuid)
returns jsonb as $$
declare v_order public.orders; v_item public.order_items; v_n int := 0;
begin
  select * into v_order from public.orders where id = p_order for update;
  if not found then return jsonb_build_object('found', false); end if;
  if v_order.status = 'refunded' then
    return jsonb_build_object('found', true, 'alreadyRefunded', true);
  end if;
  -- guarda de estado: só reembolsa pedido pago
  if v_order.status <> 'paid' then
    return jsonb_build_object('found', true, 'refunded', false, 'reason', 'NOT_PAID', 'status', v_order.status);
  end if;

  -- invalida ingressos e devolve estoque
  for v_item in select * from public.order_items where order_id = p_order loop
    update public.ticket_tiers
       set quantity_sold = greatest(0, quantity_sold - v_item.quantity),
           status = case when status = 'sold_out' then 'on_sale'::tier_status else status end
     where id = v_item.ticket_tier_id;
  end loop;

  update public.tickets set status = 'cancelled'
   where order_id = p_order and status in ('valid', 'used');

  select count(*) into v_n from public.tickets where order_id = p_order;
  update public.orders set status = 'refunded' where id = p_order;

  -- devolve o uso do cupom
  if v_order.coupon_code is not null then
    update public.coupons set used_count = greatest(0, used_count - 1)
     where event_id = v_order.event_id and lower(code) = lower(v_order.coupon_code);
  end if;

  return jsonb_build_object('found', true, 'refunded', true, 'tickets', v_n);
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.refund_order(uuid) from public, anon, authenticated;
grant  execute on function public.refund_order(uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────
-- F0.6 — spend_wallet registra a transação no ledger (antes debitava
-- sem lançar → deriva de saldo). search_path fixado.
-- (drop da assinatura antiga: ganha 1 parâmetro p_description)
-- ─────────────────────────────────────────────────────────────────
drop function if exists public.spend_wallet(uuid, integer);
create or replace function public.spend_wallet(
  p_wallet uuid, p_amount integer, p_description text default 'Débito de saldo'
)
returns integer as $$
declare new_balance integer;
begin
  update public.wallets
     set balance_cents = balance_cents - p_amount, updated_at = now()
   where id = p_wallet and balance_cents >= p_amount
   returning balance_cents into new_balance;
  if new_balance is null then return null; end if;  -- saldo insuficiente
  insert into public.wallet_transactions (wallet_id, type, amount_cents, description)
  values (p_wallet, 'spend', -p_amount, p_description);
  return new_balance;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.spend_wallet(uuid, integer, text) from public, anon, authenticated;
grant  execute on function public.spend_wallet(uuid, integer, text) to service_role;

-- ─────────────────────────────────────────────────────────────────
-- F0.6 — view de reconciliação do ledger (surface do invariante
-- balance_cents == soma das transações). drift_cents deve ser 0.
-- ─────────────────────────────────────────────────────────────────
create or replace view public.wallet_reconciliation as
  select w.id as wallet_id, w.profile_id, w.event_id, w.balance_cents,
         coalesce(sum(t.amount_cents), 0) as ledger_cents,
         w.balance_cents - coalesce(sum(t.amount_cents), 0) as drift_cents
    from public.wallets w
    left join public.wallet_transactions t on t.wallet_id = w.id
   group by w.id, w.profile_id, w.event_id, w.balance_cents;

-- ═══════════════════════════════════════════════════════════════
