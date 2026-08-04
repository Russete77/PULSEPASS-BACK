-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0031 — REENTRADA CONTROLADA + LOTAÇÃO
--
--   Hoje o ingresso é consumido uma vez e pronto: quem sai pra fumar e volta
--   é barrado como "já utilizado". Numa balada isso vira discussão na porta
--   toda noite. Mas liberar reentrada sem controle é o caminho do ingresso
--   emprestado — um entra, sai, passa o celular pro amigo.
--
--   Solução: MOVIMENTOS. Cada passagem (entrada ou saída) vira linha. O
--   ingresso não some, ele muda de lado. Isso dá de graça:
--     · reentrada com limite por evento;
--     · lotação em tempo real (quantos estão DENTRO agora);
--     · histórico pra investigar fraude ("esse ingresso entrou 6 vezes").
-- ═══════════════════════════════════════════════════════════════

do $$ begin
  create type public.gate_direction as enum ('in', 'out');
exception when duplicate_object then null; end $$;

-- Política de reentrada por evento.
alter table public.events
  add column if not exists reentry_enabled boolean not null default false,
  add column if not exists reentry_max int;   -- null = sem limite quando habilitada

comment on column public.events.reentry_enabled is
  'Permite sair e voltar com o mesmo ingresso. Desligado por padrão: liberar sem a casa pedir é convite a ingresso emprestado.';

-- ── Movimentos de porta ──
create table if not exists public.gate_movements (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references public.tickets(id) on delete cascade,
  event_id    uuid not null references public.events(id) on delete cascade,
  direction   public.gate_direction not null,
  operator_id uuid references public.profiles(id),
  gate        text,                    -- portão/setor, quando a casa usa mais de um
  created_at  timestamptz not null default now()
);
create index if not exists idx_gate_ticket on public.gate_movements (ticket_id, created_at desc);
create index if not exists idx_gate_event on public.gate_movements (event_id, created_at desc);

alter table public.gate_movements enable row level security;
revoke all on public.gate_movements from anon, authenticated;

-- ── Passagem na porta: decide entrada, saída ou recusa ──
-- Substitui o "consome e acabou". Retorna sempre o mesmo vocabulário do
-- scanner (ok/already_used/invalid/…) mais o estado de presença.
create or replace function public.gate_pass(
  p_ticket uuid, p_event uuid, p_operator uuid default null,
  p_direction text default null,     -- null = automático (alterna dentro/fora)
  p_gate text default null
)
returns jsonb as $$
declare
  v_ticket public.tickets; v_event public.events;
  v_dentro boolean; v_entradas int; v_dir public.gate_direction;
begin
  select * into v_ticket from public.tickets where id = p_ticket for update;
  if not found then return jsonb_build_object('result', 'invalid', 'message', 'Ingresso não encontrado'); end if;
  if v_ticket.event_id <> p_event then
    return jsonb_build_object('result', 'wrong_event', 'message', 'Ingresso de outro evento');
  end if;
  if v_ticket.status not in ('valid', 'used') then
    return jsonb_build_object('result', 'invalid', 'message', 'Ingresso ' || v_ticket.status);
  end if;

  select * into v_event from public.events where id = p_event;

  -- Está dentro? Último movimento manda.
  select coalesce((select m.direction = 'in' from public.gate_movements m
                    where m.ticket_id = p_ticket order by m.created_at desc limit 1), false)
    into v_dentro;

  select count(*) into v_entradas from public.gate_movements
   where ticket_id = p_ticket and direction = 'in';

  -- Direção: explícita quando o porteiro escolhe, senão alterna.
  --
  -- A alternância só vale se o evento permite reentrada. Sem ela, "entrou,
  -- acabou": alternar transformaria o segundo bipe numa saída silenciosa e o
  -- ingresso poderia ser reaproveitado — exatamente o que a política proíbe.
  -- Saída EXPLÍCITA continua aceita mesmo sem reentrada, porque a casa pode
  -- querer contar lotação (bombeiro) sem liberar retorno.
  v_dir := case
    when p_direction in ('in', 'out') then p_direction::public.gate_direction
    when v_dentro and coalesce(v_event.reentry_enabled, false) then 'out'::public.gate_direction
    else 'in'::public.gate_direction
  end;

  if v_dir = 'in' then
    -- Primeira entrada sempre vale. Da segunda em diante, depende da política.
    if v_entradas > 0 then
      if not coalesce(v_event.reentry_enabled, false) then
        return jsonb_build_object('result', 'already_used', 'message', 'Ingresso já utilizado',
          'checked_in_at', v_ticket.checked_in_at, 'entries', v_entradas);
      end if;
      if v_dentro then
        return jsonb_build_object('result', 'already_used', 'message', 'Este ingresso já está dentro',
          'entries', v_entradas);
      end if;
      if v_event.reentry_max is not null and v_entradas >= v_event.reentry_max then
        return jsonb_build_object('result', 'already_used',
          'message', 'Limite de reentradas atingido (' || v_event.reentry_max || ')', 'entries', v_entradas);
      end if;
    end if;

    insert into public.gate_movements (ticket_id, event_id, direction, operator_id, gate)
    values (p_ticket, p_event, 'in', p_operator, p_gate);

    -- checked_in_at guarda a PRIMEIRA entrada (é o que relatório e manifesto usam).
    update public.tickets
       set status = 'used', checked_in_at = coalesce(checked_in_at, now())
     where id = p_ticket;

    return jsonb_build_object('result', 'ok',
      'message', case when v_entradas = 0 then 'Entrada liberada' else 'Reentrada liberada' end,
      'direction', 'in', 'entries', v_entradas + 1, 'inside', true);
  end if;

  -- Saída
  if not v_dentro then
    return jsonb_build_object('result', 'invalid', 'message', 'Este ingresso não está dentro', 'inside', false);
  end if;
  insert into public.gate_movements (ticket_id, event_id, direction, operator_id, gate)
  values (p_ticket, p_event, 'out', p_operator, p_gate);

  return jsonb_build_object('result', 'ok', 'message', 'Saída registrada',
    'direction', 'out', 'entries', v_entradas, 'inside', false);
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
revoke execute on function public.gate_pass(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.gate_pass(uuid, uuid, uuid, text, text) to service_role;

-- ── Lotação em tempo real ──
-- Quantos estão DENTRO agora: dado que o segurança e o bombeiro perguntam.
create or replace function public.event_occupancy(p_event uuid)
returns jsonb as $$
  with ultimo as (
    select distinct on (m.ticket_id) m.ticket_id, m.direction
      from public.gate_movements m
     where m.event_id = p_event
     order by m.ticket_id, m.created_at desc
  )
  select jsonb_build_object(
    'inside',        (select count(*) from ultimo where direction = 'in'),
    'left',          (select count(*) from ultimo where direction = 'out'),
    'total_entries', (select count(*) from public.gate_movements where event_id = p_event and direction = 'in'),
    'tickets_sold',  (select count(*) from public.tickets where event_id = p_event and status in ('valid','used'))
  );
$$ language sql security definer set search_path = public, pg_temp;
revoke execute on function public.event_occupancy(uuid) from public, anon, authenticated;
grant execute on function public.event_occupancy(uuid) to service_role;

-- ── Retrocompatibilidade: ingressos já usados antes desta migration ──
-- Sem isto eles apareceriam como "nunca entraram" e a lotação nasceria errada.
insert into public.gate_movements (ticket_id, event_id, direction, created_at)
select t.id, t.event_id, 'in', t.checked_in_at
  from public.tickets t
 where t.status = 'used' and t.checked_in_at is not null
   and not exists (select 1 from public.gate_movements m where m.ticket_id = t.id);

-- ═══════════════════════════════════════════════════════════════
