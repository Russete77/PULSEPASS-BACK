-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0028 — BILHETERIA FÍSICA (venda na porta)
--
--   Todo evento vende na entrada: dinheiro, maquininha própria da casa, Pix
--   na chave do dono. Esse dinheiro nunca passa pelo Asaas, então o caminho
--   confirm_order_payment (que indexa por asaas_payment_id) não serve.
--
--   Aqui entra settle_order_offline: mesma emissão de ingressos, mesma
--   idempotência, mas liquidando um pedido presencial e deixando trilha de
--   QUEM vendeu, POR QUANTO e COMO — sem isso não há como fechar o caixa da
--   bilheteria nem apurar diferença no fim da noite.
-- ═══════════════════════════════════════════════════════════════

do $$ begin
  create type public.box_office_method as enum ('cash', 'card_machine', 'pix_manual', 'courtesy');
exception when duplicate_object then null; end $$;

-- ── Venda presencial: uma linha por pedido liquidado na bilheteria ──
create table if not exists public.box_office_sales (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null unique references public.orders(id) on delete cascade,
  event_id       uuid not null references public.events(id),
  operator_id    uuid not null references public.profiles(id),   -- quem vendeu
  method         public.box_office_method not null,
  amount_cents   integer not null check (amount_cents >= 0),     -- valor do pedido
  received_cents integer not null check (received_cents >= 0),   -- o que entrou na mão
  change_cents   integer not null default 0 check (change_cents >= 0),
  buyer_name     text,                                           -- portador (venda sem cadastro)
  buyer_doc      text,
  note           text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_box_office_event on public.box_office_sales (event_id, created_at desc);
create index if not exists idx_box_office_operator on public.box_office_sales (operator_id, created_at desc);

alter table public.box_office_sales enable row level security;
-- Sem política: só o backend (service_role) enxerga. Dado financeiro operacional.
revoke all on public.box_office_sales from anon, authenticated;

-- ── Liquidação presencial: marca pago, emite ingressos e registra a venda ──
-- Idempotente por pedido: repetir a chamada devolve o mesmo resultado sem
-- emitir ingresso a mais (bilheteria com internet ruim reenvia o tempo todo).
create or replace function public.settle_order_offline(
  p_order        uuid,
  p_operator     uuid,
  p_method       text,
  p_received_cents integer default null,
  p_buyer_name   text default null,
  p_buyer_doc    text default null,
  p_note         text default null
)
returns jsonb as $$
declare
  v_order public.orders; v_item public.order_items; n int; v_count int := 0;
  v_received int; v_change int; v_existing public.box_office_sales;
begin
  select * into v_order from public.orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  -- Replay: pedido já liquidado na bilheteria devolve o que aconteceu antes.
  select * into v_existing from public.box_office_sales where order_id = p_order;
  if found then
    return jsonb_build_object('order_id', p_order, 'already_settled', true,
      'total_cents', v_existing.amount_cents, 'change_cents', v_existing.change_cents,
      'emitted', (select count(*) from public.tickets where order_id = p_order));
  end if;

  if v_order.status <> 'pending' then raise exception 'ORDER_NOT_PENDING:%', v_order.status; end if;

  -- Cortesia: ingresso da casa. O total vai a ZERO (senão o caixa fecharia
  -- cobrando um dinheiro que ninguém pagou), mas o estoque do lote continua
  -- consumido — a cortesia ocupa uma vaga real no evento.
  if p_method = 'courtesy' then
    update public.orders set total_cents = 0 where id = v_order.id;
    v_order.total_cents := 0;
  end if;

  v_received := coalesce(p_received_cents, v_order.total_cents);
  if v_received < v_order.total_cents then raise exception 'INSUFFICIENT_PAYMENT'; end if;
  v_change := v_received - v_order.total_cents;

  update public.orders set status = 'paid', paid_at = now() where id = v_order.id;

  -- Mesma emissão do fluxo online: 1 ingresso por unidade de cada item.
  for v_item in select * from public.order_items where order_id = v_order.id loop
    for n in 1..v_item.quantity loop
      insert into public.tickets (order_id, event_id, ticket_tier_id, owner_id, code, status, holder_name)
      values (v_order.id, v_order.event_id, v_item.ticket_tier_id, v_order.buyer_id,
              public.gen_ticket_code(), 'valid', p_buyer_name);
      v_count := v_count + 1;
    end loop;
  end loop;

  insert into public.box_office_sales
    (order_id, event_id, operator_id, method, amount_cents, received_cents, change_cents, buyer_name, buyer_doc, note)
  values (v_order.id, v_order.event_id, p_operator, p_method::public.box_office_method,
          v_order.total_cents, v_received, v_change, p_buyer_name, p_buyer_doc, p_note);

  return jsonb_build_object('order_id', v_order.id, 'already_settled', false,
    'total_cents', v_order.total_cents, 'received_cents', v_received,
    'change_cents', v_change, 'emitted', v_count);
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
revoke execute on function public.settle_order_offline(uuid, uuid, text, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.settle_order_offline(uuid, uuid, text, integer, text, text, text)
  to service_role;

-- ── Fechamento do caixa da bilheteria (por evento) ──
-- O que a produtora precisa às 4h da manhã: quanto entrou, por forma, por
-- operador, e quantos ingressos saíram — pra bater com o dinheiro na mão.
create or replace function public.box_office_report(p_event uuid)
returns jsonb as $$
declare v_result jsonb;
begin
  select jsonb_build_object(
    'total_cents',   coalesce(sum(s.amount_cents), 0),
    'sales_count',   count(*),
    'tickets_count', coalesce(sum((select count(*) from public.tickets t where t.order_id = s.order_id)), 0),
    'by_method', coalesce((
      select jsonb_object_agg(m.method, m.obj) from (
        select x.method::text as method,
               jsonb_build_object('total_cents', sum(x.amount_cents), 'count', count(*)) as obj
          from public.box_office_sales x where x.event_id = p_event group by x.method
      ) m), '{}'::jsonb),
    'by_operator', coalesce((
      select jsonb_agg(o.obj) from (
        select jsonb_build_object(
                 'operator_id', x.operator_id,
                 'name', (select p.full_name from public.profiles p where p.id = x.operator_id),
                 'total_cents', sum(x.amount_cents), 'count', count(*)) as obj
          from public.box_office_sales x where x.event_id = p_event group by x.operator_id
      ) o), '[]'::jsonb)
  ) into v_result
  from public.box_office_sales s where s.event_id = p_event;
  return v_result;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
revoke execute on function public.box_office_report(uuid) from public, anon, authenticated;
grant execute on function public.box_office_report(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════
