-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0001 — Núcleo de Ticketing + Cashless
-- Postgres 15+ / Supabase · schema public · RLS habilitado
-- Aplicar via: supabase db push  OU  cole no SQL Editor do projeto
-- ═══════════════════════════════════════════════════════════════

-- Extensões -------------------------------------------------------
create extension if not exists "pgcrypto";        -- gen_random_uuid()
create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────────────────────────
do $$ begin
  create type user_role   as enum ('cliente','promoter','produtora','adm');
exception when duplicate_object then null; end $$;

do $$ begin
  create type event_status as enum ('draft','published','paused','ended','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tier_status  as enum ('scheduled','on_sale','sold_out','closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status as enum ('pending','paid','cancelled','expired','refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ticket_status as enum ('valid','used','transferred','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type wallet_tx_type as enum ('topup','spend','refund','adjustment');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────
-- updated_at helper
-- ─────────────────────────────────────────────────────────────────
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

-- ─────────────────────────────────────────────────────────────────
-- PROFILES — 1:1 com auth.users
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  cpf         text unique,
  phone       text,
  role        user_role not null default 'cliente',
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function set_updated_at();

-- Cria profile automaticamente quando nasce um auth.user
create or replace function public.handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────
-- ORGANIZATIONS (produtoras / casas)
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.organizations (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references public.profiles(id),
  name             text not null,
  slug             text unique not null,
  cnpj             text,
  asaas_wallet_id  text,              -- destino do split Asaas
  logo_url         text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger trg_orgs_updated before update on public.organizations
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- EVENTS
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  title            text not null,
  slug             text unique not null,
  description      text,
  cover_url        text,
  venue_name       text,
  address          text,
  city             text not null,
  state            char(2) not null,
  starts_at        timestamptz not null,
  ends_at          timestamptz,
  status           event_status not null default 'draft',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_events_status_city on public.events (status, city);
create index if not exists idx_events_starts_at   on public.events (starts_at);
create trigger trg_events_updated before update on public.events
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- TICKET TIERS (lotes)
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.ticket_tiers (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events(id) on delete cascade,
  name            text not null,
  description     text,
  price_cents     integer not null check (price_cents >= 0),
  quantity_total  integer not null check (quantity_total >= 0),
  quantity_sold   integer not null default 0 check (quantity_sold >= 0),
  max_per_order   integer not null default 6 check (max_per_order > 0),
  sales_start     timestamptz,
  sales_end       timestamptz,
  status          tier_status not null default 'on_sale',
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint chk_not_oversold check (quantity_sold <= quantity_total)
);
create index if not exists idx_tiers_event on public.ticket_tiers (event_id, position);
create trigger trg_tiers_updated before update on public.ticket_tiers
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- ORDERS
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.orders (
  id                  uuid primary key default gen_random_uuid(),
  buyer_id            uuid not null references public.profiles(id),
  event_id            uuid not null references public.events(id),
  status              order_status not null default 'pending',
  total_cents         integer not null check (total_cents >= 0),
  -- Asaas
  asaas_customer_id   text,
  asaas_payment_id    text,
  external_reference  text unique,
  pix_payload         text,           -- copia-e-cola
  pix_qr_base64       text,           -- imagem do QR (base64)
  pix_expiration      timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  paid_at             timestamptz,
  expires_at          timestamptz
);
create index if not exists idx_orders_buyer  on public.orders (buyer_id, created_at desc);
create index if not exists idx_orders_payment on public.orders (asaas_payment_id);
create trigger trg_orders_updated before update on public.orders
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- ORDER ITEMS
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders(id) on delete cascade,
  ticket_tier_id   uuid not null references public.ticket_tiers(id),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  quantity         integer not null check (quantity > 0)
);
create index if not exists idx_order_items_order on public.order_items (order_id);

-- ─────────────────────────────────────────────────────────────────
-- TICKETS (emitidos após pagamento)
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.tickets (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete cascade,
  event_id        uuid not null references public.events(id),
  ticket_tier_id  uuid not null references public.ticket_tiers(id),
  owner_id        uuid not null references public.profiles(id),
  code            text unique not null,            -- código curto legível
  qr_secret       text not null default encode(gen_random_bytes(16),'hex'),
  holder_name     text,
  status          ticket_status not null default 'valid',
  checked_in_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_tickets_owner on public.tickets (owner_id);
create index if not exists idx_tickets_event on public.tickets (event_id);
create trigger trg_tickets_updated before update on public.tickets
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- WALLETS + TRANSAÇÕES (cashless — base para fase futura)
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.wallets (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  event_id      uuid references public.events(id) on delete cascade,
  balance_cents integer not null default 0 check (balance_cents >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (profile_id, event_id)
);
create trigger trg_wallets_updated before update on public.wallets
  for each row execute function set_updated_at();

create table if not exists public.wallet_transactions (
  id           uuid primary key default gen_random_uuid(),
  wallet_id    uuid not null references public.wallets(id) on delete cascade,
  type         wallet_tx_type not null,
  amount_cents integer not null,
  description  text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_wallet_tx on public.wallet_transactions (wallet_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────
-- WEBHOOK EVENTS (idempotência Asaas)
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null default 'asaas',
  event_id     text unique,           -- id único do evento (idempotência)
  event_type   text,
  payload      jsonb not null,
  processed    boolean not null default false,
  created_at   timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────
-- RLS — Row Level Security
-- Backend usa service_role (bypassa RLS). Policies abaixo protegem
-- qualquer acesso direto via anon/authenticated key do cliente.
-- ─────────────────────────────────────────────────────────────────
alter table public.profiles            enable row level security;
alter table public.organizations       enable row level security;
alter table public.events              enable row level security;
alter table public.ticket_tiers        enable row level security;
alter table public.orders              enable row level security;
alter table public.order_items         enable row level security;
alter table public.tickets             enable row level security;
alter table public.wallets             enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.webhook_events      enable row level security;

-- profiles: cada um lê/edita o seu
create policy "profiles_self_select" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_self_update" on public.profiles
  for update using (auth.uid() = id);

-- events: catálogo público lê apenas eventos publicados
create policy "events_public_read" on public.events
  for select using (status = 'published');

-- ticket_tiers: lê lotes de eventos publicados
create policy "tiers_public_read" on public.ticket_tiers
  for select using (
    exists (select 1 from public.events e
            where e.id = ticket_tiers.event_id and e.status = 'published')
  );

-- orders: comprador vê os próprios pedidos
create policy "orders_owner_read" on public.orders
  for select using (auth.uid() = buyer_id);

-- order_items: via pedido do comprador
create policy "order_items_owner_read" on public.order_items
  for select using (
    exists (select 1 from public.orders o
            where o.id = order_items.order_id and o.buyer_id = auth.uid())
  );

-- tickets: dono vê os próprios ingressos
create policy "tickets_owner_read" on public.tickets
  for select using (auth.uid() = owner_id);

-- wallets: dono vê a própria carteira
create policy "wallets_owner_read" on public.wallets
  for select using (auth.uid() = profile_id);
create policy "wallet_tx_owner_read" on public.wallet_transactions
  for select using (
    exists (select 1 from public.wallets w
            where w.id = wallet_transactions.wallet_id and w.profile_id = auth.uid())
  );

-- webhook_events: somente service_role (sem policy = nega tudo p/ anon)

-- ═══════════════════════════════════════════════════════════════
-- Fim da migration 0001
-- ═══════════════════════════════════════════════════════════════
