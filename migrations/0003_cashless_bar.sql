-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0003 — Cashless · Bar · Transferência
-- Fase 2 (super-app Cliente). Aplicar após 0001/0002.
-- ═══════════════════════════════════════════════════════════════

-- ── ENUMS ──
do $$ begin
  create type topup_status as enum ('pending','paid','expired','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bar_order_status as enum ('paid','preparing','ready','delivered','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type transfer_status as enum ('pending','accepted','cancelled');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────
-- MENU (cardápio do bar, por evento)
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.menu_items (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references public.events(id) on delete cascade,
  name         text not null,
  description  text,
  category     text default 'Geral',
  price_cents  integer not null check (price_cents >= 0),
  image_url    text,
  available    boolean not null default true,
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_menu_event on public.menu_items (event_id, position);
drop trigger if exists trg_menu_updated on public.menu_items;
create trigger trg_menu_updated before update on public.menu_items
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- WALLET TOP-UPS (recarga via Pix)
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.wallet_topups (
  id                  uuid primary key default gen_random_uuid(),
  profile_id          uuid not null references public.profiles(id),
  event_id            uuid references public.events(id) on delete set null,
  amount_cents        integer not null check (amount_cents > 0),
  status              topup_status not null default 'pending',
  asaas_payment_id    text,
  external_reference  text unique,
  pix_payload         text,
  pix_qr_base64       text,
  pix_expiration      timestamptz,
  created_at          timestamptz not null default now(),
  paid_at             timestamptz
);
create index if not exists idx_topups_profile on public.wallet_topups (profile_id, created_at desc);
create index if not exists idx_topups_payment on public.wallet_topups (asaas_payment_id);

-- ─────────────────────────────────────────────────────────────────
-- BAR ORDERS (pedido no bar, pago com saldo da carteira)
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.bar_orders (
  id           uuid primary key default gen_random_uuid(),
  buyer_id     uuid not null references public.profiles(id),
  event_id     uuid not null references public.events(id),
  wallet_id    uuid references public.wallets(id),
  status       bar_order_status not null default 'paid',
  total_cents  integer not null check (total_cents >= 0),
  pickup_code  text,                         -- código de retirada
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_bar_orders_buyer on public.bar_orders (buyer_id, created_at desc);
create index if not exists idx_bar_orders_event on public.bar_orders (event_id, status);
drop trigger if exists trg_bar_orders_updated on public.bar_orders;
create trigger trg_bar_orders_updated before update on public.bar_orders
  for each row execute function set_updated_at();

create table if not exists public.bar_order_items (
  id               uuid primary key default gen_random_uuid(),
  bar_order_id     uuid not null references public.bar_orders(id) on delete cascade,
  menu_item_id     uuid not null references public.menu_items(id),
  name             text not null,            -- snapshot do nome
  unit_price_cents integer not null check (unit_price_cents >= 0),
  quantity         integer not null check (quantity > 0),
  notes            text
);
create index if not exists idx_bar_items_order on public.bar_order_items (bar_order_id);

-- ─────────────────────────────────────────────────────────────────
-- TICKET TRANSFERS
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.ticket_transfers (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references public.tickets(id) on delete cascade,
  from_user    uuid not null references public.profiles(id),
  to_email     text not null,
  to_user      uuid references public.profiles(id),
  status       transfer_status not null default 'pending',
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz
);
create index if not exists idx_transfers_ticket on public.ticket_transfers (ticket_id);

-- ─────────────────────────────────────────────────────────────────
-- Débito atômico de saldo (evita corrida): retorna o novo saldo
-- ou NULL se saldo insuficiente.
-- ─────────────────────────────────────────────────────────────────
create or replace function public.spend_wallet(p_wallet uuid, p_amount integer)
returns integer as $$
declare new_balance integer;
begin
  update public.wallets
     set balance_cents = balance_cents - p_amount,
         updated_at = now()
   where id = p_wallet and balance_cents >= p_amount
   returning balance_cents into new_balance;
  return new_balance;  -- NULL quando não atualizou (saldo insuficiente)
end;
$$ language plpgsql security definer;

-- ─────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────
alter table public.menu_items       enable row level security;
alter table public.wallet_topups    enable row level security;
alter table public.bar_orders       enable row level security;
alter table public.bar_order_items  enable row level security;
alter table public.ticket_transfers enable row level security;

-- cardápio: leitura pública para eventos publicados
drop policy if exists "menu_public_read" on public.menu_items;
create policy "menu_public_read" on public.menu_items
  for select using (
    available and exists (
      select 1 from public.events e
      where e.id = menu_items.event_id and e.status = 'published'
    )
  );

drop policy if exists "topups_owner_read" on public.wallet_topups;
create policy "topups_owner_read" on public.wallet_topups
  for select using (auth.uid() = profile_id);

drop policy if exists "bar_orders_owner_read" on public.bar_orders;
create policy "bar_orders_owner_read" on public.bar_orders
  for select using (auth.uid() = buyer_id);

drop policy if exists "bar_items_owner_read" on public.bar_order_items;
create policy "bar_items_owner_read" on public.bar_order_items
  for select using (
    exists (select 1 from public.bar_orders o
            where o.id = bar_order_items.bar_order_id and o.buyer_id = auth.uid())
  );

drop policy if exists "transfers_party_read" on public.ticket_transfers;
create policy "transfers_party_read" on public.ticket_transfers
  for select using (auth.uid() = from_user or auth.uid() = to_user);

-- (Seed de cardápio removido daqui — dados de exemplo agora ficam só no
--  0014_demo_seed.sql, separados do schema. Schema não deve conter dados.)

-- ═══════════════════════════════════════════════════════════════
