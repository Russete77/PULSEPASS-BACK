-- ═══════════════════════════════════════════════════════════
-- 0054 — Central de notificações do cliente
--
-- Existe um módulo `notifications`, mas ele é ENTREGA DE E-MAIL: manda o
-- ingresso, manda o convite da fila. Se a pessoa apagou o e-mail, trocou de
-- endereço ou o Resend engasgou, não sobra nada — o app não tem memória do
-- que aconteceu com ela.
--
-- O que esta tabela resolve é isso: o histórico fica DENTRO do produto, e a
-- pessoa reabre quando quiser. E-mail é entrega; isto é registro.
--
-- A REGRA QUE IMPORTA: notificação não se inventa. Cada linha nasce de um
-- fato que já aconteceu no sistema — pagamento confirmado, ingresso
-- recebido, vaga liberada na fila. Central que enche de "novidade" genérica
-- vira ruído, e ruído ensina a pessoa a ignorar justo o aviso que importa.
--
-- Por isso as fontes são gatilhos sobre tabelas reais, não chamadas espalhadas
-- pela aplicação: o que depende de alguém lembrar de chamar é o que fica para
-- trás quando um caminho novo de pagamento aparece.
-- ═══════════════════════════════════════════════════════════

do $$ begin
  create type notificacao_tipo as enum (
    'pedido_pago',        -- a compra foi confirmada
    'ingresso_recebido',  -- alguém transferiu um ingresso para você
    'ingresso_enviado',   -- você transferiu (fica de recibo)
    'fila_convite',       -- vaga liberada na fila de espera
    'evento_lembrete'     -- reservado: lembrete de evento próximo
  );
exception when duplicate_object then null; end $$;

create table if not exists public.notificacoes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  tipo        notificacao_tipo not null,
  titulo      text not null,
  corpo       text,
  -- Para onde a notificação leva quando tocada. Caminho relativo do app, não
  -- URL absoluta: o domínio muda entre ambientes e link quebrado numa central
  -- de avisos é pior que aviso nenhum.
  destino     text,
  event_id    uuid references public.events(id) on delete cascade,
  lida_em     timestamptz,
  created_at  timestamptz not null default now()
);

-- A consulta que a tela faz o tempo todo: as minhas, mais recentes primeiro.
create index if not exists idx_notificacoes_user
  on public.notificacoes (user_id, created_at desc);
-- E o contador do sininho, que roda em toda navegação.
create index if not exists idx_notificacoes_nao_lidas
  on public.notificacoes (user_id) where lida_em is null;

alter table public.notificacoes enable row level security;
revoke all on public.notificacoes from anon, authenticated;

comment on table public.notificacoes is
  'Histórico de avisos DENTRO do app. Complementa o e-mail: se a entrega '
  'falhou ou a pessoa apagou, o registro continua aqui.';

-- ── Fonte 1: pedido pago ──
create or replace function public.notificar_pedido_pago()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_titulo text;
begin
  -- Só na TRANSIÇÃO para pago. Sem isto, qualquer update posterior no pedido
  -- (conciliação, nota fiscal, ajuste) geraria um aviso repetido de algo que
  -- a pessoa já sabe.
  --
  -- `is distinct from`, não `coalesce(old.status, '')`: status é enum, e a
  -- string vazia não é valor válido dele — o coalesce derrubava QUALQUER
  -- update em orders, inclusive o do fluxo de compra.
  if new.status = 'paid' and old.status is distinct from 'paid' then
    select 'Pagamento confirmado · ' || e.title into v_titulo
      from public.events e where e.id = new.event_id;

    insert into public.notificacoes (user_id, tipo, titulo, corpo, destino, event_id)
    values (
      new.buyer_id, 'pedido_pago',
      coalesce(v_titulo, 'Pagamento confirmado'),
      'Seus ingressos já estão disponíveis.',
      '/pedido/' || new.id || '/confirmado',
      new.event_id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notificar_pedido_pago on public.orders;
create trigger trg_notificar_pedido_pago
  after update on public.orders
  for each row execute function public.notificar_pedido_pago();

-- ── Fonte 2: transferência de ingresso ──
-- Avisa OS DOIS LADOS. Quem recebe precisa saber que ganhou; quem enviou
-- precisa do recibo, porque a transferência mata o QR antigo e a pessoa vai
-- procurar o ingresso que sumiu da conta dela.
create or replace function public.notificar_transferencia()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_evento text; v_event_id uuid;
begin
  if new.status <> 'accepted' or new.to_user is null then return new; end if;
  -- Resgate de pendente entra por UPDATE; a transferência direta, por INSERT.
  -- Sem esta guarda, um update posterior na mesma linha avisaria de novo.
  if tg_op = 'UPDATE' and old.status is not distinct from 'accepted' then return new; end if;

  select e.title, e.id into v_evento, v_event_id
    from public.tickets t join public.events e on e.id = t.event_id
   where t.id = new.ticket_id;

  insert into public.notificacoes (user_id, tipo, titulo, corpo, destino, event_id)
  values (
    new.to_user, 'ingresso_recebido',
    'Você recebeu um ingresso' || coalesce(' · ' || v_evento, ''),
    'O ingresso já está na sua conta, com um QR novo.',
    '/meus-ingressos', v_event_id
  );

  insert into public.notificacoes (user_id, tipo, titulo, corpo, destino, event_id)
  values (
    new.from_user, 'ingresso_enviado',
    'Ingresso transferido' || coalesce(' · ' || v_evento, ''),
    'Passou para ' || new.to_email || '. Seu QR antigo deixou de valer.',
    '/meus-ingressos', v_event_id
  );

  return new;
end;
$$;

drop trigger if exists trg_notificar_transferencia on public.ticket_transfers;
create trigger trg_notificar_transferencia
  after insert or update on public.ticket_transfers
  for each row execute function public.notificar_transferencia();

-- ── Marcar como lida ──
-- Só as próprias: o p_user vem do token no servidor, nunca do corpo da
-- requisição, senão bastaria mandar o id de outra pessoa para mexer na
-- caixa dela.
create or replace function public.marcar_notificacoes_lidas(
  p_user uuid,
  p_ids  uuid[] default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n integer;
begin
  update public.notificacoes
     set lida_em = now()
   where user_id = p_user
     and lida_em is null
     and (p_ids is null or id = any(p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.marcar_notificacoes_lidas(uuid, uuid[]) from public, anon, authenticated;
grant  execute on function public.marcar_notificacoes_lidas(uuid, uuid[]) to service_role;

-- ═══════════════════════════════════════════════════════════
