-- ═══════════════════════════════════════════════════════════
-- 0053 — Campanhas de e-mail para o público do evento
--
-- A produtora já tem o público todo dentro do sistema (quem comprou, quem
-- entrou na lista do promoter, quem não apareceu, quem ficou na fila) mas não
-- tem como falar com ele. Hoje a saída é exportar e-mail na mão pra uma
-- ferramenta de fora, o que quebra o consentimento e envelhece no mesmo dia.
--
-- Duas tabelas:
--   marketing_campaigns   — o que foi escrito, pra quem, e o resultado agregado
--   marketing_recipients  — uma linha por pessoa por campanha
--
-- A segunda existe por um motivo só: o índice único (campaign_id, lower(email))
-- é o que impede a mesma pessoa de receber a mesma campanha duas vezes quando
-- um envio falha no meio e alguém reenvia. Sem ela, "tentar de novo" vira spam.
--
-- Os segmentos NÃO são listas guardadas — são consultas no dado que já existe,
-- resolvidas na hora do envio (marketing_publico). Lista congelada mente: quem
-- comprou depois que a campanha foi criada precisa entrar.
-- ═══════════════════════════════════════════════════════════

do $$ begin
  create type public.marketing_campaign_status as enum ('draft', 'sending', 'sent', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  -- 'mock' é status de primeira classe, não um 'failed' disfarçado: sem
  -- RESEND_API_KEY o envio é simulado, e a produtora precisa ver isso como tal.
  create type public.marketing_recipient_status as enum ('pending', 'sent', 'failed', 'mock');
exception when duplicate_object then null; end $$;

-- ── Campanhas ──────────────────────────────────────────────

create table if not exists public.marketing_campaigns (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subject         text not null,
  body            text not null,
  segment         text not null,
  status          public.marketing_campaign_status not null default 'draft',
  mode            text,
  audience_count  integer not null default 0,
  sent_count      integer not null default 0,
  failed_count    integer not null default 0,
  mock_count      integer not null default 0,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

do $$ begin
  alter table public.marketing_campaigns
    add constraint marketing_campaigns_segment_valido
    check (segment in ('compradores', 'lista', 'sem_checkin', 'fila_espera'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.marketing_campaigns
    add constraint marketing_campaigns_mode_valido
    check (mode is null or mode in ('resend', 'mock'));
exception when duplicate_object then null; end $$;

create index if not exists idx_marketing_campaigns_evento
  on public.marketing_campaigns (event_id, created_at desc);

-- ── Destinatários ──────────────────────────────────────────

create table if not exists public.marketing_recipients (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.marketing_campaigns(id) on delete cascade,
  email       text not null,
  name        text,
  status      public.marketing_recipient_status not null default 'pending',
  error       text,
  provider_id text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

-- O ponto da tabela. Reenviar uma campanha parcialmente entregue não pode
-- duplicar quem já recebeu.
create unique index if not exists uq_marketing_recipient_email
  on public.marketing_recipients (campaign_id, lower(email));

create index if not exists idx_marketing_recipients_pendentes
  on public.marketing_recipients (campaign_id) where status = 'pending';

-- ── RLS ────────────────────────────────────────────────────
-- Sem política: as duas tabelas são uma lista de e-mails de clientes.
-- Só o backend (service_role) encosta.

alter table public.marketing_campaigns  enable row level security;
revoke all on public.marketing_campaigns from anon, authenticated;

alter table public.marketing_recipients enable row level security;
revoke all on public.marketing_recipients from anon, authenticated;

comment on column public.marketing_campaigns.segment is
  'Consulta nomeada sobre o dado que já existe, resolvida no envio por '
  'marketing_publico(). Nunca uma lista congelada.';

comment on column public.marketing_campaigns.mode is
  'Como o envio realmente saiu: resend (de verdade) ou mock (sem RESEND_API_KEY). '
  'Fica na linha porque o histórico precisa distinguir os dois pra sempre.';

comment on column public.marketing_campaigns.audience_count is
  'Tamanho do público no instante do envio. Difere da prévia da tela se alguém '
  'comprou no meio — é isso mesmo, o envio é que vale.';

-- ── Público de um segmento ─────────────────────────────────

create or replace function public.marketing_publico(p_event uuid, p_segmento text)
returns table (email text, nome text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_segmento = 'compradores' then
    -- Quem pagou. Fonte da verdade é orders.status='paid'; o e-mail mora em
    -- profiles porque orders não guarda e-mail do comprador.
    return query
      select distinct on (lower(p.email)) p.email, p.full_name
        from public.orders o
        join public.profiles p on p.id = o.buyer_id
       where o.event_id = p_event
         and o.status = 'paid'
         and p.email is not null and p.email <> ''
       order by lower(p.email);

  elsif p_segmento = 'lista' then
    -- Lista de promoter. E-mail é opcional em guests, então filtra.
    return query
      select distinct on (lower(g.email)) g.email, g.name
        from public.guests g
       where g.event_id = p_event
         and g.status <> 'cancelled'
         and g.email is not null and g.email <> ''
       order by lower(g.email);

  elsif p_segmento = 'sem_checkin' then
    -- Não compareceu: tem ingresso válido sem check-in E nenhum ingresso
    -- checado no evento. O "nenhum" importa — quem comprou 3 e entrou com 1
    -- compareceu, e mandar "sentimos sua falta" pra essa pessoa queima a marca.
    return query
      select distinct on (lower(p.email)) p.email, p.full_name
        from public.tickets t
        join public.profiles p on p.id = t.owner_id
       where t.event_id = p_event
         and t.status = 'valid'
         and t.checked_in_at is null
         and p.email is not null and p.email <> ''
         and not exists (
           select 1 from public.tickets t2
            where t2.event_id = p_event
              and t2.owner_id = t.owner_id
              and t2.checked_in_at is not null
         )
       order by lower(p.email);

  elsif p_segmento = 'fila_espera' then
    -- Só quem ainda espera. Convidado/convertido já recebeu o seu e-mail.
    return query
      select distinct on (lower(w.email)) w.email, w.name
        from public.waitlist w
       where w.event_id = p_event
         and w.status = 'waiting'
       order by lower(w.email);

  else
    raise exception 'SEGMENTO_INVALIDO';
  end if;
end;
$$;

revoke execute on function public.marketing_publico(uuid, text) from public, anon, authenticated;
grant  execute on function public.marketing_publico(uuid, text) to service_role;

comment on function public.marketing_publico(uuid, text) is
  'Resolve um segmento em e-mails, sem duplicata (distinct on lower(email)). '
  'Toda regra de quem entra em cada segmento vive aqui, num lugar só.';

-- ── Tamanho de cada segmento (prévia da tela) ──────────────

create or replace function public.marketing_segmentos(p_event uuid)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  -- Conta pela mesma função que envia. Se divergir, o número da tela vira
  -- promessa que o envio não cumpre.
  select jsonb_build_object(
    'compradores', (select count(*) from public.marketing_publico(p_event, 'compradores')),
    'lista',       (select count(*) from public.marketing_publico(p_event, 'lista')),
    'sem_checkin', (select count(*) from public.marketing_publico(p_event, 'sem_checkin')),
    'fila_espera', (select count(*) from public.marketing_publico(p_event, 'fila_espera'))
  );
$$;

revoke execute on function public.marketing_segmentos(uuid) from public, anon, authenticated;
grant  execute on function public.marketing_segmentos(uuid) to service_role;

comment on function public.marketing_segmentos(uuid) is
  'Tamanho real de cada segmento agora. Usa marketing_publico pra garantir que '
  'a prévia e o envio nunca discordem.';

-- ── Materializar o público de uma campanha ─────────────────

create or replace function public.marketing_materializar(p_campaign uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event    uuid;
  v_segmento text;
  v_total    integer;
begin
  select event_id, segment into v_event, v_segmento
    from public.marketing_campaigns where id = p_campaign;

  if v_event is null then
    raise exception 'CAMPANHA_NAO_ENCONTRADA';
  end if;

  -- O `on conflict do nothing` é a rede: quem já está na campanha (porque um
  -- envio anterior falhou no meio) não entra de novo. Sem alvo explícito, pra
  -- casar com o índice único por expressão lower(email).
  insert into public.marketing_recipients (campaign_id, email, name)
  select p_campaign, lower(btrim(pu.email)), pu.nome
    from public.marketing_publico(v_event, v_segmento) pu
   where pu.email is not null and btrim(pu.email) <> ''
  on conflict do nothing;

  select count(*) into v_total
    from public.marketing_recipients where campaign_id = p_campaign;

  return v_total;
end;
$$;

revoke execute on function public.marketing_materializar(uuid) from public, anon, authenticated;
grant  execute on function public.marketing_materializar(uuid) to service_role;

comment on function public.marketing_materializar(uuid) is
  'Congela o público no momento do envio. Idempotente: rodar de novo só '
  'acrescenta quem entrou no segmento desde a última vez.';
