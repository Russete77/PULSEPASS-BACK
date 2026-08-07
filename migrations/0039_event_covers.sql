-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0039 — CAPA DO EVENTO (Storage)
--
--   A auditoria de design fechou com o achado que nenhuma folha de estilo
--   resolve: o hero do evento é um gradiente genérico. As referências do
--   setor convergem num ponto — a imagem do evento é a peça principal e a
--   interface se apaga. Evento sem foto é evento sem desejo.
--
--   O bucket é PÚBLICO para leitura de propósito: a capa aparece na
--   vitrine, que é anônima, e no e-mail do ingresso, que abre fora do app.
--   URL assinada em imagem de divulgação só cria link que expira no meio da
--   campanha.
--
--   A escrita é outra história: ninguém sobe arquivo direto. O backend
--   assina cada envio depois de checar que a pessoa é dona do evento.
-- ═══════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'event-covers', 'event-covers', true,
  5242880,                                   -- 5 MB: capa de evento não precisa de mais
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update
  set public = true,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

-- Leitura pública: a vitrine é anônima.
do $$ begin
  create policy "capas sao publicas para leitura"
    on storage.objects for select
    using (bucket_id = 'event-covers');
exception when duplicate_object then null; end $$;

-- Escrita/remoção só pelo backend (service_role ignora RLS). Sem política
-- para anon/authenticated = ninguém sobe nem apaga por fora.

-- ═══════════════════════════════════════════════════════════════
