-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0004 — Guest List + Promoters (AZList)
-- Aplicar após 0001/0002/0003.
-- ═══════════════════════════════════════════════════════════════

do $$ begin
  create type guest_status as enum ('confirmed','checked_in','cancelled');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────
-- PROMOTERS — cada um tem um código público (link) e comissão por cabeça
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.promoters (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  event_id         uuid not null references public.events(id) on delete cascade,
  profile_id       uuid references public.profiles(id),     -- conta do promoter (opcional)
  name             text not null,
  code             text unique not null,                    -- slug público do link
  commission_cents integer not null default 0 check (commission_cents >= 0),
  created_at       timestamptz not null default now()
);
create index if not exists idx_promoters_event on public.promoters (event_id);

-- ─────────────────────────────────────────────────────────────────
-- GUESTS — inscrições via link público do promoter
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.guests (
  id            uuid primary key default gen_random_uuid(),
  promoter_id   uuid not null references public.promoters(id) on delete cascade,
  event_id      uuid not null references public.events(id) on delete cascade,
  name          text not null,
  email         text,
  phone         text,
  status        guest_status not null default 'confirmed',
  created_at    timestamptz not null default now(),
  checked_in_at timestamptz
);
create index if not exists idx_guests_promoter on public.guests (promoter_id);
create index if not exists idx_guests_event on public.guests (event_id, status);

-- ─────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────
alter table public.promoters enable row level security;
alter table public.guests    enable row level security;

-- leitura pública do promoter pelo código (para a página de inscrição)
drop policy if exists "promoters_public_read" on public.promoters;
create policy "promoters_public_read" on public.promoters
  for select using (true);

-- guests: sem leitura pública (apenas service_role no backend gerencia)
-- (nenhuma policy = nega anon; backend usa service_role e bypassa)

-- ═══════════════════════════════════════════════════════════════
