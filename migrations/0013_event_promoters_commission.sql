-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0013 — event_promoters expõe commission_paid_at
-- Permite ao admin mostrar de forma persistente se a comissão foi paga.
-- Recria a função (muda o retorno → precisa DROP) e re-aplica o hardening.
-- Aplicar após 0012 (que adiciona promoters.commission_paid_at).
-- ═══════════════════════════════════════════════════════════════

drop function if exists public.event_promoters(uuid);

create function public.event_promoters(p_event uuid)
returns table(
  id uuid, name text, code text, commission_cents int,
  confirmed bigint, checked_in bigint, commission_due_cents bigint,
  commission_paid_at timestamptz
) as $$
  select p.id, p.name, p.code, p.commission_cents,
         count(g.id) as confirmed,
         count(g.id) filter (where g.status = 'checked_in') as checked_in,
         count(g.id) filter (where g.status = 'checked_in') * p.commission_cents as commission_due_cents,
         p.commission_paid_at
    from public.promoters p
    left join public.guests g on g.promoter_id = p.id
   where p.event_id = p_event
   group by p.id
   order by p.created_at;
$$ language sql security definer set search_path = public, pg_temp;

revoke execute on function public.event_promoters(uuid) from public, anon, authenticated;
grant  execute on function public.event_promoters(uuid) to service_role;
