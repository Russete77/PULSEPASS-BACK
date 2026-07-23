-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0018 — FASE 2 (Sympla): conciliação financeira
--   event_reconciliation(p_event) → somas brutas p/ o painel do produtor.
--   A taxa da plataforma (repasse retido) é aplicada no backend (env),
--   pois é config do app, não do banco.
-- Aplicar após 0001..0017.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.event_reconciliation(p_event uuid)
returns jsonb as $$
declare v_gross int; v_fees int; v_disc int; v_paid_cnt int; v_ref_cnt int; v_ref int; v_bar int;
begin
  select coalesce(sum(total_cents), 0), coalesce(sum(service_fee_cents), 0),
         coalesce(sum(discount_cents), 0), count(*)
    into v_gross, v_fees, v_disc, v_paid_cnt
    from public.orders where event_id = p_event and status = 'paid';

  select count(*), coalesce(sum(total_cents), 0)
    into v_ref_cnt, v_ref
    from public.orders where event_id = p_event and status = 'refunded';

  select coalesce(sum(total_cents), 0)
    into v_bar
    from public.bar_orders where event_id = p_event and status = 'paid';

  return jsonb_build_object(
    'tickets_gross_cents', v_gross,
    'service_fees_cents', v_fees,
    'discounts_cents', v_disc,
    'orders_paid', v_paid_cnt,
    'refunds_count', v_ref_cnt,
    'refunds_cents', v_ref,
    'bar_gross_cents', v_bar
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.event_reconciliation(uuid) from public, anon, authenticated;
grant  execute on function public.event_reconciliation(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════
