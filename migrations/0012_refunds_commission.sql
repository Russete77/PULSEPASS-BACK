-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0012 — Reembolso de pedido, estorno de saldo,
-- comissão de promoter paga.
-- ═══════════════════════════════════════════════════════════════

-- Comissão do promoter: marca quando foi paga.
alter table public.promoters add column if not exists commission_paid_at timestamptz;

-- ── Reembolso de pedido (atômico): cancela ingressos, devolve estoque,
--    marca o pedido como refunded. O estorno financeiro no Asaas é feito
--    pelo backend antes de chamar isto. ──
create or replace function public.refund_order(p_order uuid)
returns jsonb as $$
declare v_order public.orders; v_item public.order_items; v_n int := 0;
begin
  select * into v_order from public.orders where id = p_order for update;
  if not found then return jsonb_build_object('found', false); end if;
  if v_order.status = 'refunded' then
    return jsonb_build_object('found', true, 'alreadyRefunded', true);
  end if;

  -- invalida ingressos ainda válidos e devolve estoque
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

  return jsonb_build_object('found', true, 'refunded', true, 'tickets', v_n);
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.refund_order(uuid) from public, anon, authenticated;
grant  execute on function public.refund_order(uuid) to service_role;

-- ── Estorno de saldo da carteira (zera e registra a transação). ──
create or replace function public.refund_wallet(p_wallet uuid)
returns integer as $$
declare v_bal int;
begin
  select balance_cents into v_bal from public.wallets where id = p_wallet for update;
  if v_bal is null or v_bal <= 0 then return 0; end if;

  update public.wallets set balance_cents = 0, updated_at = now() where id = p_wallet;
  insert into public.wallet_transactions (wallet_id, type, amount_cents, description)
  values (p_wallet, 'refund', -v_bal, 'Estorno de saldo ao fim do evento');
  return v_bal;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.refund_wallet(uuid) from public, anon, authenticated;
grant  execute on function public.refund_wallet(uuid) to service_role;
