-- ═══════════════════════════════════════════════════════════
-- 0042 — White-label da produtora
--
-- Casa grande não aceita vender no site de outra marca. Aqui a produtora
-- coloca logo e cor, e a página pública do evento passa a ser dela.
--
-- O que NÃO muda: o rodapé, a política e o processamento do pagamento
-- seguem sendo do PulsePass. White-label é a marca na frente, não a
-- responsabilidade — e essa distinção precisa ficar visível para o
-- comprador saber com quem está falando se algo der errado.
-- ═══════════════════════════════════════════════════════════

alter table public.organizations
  add column if not exists logo_url     text,
  -- Uma cor só. Paleta inteira editável vira interface ilegível na primeira
  -- vez que alguém escolhe amarelo sobre branco; daqui o sistema deriva os
  -- tons e garante o contraste.
  add column if not exists brand_color  text,
  add column if not exists site_url     text,
  add column if not exists instagram    text;

-- Cor precisa ser hexadecimal de 6 dígitos. Sem isto, um valor colado
-- errado ("azul", "#12") entraria no CSS da página pública e quebraria o
-- tema para todos os visitantes daquela produtora.
do $$ begin
  alter table public.organizations
    add constraint organizations_brand_color_hex
    check (brand_color is null or brand_color ~ '^#[0-9A-Fa-f]{6}$');
exception when duplicate_object then null;
end $$;

-- Bucket dos logos. Público na leitura, como as capas: o logo aparece na
-- vitrine para quem nem tem conta.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('org-logos', 'org-logos', true, 2097152,
        array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'])
on conflict (id) do update set
  public = true,
  file_size_limit = 2097152,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];

-- Leitura pública; escrita só pela API (service_role), que checa a dona da
-- organização antes de assinar o envio.
do $$ begin
  create policy "org_logos_public_read" on storage.objects
    for select using (bucket_id = 'org-logos');
exception when duplicate_object then null;
end $$;

comment on column public.organizations.brand_color is
  'Cor da marca em #RRGGBB. O sistema deriva os tons e mantém o contraste.';
