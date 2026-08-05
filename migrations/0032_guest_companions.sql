-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0032 — ACOMPANHANTES NA LISTA (+N)
--
--   Na guest list de balada quase ninguém vai sozinho: "João +2". Hoje o
--   convidado é 1 pessoa e o check-in é liga/desliga, então o porteiro tem
--   duas saídas ruins — cadastrar três linhas na mão, ou deixar entrar sem
--   registro. Nos dois casos a contagem da casa fica errada.
--
--   Aqui o convidado passa a ter LOTAÇÃO: total de pessoas e quantas já
--   entraram. Isso permite chegada parcial ("vieram 2 dos 3"), que é o caso
--   comum — o grupo raramente chega junto.
-- ═══════════════════════════════════════════════════════════════

alter table public.guests
  add column if not exists party_size int not null default 1,
  add column if not exists checked_in_count int not null default 0;

-- Coerência: não pode ter entrado mais gente do que foi convidada.
do $$ begin
  alter table public.guests add constraint guests_party_size_valido check (party_size >= 1);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.guests add constraint guests_checkin_dentro_do_grupo
    check (checked_in_count >= 0 and checked_in_count <= party_size);
exception when duplicate_object then null; end $$;

comment on column public.guests.party_size is
  'Total de pessoas do convite (o próprio convidado + acompanhantes).';
comment on column public.guests.checked_in_count is
  'Quantas já entraram. Permite chegada parcial: o grupo raramente chega junto.';

-- Convidados que já tinham check-in antes desta migration contam como 1.
update public.guests set checked_in_count = 1
 where status = 'checked_in' and checked_in_count = 0;

-- ── Check-in de convidado com acompanhantes ──
-- Recebe QUANTAS pessoas estão entrando agora. Idempotência aqui seria errada:
-- chegar mais gente do mesmo convite é evento novo, não repetição.
create or replace function public.guest_check_in(p_guest uuid, p_people int default 1)
returns jsonb as $$
declare v_guest public.guests; v_novo int;
begin
  if p_people < 1 then raise exception 'INVALID_PEOPLE'; end if;

  select * into v_guest from public.guests where id = p_guest for update;
  if not found then raise exception 'GUEST_NOT_FOUND'; end if;
  if v_guest.status = 'cancelled' then raise exception 'GUEST_CANCELLED'; end if;

  v_novo := v_guest.checked_in_count + p_people;
  if v_novo > v_guest.party_size then
    return jsonb_build_object(
      'result', 'over_capacity',
      'message', 'O convite é para ' || v_guest.party_size || ' pessoa(s) e ' ||
                 v_guest.checked_in_count || ' já entraram',
      'party_size', v_guest.party_size, 'checked_in_count', v_guest.checked_in_count,
      'remaining', v_guest.party_size - v_guest.checked_in_count);
  end if;

  update public.guests
     set checked_in_count = v_novo,
         status = 'checked_in',
         -- Guarda o horário da PRIMEIRA chegada do grupo.
         checked_in_at = coalesce(checked_in_at, now())
   where id = p_guest;

  return jsonb_build_object(
    'result', 'ok',
    'message', case when v_novo = v_guest.party_size
                    then 'Grupo completo liberado'
                    else v_novo || ' de ' || v_guest.party_size || ' liberado(s)' end,
    'admitted', p_people,
    'party_size', v_guest.party_size, 'checked_in_count', v_novo,
    'remaining', v_guest.party_size - v_novo,
    'complete', v_novo = v_guest.party_size);
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
revoke execute on function public.guest_check_in(uuid, int) from public, anon, authenticated;
grant execute on function public.guest_check_in(uuid, int) to service_role;

-- ── Resumo da lista para a porta ──
-- Pessoas, não linhas: a casa controla lotação por gente que entrou.
create or replace function public.guestlist_summary(p_event uuid)
returns jsonb as $$
  select jsonb_build_object(
    'guests',          count(*),
    'people_expected', coalesce(sum(party_size), 0),
    'people_arrived',  coalesce(sum(checked_in_count), 0),
    'groups_complete', count(*) filter (where checked_in_count = party_size and checked_in_count > 0),
    'groups_partial',  count(*) filter (where checked_in_count > 0 and checked_in_count < party_size)
  )
  from public.guests
  where event_id = p_event and status <> 'cancelled';
$$ language sql security definer set search_path = public, pg_temp;
revoke execute on function public.guestlist_summary(uuid) from public, anon, authenticated;
grant execute on function public.guestlist_summary(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════
