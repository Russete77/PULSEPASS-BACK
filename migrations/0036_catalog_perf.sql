-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0036 — ÍNDICES DA VITRINE
--
--   A home é a página mais acessada do produto e faz sempre a mesma consulta:
--   eventos PUBLICADOS, a partir de agora, ordenados por data — às vezes
--   filtrando por cidade.
--
--   Os índices que existiam não serviam a ela:
--     · (status, city)  → ignora starts_at, então a ordenação vira sort;
--     · (starts_at)     → o filtro de status sobra para depois da varredura.
--
--   Aqui entram índices PARCIAIS. Como a vitrine só enxerga 'published',
--   indexar apenas essas linhas deixa o índice menor (rascunho e evento
--   encerrado ficam de fora) e entrega a ordenação pronta.
-- ═══════════════════════════════════════════════════════════════

-- Vitrine sem filtro de cidade: range em starts_at + ordenação já ordenada.
create index if not exists idx_events_vitrine
  on public.events (starts_at)
  where status = 'published';

-- Vitrine filtrada por cidade (o filtro mais usado depois da data).
create index if not exists idx_events_vitrine_cidade
  on public.events (city, starts_at)
  where status = 'published';

-- Lotes são lidos junto com todo evento da vitrine (join do catálogo).
create index if not exists idx_tiers_event on public.ticket_tiers (event_id);

-- Os antigos viram redundância: (status, city) é coberto pelo parcial de
-- cidade, e índice sobrando custa escrita em toda venda.
drop index if exists public.idx_events_status_city;

-- ═══════════════════════════════════════════════════════════════
