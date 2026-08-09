-- ═══════════════════════════════════════════════════════════
-- 0048 — Permissões granulares da equipe
--
-- Hoje o acesso é um papel só: manager, door ou bar. Isso força escolhas
-- ruins na prática — o gerente de bar precisa ver o financeiro? Se sim, vira
-- manager e passa a poder despublicar o evento. Se não, alguém empresta a
-- conta da produtora, que é como o controle de acesso morre de verdade na
-- noite do evento.
--
-- O papel CONTINUA existindo e define o padrão. As permissões são o ajuste
-- fino por cima: sem nada marcado, o comportamento é exatamente o de antes.
-- ═══════════════════════════════════════════════════════════

alter table public.event_staff
  -- Lista de permissões extras. Array e não jsonb porque a pergunta é sempre
  -- "tem esta?" — e array com GIN responde isso direto, sem navegar objeto.
  add column if not exists permissoes text[] not null default '{}';

create index if not exists idx_staff_permissoes
  on public.event_staff using gin (permissoes);

-- As treze que o sistema de fato tem. Manter a lista NO BANCO evita o caso
-- clássico: a API passa a aceitar "finance:withdraw2" por erro de digitação,
-- ninguém percebe, e a pessoa fica sem acesso sem entender por quê.
do $$ begin
  alter table public.event_staff
    add constraint event_staff_permissoes_validas
    check (permissoes <@ array[
      'door:checkin', 'door:reentry', 'door:guests',
      'bar:pdv', 'bar:kds', 'bar:waiter', 'bar:menu',
      'boxoffice:sell', 'boxoffice:refund',
      'tables:manage', 'coupons:manage',
      'finance:view', 'finance:withdraw'
    ]::text[]);
exception when duplicate_object then null;
end $$;

comment on column public.event_staff.permissoes is
  'Ajuste fino por cima do papel. Vazio = comportamento do papel puro, como era antes.';
