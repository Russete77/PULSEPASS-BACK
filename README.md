# PulsePass · API (pulse-back)

Backend **único** da plataforma PulsePass — ticketeria + guest list + bar cashless.
Inspirado em Sympla + AzList + Zig. Node + **Express 5** + Supabase (Postgres) + Asaas (Pix).

Repositório: `https://github.com/Russete77/pulse-back`

## Stack

- **Node 20.19+** (ESM, `"type": "module"`)
- **Express 5** (async error handling nativo)
- **@supabase/supabase-js v2** — acesso ao Postgres via `service_role`
- **Asaas** — cobranças Pix (cliente `fetch` nativo, com modo *mock* embutido)
- **Zod** — validação de payloads
- **helmet / cors / morgan**

## Estrutura

```
src/
  config/      env, cliente Supabase
  lib/         integração Asaas
  middleware/  auth, errorHandler, asyncHandler
  routes/      events, orders, tickets, webhooks
  controllers/ camada HTTP (valida + responde)
  services/    regra de negócio (Supabase + Asaas)
  utils/       ApiError, geração de códigos
migrations/    0001_init.sql, 0002_seed.sql
```

## Configuração

```bash
cp .env.example .env      # preencha SUPABASE_* e ASAAS_API_KEY
npm install
npm run dev               # http://localhost:4000
```

> Sem `ASAAS_API_KEY`, a API roda em **modo mock**: gera cobrança/QR fictícios
> para testar o fluxo ponta a ponta. Cole sua key sandbox para integrar de verdade.

## Banco (Supabase)

Aplique as migrations no seu projeto Supabase (SQL Editor ou `supabase db push`):

1. `migrations/0001_init.sql` — enums, tabelas, índices, **RLS**, triggers
2. `migrations/0002_seed.sql` — dados de exemplo (apenas dev)

## Endpoints (v1 — vertical slice "comprar ingresso")

| Método | Rota                              | Auth | Descrição                          |
|--------|-----------------------------------|------|------------------------------------|
| GET    | `/api/health`                     | —    | Healthcheck + modo Asaas           |
| GET    | `/api/events?city=&q=`            | —    | Catálogo de eventos publicados     |
| GET    | `/api/events/:slug`               | —    | Detalhe do evento + lotes          |
| POST   | `/api/orders`                     | ✅   | Cria pedido + cobrança Pix         |
| GET    | `/api/orders/:id`                 | ✅   | Status do pedido                   |
| POST   | `/api/orders/:id/simulate-paid`   | ✅   | (dev) confirma pagamento           |
| GET    | `/api/tickets`                    | ✅   | Meus ingressos                     |
| GET    | `/api/tickets/:id`                | ✅   | Detalhe do ingresso (QR)           |
| POST   | `/api/webhooks/asaas`             | token| Confirmação de pagamento (Asaas)   |

Auth = header `Authorization: Bearer <access_token do Supabase>`.

## Webhook Asaas

Configure no painel Asaas apontando para `PUBLIC_API_URL/api/webhooks/asaas`
com o token definido em `ASAAS_WEBHOOK_TOKEN`. Eventos tratados:
`PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED` → emite os ingressos (idempotente).

## Roadmap

- Fase 1 (atual): web responsivo · fluxo Cliente comprar ingresso
- Fase 2: mobile (super-app Cliente, Promoter, Garçom)
- Fase 3: iPad/tablet (cockpit Produtora, PDV, KDS, porta)
- Próximos módulos: guest list, cashless completo, split de comissão, ADM

## Endpoints v2 (Fase 2 — super-app Cliente)

| Método | Rota                                   | Auth | Descrição                          |
|--------|----------------------------------------|------|------------------------------------|
| GET    | `/api/events/:slug/menu`               | —    | Cardápio do bar do evento          |
| GET    | `/api/wallet?eventId=`                 | ✅   | Saldo + extrato da carteira        |
| POST   | `/api/wallet/topups`                   | ✅   | Recarga via Pix (Asaas)            |
| GET    | `/api/wallet/topups/:id`               | ✅   | Status da recarga                  |
| POST   | `/api/wallet/topups/:id/simulate-paid` | ✅   | (dev) credita a recarga            |
| POST   | `/api/bar-orders`                      | ✅   | Pedido no bar (paga com saldo)     |
| GET    | `/api/bar-orders`                      | ✅   | Meus pedidos no bar                |
| POST   | `/api/tickets/:id/transfer`            | ✅   | Transferir ingresso por e-mail     |

Migration nova: `migrations/0003_cashless_bar.sql` (menu, recargas, pedidos no
bar, transferências, função atômica `spend_wallet`, RLS). Aplique após 0001/0002.

## Endpoints v3 (Fase 3 — operação da Produtora)

| Método | Rota                                         | Auth | Descrição                         |
|--------|----------------------------------------------|------|-----------------------------------|
| GET    | `/api/admin/me`                              | ✅   | Perfil + organizações             |
| POST   | `/api/admin/organizations`                   | ✅   | Cria org (vira produtora)         |
| GET    | `/api/admin/events`                          | ✅   | Meus eventos                      |
| POST   | `/api/admin/events`                          | ✅   | Cria evento + lotes (draft)       |
| GET    | `/api/admin/events/:id`                      | ✅   | Detalhe (qualquer status)         |
| PATCH  | `/api/admin/events/:id/status`               | ✅   | Publicar / pausar                 |
| GET    | `/api/admin/events/:id/dashboard`            | ✅   | Métricas ao vivo                  |
| POST   | `/api/admin/events/:id/checkin`              | ✅   | Check-in na porta (antifraude)    |
| GET    | `/api/admin/events/:id/menu`                 | ✅   | Cardápio (admin)                  |
| GET    | `/api/admin/events/:id/wallet-lookup?email=` | ✅   | Saldo do cliente (PDV)            |
| POST   | `/api/admin/events/:id/pdv-charge`           | ✅   | Cobrar no bar (debita saldo)      |

Todos checam se o evento/organização pertence ao usuário autenticado.

## Endpoints v4 (Guest List / Promoters — AZList)

| Método | Rota                                       | Auth | Descrição                          |
|--------|--------------------------------------------|------|------------------------------------|
| GET    | `/api/lists/:code`                         | —    | Dados públicos da lista (link)     |
| POST   | `/api/lists/:code/signup`                  | —    | Inscrição de convidado (público)   |
| POST   | `/api/admin/events/:id/promoters`          | ✅   | Cria promoter (gera link/código)   |
| GET    | `/api/admin/events/:id/promoters`          | ✅   | Promoters + contagem + comissão    |
| GET    | `/api/admin/promoters/:promoterId/guests`  | ✅   | Convidados de um promoter          |
| POST   | `/api/admin/guests/:guestId/checkin`       | ✅   | Marca convidado como presente      |

Migration: `migrations/0004_guestlist.sql` (promoters, guests, RLS). Aplique após 0003.
Link público do promoter: `<pulse-front>/lista/<code>`.

## v5 — Hardening de produção (integridade & segurança)

Migration `migrations/0005_integrity.sql` introduz funções Postgres **transacionais**:

- `place_order` — reserva estoque de forma **atômica** (anti-oversell) e cria o pedido pending numa única transação; `attach_order_payment` anexa o Pix depois.
- `confirm_order_payment` — emite ingressos (idempotente).
- `expire_pending_orders` — devolve estoque de pedidos pending expirados. **Agende** via pg_cron ou scheduler (ex.: a cada 5 min).
- `place_bar_order` — débito de saldo + pedido no bar **na mesma transação** (sem débito sem pedido). Usado pelo app do cliente e pelo PDV.
- `credit_topup` — crédito de recarga atômico e idempotente.
- `event_dashboard` / `event_promoters` — agregações no banco (não em memória).

Outras correções: `profiles.email` (lookup sem `listUsers` paginado), RLS pública removida de `promoters`, Asaas **falha no boot** se faltar chave em produção, rate-limit por IP, cache curto de verificação de JWT, webhook com comparação **timing-safe** + reconciliação de valor, check-in condicional anti-corrida, paginação nas listagens, `/api/health/ready` (checa o banco) e graceful shutdown.

> Aplicar todas as migrations em ordem: `0001 → 0002 → 0003 → 0004 → 0005`.

## v6 — Auth completo (Supabase Auth)

Cadastro/login via **Supabase Auth** (e-mail+senha) com:
- **CPF/telefone** capturados no signup (metadata) → copiados para `profiles` pelo trigger (`migrations/0006_auth_profile.sql`).
- **Confirmação de e-mail**: se o projeto exigir, o app mostra "confirme seu e-mail".
- **Reset de senha**: `resetPasswordForEmail` → página `/redefinir-senha` (web e admin). No mobile o link aponta para o site do Cliente.
- **Login social Google/Apple**: web/admin via `signInWithOAuth` (redirect); mobile via `expo-web-browser` + deep link `pulsepass://auth-callback` (PKCE).

Para funcionar em produção, configure no painel do Supabase:
1. **Authentication → Providers**: habilitar Google e Apple (client id/secret).
2. **URL Configuration → Redirect URLs**: adicionar as origens dos apps e
   `http://localhost:5173/redefinir-senha`, `http://localhost:5174/redefinir-senha`
   e o deep link `pulsepass://auth-callback`.
3. **Email** templates/confirmação conforme a política desejada.

## v7 — Hardening de funções (Supabase advisor)

Migration `0007_harden_functions.sql`: em todas as funções, fixa `search_path`
e **revoga EXECUTE de public/anon/authenticated**, concedendo só ao `service_role`.
Motivo: as RPCs (`place_order`, `credit_topup`, `confirm_order_payment`, etc.)
devem ser chamadas **apenas pelo backend** — sem isso, um cliente com a anon key
poderia chamá-las direto via `/rest/v1/rpc/...` e burlar a autorização.

Os avisos INFO de "RLS enabled, no policy" (guests, organizations, promoters,
webhook_events) são intencionais: nega tudo para o cliente; só o backend
(service_role) acessa.

## Projeto Supabase

Banco aplicado em `pulsepass` (ref `audorkvwafgocmcmbyme`, região sa-east-1),
migrations 0001→0007. URL: `https://audorkvwafgocmcmbyme.supabase.co`.
