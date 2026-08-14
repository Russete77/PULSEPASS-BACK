-- ═══════════════════════════════════════════════════════════
-- 0056 — Programa de fidelidade (ledger de pontos)
--
-- ESTE PROGRAMA NASCE DESLIGADO, E ISSO É A DECISÃO MAIS IMPORTANTE AQUI.
--
-- Ponto de fidelidade é dinheiro com outro nome: no momento em que a pessoa
-- resgata, alguém paga a diferença. Quem paga, quanto vale um ponto e quantos
-- pontos um real gera são decisões comerciais da produtora — não do código.
-- Um padrão inventado aqui viraria promessa que a casa descobre no
-- fechamento, quando já prometeu ao cliente.
--
-- Por isso: `ativo = false` por padrão, `pontos_por_real` e `centavos_por_ponto`
-- sem valor sugerido. Enquanto a produtora não configurar, nada acumula e a
-- tela diz que o programa não está ativo.
--
-- A INTEGRIDADE segue a mesma regra da carteira (F0.6): o saldo NÃO é uma
-- coluna que se atualiza, é a SOMA DO LEDGER. Coluna de saldo diverge no
-- primeiro erro de caminho e ninguém percebe até a conferência não fechar.
--
-- E o furo clássico do cashback: comprar, ganhar ponto, resgatar, pedir
-- estorno. O estorno ESTORNA OS PONTOS junto — via gatilho, não via código de
-- aplicação, porque pedido muda de status por meia dúzia de caminhos.
-- O saldo pode ficar NEGATIVO nesse caso, e fica de propósito: apagar a
-- dívida seria a plataforma pagando pelo golpe.
-- ═══════════════════════════════════════════════════════════

do $$ begin
  create type fidelidade_tipo as enum ('acumulo', 'resgate', 'estorno', 'ajuste');
exception when duplicate_object then null; end $$;

-- ── Configuração por produtora ──
create table if not exists public.fidelidade_config (
  organization_id     uuid primary key references public.organizations(id) on delete cascade,
  ativo               boolean not null default false,
  -- Quantos pontos cada R$ 1,00 gasto gera. Sem padrão: a produtora define.
  pontos_por_real     numeric(10,2) not null default 0 check (pontos_por_real >= 0),
  -- Quanto vale 1 ponto no resgate, em centavos. Idem.
  centavos_por_ponto  numeric(10,2) not null default 0 check (centavos_por_ponto >= 0),
  -- Piso de resgate: evita transação de R$ 0,03 que custa mais em taxa do
  -- que o valor resgatado.
  minimo_resgate      integer not null default 0 check (minimo_resgate >= 0),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references public.profiles(id)
);

alter table public.fidelidade_config enable row level security;
revoke all on public.fidelidade_config from anon, authenticated;

comment on table public.fidelidade_config is
  'Regra do programa POR PRODUTORA. Nasce inativa e sem valores: quanto vale '
  'um ponto é decisão comercial, não padrão de código.';

-- ── Ledger: a fonte da verdade do saldo ──
create table if not exists public.fidelidade_ledger (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tipo            fidelidade_tipo not null,
  -- Positivo credita, negativo debita. Um sinal só, uma regra só.
  pontos          integer not null,
  order_id        uuid references public.orders(id) on delete set null,
  descricao       text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_fidelidade_ledger_saldo
  on public.fidelidade_ledger (user_id, organization_id);
-- Um acúmulo por pedido: sem isto, reprocessar um webhook de pagamento
-- creditaria os mesmos pontos de novo.
create unique index if not exists idx_fidelidade_acumulo_unico
  on public.fidelidade_ledger (order_id) where tipo = 'acumulo';

alter table public.fidelidade_ledger enable row level security;
revoke all on public.fidelidade_ledger from anon, authenticated;

comment on table public.fidelidade_ledger is
  'Todo movimento de pontos. O saldo é a SOMA disto — nunca uma coluna à '
  'parte, que divergiria no primeiro erro de caminho.';

-- ── Saldo ──
create or replace function public.fidelidade_saldo(p_user uuid, p_org uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(pontos), 0)::integer
    from public.fidelidade_ledger
   where user_id = p_user and organization_id = p_org;
$$;

-- ── Acúmulo automático no pagamento ──
create or replace function public.fidelidade_acumular()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_cfg record; v_org uuid; v_pontos integer;
begin
  if new.status <> 'paid' or old.status is not distinct from 'paid' then
    return new;
  end if;

  select e.organization_id into v_org from public.events e where e.id = new.event_id;
  if v_org is null then return new; end if;

  select * into v_cfg from public.fidelidade_config where organization_id = v_org;
  -- Programa desligado ou sem regra definida: não acumula. Silenciosamente,
  -- porque não é erro — é a produtora ainda não ter decidido.
  if v_cfg is null or not v_cfg.ativo or v_cfg.pontos_por_real <= 0 then
    return new;
  end if;

  v_pontos := floor((new.total_cents / 100.0) * v_cfg.pontos_por_real);
  if v_pontos <= 0 then return new; end if;

  insert into public.fidelidade_ledger (user_id, organization_id, tipo, pontos, order_id, descricao)
  values (new.buyer_id, v_org, 'acumulo', v_pontos, new.id, 'Compra de ingresso')
  on conflict (order_id) where tipo = 'acumulo' do nothing;

  return new;
end;
$$;

drop trigger if exists trg_fidelidade_acumular on public.orders;
create trigger trg_fidelidade_acumular
  after update on public.orders
  for each row execute function public.fidelidade_acumular();

-- ── Estorno de pontos quando o pedido é revertido ──
create or replace function public.fidelidade_estornar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_acumulo record;
begin
  -- `refunded` e `cancelled` são os valores que o enum order_status tem de
  -- fato. Escrever 'chargeback' aqui — que NÃO está no enum — derrubaria
  -- todo update de pedido, inclusive o fluxo de compra. Chargeback no
  -- sistema chega como refunded.
  if new.status not in ('refunded', 'cancelled') then return new; end if;
  if old.status is not distinct from new.status then return new; end if;

  select * into v_acumulo
    from public.fidelidade_ledger
   where order_id = new.id and tipo = 'acumulo';
  if not found then return new; end if;

  -- Já estornado? Não estorna de novo.
  if exists (select 1 from public.fidelidade_ledger
              where order_id = new.id and tipo = 'estorno') then
    return new;
  end if;

  -- O saldo pode ficar negativo aqui, e fica de propósito: se a pessoa já
  -- gastou os pontos que a compra gerou e depois pediu o dinheiro de volta,
  -- a dívida é dela. Zerar seria a plataforma pagando pelo golpe.
  insert into public.fidelidade_ledger (user_id, organization_id, tipo, pontos, order_id, descricao)
  values (v_acumulo.user_id, v_acumulo.organization_id, 'estorno',
          -v_acumulo.pontos, new.id, 'Pedido revertido');

  return new;
end;
$$;

drop trigger if exists trg_fidelidade_estornar on public.orders;
create trigger trg_fidelidade_estornar
  after update on public.orders
  for each row execute function public.fidelidade_estornar();

-- ── Resgate ──
create or replace function public.fidelidade_resgatar(
  p_user   uuid,
  p_org    uuid,
  p_pontos integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_cfg record; v_saldo integer; v_centavos integer;
begin
  if p_pontos is null or p_pontos <= 0 then
    raise exception 'PONTOS_INVALIDOS' using errcode = 'P0001';
  end if;

  select * into v_cfg from public.fidelidade_config where organization_id = p_org for update;
  if v_cfg is null or not v_cfg.ativo then
    raise exception 'PROGRAMA_INATIVO' using errcode = 'P0001';
  end if;
  if v_cfg.centavos_por_ponto <= 0 then
    raise exception 'SEM_REGRA_DE_VALOR' using errcode = 'P0001';
  end if;
  if p_pontos < v_cfg.minimo_resgate then
    raise exception 'ABAIXO_DO_MINIMO' using errcode = 'P0001';
  end if;

  -- Trava as linhas do ledger antes de somar: sem isto, dois resgates
  -- simultâneos leriam o mesmo saldo e sacariam o dobro do que existe.
  perform 1 from public.fidelidade_ledger
    where user_id = p_user and organization_id = p_org for update;

  v_saldo := public.fidelidade_saldo(p_user, p_org);
  if v_saldo < p_pontos then
    raise exception 'SALDO_INSUFICIENTE' using errcode = 'P0001';
  end if;

  v_centavos := floor(p_pontos * v_cfg.centavos_por_ponto);

  insert into public.fidelidade_ledger (user_id, organization_id, tipo, pontos, descricao)
  values (p_user, p_org, 'resgate', -p_pontos,
          'Resgate de ' || p_pontos || ' pontos');

  return jsonb_build_object(
    'pontos_resgatados', p_pontos,
    'valor_cents', v_centavos,
    'saldo_restante', public.fidelidade_saldo(p_user, p_org)
  );
end;
$$;

revoke execute on function public.fidelidade_saldo(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fidelidade_resgatar(uuid, uuid, integer) from public, anon, authenticated;
grant  execute on function public.fidelidade_saldo(uuid, uuid) to service_role;
grant  execute on function public.fidelidade_resgatar(uuid, uuid, integer) to service_role;

-- ═══════════════════════════════════════════════════════════
