-- ═══════════════════════════════════════════════════════════
-- 0043 — Assento marcado
--
-- Abre teatro, show sentado e casa com plateia numerada — mercado que hoje
-- não dá para atender, porque o lote só sabe "quantos", nunca "quais".
--
-- Sobre não usar seats.io: a recomendação de não construir o motor vale para
-- planta livre — arrastar cadeira, fileira curva, palco em L. O que a tela
-- desenhada pede é setor / fileira / número, que é uma grade. Grade não
-- justifica dependência externa, chave de API e custo por consulta.
--
-- O mecanismo central é o mesmo dos dois mundos: RESERVA TEMPORÁRIA. Sem
-- ela, duas pessoas escolhem a mesma poltrona e uma descobre no pagamento.
-- ═══════════════════════════════════════════════════════════

do $$ begin
  create type seat_status as enum ('free', 'held', 'sold', 'blocked');
exception when duplicate_object then null;
end $$;

create table if not exists public.event_seats (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references public.events (id) on delete cascade,
  -- O assento pertence a um LOTE: é ele que carrega o preço. "Plateia
  -- Premium R$ 280" e "Balcão R$ 90" são lotes diferentes, não atributos
  -- do assento — assim a virada de lote e a meia-entrada continuam valendo
  -- sem nenhuma regra nova.
  tier_id      uuid not null references public.ticket_tiers (id) on delete cascade,
  setor        text not null,
  fileira      text not null,
  numero       integer not null,
  status       public.seat_status not null default 'free',
  -- Posição na grade, para desenhar. Guardada em vez de calculada porque
  -- fileira real tem buraco: corredor, coluna, cadeira de rodas.
  col          integer not null default 0,
  row_idx      integer not null default 0,
  order_id     uuid references public.orders (id) on delete set null,
  held_by      uuid references public.profiles (id) on delete set null,
  held_until   timestamptz,
  created_at   timestamptz not null default now(),
  unique (event_id, setor, fileira, numero)
);

create index if not exists idx_seats_event_status
  on public.event_seats (event_id, status);
-- Varredura de reservas vencidas: só as que interessam entram no índice.
create index if not exists idx_seats_expira
  on public.event_seats (held_until)
  where status = 'held';

alter table public.event_seats enable row level security;

-- O mapa é público: quem ainda não tem conta precisa ver o que sobrou antes
-- de decidir criar uma. Só de eventos publicados.
do $$ begin
  create policy "seats_public_read" on public.event_seats
    for select using (
      exists (select 1 from public.events e where e.id = event_seats.event_id and e.status = 'published')
    );
exception when duplicate_object then null;
end $$;

-- Escrita só pela API. Assento é estoque: cliente mexendo direto seria o
-- mesmo que deixar alterar a própria carteira.
revoke insert, update, delete on public.event_seats from anon, authenticated;

-- ═══════════════════════════════════════════════════════════
-- liberar_assentos_vencidos — devolve ao mapa quem desistiu
--
-- Roda antes de toda leitura e de toda reserva. Sem isso, quem abandona o
-- carrinho leva a poltrona junto para sempre, e um teatro esgota sem ter
-- vendido.
-- ═══════════════════════════════════════════════════════════
create or replace function public.liberar_assentos_vencidos(p_event uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  update public.event_seats
     set status = 'free', held_by = null, held_until = null
   where status = 'held'
     and held_until < now()
     and (p_event is null or event_id = p_event);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ═══════════════════════════════════════════════════════════
-- reservar_assentos — a operação que impede dois donos na mesma poltrona
--
-- Tudo numa transação só, com `for update`: se duas pessoas tocam o mesmo
-- assento no mesmo instante, uma espera a outra e recebe a recusa. Fora do
-- banco isso viraria uma corrida que só aparece na noite de estreia.
--
-- A reserva VENCE. Prender assento até o pagamento seria dar a qualquer um
-- o poder de esgotar a casa de graça.
-- ═══════════════════════════════════════════════════════════
create or replace function public.reservar_assentos(
  p_event      uuid,
  p_seats      uuid[],
  p_user       uuid,
  p_minutos    integer default 8
)
returns table (id uuid, setor text, fileira text, numero integer, held_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ate    timestamptz := now() + make_interval(mins => greatest(1, least(30, p_minutos)));
  v_livres integer;
begin
  perform public.liberar_assentos_vencidos(p_event);

  -- Solta o que ESTA pessoa já segurava: trocar de assento no mapa não pode
  -- acumular reservas até ela travar a fileira inteira sozinha.
  update public.event_seats
     set status = 'free', held_by = null, held_until = null
   where event_id = p_event and held_by = p_user and status = 'held';

  select count(*) into v_livres
    from public.event_seats s
   where s.id = any(p_seats) and s.event_id = p_event and s.status = 'free'
     for update;

  if v_livres <> array_length(p_seats, 1) then
    raise exception 'ASSENTO_INDISPONIVEL';
  end if;

  return query
    update public.event_seats s
       set status = 'held', held_by = p_user, held_until = v_ate
     where s.id = any(p_seats) and s.event_id = p_event and s.status = 'free'
    returning s.id, s.setor, s.fileira, s.numero, s.held_until;
end;
$$;

/** Solta o que a pessoa segurava — ao sair do mapa ou cancelar. */
create or replace function public.soltar_assentos(p_event uuid, p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  update public.event_seats
     set status = 'free', held_by = null, held_until = null
   where event_id = p_event and held_by = p_user and status = 'held';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.reservar_assentos(uuid, uuid[], uuid, integer) from public, anon, authenticated;
revoke all on function public.soltar_assentos(uuid, uuid) from public, anon, authenticated;
revoke all on function public.liberar_assentos_vencidos(uuid) from public, anon, authenticated;
grant execute on function public.reservar_assentos(uuid, uuid[], uuid, integer) to service_role;
grant execute on function public.soltar_assentos(uuid, uuid) to service_role;
grant execute on function public.liberar_assentos_vencidos(uuid) to service_role;

comment on table public.event_seats is
  'Assento marcado. O preço vem do ticket_tier; o assento carrega só o lugar e o estado.';
