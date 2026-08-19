-- ═══════════════════════════════════════════════════════════
-- 0059 — Reaplica a correção do bar na conciliação
--
-- A 0057 consertou event_reconciliation no banco às 19:48 de 19/08/2026.
-- Às 20:00 um `npm run migrate` aplicou o atraso de migrations que nunca
-- tinham sido registradas (0050, 0052, 0053, 0054, 0056, 0058) — e a 0050,
-- que é `create or replace function event_reconciliation`, reinstalou o
-- `status = 'paid'` por cima. A 0057 já constava aplicada, então o runner
-- pulou ela: nada reverteu a reversão. A conciliação voltou a esconder o
-- que a cozinha entregava, sem nenhum erro em lugar nenhum.
--
-- Duas providências, porque o problema tem duas metades:
--   1. o arquivo da 0050 (e 0005, 0018, 0023) foi corrigido na origem, para
--      que replay em qualquer ordem não ressuscite o bug;
--   2. esta migration reaplica a definição boa nos bancos onde o estrago
--      já aconteceu — a 0050 lá já consta aplicada e não roda de novo.
--
-- Idempotente: rodar duas vezes não muda nada.
-- ═══════════════════════════════════════════════════════════

create or replace function public.event_reconciliation(p_event uuid)
returns jsonb as $$
declare
  v_gross int; v_fees int; v_disc int; v_paid_cnt int;
  v_ref_cnt int; v_ref int; v_bar int;
  v_plat int; v_bps_min int; v_bps_max int;
begin
  select coalesce(sum(total_cents), 0), coalesce(sum(service_fee_cents), 0),
         coalesce(sum(discount_cents), 0), count(*)
    into v_gross, v_fees, v_disc, v_paid_cnt
    from public.orders where event_id = p_event and status = 'paid';

  select coalesce(sum(
           round(o.total_cents::numeric
                 * coalesce(o.platform_fee_bps, public.effective_fee_bps(e.organization_id))
                 / 10000)
         ), 0)::int,
         min(coalesce(o.platform_fee_bps, public.effective_fee_bps(e.organization_id))),
         max(coalesce(o.platform_fee_bps, public.effective_fee_bps(e.organization_id)))
    into v_plat, v_bps_min, v_bps_max
    from public.orders o
    join public.events e on e.id = o.event_id
   where o.event_id = p_event and o.status = 'paid';

  select count(*), coalesce(sum(total_cents), 0)
    into v_ref_cnt, v_ref
    from public.orders where event_id = p_event and status = 'refunded';

  -- A linha em disputa. Comanda entregue continua sendo venda.
  select coalesce(sum(total_cents), 0)
    into v_bar
    from public.bar_orders where event_id = p_event and status <> 'cancelled';

  return jsonb_build_object(
    'tickets_gross_cents', v_gross,
    'service_fees_cents', v_fees,
    'discounts_cents', v_disc,
    'orders_paid', v_paid_cnt,
    'refunds_count', v_ref_cnt,
    'refunds_cents', v_ref,
    'bar_gross_cents', v_bar,
    'net_sales_cents', v_gross,
    'platform_fee_cents', v_plat,
    'producer_net_cents', v_gross - v_plat,
    'fee_bps_min', coalesce(v_bps_min, 0),
    'fee_bps_max', coalesce(v_bps_max, 0)
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.event_reconciliation(uuid) from public, anon, authenticated;
grant  execute on function public.event_reconciliation(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════
