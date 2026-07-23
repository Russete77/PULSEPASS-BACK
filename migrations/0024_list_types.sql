-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0024 — FASE 3 (AzList): tipos de lista
--   • promoters.list_type — standard | free_until | birthday | vip
--   • promoters.free_until — horário-limite de entrada grátis (list_type='free_until')
-- Aplicar após 0001..0023.
-- ═══════════════════════════════════════════════════════════════

alter table public.promoters add column if not exists list_type text not null default 'standard'
  check (list_type in ('standard', 'free_until', 'birthday', 'vip'));

alter table public.promoters add column if not exists free_until timestamptz;

-- ═══════════════════════════════════════════════════════════════
