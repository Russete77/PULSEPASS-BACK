-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0033 — TRILHA DE AUDITORIA IMUTÁVEL
--
--   Quando some dinheiro do caixa, quando um ingresso "some" da lista, quando
--   alguém muda a carteira que recebe o repasse — a pergunta é sempre a mesma:
--   QUEM fez, QUANDO e o que era ANTES. Sem isso a discussão vira palavra
--   contra palavra e a produtora não tem como responder ao próprio sócio.
--
--   Duas decisões que fazem essa tabela valer alguma coisa:
--
--   1. IMUTÁVEL DE VERDADE. UPDATE e DELETE são revogados de TODOS os papéis,
--      inclusive service_role, e um trigger recusa a operação. O backend
--      escreve e nunca mais consegue mexer. Trilha que o próprio sistema pode
--      reescrever não serve como prova.
--
--   2. Registra o ANTES e o DEPOIS. "Fulano alterou a carteira" não ajuda;
--      "trocou de X para Y às 3h12" resolve.
-- ═══════════════════════════════════════════════════════════════

create table if not exists public.audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  -- Quem
  actor_id     uuid references public.profiles(id),
  actor_email  text,
  actor_ip     text,
  -- O quê
  action       text not null,            -- ex: 'box_office.sale', 'order.refund'
  entity       text,                     -- tabela/domínio afetado
  entity_id    text,
  -- Contexto de negócio (permite filtrar a trilha de um evento/organização)
  event_id     uuid,
  organization_id uuid,
  -- Antes e depois (só o que interessa, nunca o registro inteiro)
  before       jsonb,
  after        jsonb,
  -- Valor movimentado, quando houver: torna a busca por dinheiro trivial
  amount_cents integer,
  note         text
);

create index if not exists idx_audit_at on public.audit_log (at desc);
create index if not exists idx_audit_actor on public.audit_log (actor_id, at desc);
create index if not exists idx_audit_event on public.audit_log (event_id, at desc);
create index if not exists idx_audit_action on public.audit_log (action, at desc);
-- Investigação de dinheiro é a consulta mais comum numa auditoria.
create index if not exists idx_audit_money on public.audit_log (at desc) where amount_cents is not null;

-- ── Imutabilidade ──
-- O trigger é o cinto; a revogação de privilégio é o suspensório. Um protege
-- contra o outro falhar (ex.: alguém conceder o grant de volta sem perceber).
create or replace function public.audit_log_imutavel()
returns trigger as $$
begin
  raise exception 'audit_log é append-only: % não é permitido', tg_op;
end;
$$ language plpgsql;

drop trigger if exists trg_audit_no_update on public.audit_log;
create trigger trg_audit_no_update before update on public.audit_log
  for each row execute function public.audit_log_imutavel();

drop trigger if exists trg_audit_no_delete on public.audit_log;
create trigger trg_audit_no_delete before delete on public.audit_log
  for each row execute function public.audit_log_imutavel();

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;
-- service_role escreve e lê, mas NÃO altera nem apaga.
revoke update, delete on public.audit_log from service_role;
grant insert, select on public.audit_log to service_role;

-- ═══════════════════════════════════════════════════════════════
