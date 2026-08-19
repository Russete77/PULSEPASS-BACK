-- ═══════════════════════════════════════════════════════════
-- 0057 — O bar sumia do faturamento quando trabalhava bem
--
-- `bar_orders.status` carrega DUAS coisas ao mesmo tempo: se a comanda foi
-- paga e em que ponto do preparo ela está. O ciclo é
-- paid → preparing → ready → delivered, e os relatórios somavam só `paid`.
--
-- O resultado é perverso: a comanda entra no faturamento no instante em que
-- é cobrada e SAI assim que a cozinha começa a preparar. Quanto mais rápido
-- o bar atende, menor o número que a produtora vê. No fim da noite, com tudo
-- entregue, o bar aparece quase zerado — justo a noite em que ele foi bem.
--
-- Medido no banco de demonstração no momento do conserto:
--   relatório dizia   R$  9.528,00
--   o bar faturou     R$ 13.239,00
-- R$ 3.711 — 28% da receita — invisíveis, e a diferença CRESCE conforme a
-- cozinha vaza a fila.
--
-- A correção é somar tudo que não foi cancelado. Dinheiro entrou quando a
-- comanda foi paga; o que acontece com o prato depois é operação, não caixa.
-- `cancelled` é o único estado do enum que significa "não houve venda".
--
-- Atingidos (varredura em pg_proc por tudo que soma bar_orders.total_cents):
--   • event_dashboard      — painel ao vivo
--   • event_reconciliation — conciliação financeira do evento
--   • cashier_report       — fechamento de gaveta por operador
-- O mesmo filtro existia fora do banco, em src/modules/platform/repo.js
-- (GMV do god-mode); corrigido no mesmo commit.
-- ═══════════════════════════════════════════════════════════

-- ── Painel ao vivo ──
create or replace function public.event_dashboard(p_event uuid)
returns jsonb as $$
declare v_sold int; v_checked int; v_trev bigint; v_orders int; v_brev bigint;
begin
  select count(*) into v_sold from public.tickets where event_id = p_event;
  select count(*) into v_checked from public.tickets where event_id = p_event and status = 'used';
  select coalesce(sum(total_cents),0), count(*) into v_trev, v_orders
    from public.orders where event_id = p_event and status = 'paid';

  -- `<> 'cancelled'` e não `= 'paid'`: preparing, ready e delivered são
  -- comandas PAGAS que avançaram no preparo. Filtrar por 'paid' fazia a
  -- receita encolher à medida que a cozinha entregava.
  select coalesce(sum(total_cents),0) into v_brev
    from public.bar_orders where event_id = p_event and status <> 'cancelled';

  return jsonb_build_object(
    'tickets_sold', v_sold, 'checked_in', v_checked,
    'ticket_revenue_cents', v_trev, 'bar_revenue_cents', v_brev,
    'total_revenue_cents', v_trev + v_brev, 'orders_paid', v_orders);
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.event_dashboard(uuid) from public, anon, authenticated;
grant  execute on function public.event_dashboard(uuid) to service_role;

-- ── Conciliação ──
-- Mantém o resto da 0050 intacto; muda só a linha do bar.
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

  -- Mesma correção do painel: comanda entregue continua sendo venda.
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

-- ── Fechamento de caixa por operador ──
-- Mesmo furo, consequência pior: aqui o número vira acusação. O relatório
-- serve pra conferir a gaveta do operador contra o que o sistema registrou.
-- Somando só 'paid', tudo que ele vendeu e o bar já entregou some do lado do
-- sistema — e a conferência acusa uma FALTA que o operador nunca causou.
-- No banco de demonstração, um operador com R$ 2.276,00 em comandas aparecia
-- com R$ 343,00: R$ 1.933,00 de "diferença de caixa" puramente contábil.
create or replace function public.cashier_report(p_event uuid)
returns table(operator_id uuid, operator_name text, operator_email text, orders bigint, total_cents bigint) as $$
  select b.operator_id, pr.full_name, pr.email, count(*) as orders, coalesce(sum(b.total_cents), 0) as total_cents
    from public.bar_orders b
    join public.profiles pr on pr.id = b.operator_id
   where b.event_id = p_event and b.operator_id is not null and b.status <> 'cancelled'
   group by b.operator_id, pr.full_name, pr.email
   order by sum(b.total_cents) desc;
$$ language sql security definer set search_path = public, pg_temp;

revoke execute on function public.cashier_report(uuid) from public, anon, authenticated;
grant  execute on function public.cashier_report(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════
