-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0020 — FASE 3 (AzList): analytics de funil por link
--   • promoters.clicks — cliques no link público (beacon na página de inscrição)
--   • increment_promoter_hit(code) — incremento atômico
--   • clicks adicionado a event_promoters e promoter_dashboard (funil completo)
-- Aplicar após 0001..0019.
-- ═══════════════════════════════════════════════════════════════

alter table public.promoters add column if not exists clicks integer not null default 0;

create or replace function public.increment_promoter_hit(p_code text) returns void as $$
  update public.promoters set clicks = clicks + 1 where code = p_code;
$$ language sql security definer set search_path = public, pg_temp;
revoke execute on function public.increment_promoter_hit(text) from public, anon, authenticated;
grant  execute on function public.increment_promoter_hit(text) to service_role;

-- ── event_promoters (+ clicks) — DROP por mudar o tipo de retorno ──
drop function if exists public.event_promoters(uuid);
create function public.event_promoters(p_event uuid)
returns table(id uuid, name text, code text, commission_cents int, clicks int,
              confirmed bigint, checked_in bigint, commission_due_cents bigint, commission_paid_at timestamptz) as $$
  select p.id, p.name, p.code, p.commission_cents, p.clicks,
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

-- ── promoter_dashboard (+ clicks) — DROP por mudar o tipo de retorno ──
drop function if exists public.promoter_dashboard(uuid);
create function public.promoter_dashboard(p_user uuid)
returns table(
  promoter_id uuid, name text, code text, event_id uuid, event_title text, event_slug text,
  event_starts_at timestamptz, event_status text, commission_cents int, clicks int,
  confirmed bigint, checked_in bigint, commission_due_cents bigint, commission_paid_at timestamptz
) as $$
  select p.id, p.name, p.code, p.event_id, e.title, e.slug, e.starts_at, e.status::text, p.commission_cents, p.clicks,
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
