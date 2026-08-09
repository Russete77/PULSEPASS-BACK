-- ═══════════════════════════════════════════════════════════
-- 0046 — Chegada da mesa
--
-- A reserva sabia se foi confirmada, nunca se a pessoa CHEGOU. Na operação
-- essas são perguntas diferentes e a segunda é a que decide a noite:
-- confirmada e vazia às 2h é mesa que pode ser liberada; confirmada e
-- ocupada há três horas é mesa que já consumiu e vai fechar conta.
--
-- Sem isso, a tela de camarotes lista intenções, não o salão.
-- ═══════════════════════════════════════════════════════════

do $$ begin
  alter type public.reservation_status add value if not exists 'seated';
exception when others then null;
end $$;

alter table public.table_reservations
  -- Quando sentaram. É daqui que sai "ocupada há 2h47" — a informação que o
  -- gerente lê para saber qual mesa cobrar e qual liberar.
  add column if not exists seated_at timestamptz,
  add column if not exists left_at   timestamptz,
  -- Ocasião: aniversário, formatura, corporativo. Muda o atendimento — mesa
  -- de aniversário ganha o bolo na hora certa, e ninguém descobre isso
  -- lendo um campo de observação livre no meio da noite.
  add column if not exists ocasiao   text;

create index if not exists idx_reservas_ocupadas
  on public.table_reservations (event_id, seated_at)
  where seated_at is not null and left_at is null;

comment on column public.table_reservations.seated_at is
  'Quando a mesa foi ocupada. "confirmada" e "chegou" são perguntas diferentes.';
