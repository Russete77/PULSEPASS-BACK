-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0011 — Cupons de desconto
-- Desconto percentual ou fixo, por evento, com limite de usos e validade.
-- A redenção é atômica (redeem_coupon) para não estourar max_uses.
-- ═══════════════════════════════════════════════════════════════

do $$ begin
  create type public.coupon_kind as enum ('percent', 'fixed');
exception when duplicate_object then null; end $$;

create table if not exists public.coupons (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  code        text not null,
  kind        public.coupon_kind not null,
  value       integer not null check (value > 0),   -- percent: 1..100 | fixed: centavos
  max_uses    integer,                              -- null = ilimitado
  used_count  integer not null default 0,
  active      boolean not null default true,
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (event_id, code)
);
create index if not exists idx_coupons_event on public.coupons(event_id);

alter table public.coupons enable row level security;
-- leitura pública de cupom ativo (para validar no checkout); escrita via backend.
drop policy if exists "coupons_public_read" on public.coupons;
create policy "coupons_public_read" on public.coupons
  for select using (active);

-- registro do cupom usado no pedido
alter table public.orders add column if not exists coupon_code text;
alter table public.orders add column if not exists discount_cents integer not null default 0;

-- ── Redenção atômica: valida e incrementa o uso; retorna o cupom ou nada ──
create or replace function public.redeem_coupon(p_event uuid, p_code text)
returns table(kind text, value int) as $$
declare c public.coupons;
begin
  select * into c from public.coupons
    where event_id = p_event and lower(code) = lower(p_code)
    for update;
  if not found then raise exception 'COUPON_INVALID'; end if;
  if not c.active then raise exception 'COUPON_INACTIVE'; end if;
  if c.expires_at is not null and c.expires_at < now() then raise exception 'COUPON_EXPIRED'; end if;
  if c.max_uses is not null and c.used_count >= c.max_uses then raise exception 'COUPON_EXHAUSTED'; end if;

  update public.coupons set used_count = used_count + 1 where id = c.id;
  return query select c.kind::text, c.value;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function public.redeem_coupon(uuid, text) from public, anon, authenticated;
grant  execute on function public.redeem_coupon(uuid, text) to service_role;
