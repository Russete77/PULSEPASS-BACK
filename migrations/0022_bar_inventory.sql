-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0022 — FASE 4 (Zig): inventário do bar
--   • menu_items.stock — estoque (null = ilimitado)
--   • place_bar_order decrementa estoque atomicamente (bloqueia ruptura)
-- Aplicar após 0001..0021.
-- ═══════════════════════════════════════════════════════════════

alter table public.menu_items add column if not exists stock integer
  check (stock is null or stock >= 0);

-- place_bar_order (mesma assinatura/retorno da 0015; adiciona baixa de estoque)
create or replace function public.place_bar_order(
  p_buyer uuid, p_event uuid, p_items jsonb, p_idempotency_key text default null
)
returns jsonb as $$
declare it jsonb; v_item public.menu_items; v_qty int; v_total int := 0;
        v_wallet uuid; v_balance int; v_order uuid; v_pickup text; v_items jsonb := '[]'::jsonb;
        v_existing public.bar_orders;
begin
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

    -- inventário (F4.3): baixa atômica de estoque, se controlado (rollback junto se faltar saldo)
    if v_item.stock is not null then
      update public.menu_items set stock = stock - v_qty where id = v_item.id and stock >= v_qty;
      if not found then raise exception 'OUT_OF_STOCK:%', v_item.name; end if;
    end if;

    v_total := v_total + v_item.price_cents * v_qty;
    v_items := v_items || jsonb_build_object(
      'menu_item_id', v_item.id, 'name', v_item.name,
      'unit_price_cents', v_item.price_cents, 'quantity', v_qty);
  end loop;

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

-- ═══════════════════════════════════════════════════════════════
