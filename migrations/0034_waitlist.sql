-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0034 — FILA DE ESPERA
--
--   Lote esgota, o cliente fecha a aba e vai comprar no cambista. Enquanto
--   isso, reembolsos e pedidos expirados devolvem ingressos ao estoque no
--   meio da madrugada, sem ninguém para comprá-los.
--
--   A fila liga as duas pontas: quem quis comprar fica registrado e é chamado
--   quando abre vaga. Receita que hoje simplesmente evapora.
--
--   Decisão importante: o convite é por ORDEM DE CHEGADA e tem PRAZO. Sem
--   prazo, o primeiro da fila trava a vaga indefinidamente e os outros nunca
--   são chamados — a fila viraria uma lista de espera eterna.
-- ═══════════════════════════════════════════════════════════════

do $$ begin
  create type public.waitlist_status as enum ('waiting', 'invited', 'converted', 'expired', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.waitlist (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events(id) on delete cascade,
  ticket_tier_id uuid references public.ticket_tiers(id) on delete cascade,
  profile_id     uuid references public.profiles(id) on delete set null,
  email          text not null,
  name           text,
  quantity       int not null default 1 check (quantity between 1 and 10),
  status         public.waitlist_status not null default 'waiting',
  position       bigint generated always as identity,  -- ordem de chegada
  invited_at     timestamptz,
  invite_expires_at timestamptz,
  converted_order_id uuid references public.orders(id) on delete set null,
  created_at     timestamptz not null default now()
);

-- Mesma pessoa não ocupa duas posições no mesmo lote.
create unique index if not exists uq_waitlist_ativo
  on public.waitlist (event_id, coalesce(ticket_tier_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(email))
  where status in ('waiting', 'invited');

create index if not exists idx_waitlist_fila on public.waitlist (event_id, ticket_tier_id, position)
  where status = 'waiting';
create index if not exists idx_waitlist_convites on public.waitlist (invite_expires_at)
  where status = 'invited';

alter table public.waitlist enable row level security;
revoke all on public.waitlist from anon, authenticated;

-- ── Entrar na fila ──
create or replace function public.waitlist_join(
  p_event uuid, p_tier uuid, p_email text, p_name text default null,
  p_quantity int default 1, p_profile uuid default null
)
returns jsonb as $$
declare v_id uuid; v_pos bigint; v_existente public.waitlist;
begin
  -- Já está na fila? Devolve a posição em vez de duplicar (o cliente costuma
  -- clicar duas vezes quando não vê retorno imediato).
  select * into v_existente from public.waitlist
   where event_id = p_event
     and coalesce(ticket_tier_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(p_tier, '00000000-0000-0000-0000-000000000000'::uuid)
     and lower(email) = lower(p_email)
     and status in ('waiting', 'invited');
  if found then
    return jsonb_build_object('id', v_existente.id, 'already', true, 'status', v_existente.status,
      'ahead', (select count(*) from public.waitlist w
                 where w.event_id = p_event and w.status = 'waiting' and w.position < v_existente.position));
  end if;

  insert into public.waitlist (event_id, ticket_tier_id, profile_id, email, name, quantity)
  values (p_event, p_tier, p_profile, lower(p_email), p_name, greatest(1, least(10, p_quantity)))
  returning id, position into v_id, v_pos;

  return jsonb_build_object('id', v_id, 'already', false, 'status', 'waiting',
    'ahead', (select count(*) from public.waitlist w
               where w.event_id = p_event and w.status = 'waiting' and w.position < v_pos));
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
revoke execute on function public.waitlist_join(uuid, uuid, text, text, int, uuid) from public, anon, authenticated;
grant execute on function public.waitlist_join(uuid, uuid, text, text, int, uuid) to service_role;

-- ── Convidar quem cabe na vaga que abriu ──
-- Chamada quando estoque volta (reembolso/expiração). Convida por ordem de
-- chegada, só até o número de vagas disponíveis, com prazo para comprar.
create or replace function public.waitlist_invite(
  p_tier uuid, p_slots int default null, p_ttl_minutes int default 60
)
returns jsonb as $$
declare
  v_tier public.ticket_tiers; v_disponivel int; v_vagas int;
  v_convidados jsonb := '[]'::jsonb; v_row public.waitlist;
begin
  select * into v_tier from public.ticket_tiers where id = p_tier for update;
  if not found then raise exception 'TIER_NOT_FOUND'; end if;

  -- Vagas reais = estoque livre menos convites em aberto (que já as reservam).
  v_disponivel := coalesce(v_tier.quantity_total, 0) - coalesce(v_tier.quantity_sold, 0);
  v_disponivel := v_disponivel - (
    select coalesce(sum(w.quantity), 0) from public.waitlist w
     where w.ticket_tier_id = p_tier and w.status = 'invited' and w.invite_expires_at > now());
  v_vagas := least(coalesce(p_slots, v_disponivel), v_disponivel);
  if v_vagas <= 0 then
    return jsonb_build_object('invited', 0, 'reason', 'sem vagas disponiveis');
  end if;

  for v_row in
    select * from public.waitlist
     where ticket_tier_id = p_tier and status = 'waiting'
     order by position asc
     for update skip locked
  loop
    exit when v_vagas < v_row.quantity;
    update public.waitlist
       set status = 'invited', invited_at = now(),
           invite_expires_at = now() + make_interval(mins => p_ttl_minutes)
     where id = v_row.id;
    v_vagas := v_vagas - v_row.quantity;
    v_convidados := v_convidados || jsonb_build_object(
      'id', v_row.id, 'email', v_row.email, 'name', v_row.name, 'quantity', v_row.quantity);
  end loop;

  return jsonb_build_object('invited', jsonb_array_length(v_convidados), 'guests', v_convidados);
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
revoke execute on function public.waitlist_invite(uuid, int, int) from public, anon, authenticated;
grant execute on function public.waitlist_invite(uuid, int, int) to service_role;

-- ── Expirar convites vencidos e devolver a vez a quem está atrás ──
create or replace function public.waitlist_expire_invites()
returns int as $$
declare v_n int;
begin
  with vencidos as (
    update public.waitlist set status = 'expired'
     where status = 'invited' and invite_expires_at < now()
     returning 1
  ) select count(*) into v_n from vencidos;
  return v_n;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
revoke execute on function public.waitlist_expire_invites() from public, anon, authenticated;
grant execute on function public.waitlist_expire_invites() to service_role;

-- ═══════════════════════════════════════════════════════════════
