-- ═══════════════════════════════════════════════════════════
-- 0058 — A conferência de carteira do Fechamento não conferia nada
--
-- A view `wallet_reconciliation` (0015) expõe o invariante do dinheiro
-- guardado: `balance_cents` tem que ser igual à soma do extrato, e
-- `drift_cents` tem que ser zero. É a checagem de integridade do cashless.
--
-- A tela de Fechamento consultava essa view assim:
--     where event_id = :evento and drift_cents <> 0
--
-- Só que a migration 0027 passou o sistema para CARTEIRA ÚNICA por usuário:
-- toda carteira nasce com `event_id` NULL, e a própria 0027 zerou as antigas
-- carteiras por evento. Conferido no banco: 20 de 20 carteiras com event_id
-- nulo, zero com evento. O filtro por evento, portanto, NUNCA casa.
--
-- O efeito é o pior possível numa checagem de integridade: ela sempre
-- responde "tudo certo". Medido no banco de demonstração, com uma divergência
-- real de R$ 123,45 plantada numa carteira que consumiu no evento:
--     consulta da tela  → 0 linhas   ("✓ sem divergências")
--     escopo real       → 1 linha    (a divergência)
-- Uma carteira podia estar R$ 1.000 fora do extrato e o fechamento assinava
-- embaixo.
--
-- A correção NÃO é devolver `event_id` para a carteira — isso desfaria a
-- 0027 e traria de volta o bug de saldo que ela consertou. O vínculo entre
-- carteira e evento existe em outro lugar, e é mais honesto: `bar_orders`
-- registra qual carteira foi debitada em qual evento. O escopo da conferência
-- passa a ser "as carteiras que movimentaram NESTE evento".
--
-- `drift_cents` continua sendo uma propriedade da carteira INTEIRA (o extrato
-- todo, não a fatia do evento), então o número não é parcial: ou a carteira
-- fecha, ou não fecha. O evento só decide QUEM entra na conferência.
--
-- A função devolve também quantas carteiras foram conferidas. Sem isso, um
-- evento sem nenhum consumo de bar responderia "sem divergências" — que é
-- exatamente a mentira que esta migration existe para acabar. Zero carteiras
-- conferidas é "não havia o que conferir", não é "está tudo certo".
--
-- Aplicar após 0001..0057.
-- ═══════════════════════════════════════════════════════════

create or replace function public.conferencia_carteiras_evento(p_event uuid)
returns jsonb as $$
declare v_carteiras uuid[]; v_drifts jsonb;
begin
  -- Quem movimentou aqui: a carteira debitada em cada comanda do evento.
  -- Comanda cancelada continua valendo como movimento — o débito e o estorno
  -- passaram pelo extrato, e é justamente aí que uma divergência aparece.
  select coalesce(array_agg(distinct bo.wallet_id), '{}')
    into v_carteiras
    from public.bar_orders bo
   where bo.event_id = p_event and bo.wallet_id is not null;

  select coalesce(jsonb_agg(x order by abs(x.drift_cents) desc), '[]'::jsonb)
    into v_drifts
    from (
      select wr.wallet_id, wr.profile_id, wr.balance_cents, wr.ledger_cents, wr.drift_cents
        from public.wallet_reconciliation wr
       where wr.wallet_id = any(v_carteiras) and wr.drift_cents <> 0
    ) x;

  return jsonb_build_object(
    'carteiras_conferidas', coalesce(array_length(v_carteiras, 1), 0),
    'drifts', v_drifts
  );
end;
$$ language plpgsql stable security definer set search_path = public, pg_temp;

revoke execute on function public.conferencia_carteiras_evento(uuid) from public, anon, authenticated;
grant  execute on function public.conferencia_carteiras_evento(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════
