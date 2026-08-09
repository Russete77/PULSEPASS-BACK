-- ═══════════════════════════════════════════════════════════
-- 0047 — Turno de caixa e margem do cardápio
--
-- Duas lacunas da operação de bar que a tela desenhada mostra e o sistema
-- não tinha:
--
--  1. O caixa nunca ABRIU. Existia o relatório de fechamento por operador,
--     mas não o turno: sem hora de abertura e sem fundo de troco, "sobrou
--     R$ 300 na gaveta" não quer dizer nada — não há com o que comparar.
--
--  2. O cardápio sabia o preço de venda e não o de custo. Sem isso a
--     produtora escolhe o que promover no escuro: o chope de R$ 12 pode dar
--     menos lucro que a água de R$ 6, e ninguém tem como saber.
-- ═══════════════════════════════════════════════════════════

-- ── Custo do item ──
alter table public.menu_items
  -- Custo unitário. Nulo = não informado, e a tela mostra "—" em vez de
  -- fingir margem de 100%, que seria mentira confortável.
  add column if not exists cost_cents integer check (cost_cents is null or cost_cents >= 0);

comment on column public.menu_items.cost_cents is
  'Custo unitário. Nulo quando a produtora não informou — a margem some da tela em vez de ser inventada.';

-- ═══════════════════════════════════════════════════════════
-- Turno de caixa
--
-- O turno é do OPERADOR, não do evento: numa noite com três praças, cada
-- uma abre e fecha a sua gaveta, e misturar tudo num só número esconde
-- exatamente a diferença que a conferência procura.
-- ═══════════════════════════════════════════════════════════
create table if not exists public.cashier_shifts (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events (id) on delete cascade,
  operator_id    uuid not null references public.profiles (id) on delete restrict,
  station        text,
  -- Fundo de troco com que a gaveta começou. É o termo de comparação: sem
  -- ele, o dinheiro contado no fim não prova nada.
  opening_cents  integer not null default 0 check (opening_cents >= 0),
  -- Quanto o operador CONTOU ao fechar. Fica separado do que o sistema
  -- calcula, de propósito: a diferença entre os dois é o achado.
  counted_cents  integer check (counted_cents is null or counted_cents >= 0),
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  notes          text,
  created_at     timestamptz not null default now()
);

-- Um turno aberto por operador e evento. Sem isso, dois toques no botão
-- abrem duas gavetas e a conferência do fim da noite não fecha nunca.
create unique index if not exists uq_turno_aberto
  on public.cashier_shifts (event_id, operator_id)
  where closed_at is null;

create index if not exists idx_turnos_evento
  on public.cashier_shifts (event_id, opened_at desc);

alter table public.cashier_shifts enable row level security;
revoke insert, update, delete on public.cashier_shifts from anon, authenticated;

-- ═══════════════════════════════════════════════════════════
-- fechar_turno — a conferência da gaveta
--
-- Calcula o esperado (fundo + vendas em dinheiro do operador no período) e
-- devolve a diferença junto. Em RPC porque as duas metades precisam ser
-- lidas no mesmo instante: com a conta feita na aplicação, uma venda que
-- entra entre a leitura e o fechamento vira "quebra de caixa" fantasma.
-- ═══════════════════════════════════════════════════════════
create or replace function public.fechar_turno(
  p_turno   uuid,
  p_contado integer,
  p_notas   text default null
)
returns table (
  esperado_cents integer,
  contado_cents  integer,
  diferenca_cents integer,
  vendas_cents   integer,
  fundo_cents    integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.cashier_shifts;
  v_vendas integer;
begin
  select * into v from public.cashier_shifts where id = p_turno for update;
  if not found then raise exception 'TURNO_NAO_ENCONTRADO'; end if;
  if v.closed_at is not null then raise exception 'TURNO_JA_FECHADO'; end if;

  -- Só o que entrou EM DINHEIRO conta para a gaveta. Cartão e Pix caem na
  -- conta da produtora, não na mão do operador — somá-los aqui faria toda
  -- conferência acusar falta.
  select coalesce(sum(bs.amount_cents), 0) into v_vendas
    from public.box_office_sales bs
   where bs.event_id = v.event_id
     and bs.operator_id = v.operator_id
     and bs.method = 'cash'
     and bs.created_at >= v.opened_at;

  update public.cashier_shifts
     set closed_at = now(), counted_cents = p_contado, notes = coalesce(p_notas, notes)
   where id = p_turno;

  return query select
    (v.opening_cents + v_vendas)::integer,
    p_contado,
    (p_contado - v.opening_cents - v_vendas)::integer,
    v_vendas,
    v.opening_cents;
end;
$$;

revoke all on function public.fechar_turno(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.fechar_turno(uuid, integer, text) to service_role;

comment on table public.cashier_shifts is
  'Turno de caixa por operador. O fundo de troco é o termo de comparação — sem ele o dinheiro contado no fim não prova nada.';
