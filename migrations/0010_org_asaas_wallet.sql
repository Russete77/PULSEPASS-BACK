-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0010 — Carteira Asaas da produtora (split/repasse)
-- Guarda o walletId Asaas de cada organização para o split automático:
-- a plataforma retém a taxa e repassa o restante ao produtor.
-- ═══════════════════════════════════════════════════════════════

alter table public.organizations
  add column if not exists asaas_wallet_id text;

comment on column public.organizations.asaas_wallet_id is
  'walletId da conta Asaas da produtora — destino do repasse (split) das vendas.';
