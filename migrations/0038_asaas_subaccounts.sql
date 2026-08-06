-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0038 — SUBCONTAS ASAAS
--
--   Sem subconta, a produtora precisa abrir conta no Asaas por fora, achar o
--   walletId no painel e colar aqui. Cada passo desses é uma chance de
--   desistir — e, enquanto não cola, a venda dela fica retida na nossa conta.
--
--   Com subconta, a conta nasce pela API no momento do cadastro e o walletId
--   já volta pronto para o split.
--
--   Sobre a apiKey: o Asaas devolve UMA ÚNICA VEZ e ela dá acesso total à
--   conta da produtora — movimentar dinheiro, sacar, emitir cobrança. Fica
--   guardada CIFRADA (a chave mora em variável de ambiente, fora do banco) e
--   nunca é devolvida por nenhuma rota. Um dump do banco não vira acesso à
--   conta bancária dos clientes.
-- ═══════════════════════════════════════════════════════════════

alter table public.organizations
  add column if not exists asaas_account_id      text,
  add column if not exists asaas_account_status  text,     -- pending | approved | rejected
  add column if not exists asaas_onboarding_url  text,     -- link de envio de documentos
  add column if not exists asaas_api_key_enc     text,     -- CIFRADA (ver lib/secretBox.js)
  add column if not exists asaas_account_created_at timestamptz;

comment on column public.organizations.asaas_api_key_enc is
  'apiKey da subconta, CIFRADA (AES-256-GCM). Nunca exposta por API. O Asaas só devolve na criação.';
comment on column public.organizations.asaas_onboarding_url is
  'Link do Asaas para a produtora enviar os documentos. Sem aprovação, a conta não recebe.';

-- Uma subconta por organização: recriar geraria conta órfã com dinheiro preso.
create unique index if not exists uq_org_asaas_account
  on public.organizations (asaas_account_id) where asaas_account_id is not null;

-- ═══════════════════════════════════════════════════════════════
