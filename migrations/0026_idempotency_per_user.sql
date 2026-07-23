-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0026 — HARDENING de segurança (Auditoria v4)
--   A) Idempotency-Key POR USUÁRIO — a chave era global, permitindo que
--      o usuário B reusasse a chave de A e recebesse o pedido/QR-PIX de A
--      (vazamento cross-tenant). Índices compostos + replay filtrado por dono.
--   B) credit_topup com RECONCILIAÇÃO DE VALOR — recusa creditar se o valor
--      pago no webhook divergir do amount_cents (como já ocorre no pedido).
-- Aplicar após 0001..0025.
-- ═══════════════════════════════════════════════════════════════

-- ── A) Índices de idempotência compostos (por dono) ──
drop index if exists public.idx_orders_idem;
create unique index if not exists idx_orders_idem on public.orders(buyer_id, client_request_id) where client_request_id is not null;

drop index if exists public.idx_bar_idem;
create unique index if not exists idx_bar_idem on public.bar_orders(buyer_id, client_request_id) where client_request_id is not null;

drop index if exists public.idx_topups_idem;
create unique index if not exists idx_topups_idem on public.wallet_topups(profile_id, client_request_id) where client_request_id is not null;

-- ── place_order: replay escopado por buyer_id (mantém meia/taxa/janela da 0017) ──
create or replace function public.place_order(
  p_buyer uuid, p_event uuid, p_items jsonb, p_idempotency_key text default null
)
returns table(order_id uuid, total_cents int, is_replay boolean) as $$
declare it jsonb; v_tier public.ticket_tiers; v_qty int; v_subtotal int := 0; v_order uuid;
        v_existing public.orders; v_half boolean; v_unit int; v_fee_bps int; v_fee int; v_total int;
begin
  if p_idempotency_key is not null then
    select * into v_existing from public.orders where client_request_id = p_idempotency_key and buyer_id = p_buyer;
    if found then
      return query select v_existing.id, v_existing.total_cents, true;
      return;
    end if;
  end if;

  select service_fee_bps into v_fee_bps from public.events where id = p_event and status = 'published';
  if not found then raise exception 'EVENT_UNAVAILABLE'; end if;
  v_fee_bps := coalesce(v_fee_bps, 0);

  insert into public.orders (buyer_id, event_id, status, total_cents, expires_at, client_request_id)
  values (p_buyer, p_event, 'pending', 0, now() + interval '30 minutes', p_idempotency_key)
  returning id into v_order;

  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'quantity')::int;
    v_half := coalesce((it->>'half')::boolean, false);
    if v_qty is null or v_qty < 1 then raise exception 'INVALID_QTY'; end if;

    select * into v_tier from public.ticket_tiers
      where id = (it->>'ticket_tier_id')::uuid and event_id = p_event for update;
    if not found then raise exception 'TIER_INVALID'; end if;
    if v_tier.status <> 'on_sale' then raise exception 'TIER_NOT_ON_SALE:%', v_tier.name; end if;
    if v_tier.sales_start is not null and now() < v_tier.sales_start then raise exception 'TIER_NOT_ON_SALE:%', v_tier.name; end if;
    if v_tier.sales_end   is not null and now() > v_tier.sales_end   then raise exception 'TIER_NOT_ON_SALE:%', v_tier.name; end if;
    if v_qty > v_tier.max_per_order then raise exception 'OVER_MAX:%', v_tier.name; end if;
    if v_tier.quantity_sold + v_qty > v_tier.quantity_total then raise exception 'SOLD_OUT:%', v_tier.name; end if;

    if v_half then
      if v_tier.half_price_cents is null then raise exception 'HALF_UNAVAILABLE:%', v_tier.name; end if;
      v_unit := v_tier.half_price_cents;
    else
      v_unit := v_tier.price_cents;
    end if;

    update public.ticket_tiers
       set quantity_sold = quantity_sold + v_qty,
           status = case when quantity_sold + v_qty >= quantity_total then 'sold_out'::tier_status else status end
     where id = v_tier.id;

    insert into public.order_items (order_id, ticket_tier_id, unit_price_cents, quantity)
    values (v_order, v_tier.id, v_unit, v_qty);

    v_subtotal := v_subtotal + v_unit * v_qty;
  end loop;

  v_fee := round(v_subtotal::numeric * v_fee_bps / 10000.0)::int;
  v_total := v_subtotal + v_fee;
  update public.orders set total_cents = v_total, service_fee_cents = v_fee where id = v_order;
  return query select v_order, v_total, false;
exception
  when unique_violation then
    select * into v_existing from public.orders where client_request_id = p_idempotency_key and buyer_id = p_buyer;
    return query select v_existing.id, v_existing.total_cents, true;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
revoke execute on function public.place_order(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant  execute on function public.place_order(uuid, uuid, jsonb, text) to service_role;

-- ── place_bar_order: replay escopado por buyer_id (mantém inventário da 0022) ──
create or replace function public.place_bar_order(
  p_buyer uuid, p_event uuid, p_items jsonb, p_idempotency_key text default null
)
returns jsonb as $$
declare it jsonb; v_item public.menu_items; v_qty int; v_total int := 0;
        v_wallet uuid; v_balance int; v_order uuid; v_pickup text; v_items jsonb := '[]'::jsonb;
        v_existing public.bar_orders;
begin
  if p_idempotency_key is not null then
    select * into v_existing from public.bar_orders where client_request_id = p_idempotency_key and buyer_id = p_buyer;
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
    insert into public.wallets (profile_id, event_id, balance_cents) values (p_buyer, p_event, 0) returning id into v_wallet;
  end if;

  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'quantity')::int;
    if v_qty is null or v_qty < 1 then raise exception 'INVALID_QTY'; end if;
    select * into v_item from public.menu_items where id = (it->>'menu_item_id')::uuid and event_id = p_event;
    if not found then raise exception 'ITEM_INVALID'; end if;
    if not v_item.available then raise exception 'ITEM_UNAVAILABLE:%', v_item.name; end if;
    if v_item.stock is not null then
      update public.menu_items set stock = stock - v_qty where id = v_item.id and stock >= v_qty;
      if not found then raise exception 'OUT_OF_STOCK:%', v_item.name; end if;
    end if;
    v_total := v_total + v_item.price_cents * v_qty;
    v_items := v_items || jsonb_build_object('menu_item_id', v_item.id, 'name', v_item.name,
      'unit_price_cents', v_item.price_cents, 'quantity', v_qty);
  end loop;

  update public.wallets set balance_cents = balance_cents - v_total, updated_at = now()
   where id = v_wallet and balance_cents >= v_total returning balance_cents into v_balance;
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
  when unique_violation then
    select * into v_existing from public.bar_orders where client_request_id = p_idempotency_key and buyer_id = p_buyer;
    return jsonb_build_object('order_id', v_existing.id, 'pickup_code', v_existing.pickup_code,
      'total_cents', v_existing.total_cents,
      'balance_cents', (select balance_cents from public.wallets where id = v_existing.wallet_id),
      'items', '[]'::jsonb, 'idempotent_replay', true);
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
revoke execute on function public.place_bar_order(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant  execute on function public.place_bar_order(uuid, uuid, jsonb, text) to service_role;

-- ── B) credit_topup com reconciliação de valor (ganha p_paid_value_cents) ──
drop function if exists public.credit_topup(text);
create function public.credit_topup(p_payment_id text, p_paid_value_cents int default null)
returns jsonb as $$
declare v_top public.wallet_topups; v_wallet uuid; v_balance int;
begin
  select * into v_top from public.wallet_topups where asaas_payment_id = p_payment_id for update;
  if not found then return jsonb_build_object('found', false); end if;
  if v_top.status = 'paid' then return jsonb_build_object('found', true, 'alreadyProcessed', true); end if;
  -- segurança: recusa creditar se o valor pago diverge do esperado
  if p_paid_value_cents is not null and v_top.amount_cents <> p_paid_value_cents then
    return jsonb_build_object('found', true, 'mismatch', true);
  end if;

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
$$ language plpgsql security definer set search_path = public, pg_temp;
revoke execute on function public.credit_topup(text, int) from public, anon, authenticated;
grant  execute on function public.credit_topup(text, int) to service_role;

-- ═══════════════════════════════════════════════════════════════
