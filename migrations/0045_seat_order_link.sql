-- ═══════════════════════════════════════════════════════════
-- 0045 — Amarra o assento ao pedido
--
-- Até aqui o mapa reservava e soltava, mas a reserva morria no caminho até o
-- checkout: o pedido nascia sem saber quais poltronas eram dele, e a reserva
-- vencia em 8 minutos mesmo depois de pago. A pessoa pagava e perdia o lugar.
--
-- A ligação vira estado do PEDIDO, e quem a mantém é um GATILHO, não o
-- código da aplicação. O motivo é direto: um pedido muda de status por meia
-- dúzia de caminhos — webhook de pagamento, expiração automática,
-- cancelamento manual, estorno, chargeback — e cada um deles teria que
-- lembrar de mexer no assento. O que é esquecido uma vez vira poltrona
-- presa para sempre, ou pior: assento vendido que volta a ser oferecido.
-- ═══════════════════════════════════════════════════════════

/**
 * Liga os assentos que a pessoa está segurando ao pedido recém-criado.
 *
 * Exige que ela seja a dona da reserva e que a reserva esteja viva. Sem essa
 * checagem, bastaria enviar o id de uma poltrona alheia no corpo da
 * requisição para roubá-la no momento do checkout.
 */
create or replace function public.vincular_assentos_ao_pedido(
  p_order uuid,
  p_user  uuid,
  p_seats uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event uuid;
  v_ok    integer;
  v_n     integer;
begin
  if p_seats is null or array_length(p_seats, 1) is null then
    return 0;
  end if;

  select event_id into v_event from public.orders where id = p_order;
  if not found then
    raise exception 'PEDIDO_NAO_ENCONTRADO';
  end if;

  -- Trava antes de conferir: entre a checagem e a gravação cabe outra
  -- transação, e é nessa fresta que duas pessoas saem com a mesma poltrona.
  perform 1 from public.event_seats
   where id = any(p_seats) and event_id = v_event
   for update;

  select count(*) into v_ok
    from public.event_seats
   where id = any(p_seats)
     and event_id = v_event
     and status = 'held'
     and held_by = p_user
     and held_until > now();

  if v_ok <> array_length(p_seats, 1) then
    raise exception 'RESERVA_EXPIRADA_OU_ALHEIA';
  end if;

  update public.event_seats
     set order_id = p_order
   where id = any(p_seats) and event_id = v_event;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ═══════════════════════════════════════════════════════════
-- Gatilho: o estado do assento SEGUE o estado do pedido
--
-- pago      → vendido, e a reserva deixa de vencer (held_until vira null).
--             Sem isso o assento voltaria ao mapa 8 minutos depois de pago.
-- desfeito  → livre. Cancelado, expirado, estornado — em todos a poltrona
--             volta para quem quiser, e ela não pode depender de alguém
--             lembrar de rodar uma rotina de limpeza.
-- ═══════════════════════════════════════════════════════════
create or replace function public.assentos_seguem_o_pedido()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if new.status = 'paid' then
    update public.event_seats
       set status = 'sold', held_until = null
     where order_id = new.id;

  elsif new.status in ('cancelled', 'expired', 'refunded') then
    update public.event_seats
       set status = 'free', order_id = null, held_by = null, held_until = null
     where order_id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_assentos_seguem_o_pedido on public.orders;
create trigger trg_assentos_seguem_o_pedido
  after update of status on public.orders
  for each row
  execute function public.assentos_seguem_o_pedido();

revoke all on function public.vincular_assentos_ao_pedido(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.vincular_assentos_ao_pedido(uuid, uuid, uuid[]) to service_role;

comment on function public.assentos_seguem_o_pedido is
  'O assento acompanha o pedido. Em gatilho porque o pedido muda de status por vários caminhos e nenhum deles pode esquecer da poltrona.';
