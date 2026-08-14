-- ═══════════════════════════════════════════════════════════
-- 0052 — Transferência de ingresso: fecha o QR antigo e entrega o pendente
--
-- A transferência já existia (rota, controller, service e tabela). Dois
-- buracos, os dois sérios:
--
-- 1. O QR ANTIGO CONTINUAVA VALENDO.
--    `setTicketOwner` trocava só o owner_id. O `code` e o `qr_secret` — os
--    dois caminhos pelos quais a portaria valida — ficavam iguais. Quem
--    transferiu continuava com o print do QR no celular, e ele ABRIA A PORTA.
--    Na prática: o remetente entra, e quem recebeu o ingresso chega e ouve
--    "já foi usado". A transferência era cosmética.
--
-- 2. A TRANSFERÊNCIA PENDENTE NUNCA ERA RESGATADA.
--    Transferir para e-mail sem cadastro gravava status 'pending' e
--    respondia "a pessoa receberá o ingresso ao criar a conta com esse
--    e-mail". Nada no código inteiro lê esse 'pending'. O ingresso ficava
--    parado com o dono antigo e a promessa nunca acontecia — a pior espécie
--    de bug, porque as duas pontas acham que está resolvido.
--
-- A rotação é o coração da correção. O resgate vira GATILHO no cadastro do
-- perfil, não código de aplicação, pelo mesmo motivo da 0045: conta pode
-- nascer por vários caminhos, e o que depende de alguém lembrar de chamar é
-- o que fica para trás.
-- ═══════════════════════════════════════════════════════════

-- A tabela já existe (to_email, status, accepted_at). Só faltam as colunas
-- que reconstroem a história de um ingresso que trocou de mão.
alter table public.ticket_transfers
  add column if not exists code_anterior text,
  add column if not exists code_novo     text;

comment on column public.ticket_transfers.code_anterior is
  'Código do ingresso ANTES da transferência. O código é rotacionado a cada '
  'passagem, então sem isto a história do ingresso fica ilegível.';

create index if not exists idx_ticket_transfers_pendente
  on public.ticket_transfers (lower(to_email)) where status = 'pending';

-- ── Transferir ──
create or replace function public.transferir_ingresso(
  p_ticket uuid,
  p_from   uuid,
  p_email  text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ticket    record;
  v_to        uuid;
  v_nome      text;
  v_novo_code text;
begin
  -- Trava a linha: duas transferências simultâneas do mesmo ingresso
  -- deixariam duas pessoas convencidas de que são a dona.
  select * into v_ticket from public.tickets where id = p_ticket for update;
  if not found then raise exception 'INGRESSO_NAO_ENCONTRADO' using errcode = 'P0002'; end if;
  if v_ticket.owner_id <> p_from then raise exception 'NAO_E_SEU' using errcode = 'P0001'; end if;
  -- Depois da entrada não se passa titularidade: a pessoa já está lá dentro.
  if v_ticket.checked_in_at is not null then raise exception 'JA_USADO' using errcode = 'P0001'; end if;
  if v_ticket.status <> 'valid' then raise exception 'INGRESSO_INVALIDO' using errcode = 'P0001'; end if;

  select id, full_name into v_to, v_nome
    from public.profiles where lower(email) = lower(trim(p_email));

  if v_to = p_from then raise exception 'PARA_SI_MESMO' using errcode = 'P0001'; end if;

  if v_to is null then
    -- Sem conta ainda: fica pendente e o gatilho de cadastro entrega. O
    -- ingresso NÃO sai do dono atual enquanto isso — ninguém fica sem nada.
    insert into public.ticket_transfers (ticket_id, from_user, to_email, to_user, status)
    values (p_ticket, p_from, lower(trim(p_email)), null, 'pending');
    return jsonb_build_object('status', 'pending', 'entregue', false, 'para', lower(trim(p_email)));
  end if;

  v_novo_code := public.rotacionar_ingresso(p_ticket, v_to, v_nome);

  insert into public.ticket_transfers
    (ticket_id, from_user, to_email, to_user, status, accepted_at, code_anterior, code_novo)
  values
    (p_ticket, p_from, lower(trim(p_email)), v_to, 'accepted', now(), v_ticket.code, v_novo_code);

  return jsonb_build_object(
    'status', 'accepted', 'entregue', true,
    'para', coalesce(v_nome, p_email), 'code_novo', v_novo_code
  );
end;
$$;

-- ── A rotação, isolada: é ela que mata o print antigo ──
create or replace function public.rotacionar_ingresso(
  p_ticket uuid,
  p_novo_dono uuid,
  p_nome text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_code text;
begin
  -- Mesmo formato do original (PP-XXXX-XXXX): portaria e bilheteria não
  -- precisam aprender um segundo formato de código.
  v_code := 'PP-' || upper(substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 4))
            || '-' || upper(substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 4));

  update public.tickets
     set owner_id    = p_novo_dono,
         -- Os DOIS, sempre juntos. Rotacionar só um deixaria o outro caminho
         -- de validação (código curto na bilheteria OU QR rotativo na porta)
         -- ainda aceitando o ingresso de quem transferiu.
         code        = v_code,
         qr_secret   = encode(extensions.gen_random_bytes(16), 'hex'),
         holder_name = p_nome,
         updated_at  = now()
   where id = p_ticket;

  return v_code;
end;
$$;

-- ── Resgate automático no cadastro ──
create or replace function public.resgatar_transferencias_pendentes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare t record;
begin
  if new.email is null then return new; end if;

  for t in
    select tt.id, tt.ticket_id, tk.code
      from public.ticket_transfers tt
      join public.tickets tk on tk.id = tt.ticket_id
     where tt.status = 'pending'
       and lower(tt.to_email) = lower(new.email)
       -- Só ingresso ainda válido e não usado: enquanto a transferência
       -- esperava, o dono antigo pode ter entrado ou pedido estorno.
       and tk.status = 'valid'
       and tk.checked_in_at is null
  loop
    update public.ticket_transfers
       set to_user = new.id, status = 'accepted', accepted_at = now(),
           code_anterior = t.code,
           code_novo = public.rotacionar_ingresso(t.ticket_id, new.id, new.full_name)
     where id = t.id;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_resgatar_transferencias on public.profiles;
create trigger trg_resgatar_transferencias
  after insert on public.profiles
  for each row execute function public.resgatar_transferencias_pendentes();

revoke execute on function public.transferir_ingresso(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.rotacionar_ingresso(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.transferir_ingresso(uuid, uuid, text) to service_role;

comment on function public.transferir_ingresso(uuid, uuid, text) is
  'Passa a titularidade rotacionando code + qr_secret. A rotação é o que '
  'invalida o print do QR antigo — sem ela a transferência é cosmética.';

-- ═══════════════════════════════════════════════════════════
