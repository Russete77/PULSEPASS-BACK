-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0007 — Hardening de funções (advisor Supabase)
-- 1) search_path fixo (evita injeção em SECURITY DEFINER)
-- 2) revoga EXECUTE de public/anon/authenticated e concede só ao backend
--    (service_role). As RPCs só devem ser chamadas pelo nosso servidor.
-- Aplicar após 0006.
-- ═══════════════════════════════════════════════════════════════

do $$
declare
  fns text[] := array[
    'public.gen_ticket_code()',
    'public.set_updated_at()',
    'public.handle_new_user()',
    'public.place_order(uuid, uuid, jsonb)',
    'public.attach_order_payment(uuid, text, text, text, text, text, timestamptz)',
    'public.confirm_order_payment(text)',
    'public.expire_pending_orders()',
    'public.place_bar_order(uuid, uuid, jsonb)',
    'public.credit_topup(text)',
    'public.event_dashboard(uuid)',
    'public.event_promoters(uuid)',
    'public.spend_wallet(uuid, integer)'
  ];
  f text;
begin
  foreach f in array fns loop
    execute format('alter function %s set search_path = public, pg_temp;', f);
    execute format('revoke execute on function %s from public, anon, authenticated;', f);
    execute format('grant execute on function %s to service_role;', f);
  end loop;
end $$;
