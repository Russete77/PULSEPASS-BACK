-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0027 — CARTEIRA ÚNICA (super-app)
--   Problema: existiam carteiras POR EVENTO + uma geral. O cliente
--   recarregava a geral e gastava no bar debitando a do evento → o saldo
--   na tela "não descontava". Grave de UX (o dinheiro nunca some, mas confunde).
--   Correção: UMA carteira por usuário (event_id NULL). Todo topup credita
--   e todo pedido de bar debita essa carteira única.
--   Aplicar após 0001..0026.
-- ═══════════════════════════════════════════════════════════════

-- ── place_bar_order: debita a carteira GERAL (event_id null) ──
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

  -- CARTEIRA ÚNICA: sempre a geral do comprador (event_id null).
  select id into v_wallet from public.wallets where profile_id = p_buyer and event_id is null;
  if v_wallet is null then
    insert into public.wallets (profile_id, event_id, balance_cents) values (p_buyer, null, 0) returning id into v_wallet;
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

-- ── credit_topup: credita a carteira GERAL (event_id null) ──
drop function if exists public.credit_topup(text, int);
create function public.credit_topup(p_payment_id text, p_paid_value_cents int default null)
returns jsonb as $$
declare v_top public.wallet_topups; v_wallet uuid; v_balance int;
begin
  select * into v_top from public.wallet_topups where asaas_payment_id = p_payment_id for update;
  if not found then return jsonb_build_object('found', false); end if;
  if v_top.status = 'paid' then return jsonb_build_object('found', true, 'alreadyProcessed', true); end if;
  if p_paid_value_cents is not null and v_top.amount_cents <> p_paid_value_cents then
    return jsonb_build_object('found', true, 'mismatch', true);
  end if;

  select id into v_wallet from public.wallets where profile_id = v_top.profile_id and event_id is null;
  if v_wallet is null then
    insert into public.wallets (profile_id, event_id, balance_cents) values (v_top.profile_id, null, 0) returning id into v_wallet;
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

-- ── CONSOLIDAÇÃO: junta o que já existe na carteira geral (nada se perde) ──
-- 1) garante carteira geral pra quem só tinha carteira de evento
insert into public.wallets (profile_id, event_id, balance_cents)
select distinct w.profile_id, null::uuid, 0 from public.wallets w
where w.event_id is not null
  and not exists (select 1 from public.wallets g where g.profile_id = w.profile_id and g.event_id is null);

-- 2) move as transações das carteiras de evento para a geral (mantém o ledger)
update public.wallet_transactions t set wallet_id = g.id
from public.wallets ev
join public.wallets g on g.profile_id = ev.profile_id and g.event_id is null
where t.wallet_id = ev.id and ev.event_id is not null;

-- 3) soma o saldo das carteiras de evento na geral e zera as de evento
update public.wallets g set balance_cents = g.balance_cents + coalesce(
  (select sum(ev.balance_cents) from public.wallets ev where ev.profile_id = g.profile_id and ev.event_id is not null), 0)
where g.event_id is null;

update public.wallets set balance_cents = 0 where event_id is not null;

-- ═══════════════════════════════════════════════════════════════
