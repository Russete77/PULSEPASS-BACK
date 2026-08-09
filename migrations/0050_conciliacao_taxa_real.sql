-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0050 — A CONCILIAÇÃO PASSA A DIZER A VERDADE
--
--   Dois erros na mesma tela, os dois a favor de quem recebe o relatório —
--   que é o pior tipo, porque ninguém reclama de número bom.
--
--   1. A TAXA VINHA DO AMBIENTE, NÃO DO PEDIDO.
--      A 0018 anotou "a taxa é aplicada no backend (env), pois é config do
--      app". Era verdade naquele dia. A 0037 mudou isso: passou a existir
--      taxa por produtora e o percentual usado passou a ser CONGELADO em
--      orders.platform_fee_bps, justamente para que mudar a taxa hoje não
--      reescrevesse o resultado de evento passado. A conciliação não foi
--      junto — continuou lendo PLATFORM_FEE_PERCENT. Onde essa variável não
--      está definida, e ela não está, o valor lido é ZERO: a tela informava
--      taxa de 0% e repasse igual à venda líquida. A produtora fechava a
--      noite achando que recebia o bruto.
--
--   2. O ESTORNO ERA DESCONTADO DUAS VEZES.
--      refund_order muda o status de 'paid' para 'refunded'. Logo o pedido
--      estornado JÁ SAIU da soma de vendas pagas. Subtrair os estornos
--      daquela soma tira de novo o que nunca esteve lá. Numa noite com
--      R$ 1.000 vendidos e R$ 100 estornados, o relatório mostrava R$ 800.
--
--   Os dois se cancelavam parcialmente, e é por isso que passaram: o líquido
--   subestimado compensava a taxa zerada, e o total final não parecia
--   absurdo. Nenhum dos dois números individuais estava certo.
--
--   A taxa passa a ser somada PEDIDO A PEDIDO com o bps gravado em cada um.
--   Somar tudo e aplicar um percentual médio daria outro valor quando há
--   taxas diferentes convivendo — que é exatamente o cenário que a 0037 criou.
-- ═══════════════════════════════════════════════════════════════

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

  -- Taxa da plataforma somada PEDIDO A PEDIDO, com o bps congelado em cada
  -- venda. Pedido anterior à 0037 não tem o campo: cai na taxa efetiva da
  -- produtora dona do evento, que é a melhor aproximação disponível — e é
  -- melhor que zero, que seria afirmar que a venda foi isenta.
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
    'bar_gross_cents', v_bar,
    -- v_gross já exclui estornado. O líquido é ele, sem subtrair de novo.
    'net_sales_cents', v_gross,
    'platform_fee_cents', v_plat,
    'producer_net_cents', v_gross - v_plat,
    -- Quando todos os pedidos usaram a mesma taxa, a tela mostra "10%".
    -- Quando a taxa mudou no meio da temporada, mostrar um número só seria
    -- inventar precisão: o backend detecta pelo min ≠ max e escreve a faixa.
    'fee_bps_min', coalesce(v_bps_min, 0),
    'fee_bps_max', coalesce(v_bps_max, 0)
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.event_reconciliation(uuid) from public, anon, authenticated;
grant  execute on function public.event_reconciliation(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════
