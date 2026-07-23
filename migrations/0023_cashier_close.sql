-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0023 — FASE 4 (Zig): fechamento de caixa por operador
--   • bar_orders.operator_id — quem processou (PDV). null = pedido do próprio cliente (app)
--   • cashier_report(p_event) — total processado por operador (conciliação de PDV)
-- Aplicar após 0001..0022.
-- ═══════════════════════════════════════════════════════════════

alter table public.bar_orders add column if not exists operator_id uuid references public.profiles(id);
create index if not exists idx_bar_orders_operator on public.bar_orders(event_id, operator_id) where operator_id is not null;

create or replace function public.cashier_report(p_event uuid)
returns table(operator_id uuid, operator_name text, operator_email text, orders bigint, total_cents bigint) as $$
  select b.operator_id, pr.full_name, pr.email, count(*) as orders, coalesce(sum(b.total_cents), 0) as total_cents
    from public.bar_orders b
    join public.profiles pr on pr.id = b.operator_id
   where b.event_id = p_event and b.operator_id is not null and b.status = 'paid'
   group by b.operator_id, pr.full_name, pr.email
   order by sum(b.total_cents) desc;
$$ language sql security definer set search_path = public, pg_temp;

revoke execute on function public.cashier_report(uuid) from public, anon, authenticated;
grant  execute on function public.cashier_report(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════
