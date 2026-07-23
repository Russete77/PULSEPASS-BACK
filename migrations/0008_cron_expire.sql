-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0008 — Agendamento da expiração de pedidos
-- expire_pending_orders devolve estoque de pedidos pending vencidos.
-- Antes rodava só "oportunisticamente"; agora roda a cada 2 minutos.
-- Requer a extensão pg_cron (disponível no Supabase).
-- ═══════════════════════════════════════════════════════════════

create extension if not exists pg_cron;

-- Remove agendamento anterior (idempotente) e recria.
do $$
begin
  perform cron.unschedule('pulsepass-expire-orders');
exception when others then
  null; -- não existia ainda
end $$;

select cron.schedule(
  'pulsepass-expire-orders',
  '*/2 * * * *',
  $$ select public.expire_pending_orders(); $$
);
