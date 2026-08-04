-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0030 — DOCUMENTOS FISCAIS (NFS-e)
--
--   Venda de ingresso é prestação de serviço: a produtora precisa emitir
--   NFS-e. Sem isso ela não opera formalmente — e é o tipo de coisa que
--   ninguém sente falta até a primeira fiscalização ou o primeiro contador.
--
--   A emissão em si é feita por um provedor (Focus NFe, PlugNotas, eNotas…).
--   O que precisa morar AQUI é o registro: o que foi emitido, para qual
--   pedido, com que número/verificação, e o que falhou — porque documento
--   fiscal perdido é problema de verdade, não um log.
-- ═══════════════════════════════════════════════════════════════

do $$ begin
  create type public.fiscal_status as enum ('pending', 'issued', 'failed', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.fiscal_documents (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders(id) on delete restrict,
  organization_id  uuid not null references public.organizations(id),
  status           public.fiscal_status not null default 'pending',
  -- Identificação no provedor / na prefeitura
  provider         text not null default 'mock',
  provider_ref     text,                       -- id da nota no provedor
  numero           text,                       -- número da NFS-e
  codigo_verificacao text,
  pdf_url          text,
  xml_url          text,
  -- Valores no momento da emissão (nota é foto do passado: não recalcular)
  amount_cents     integer not null check (amount_cents >= 0),
  tax_cents        integer not null default 0 check (tax_cents >= 0),
  service_code     text,                       -- código do serviço municipal
  -- Tomador (quem comprou)
  buyer_name       text,
  buyer_doc        text,
  buyer_email      text,
  error            text,
  attempts         integer not null default 0,
  issued_at        timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Um documento fiscal VÁLIDO por pedido. Nota duplicada é problema fiscal
-- sério, então o banco recusa — não confiamos só na lógica da aplicação.
create unique index if not exists uq_fiscal_order_ativo
  on public.fiscal_documents (order_id) where status in ('pending', 'issued');

create index if not exists idx_fiscal_org on public.fiscal_documents (organization_id, created_at desc);
create index if not exists idx_fiscal_pendentes on public.fiscal_documents (created_at)
  where status in ('pending', 'failed');

create trigger trg_fiscal_updated before update on public.fiscal_documents
  for each row execute function set_updated_at();

alter table public.fiscal_documents enable row level security;
-- Sem política: contém CPF/CNPJ do comprador. Só o backend (service_role) lê.
revoke all on public.fiscal_documents from anon, authenticated;

-- ── Resumo fiscal do evento (o que o contador pede) ──
create or replace function public.fiscal_summary(p_event uuid)
returns jsonb as $$
  select jsonb_build_object(
    'issued_count',  count(*) filter (where f.status = 'issued'),
    'issued_cents',  coalesce(sum(f.amount_cents) filter (where f.status = 'issued'), 0),
    'pending_count', count(*) filter (where f.status = 'pending'),
    'failed_count',  count(*) filter (where f.status = 'failed'),
    'cancelled_count', count(*) filter (where f.status = 'cancelled')
  )
  from public.fiscal_documents f
  join public.orders o on o.id = f.order_id
  where o.event_id = p_event;
$$ language sql security definer set search_path = public, pg_temp;
revoke execute on function public.fiscal_summary(uuid) from public, anon, authenticated;
grant execute on function public.fiscal_summary(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════
