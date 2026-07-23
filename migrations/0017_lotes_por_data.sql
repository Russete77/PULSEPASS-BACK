-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0017 — FASE 2 (Sympla): lotes por data
--   • ticket_tiers.sales_start / sales_end — janela de vendas do lote (null = sem limite)
--   • place_order recusa compra fora da janela (virada automática por data)
-- Aplicar após 0001..0016.
-- ═══════════════════════════════════════════════════════════════

alter table public.ticket_tiers add column if not exists sales_start timestamptz;
alter table public.ticket_tiers add column if not exists sales_end   timestamptz;

-- place_order (mesma assinatura/retorno da 0016; adiciona a checagem de janela).
create or replace function public.place_order(
  p_buyer uuid, p_event uuid, p_items jsonb, p_idempotency_key text default null
)
returns table(order_id uuid, total_cents int, is_replay boolean) as $$
declare it jsonb; v_tier public.ticket_tiers; v_qty int; v_subtotal int := 0; v_order uuid;
        v_existing public.orders; v_half boolean; v_unit int; v_fee_bps int; v_fee int; v_total int;
begin
  if p_idempotency_key is not null then
    select * into v_existing from public.orders where client_request_id = p_idempotency_key;
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
      where id = (it->>'ticket_tier_id')::uuid and event_id = p_event
      for update;
    if not found then raise exception 'TIER_INVALID'; end if;
    if v_tier.status <> 'on_sale' then raise exception 'TIER_NOT_ON_SALE:%', v_tier.name; end if;
    -- janela de vendas (lote por data)
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
    select * into v_existing from public.orders where client_request_id = p_idempotency_key;
    return query select v_existing.id, v_existing.total_cents, true;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.place_order(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant  execute on function public.place_order(uuid, uuid, jsonb, text) to service_role;

-- ═══════════════════════════════════════════════════════════════
