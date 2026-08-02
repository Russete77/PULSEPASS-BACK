-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0029 — REGISTRO DE ENTREGA DE E-MAIL
--
--   O envio dos ingressos existia, mas falhava CALADO: um logger.warn e a
--   vida seguia. Se a chave do provedor expirasse ou o provedor caísse, o
--   cliente simplesmente não recebia o ingresso e ninguém ficava sabendo —
--   descobre-se no dia do evento, na fila, com o cliente irritado.
--
--   Aqui cada tentativa vira registro: dá pra ver o que falhou, por quê, e
--   reenviar. É a diferença entre "achamos que enviou" e "sabemos que enviou".
-- ═══════════════════════════════════════════════════════════════

do $$ begin
  create type public.email_delivery_status as enum ('sent', 'failed', 'skipped');
exception when duplicate_object then null; end $$;

create table if not exists public.email_deliveries (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid references public.orders(id) on delete cascade,
  to_email     text not null,
  kind         text not null default 'tickets',   -- tickets | (futuro: lembrete, reembolso…)
  status       public.email_delivery_status not null,
  attempts     integer not null default 1,
  error        text,                              -- motivo da falha / do skip
  provider_id  text,                              -- id da mensagem no provedor
  created_at   timestamptz not null default now()
);
create index if not exists idx_email_deliveries_order on public.email_deliveries (order_id, created_at desc);
-- Para o painel de suporte: "o que falhou hoje e precisa ser reenviado".
create index if not exists idx_email_deliveries_failed
  on public.email_deliveries (created_at desc) where status <> 'sent';

alter table public.email_deliveries enable row level security;
-- Sem política: contém e-mails de clientes. Só o backend (service_role) lê.
revoke all on public.email_deliveries from anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
