-- ═══════════════════════════════════════════════════════════
-- 0044 — Corrige reservar_assentos
--
-- A 0043 fazia `select count(*) ... for update`, que o Postgres recusa:
-- "FOR UPDATE is not allowed with aggregate functions". A trava e a contagem
-- precisam ser dois passos.
--
-- A ordem importa e não é detalhe: TRAVA primeiro TODAS as linhas alvo —
-- livres ou não — e só então conta quantas estão livres. Travar apenas as
-- livres deixaria a janela aberta: outra transação poderia liberar uma
-- reservada no meio do caminho e as duas sairiam achando que ganharam.
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
  v_pedidos integer := coalesce(array_length(p_seats, 1), 0);
begin
  if v_pedidos = 0 then
    raise exception 'NENHUM_ASSENTO';
  end if;

  perform public.liberar_assentos_vencidos(p_event);

  -- Solta o que ESTA pessoa já segurava: trocar de assento no mapa não pode
  -- acumular reservas até ela travar a fileira inteira sozinha.
  update public.event_seats
     set status = 'free', held_by = null, held_until = null
   where event_id = p_event and held_by = p_user and status = 'held';

  -- Passo 1 — trava as linhas alvo. Quem chegar junto espera aqui.
  perform 1
     from public.event_seats s
    where s.id = any(p_seats) and s.event_id = p_event
    for update;

  -- Passo 2 — com as linhas travadas, a contagem já não muda debaixo dos pés.
  select count(*) into v_livres
    from public.event_seats s
   where s.id = any(p_seats) and s.event_id = p_event and s.status = 'free';

  if v_livres <> v_pedidos then
    raise exception 'ASSENTO_INDISPONIVEL';
  end if;

  return query
    update public.event_seats s
       set status = 'held', held_by = p_user, held_until = v_ate
     where s.id = any(p_seats) and s.event_id = p_event and s.status = 'free'
    returning s.id, s.setor, s.fileira, s.numero, s.held_until;
end;
$$;

revoke all on function public.reservar_assentos(uuid, uuid[], uuid, integer) from public, anon, authenticated;
grant execute on function public.reservar_assentos(uuid, uuid[], uuid, integer) to service_role;
