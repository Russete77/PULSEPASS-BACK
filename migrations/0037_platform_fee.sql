-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0037 — TAXA DA PLATAFORMA EDITÁVEL
--
--   A taxa vivia em variável de ambiente: mudar exigia redeploy e valia igual
--   para todo mundo. Plataforma de verdade negocia taxa caso a caso — a casa
--   grande que traz volume não paga o mesmo que a festa de estreia.
--
--   Três decisões que sustentam isso:
--
--   1. PADRÃO + EXCEÇÃO. Existe uma taxa padrão da plataforma e cada produtora
--      pode ter a sua. Sem o padrão, cadastrar produtora nova viraria
--      oportunidade de esquecer a taxa e vender de graça.
--
--   2. A TAXA É CONGELADA NO PEDIDO. O percentual usado fica gravado na venda.
--      Sem isso, mudar a taxa hoje reescreveria o resultado de todos os
--      eventos passados — e o relatório que a produtora já conferiu mudaria
--      sozinho.
--
--   3. SÓ O SUPER-ADMIN MEXE. Deixar a produtora editar a própria taxa é o
--      mesmo que não ter taxa.
-- ═══════════════════════════════════════════════════════════════

-- Configuração da plataforma. Linha única garantida pelo primary key booleano.
create table if not exists public.platform_settings (
  id                boolean primary key default true check (id),
  default_fee_bps   integer not null default 1000 check (default_fee_bps between 0 and 10000),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references public.profiles(id)
);
insert into public.platform_settings (id, default_fee_bps)
values (true, 1000) on conflict (id) do nothing;

comment on column public.platform_settings.default_fee_bps is
  'Taxa padrão da plataforma em pontos-base (1000 = 10%). Aplicada a produtoras sem taxa própria.';

alter table public.platform_settings enable row level security;
revoke all on public.platform_settings from anon, authenticated;

-- Taxa específica da produtora. NULL = usa o padrão da plataforma.
alter table public.organizations
  add column if not exists fee_bps integer check (fee_bps between 0 and 10000);

comment on column public.organizations.fee_bps is
  'Taxa negociada com esta produtora, em pontos-base. NULL usa o padrão da plataforma.';

-- Taxa aplicada NAQUELA venda — histórico não pode mudar quando a taxa muda.
alter table public.orders
  add column if not exists platform_fee_bps integer;

-- ── Taxa efetiva de uma organização ──
create or replace function public.effective_fee_bps(p_org uuid)
returns integer as $$
  select coalesce(
    (select o.fee_bps from public.organizations o where o.id = p_org),
    (select s.default_fee_bps from public.platform_settings s where s.id),
    1000
  );
$$ language sql stable security definer set search_path = public, pg_temp;
revoke execute on function public.effective_fee_bps(uuid) from public, anon, authenticated;
grant execute on function public.effective_fee_bps(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════
