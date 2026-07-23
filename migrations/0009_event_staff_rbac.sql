-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0009 — RBAC de equipe (event_staff)
-- Antes: só o dono da organização operava porta/PDV/promoters.
-- Agora: dono pode delegar papéis por evento — manager / door / bar.
--   manager → tudo do evento (menos billing da org)
--   door    → check-in na porta
--   bar     → PDV / cardápio / lookup de carteira
-- ═══════════════════════════════════════════════════════════════

do $$ begin
  create type public.event_role as enum ('manager', 'door', 'bar');
exception when duplicate_object then null; end $$;

create table if not exists public.event_staff (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        public.event_role not null,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  unique (event_id, user_id, role)
);

create index if not exists idx_event_staff_event on public.event_staff(event_id);
create index if not exists idx_event_staff_user  on public.event_staff(user_id);

alter table public.event_staff enable row level security;

-- staff enxerga apenas as próprias atribuições; mutações vão pelo backend (service_role).
drop policy if exists "event_staff_self_read" on public.event_staff;
create policy "event_staff_self_read" on public.event_staff
  for select using (auth.uid() = user_id);

-- ── Helper de autorização: dono da org OU staff com um dos papéis ──
-- p_roles = NULL → qualquer papel (ou dono) serve.
create or replace function public.has_event_access(p_event uuid, p_user uuid, p_roles text[])
returns boolean as $$
  select
    exists (
      select 1 from public.events e
      join public.organizations o on o.id = e.organization_id
      where e.id = p_event and o.owner_id = p_user
    )
    or exists (
      select 1 from public.event_staff s
      where s.event_id = p_event
        and s.user_id = p_user
        and (p_roles is null or s.role::text = any (p_roles))
    );
$$ language sql stable security definer set search_path = public, pg_temp;

revoke execute on function public.has_event_access(uuid, uuid, text[]) from public, anon, authenticated;
grant  execute on function public.has_event_access(uuid, uuid, text[]) to service_role;
