-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0019 — FASE 3 (AzList): portal do promoter
--   • índice para lookup dos promoters de um usuário (profile_id)
--   • promoter_dashboard(p_user) → painel self-service do promoter
--     (seus promoters por evento + inscritos, check-ins, comissão)
-- Aplicar após 0001..0018.
-- ═══════════════════════════════════════════════════════════════

create index if not exists idx_promoters_profile on public.promoters(profile_id) where profile_id is not null;

create or replace function public.promoter_dashboard(p_user uuid)
returns table(
  promoter_id uuid, name text, code text, event_id uuid, event_title text, event_slug text,
  event_starts_at timestamptz, event_status text, commission_cents int,
  confirmed bigint, checked_in bigint, commission_due_cents bigint, commission_paid_at timestamptz
) as $$
  select p.id, p.name, p.code, p.event_id, e.title, e.slug, e.starts_at, e.status::text, p.commission_cents,
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
