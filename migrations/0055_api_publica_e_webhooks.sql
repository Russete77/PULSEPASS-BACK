-- ═══════════════════════════════════════════════════════════
-- 0055 — API pública por produtora + webhooks de saída
--
-- Duas metades do mesmo problema: deixar um sistema de fora conversar com o
-- PulsePass sem passar por um humano no painel.
--
--   · CHAVE DE API — a produtora PUXA dado nosso (ela pergunta).
--   · WEBHOOK      — a gente EMPURRA dado pra ela (a gente avisa).
--
-- A chave é da PRODUTORA, não da plataforma. Quem integra o ERP é a casa, o
-- dado que sai é o dela, e o prejuízo de uma chave vazada é dela. Chave
-- emitida pelo super-admin seria a plataforma assinando em nome do cliente.
--
-- ── A regra que manda nesta migration ──
-- A chave em claro existe por alguns milissegundos dentro do processo Node e
-- nunca mais. O banco guarda o HASH. Isso não é zelo: painel que reexibe a
-- chave transforma qualquer vazamento do painel (XSS, sessão roubada, print
-- num chamado de suporte) em vazamento de TODAS as chaves de uma vez. Se a
-- produtora perdeu a chave, ela cria outra e revoga a antiga — é mais barato
-- que a alternativa.
--
-- ── Por que nenhum segredo nasce aqui no SQL ──
-- Nada nesta migration chama `extensions.gen_random_bytes`. Não é esquecimento:
-- todo material secreto (chave de API e secret de webhook) é sorteado no Node,
-- com `crypto.randomBytes`, e só o hash/cifra chega ao Postgres. Segredo gerado
-- por SQL aparece no texto do comando — ou seja, em `pg_stat_statements`, no
-- log de statements, no plano de execução. Aqui o banco nunca vê o valor claro.
--
-- (Se algum dia precisar de bytes aleatórios em SQL: no Supabase o pgcrypto
-- mora no schema `extensions`, então é `extensions.gen_random_bytes(...)`.
-- Sem o schema, a função não resolve dentro de `set search_path = public`.)
--
-- ── Por que gatilho, e não chamada na aplicação ──
-- Mesma escolha da 0054. Pedido pago e check-in acontecem DENTRO de RPCs
-- (`confirm_order_payment`, `consume_ticket`); um `emitirWebhook()` espalhado
-- pelos services perderia todo caminho que não passa pelo trecho lembrado —
-- bilheteria física, conciliação, reprocesso. O gatilho vê o fato na tabela,
-- venha ele de onde vier.
--
-- ── O que esta migration NÃO resolve ──
-- Não existe fila de jobs no projeto (sem BullMQ, sem pg_net, sem worker).
-- Então o gatilho só ENFILEIRA a entrega numa tabela durável; quem faz o HTTP
-- é o Node, em melhor esforço, logo após a ação e sob demanda pela tela.
-- Consequência honesta: a entrega pode ATRASAR (nunca se perde — a linha está
-- gravada), e é isso que a tela precisa dizer ao integrador.
-- ═══════════════════════════════════════════════════════════

-- ── Vocabulário ──
-- Enum, e não texto livre, porque assinatura em evento que não existe é erro
-- silencioso: o integrador jura que assinou, e nunca chega nada.
do $$ begin
  create type webhook_evento as enum (
    'pedido.pago',        -- pagamento confirmado (orders.status → paid)
    'ingresso.emitido',   -- ingresso nasceu (tickets insert)
    'checkin.registrado', -- passagem na porta (gate_movements insert)
    'pedido.estornado'    -- dinheiro devolvido / chargeback
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type webhook_entrega_status as enum (
    'pendente',   -- aguardando tentativa (agora ou no backoff)
    'enviando',   -- reservada por um despachante
    'entregue',   -- 2xx do destino
    'desistiu'    -- estourou o teto de tentativas
  );
exception when duplicate_object then null; end $$;

-- Escopo é enum pelo mesmo motivo: 'pedido:ler' com typo vira chave que não
-- lê nada, e o integrador culpa a API.
do $$ begin
  create type api_escopo as enum (
    'eventos:ler',
    'pedidos:ler',
    'ingressos:ler'
  );
exception when duplicate_object then null; end $$;

-- ═══════════════════════════════════════════════════════════
-- 1. Chaves de API
-- ═══════════════════════════════════════════════════════════
create table if not exists public.api_keys (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,

  -- Pra que serve esta chave, em português. Sem isso a lista vira quatro
  -- linhas idênticas e ninguém revoga nada com medo de derrubar produção.
  nome             text not null,

  -- Os primeiros caracteres da chave, EM CLARO e de propósito. Duas funções:
  -- a produtora reconhece qual linha é a chave que está no .env dela, e o
  -- servidor acha a linha por índice em vez de varrer a tabela comparando
  -- hash a hash. O prefixo não ajuda a adivinhar o resto — sobram 32 bytes
  -- de sorteio depois dele.
  prefixo          text not null unique,

  -- SHA-256 do valor completo, em hex. Não é bcrypt/argon2 de propósito: KDF
  -- lento existe pra defender segredo com pouca entropia (senha de gente).
  -- Aqui o segredo é 32 bytes de CSPRNG — não há dicionário, e força bruta é
  -- 2^256. O que um KDF lento acrescentaria é latência em TODA requisição da
  -- API pública, que é justamente o caminho quente.
  hash             text not null,

  escopos          api_escopo[] not null default '{eventos:ler}',

  -- Chave que nunca foi usada é chave que pode ser apagada sem medo; chave
  -- parada há meses é superfície de ataque de graça. Sem esta coluna não dá
  -- pra saber nem uma coisa nem outra.
  ultimo_uso_em    timestamptz,

  criada_por       uuid references public.profiles(id) on delete set null,

  -- Revogar é marcar, não apagar: a linha continua explicando as chamadas que
  -- já aconteceram com ela. Delete apagaria a história junto com a chave.
  revogada_em      timestamptz,

  created_at       timestamptz not null default now()
);

-- A consulta da tela: as chaves da minha produtora, mais nova primeiro.
create index if not exists idx_api_keys_org
  on public.api_keys (organization_id, created_at desc);

comment on table public.api_keys is
  'Chaves de API por produtora. Guarda o HASH — o valor em claro é mostrado '
  'uma única vez, na criação, e não é recuperável.';
comment on column public.api_keys.hash is
  'SHA-256 hex do valor completo. Conferido em tempo constante no Node.';

-- ═══════════════════════════════════════════════════════════
-- 2. Assinaturas de webhook
-- ═══════════════════════════════════════════════════════════
create table if not exists public.webhook_assinaturas (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,

  url              text not null,

  -- Quais fatos essa URL quer receber. Array, porque um endpoint de CRM quer
  -- 'pedido.pago' e um painel de portaria quer 'checkin.registrado' — mandar
  -- tudo pra todo mundo é obrigar o integrador a filtrar o nosso ruído.
  eventos          webhook_evento[] not null,

  -- Segredo COMPARTILHADO da assinatura HMAC, cifrado (AES-256-GCM, lib
  -- secretBox, chave fora do banco). Diferente da chave de API, este não pode
  -- ser hash: a gente precisa reproduzir o HMAC a cada envio. Cifrado ainda
  -- resolve o caso que importa — dump do banco sem a SECRET_BOX_KEY não abre.
  secret_enc       text not null,

  -- Desligar sem apagar. Endpoint do cliente caiu numa madrugada? Pausa,
  -- conserta, religa — e o histórico de entregas continua de pé.
  ativa            boolean not null default true,

  criada_por       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists idx_webhook_assinaturas_org
  on public.webhook_assinaturas (organization_id, created_at desc);

-- O gatilho pergunta "quem da org X assina o evento Y?" a cada fato. Sem este
-- índice parcial, toda venda faria varredura na tabela.
create index if not exists idx_webhook_assinaturas_ativas
  on public.webhook_assinaturas (organization_id) where ativa;

comment on table public.webhook_assinaturas is
  'Para onde a produtora quer que a gente avise, e sobre o quê.';

-- ═══════════════════════════════════════════════════════════
-- 3. Entregas
-- ═══════════════════════════════════════════════════════════
-- Esta tabela é a fila. Não é log: é o registro DURÁVEL do que ainda precisa
-- sair. Por isso o payload é congelado aqui — se o pedido for alterado depois,
-- o webhook continua descrevendo o fato do momento em que ele aconteceu, que é
-- o que o integrador precisa pra reconciliar.
create table if not exists public.webhook_entregas (
  id                    uuid primary key default gen_random_uuid(),
  assinatura_id         uuid not null references public.webhook_assinaturas(id) on delete cascade,

  evento                webhook_evento not null,
  payload               jsonb not null,

  status                webhook_entrega_status not null default 'pendente',
  tentativas            integer not null default 0,

  -- Resposta do destino, pra tela conseguir dizer POR QUE falhou. Truncada no
  -- Node: alguns servidores devolvem uma página de erro de 40 KB, e guardar
  -- isso vezes milhares de entregas enche o disco sem informar mais nada.
  http_status           integer,
  resposta              text,
  erro                  text,

  -- Backoff: quando vale a pena tentar de novo.
  proxima_tentativa_em  timestamptz not null default now(),
  -- Quando um despachante pegou esta linha. É o que permite destravar entrega
  -- presa: processo que morre no meio do POST deixa a linha em 'enviando'
  -- pra sempre se ninguém souber há quanto tempo ela está assim.
  reservada_em          timestamptz,
  entregue_em           timestamptz,
  created_at            timestamptz not null default now()
);

-- A tela: últimas entregas desta assinatura.
create index if not exists idx_webhook_entregas_assinatura
  on public.webhook_entregas (assinatura_id, created_at desc);
-- O despachante: o que está na hora de sair. Parcial, porque entrega concluída
-- é a esmagadora maioria das linhas e não interessa a esta busca.
create index if not exists idx_webhook_entregas_fila
  on public.webhook_entregas (proxima_tentativa_em)
  where status in ('pendente', 'enviando');

comment on table public.webhook_entregas is
  'Fila durável de webhooks de saída. O gatilho enfileira; o Node entrega em '
  'melhor esforço. Nada se perde — pode atrasar.';

-- ═══════════════════════════════════════════════════════════
-- 4. Trancas
-- ═══════════════════════════════════════════════════════════
-- As três tabelas são de infraestrutura: só o service_role toca. RLS ligada
-- sem política nenhuma = ninguém passa, nem por engano via PostgREST.
alter table public.api_keys            enable row level security;
alter table public.webhook_assinaturas enable row level security;
alter table public.webhook_entregas    enable row level security;

revoke all on public.api_keys            from anon, authenticated;
revoke all on public.webhook_assinaturas from anon, authenticated;
revoke all on public.webhook_entregas    from anon, authenticated;

-- ═══════════════════════════════════════════════════════════
-- 5. Enfileirar (usado pelos gatilhos)
-- ═══════════════════════════════════════════════════════════
create or replace function public.enfileirar_webhook(
  p_org     uuid,
  p_evento  webhook_evento,
  p_payload jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n integer;
begin
  if p_org is null then return 0; end if;

  -- Uma linha por assinatura interessada. Produtora sem webhook nenhum não
  -- paga nada por isso: o insert simplesmente não encontra destino.
  insert into public.webhook_entregas (assinatura_id, evento, payload)
  select a.id, p_evento, p_payload
    from public.webhook_assinaturas a
   where a.organization_id = p_org
     and a.ativa
     and p_evento = any(a.eventos);

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.enfileirar_webhook(uuid, webhook_evento, jsonb) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════
-- 6. Fontes — gatilhos sobre os fatos reais
-- ═══════════════════════════════════════════════════════════
-- Nota sobre o payload: os campos são listados UM A UM, nunca `to_jsonb(new)`.
-- Um `to_jsonb` mandaria pra fora todo campo novo que alguém adicionar na
-- tabela amanhã — inclusive `tickets.qr_secret`, que é o que valida a entrada
-- na porta. Enumerar é chato e é o único jeito de o vazamento não ser
-- automático.

-- ── pedido.pago ──
create or replace function public.wh_pedido_pago()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_org uuid; v_slug text; v_titulo text; v_email text; v_nome text;
begin
  -- Só na TRANSIÇÃO. Todo update posterior no pedido (nota fiscal,
  -- conciliação) reavisaria uma venda que o integrador já processou —
  -- e webhook repetido em sistema de ERP vira pedido duplicado.
  if not (new.status = 'paid' and old.status is distinct from 'paid') then
    return new;
  end if;

  select e.organization_id, e.slug, e.title into v_org, v_slug, v_titulo
    from public.events e where e.id = new.event_id;
  select p.email, p.full_name into v_email, v_nome
    from public.profiles p where p.id = new.buyer_id;

  perform public.enfileirar_webhook(v_org, 'pedido.pago', jsonb_build_object(
    'pedido', jsonb_build_object(
      'id', new.id,
      'status', new.status,
      'total_cents', new.total_cents,
      'taxa_servico_cents', new.service_fee_cents,
      'desconto_cents', new.discount_cents,
      'cupom', new.coupon_code,
      'pago_em', new.paid_at,
      'criado_em', new.created_at
    ),
    'evento', jsonb_build_object('id', new.event_id, 'slug', v_slug, 'titulo', v_titulo),
    -- O comprador é do cliente da produtora, não nosso segredo: é exatamente
    -- o dado que faz a integração de CRM existir.
    'comprador', jsonb_build_object('nome', v_nome, 'email', v_email)
  ));
  return new;
end;
$$;

drop trigger if exists trg_wh_pedido_pago on public.orders;
create trigger trg_wh_pedido_pago
  after update on public.orders
  for each row execute function public.wh_pedido_pago();

-- ── pedido.estornado ──
create or replace function public.wh_pedido_estornado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_org uuid; v_slug text; v_titulo text;
begin
  -- Dois caminhos levam a "o dinheiro voltou": o reembolso pedido pelo cliente
  -- (status → refunded) e a reversão vinda do provedor (chargeback, pagamento
  -- reprovado depois de confirmado — marca `reversed_at`). A segunda condição
  -- exclui `refunded` pra que um update que faça as duas coisas não dispare
  -- dois avisos do mesmo estorno.
  if not (
       (new.status = 'refunded' and old.status is distinct from 'refunded')
    or (new.reversed_at is not null and old.reversed_at is null and new.status is distinct from 'refunded')
  ) then
    return new;
  end if;

  select e.organization_id, e.slug, e.title into v_org, v_slug, v_titulo
    from public.events e where e.id = new.event_id;

  perform public.enfileirar_webhook(v_org, 'pedido.estornado', jsonb_build_object(
    'pedido', jsonb_build_object(
      'id', new.id,
      'status', new.status,
      'total_cents', new.total_cents,
      'estornado_em', coalesce(new.reversed_at, now()),
      'tipo', new.reversal_kind,
      'motivo', new.reversal_reason
    ),
    'evento', jsonb_build_object('id', new.event_id, 'slug', v_slug, 'titulo', v_titulo)
  ));
  return new;
end;
$$;

drop trigger if exists trg_wh_pedido_estornado on public.orders;
create trigger trg_wh_pedido_estornado
  after update on public.orders
  for each row execute function public.wh_pedido_estornado();

-- ── ingresso.emitido ──
-- Um aviso POR INGRESSO, não por pedido. Quem integra controle de acesso
-- precisa do código de cada um; agregado por pedido obrigaria uma segunda
-- chamada à API só pra descobrir o que foi emitido.
create or replace function public.wh_ingresso_emitido()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_org uuid; v_slug text; v_titulo text; v_lote text; v_preco integer;
begin
  select e.organization_id, e.slug, e.title into v_org, v_slug, v_titulo
    from public.events e where e.id = new.event_id;

  select t.name, t.price_cents into v_lote, v_preco
    from public.ticket_tiers t where t.id = new.ticket_tier_id;

  perform public.enfileirar_webhook(v_org, 'ingresso.emitido', jsonb_build_object(
    'ingresso', jsonb_build_object(
      'id', new.id,
      -- `code` é o código curto conferível na porta. `qr_secret` NÃO sai daqui:
      -- quem tiver o segredo gera QR válido e entra no lugar do comprador.
      'codigo', new.code,
      'titular', new.holder_name,
      'status', new.status,
      'emitido_em', new.created_at
    ),
    'lote', jsonb_build_object('id', new.ticket_tier_id, 'nome', v_lote, 'preco_cents', v_preco),
    'pedido_id', new.order_id,
    'evento', jsonb_build_object('id', new.event_id, 'slug', v_slug, 'titulo', v_titulo)
  ));
  return new;
end;
$$;

drop trigger if exists trg_wh_ingresso_emitido on public.tickets;
create trigger trg_wh_ingresso_emitido
  after insert on public.tickets
  for each row execute function public.wh_ingresso_emitido();

-- ── checkin.registrado ──
-- A fonte é `gate_movements`, não `tickets.checked_in_at`. O campo no ingresso
-- guarda só a última passagem; o movimento registra TODAS — incluindo saída e
-- reentrada, que é o que um painel de lotação precisa.
create or replace function public.wh_checkin_registrado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_org uuid; v_slug text; v_titulo text; v_codigo text;
begin
  select e.organization_id, e.slug, e.title into v_org, v_slug, v_titulo
    from public.events e where e.id = new.event_id;

  select t.code into v_codigo from public.tickets t where t.id = new.ticket_id;

  perform public.enfileirar_webhook(v_org, 'checkin.registrado', jsonb_build_object(
    'movimento', jsonb_build_object(
      'id', new.id,
      'direcao', new.direction,   -- in | out
      'portaria', new.gate,
      'registrado_em', new.created_at
    ),
    -- `operator_id` fica de fora: é o uuid de um funcionário nosso/da casa, não
    -- acrescenta nada a quem integra e é dado pessoal saindo sem necessidade.
    'ingresso', jsonb_build_object('id', new.ticket_id, 'codigo', v_codigo),
    'evento', jsonb_build_object('id', new.event_id, 'slug', v_slug, 'titulo', v_titulo)
  ));
  return new;
end;
$$;

drop trigger if exists trg_wh_checkin_registrado on public.gate_movements;
create trigger trg_wh_checkin_registrado
  after insert on public.gate_movements
  for each row execute function public.wh_checkin_registrado();

-- ═══════════════════════════════════════════════════════════
-- 7. Despacho — reservar / concluir
-- ═══════════════════════════════════════════════════════════
-- Por que reservar em vez de só ler: o disparo acontece em melhor esforço
-- depois de cada venda E sob demanda pela tela. Dois desses rodando ao mesmo
-- tempo leriam a mesma linha pendente e o cliente receberia o webhook em
-- duplicata. `for update skip locked` faz cada linha sair para um despachante
-- só; quem chegar depois pega a próxima em vez de esperar.
create or replace function public.reservar_entregas_webhook(
  p_limit integer default 20,
  p_org   uuid default null
)
returns table (
  id            uuid,
  assinatura_id uuid,
  evento        webhook_evento,
  payload       jsonb,
  tentativas    integer,
  url           text,
  secret_enc    text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with alvo as (
    select e.id
      from public.webhook_entregas e
      join public.webhook_assinaturas a on a.id = e.assinatura_id
     where a.ativa
       and (p_org is null or a.organization_id = p_org)
       and (
            (e.status = 'pendente' and e.proxima_tentativa_em <= now())
            -- Destrava entrega órfã: 'enviando' parada há mais de 5 min é
            -- processo que caiu no meio do POST. Sem isto ela nunca mais sai.
            or (e.status = 'enviando' and e.reservada_em < now() - interval '5 minutes')
       )
     order by e.proxima_tentativa_em
     limit greatest(1, least(coalesce(p_limit, 20), 100))
     for update of e skip locked
  ),
  reservadas as (
    update public.webhook_entregas e
       set status = 'enviando', reservada_em = now()
     where e.id in (select alvo.id from alvo)
    returning e.id, e.assinatura_id, e.evento, e.payload, e.tentativas
  )
  select r.id, r.assinatura_id, r.evento, r.payload, r.tentativas, a.url, a.secret_enc
    from reservadas r
    join public.webhook_assinaturas a on a.id = r.assinatura_id;
end;
$$;

-- Resultado de uma tentativa. O backoff mora aqui, e não no Node, porque é
-- política do sistema: se dois caminhos diferentes de disparo tivessem cada um
-- a sua conta, a mesma falha seria retentada em ritmos diferentes.
create or replace function public.concluir_entrega_webhook(
  p_id          uuid,
  p_ok          boolean,
  p_http_status integer default null,
  p_resposta    text default null,
  p_erro        text default null
)
returns webhook_entrega_status
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tentativas integer;
  v_max constant integer := 6;   -- ~9h de janela até desistir
  v_status webhook_entrega_status;
begin
  update public.webhook_entregas
     set tentativas = tentativas + 1
   where id = p_id
  returning tentativas into v_tentativas;

  if v_tentativas is null then return null; end if;

  if p_ok then
    v_status := 'entregue';
  elsif v_tentativas >= v_max then
    -- Desistir é uma decisão, não um bug: endpoint que não responde em 6
    -- tentativas ao longo de horas não vai responder na sétima, e a fila
    -- precisa parar de crescer. A linha fica, com o erro, pra reprocesso
    -- manual quando a produtora consertar o lado dela.
    v_status := 'desistiu';
  else
    v_status := 'pendente';
  end if;

  update public.webhook_entregas
     set status      = v_status,
         http_status = p_http_status,
         resposta    = left(p_resposta, 500),
         erro        = case when p_ok then null else left(p_erro, 300) end,
         entregue_em = case when p_ok then now() else entregue_em end,
         proxima_tentativa_em = case
           when v_status <> 'pendente' then proxima_tentativa_em
           -- Cresce rápido no começo (falha de rede passa em segundos) e se
           -- alonga depois (endpoint fora do ar volta em horas, não em minutos).
           when v_tentativas = 1 then now() + interval '1 minute'
           when v_tentativas = 2 then now() + interval '5 minutes'
           when v_tentativas = 3 then now() + interval '30 minutes'
           when v_tentativas = 4 then now() + interval '2 hours'
           else                       now() + interval '6 hours'
         end
   where id = p_id;

  return v_status;
end;
$$;

-- Reprocesso manual: devolve pra fila o que desistiu ou está preso, de uma
-- assinatura só. É o botão que a produtora aperta depois de consertar o
-- endpoint dela — sem ele, "desistiu" seria sentença definitiva.
create or replace function public.reenfileirar_entregas_webhook(
  p_assinatura uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n integer;
begin
  update public.webhook_entregas
     set status = 'pendente',
         tentativas = 0,
         proxima_tentativa_em = now(),
         reservada_em = null,
         erro = null
   where assinatura_id = p_assinatura
     and status in ('desistiu', 'enviando');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Retenção. NÃO está agendada: o pg_cron existe no banco, mas ligar uma rotina
-- que apaga dado é decisão de operação, não efeito colateral de migration.
-- Fica disponível pra quando alguém decidir a janela.
create or replace function public.limpar_entregas_webhook(
  p_dias integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n integer;
begin
  delete from public.webhook_entregas
   where status in ('entregue', 'desistiu')
     and created_at < now() - make_interval(days => greatest(1, p_dias));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.reservar_entregas_webhook(integer, uuid)                    from public, anon, authenticated;
revoke execute on function public.concluir_entrega_webhook(uuid, boolean, integer, text, text) from public, anon, authenticated;
revoke execute on function public.reenfileirar_entregas_webhook(uuid)                          from public, anon, authenticated;
revoke execute on function public.limpar_entregas_webhook(integer)                             from public, anon, authenticated;

grant execute on function public.reservar_entregas_webhook(integer, uuid)                     to service_role;
grant execute on function public.concluir_entrega_webhook(uuid, boolean, integer, text, text) to service_role;
grant execute on function public.reenfileirar_entregas_webhook(uuid)                          to service_role;
grant execute on function public.limpar_entregas_webhook(integer)                             to service_role;

-- ═══════════════════════════════════════════════════════════
