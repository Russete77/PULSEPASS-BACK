-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0025 — FASE 3 (AzList): mesa/camarote/bottle service
--   • event_tables — camarotes/mesas do evento (consumação mínima)
--   • table_reservations — solicitações de reserva (fluxo requested→confirmed/rejected)
-- Aplicar após 0001..0024.
-- ═══════════════════════════════════════════════════════════════

create table if not exists public.event_tables (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references public.events(id) on delete cascade,
  name             text not null,
  area             text default 'Camarote',
  capacity         integer check (capacity is null or capacity > 0),
  min_spend_cents  integer not null default 0 check (min_spend_cents >= 0),
  active           boolean not null default true,
  position         integer not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists idx_event_tables_event on public.event_tables (event_id, position);

do $$ begin
  create type public.reservation_status as enum ('requested', 'confirmed', 'rejected', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.table_reservations (
  id           uuid primary key default gen_random_uuid(),
  table_id     uuid not null references public.event_tables(id) on delete cascade,
  event_id     uuid not null references public.events(id) on delete cascade,
  profile_id   uuid references public.profiles(id),
  name         text not null,
  contact      text,
  party_size   integer check (party_size is null or party_size > 0),
  status       public.reservation_status not null default 'requested',
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_reservations_event on public.table_reservations (event_id, status);
create index if not exists idx_reservations_table on public.table_reservations (table_id);

drop trigger if exists trg_reservations_updated on public.table_reservations;
create trigger trg_reservations_updated before update on public.table_reservations
  for each row execute function public.set_updated_at();

-- RLS
alter table public.event_tables enable row level security;
drop policy if exists "event_tables_public_read" on public.event_tables;
create policy "event_tables_public_read" on public.event_tables
  for select using (
    active and exists (select 1 from public.events e where e.id = event_tables.event_id and e.status = 'published')
  );

alter table public.table_reservations enable row level security;
-- criação/gestão via backend (service_role); solicitante lê as próprias.
drop policy if exists "reservations_owner_read" on public.table_reservations;
create policy "reservations_owner_read" on public.table_reservations
  for select using (auth.uid() = profile_id);

-- ═══════════════════════════════════════════════════════════════
