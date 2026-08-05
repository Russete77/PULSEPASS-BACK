-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0035 — REVERSÃO DE PAGAMENTO
--   (estorno, chargeback, reprovação de risco)
--
--   O buraco que isto fecha: o webhook só tratava PAGO. Se o cliente pedia
--   estorno pelo painel do Asaas — ou abria chargeback no cartão — o evento
--   chegava e era ignorado. O ingresso continuava VÁLIDO. Golpe trivial:
--   compra, entra na festa, pede o dinheiro de volta.
--
--   Duas situações difíceis que precisam de decisão explícita:
--
--   1. O INGRESSO JÁ FOI USADO. Não há como desfazer a entrada de quem já
--      está dentro. Então registramos como fraude confirmada e entregamos o
--      caso pra produtora — mentir que "cancelamos" seria pior.
--
--   2. O SALDO JÁ FOI GASTO NO BAR. A pessoa bebeu. Zerar o saldo não
--      recupera o produto. A carteira vai a NEGATIVO (a dívida é real) e é
--      bloqueada até acerto — em vez de fingir que o prejuízo não existe.
-- ═══════════════════════════════════════════════════════════════

-- Rastro da reversão no pedido.
alter table public.orders
  add column if not exists reversed_at timestamptz,
  add column if not exists reversal_kind text,      -- refund | chargeback | risk_reproved | deleted
  add column if not exists reversal_reason text;

-- Carteira pode ficar negativa e ser bloqueada (dívida de consumo).
alter table public.wallets
  add column if not exists blocked_at timestamptz,
  add column if not exists block_reason text;

comment on column public.wallets.blocked_at is
  'Carteira bloqueada para novos gastos. Usada quando um estorno deixa saldo negativo — o consumo já aconteceu e a dívida é real.';

-- O saldo deixa de ter check >= 0, porque a dívida precisa ser representável.
do $$ begin
  alter table public.wallets drop constraint if exists wallets_balance_cents_check;
exception when others then null; end $$;

-- Casos de fraude para a produtora resolver (ingresso usado + pagamento revertido).
create table if not exists public.fraud_cases (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid references public.events(id) on delete cascade,
  order_id     uuid references public.orders(id) on delete set null,
  ticket_id    uuid references public.tickets(id) on delete set null,
  profile_id   uuid references public.profiles(id) on delete set null,
  kind         text not null,             -- entered_then_refunded | consumed_then_refunded
  amount_cents integer,
  detail       text,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_fraud_event on public.fraud_cases (event_id, created_at desc);
alter table public.fraud_cases enable row level security;
revoke all on public.fraud_cases from anon, authenticated;

-- ── Reverter pedido de ingresso ──
-- Cancela ingressos não usados, devolve estoque e abre caso de fraude para os
-- que já entraram. Idempotente: reverter duas vezes não duplica nada.
create or replace function public.reverse_order_payment(
  p_payment_id text, p_kind text, p_reason text default null
)
returns jsonb as $$
declare
  v_order public.orders; v_item public.order_items;
  v_cancelados int := 0; v_usados int := 0; v_t public.tickets;
begin
  select * into v_order from public.orders where asaas_payment_id = p_payment_id for update;
  if not found then return jsonb_build_object('found', false); end if;

  if v_order.reversed_at is not null then
    return jsonb_build_object('found', true, 'already_reversed', true, 'order_id', v_order.id);
  end if;

  -- Ingressos ainda não usados: cancela e devolve o estoque ao lote.
  for v_t in select * from public.tickets where order_id = v_order.id loop
    if v_t.status = 'used' then
      v_usados := v_usados + 1;
      -- Já entrou. Não existe desfazer: vira caso para a produtora decidir.
      insert into public.fraud_cases (event_id, order_id, ticket_id, profile_id, kind, amount_cents, detail)
      values (v_order.event_id, v_order.id, v_t.id, v_order.buyer_id,
              'entered_then_refunded', v_order.total_cents,
              'Ingresso ' || v_t.code || ' entrou no evento e o pagamento foi revertido (' || p_kind || ')');
    elsif v_t.status = 'valid' then
      update public.tickets set status = 'cancelled' where id = v_t.id;
      v_cancelados := v_cancelados + 1;
    end if;
  end loop;

  -- Devolve ao estoque só o que foi cancelado de fato.
  if v_cancelados > 0 then
    for v_item in select * from public.order_items where order_id = v_order.id loop
      update public.ticket_tiers
         set quantity_sold = greatest(0, quantity_sold - least(v_item.quantity, v_cancelados)),
             status = case when status = 'sold_out' then 'on_sale'::tier_status else status end
       where id = v_item.ticket_tier_id;
    end loop;
  end if;

  update public.orders
     set status = case when p_kind = 'refund' then 'refunded'::order_status else 'cancelled'::order_status end,
         reversed_at = now(), reversal_kind = p_kind, reversal_reason = p_reason
   where id = v_order.id;

  return jsonb_build_object('found', true, 'already_reversed', false,
    'order_id', v_order.id, 'event_id', v_order.event_id,
    'amount_cents', v_order.total_cents,
    'tickets_cancelled', v_cancelados, 'tickets_already_used', v_usados,
    'fraud_case', v_usados > 0);
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
revoke execute on function public.reverse_order_payment(text, text, text) from public, anon, authenticated;
grant execute on function public.reverse_order_payment(text, text, text) to service_role;

-- ── Reverter recarga de carteira ──
-- Debita o valor recarregado. Se o dinheiro já foi gasto, o saldo fica
-- NEGATIVO e a carteira é bloqueada: o consumo aconteceu e a dívida é real.
create or replace function public.reverse_topup_payment(
  p_payment_id text, p_kind text, p_reason text default null
)
returns jsonb as $$
declare v_top public.wallet_topups; v_wallet public.wallets; v_novo int;
begin
  select * into v_top from public.wallet_topups where asaas_payment_id = p_payment_id for update;
  if not found then return jsonb_build_object('found', false); end if;
  if v_top.status <> 'paid' then
    -- Recarga não creditada: só marca como cancelada, nada a debitar.
    update public.wallet_topups set status = 'cancelled' where id = v_top.id;
    return jsonb_build_object('found', true, 'debited', 0, 'was_credited', false);
  end if;

  select * into v_wallet from public.wallets
   where profile_id = v_top.profile_id and event_id is null for update;
  if not found then return jsonb_build_object('found', true, 'debited', 0, 'no_wallet', true); end if;

  v_novo := v_wallet.balance_cents - v_top.amount_cents;

  update public.wallets
     set balance_cents = v_novo,
         updated_at = now(),
         -- Saldo negativo = a pessoa consumiu o que não pagou. Bloqueia novos
         -- gastos até acerto, em vez de deixar cavar a dívida.
         blocked_at = case when v_novo < 0 then now() else blocked_at end,
         block_reason = case when v_novo < 0
                            then 'Recarga revertida (' || p_kind || ') após consumo'
                            else block_reason end
   where id = v_wallet.id;

  insert into public.wallet_transactions (wallet_id, type, amount_cents, description)
  values (v_wallet.id, 'adjustment', -v_top.amount_cents,
          'Recarga revertida · ' || p_kind || coalesce(' · ' || p_reason, ''));

  update public.wallet_topups set status = 'cancelled' where id = v_top.id;

  if v_novo < 0 then
    insert into public.fraud_cases (profile_id, kind, amount_cents, detail)
    values (v_top.profile_id, 'consumed_then_refunded', v_top.amount_cents,
            'Recarga de ' || (v_top.amount_cents / 100.0)::numeric(12,2) ||
            ' revertida (' || p_kind || ') com saldo já consumido. Dívida: ' ||
            (abs(v_novo) / 100.0)::numeric(12,2));
  end if;

  return jsonb_build_object('found', true, 'was_credited', true,
    'debited', v_top.amount_cents, 'balance_cents', v_novo,
    'wallet_blocked', v_novo < 0, 'debt_cents', greatest(0, -v_novo));
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
revoke execute on function public.reverse_topup_payment(text, text, text) from public, anon, authenticated;
grant execute on function public.reverse_topup_payment(text, text, text) to service_role;

-- ── Carteira bloqueada não gasta ──
-- Sem esta trava a pessoa endividada continuaria pedindo no bar.
create or replace function public.place_bar_order(
  p_buyer uuid, p_event uuid, p_items jsonb, p_idempotency_key text default null
)
returns jsonb as $$
declare it jsonb; v_item public.menu_items; v_qty int; v_total int := 0;
        v_wallet uuid; v_balance int; v_order uuid; v_pickup text; v_items jsonb := '[]'::jsonb;
        v_existing public.bar_orders; v_blocked timestamptz;
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

  select id, blocked_at into v_wallet, v_blocked from public.wallets
   where profile_id = p_buyer and event_id is null;
  if v_wallet is null then
    insert into public.wallets (profile_id, event_id, balance_cents) values (p_buyer, null, 0) returning id into v_wallet;
  end if;
  if v_blocked is not null then raise exception 'WALLET_BLOCKED'; end if;

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
grant execute on function public.place_bar_order(uuid, uuid, jsonb, text) to service_role;

-- ═══════════════════════════════════════════════════════════════
