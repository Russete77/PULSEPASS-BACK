-- ═══════════════════════════════════════════════════════════
-- 0040 — Serviço de bar: mesa, praça e cronômetro do preparo
--
-- O ciclo paid → preparing → ready → delivered já existia no enum
-- bar_order_status desde a 0003, mas nada no sistema o movia: não havia
-- endpoint, tela, nem sequer onde registrar QUANDO cada etapa aconteceu.
-- Um pedido nascia 'paid' e morria 'paid'.
--
-- Esta migration dá ao pedido as três coisas que a cozinha precisa saber:
--   de onde veio  (mesa? qual praça? ou o app?)
--   há quanto tempo espera
--   quem o atendeu
-- ═══════════════════════════════════════════════════════════

-- ── Origem do pedido ──
-- Sem isto o KDS não sabe para ONDE entregar. Um pedido de mesa vai até a
-- pessoa; um de praça de bar espera ser retirado no balcão. São operações
-- diferentes e a cozinha precisa distinguir de relance.
alter table public.bar_orders
  add column if not exists table_id uuid references public.event_tables (id) on delete set null,
  add column if not exists station text,          -- "Bar Central", "Bar VIP" — praça que preparou
  add column if not exists waiter_id uuid references public.profiles (id) on delete set null;

-- ── Cronômetro ──
-- O valor de uma tela de cozinha está em mostrar o tempo de espera, não a
-- lista de pedidos. Sem marcar o instante de cada transição não há como
-- dizer "esse está esperando há 12 minutos" — que é a única informação que
-- muda o comportamento de quem está na chapa.
alter table public.bar_orders
  add column if not exists preparing_at timestamptz,
  add column if not exists ready_at     timestamptz,
  add column if not exists delivered_at timestamptz;

-- ── Índice do KDS ──
-- A consulta da cozinha é sempre a mesma: pedidos em aberto deste evento,
-- mais velho primeiro. Parcial porque 'delivered' e 'cancelled' são a
-- maioria esmagadora das linhas depois de uma hora de evento, e nenhuma
-- delas interessa à tela.
create index if not exists idx_bar_orders_kds
  on public.bar_orders (event_id, created_at)
  where status in ('paid', 'preparing', 'ready');

create index if not exists idx_bar_orders_table
  on public.bar_orders (table_id)
  where table_id is not null;

-- ═══════════════════════════════════════════════════════════
-- advance_bar_order — move o pedido uma etapa adiante
--
-- Em RPC, e não em UPDATE solto no cliente, por dois motivos:
--
-- 1) A transição é validada. Só se anda para FRENTE, e só pelo caminho
--    previsto. Sem isso, dois toques na mesma tela devolveriam um pedido
--    entregue para "em preparo", e a cozinha refaria o prato.
--
-- 2) O carimbo de tempo e o status mudam juntos, na mesma linha. Separados,
--    uma falha entre os dois deixaria um pedido 'ready' sem ready_at, e o
--    cronômetro mostraria tempo de espera errado pelo resto da noite.
-- ═══════════════════════════════════════════════════════════
create or replace function public.advance_bar_order(
  p_order    uuid,
  p_para     text,
  p_operador uuid default null,
  p_station  text default null
)
returns public.bar_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_atual public.bar_order_status;
  v_row   public.bar_orders;
begin
  select status into v_atual from public.bar_orders where id = p_order for update;
  if not found then
    raise exception 'PEDIDO_NAO_ENCONTRADO';
  end if;

  -- Só para frente. 'cancelled' é a única saída lateral, e apenas antes de
  -- entregar — depois de entregue não existe desfazer: o produto já foi.
  if p_para = 'preparing' and v_atual <> 'paid' then
    raise exception 'TRANSICAO_INVALIDA: % -> preparing', v_atual;
  elsif p_para = 'ready' and v_atual not in ('paid', 'preparing') then
    raise exception 'TRANSICAO_INVALIDA: % -> ready', v_atual;
  elsif p_para = 'delivered' and v_atual not in ('preparing', 'ready') then
    raise exception 'TRANSICAO_INVALIDA: % -> delivered', v_atual;
  elsif p_para = 'cancelled' and v_atual = 'delivered' then
    raise exception 'TRANSICAO_INVALIDA: pedido ja entregue';
  elsif p_para not in ('preparing', 'ready', 'delivered', 'cancelled') then
    raise exception 'ESTADO_DESCONHECIDO: %', p_para;
  end if;

  update public.bar_orders set
    status       = p_para::public.bar_order_status,
    -- coalesce preserva o primeiro carimbo: reenviar a mesma transição não
    -- reinicia o cronômetro nem apaga o histórico de tempo.
    preparing_at = case when p_para = 'preparing' then coalesce(preparing_at, now()) else preparing_at end,
    ready_at     = case when p_para = 'ready'     then coalesce(ready_at, now())     else ready_at end,
    delivered_at = case when p_para = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
    station      = coalesce(p_station, station),
    operator_id  = coalesce(p_operador, operator_id),
    updated_at   = now()
  where id = p_order
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.advance_bar_order(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.advance_bar_order(uuid, text, uuid, text) to service_role;

comment on function public.advance_bar_order is
  'Avança o pedido do bar uma etapa, validando a transição e carimbando o horário. Só via service_role (a API checa o papel de bar/gerente antes).';
