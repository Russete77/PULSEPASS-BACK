-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0021 — FASE 3 (AzList): metas de promoter
--   • promoters.goal_checkins — meta de presenças (null = sem meta)
--   • goal_checkins exposto em event_promoters e promoter_dashboard
--   (o ranking é derivado no front, ordenando por presenças)
-- Aplicar após 0001..0020.
-- ═══════════════════════════════════════════════════════════════

alter table public.promoters add column if not exists goal_checkins integer
  check (goal_checkins is null or goal_checkins >= 0);

drop function if exists public.event_promoters(uuid);
create function public.event_promoters(p_event uuid)
returns table(id uuid, name text, code text, commission_cents int, clicks int, goal_checkins int,
              confirmed bigint, checked_in bigint, commission_due_cents bigint, commission_paid_at timestamptz) as $$
  select p.id, p.name, p.code, p.commission_cents, p.clicks, p.goal_checkins,
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

drop function if exists public.promoter_dashboard(uuid);
create function public.promoter_dashboard(p_user uuid)
returns table(
  promoter_id uuid, name text, code text, event_id uuid, event_title text, event_slug text,
  event_starts_at timestamptz, event_status text, commission_cents int, clicks int, goal_checkins int,
  confirmed bigint, checked_in bigint, commission_due_cents bigint, commission_paid_at timestamptz
) as $$
  select p.id, p.name, p.code, p.event_id, e.title, e.slug, e.starts_at, e.status::text,
         p.commission_cents, p.clicks, p.goal_checkins,
         count(g.id) as confirmed,
         count(g.id) filter (where g.status = 'checked_in') as checked_in,
         count(g.id) filter (where g.status = 'checked_in') * p.commission_cents as commission_due_cents,
         p.commission_paid_at
    from public.promoters p
    join public.events e on e.id = p.event_id
    left join public.guests g on g.promoter_id = p.id
   where p.profile_id = p_user
   group by p.id, e.title, e.slug, e.starts_at, e.status
   order by e.starts_at desc;
$$ language sql security definer set search_path = public, pg_temp;
revoke execute on function public.promoter_dashboard(uuid) from public, anon, authenticated;
grant  execute on function public.promoter_dashboard(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════
