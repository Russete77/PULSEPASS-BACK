-- ═══════════════════════════════════════════════════════════
-- 0041 — Descoberta: categoria e coordenadas do evento
--
-- A vitrine só sabia filtrar por nome de cidade em texto livre. Sem categoria
-- não há como montar as trilhas que a HomeScreen desenhada pede ("Hoje",
-- "Acontece agora", chips de Festas/Shows/Teatro), e sem coordenada não há
-- "perto de você" — só "digitou o nome certo da cidade".
--
-- As duas colunas são opcionais de propósito: evento antigo continua válido
-- e aparece nas listas gerais, só não entra nas trilhas por categoria.
-- ═══════════════════════════════════════════════════════════

do $$ begin
  create type event_category as enum (
    'festa', 'show', 'standup', 'teatro', 'esporte', 'gastronomia', 'workshop', 'outro'
  );
exception when duplicate_object then null;
end $$;

alter table public.events
  add column if not exists category  public.event_category not null default 'outro',
  -- Latitude/longitude do LOCAL, não da cidade. Guardadas para o dia em que a
  -- ordenação por raio substituir o casamento por nome de cidade — que erra
  -- em região metropolitana, onde a pessoa em Osasco não vê o evento a seis
  -- quilômetros dela porque a cidade escrita é "São Paulo".
  add column if not exists latitude  numeric(9, 6),
  add column if not exists longitude numeric(9, 6);

-- A vitrine consulta sempre "publicado, futuro, desta categoria/cidade".
-- Parcial porque rascunho e evento passado são a maioria das linhas e nenhum
-- deles aparece na vitrine.
create index if not exists idx_events_vitrine_categoria
  on public.events (category, starts_at)
  where status = 'published';

create index if not exists idx_events_vitrine_cidade
  on public.events (city, starts_at)
  where status = 'published';

comment on column public.events.category is
  'Trilha da vitrine. "outro" é o padrão para não quebrar evento já criado.';
comment on column public.events.latitude is
  'Coordenada do local. Nula enquanto a produtora não informar; a vitrine cai para casamento por cidade.';
