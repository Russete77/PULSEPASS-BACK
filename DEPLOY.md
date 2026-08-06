# Deploy — PulsePass API

Container Docker. Roda em qualquer plataforma que aceite Dockerfile (Fly, Railway, Render, Cloud Run).
Config padrão aqui é **Fly.io** (`fly.toml`), região São Paulo (`gru`).

## Pré-requisitos (segredos — NUNCA no git)

| Variável | Origem |
|---|---|
| `SUPABASE_URL` | painel Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | painel Supabase → Settings → API (service_role) |
| `SUPABASE_ANON_KEY` | painel Supabase → Settings → API (anon/publishable) |
| `ASAAS_API_KEY` | painel Asaas (vazio = modo mock; em prod é obrigatório) |
| `ASAAS_WEBHOOK_TOKEN` | você define e configura igual no webhook do Asaas |
| `TICKET_QR_SECRET` | segredo forte (≥16 chars) — assina o QR rotativo |
| `ADMIN_EMAILS` | e-mails do super-admin PulseADM, separados por vírgula |
| `CORS_ORIGIN` | domínios dos fronts (ex: `https://app.pulsepass.com,https://cockpit.pulsepass.com`) |
| `SECRET_BOX_KEY` | segredo forte (≥16 chars) — **cifra a apiKey das subcontas Asaas**. Sem ela, criar subconta é recusado |
| `RESEND_API_KEY` | painel Resend → API Keys. **Sem ela o cliente não recebe o ingresso por e-mail** |
| `EMAIL_FROM` | remetente verificado no Resend (ex: `ingressos@pulsepass.com`) |

> Sem `RESEND_API_KEY` + `EMAIL_FROM` a entrega fica desligada — mas não falha
> calada: cada pedido registra a tentativa como `skipped` em `email_deliveries`.
> Quando a configuração entrar, `POST /orders/{id}/resend-tickets` reenvia.

### Subcontas Asaas (abrir conta da produtora pela API)

A produtora abre a conta pelo cockpit e o `walletId` já fica configurado para o
split. Restrições da plataforma, que valem saber antes:

- **Só conta CNPJ cria subcontas.** Conta pessoa física recebe erro 400.
- Operação nova entra em **período de avaliação**: até 10 subcontas, limite de
  R$ 2.000 em cobranças por subconta, por até 60 dias.
- O Asaas devolve a `apiKey` da subconta **uma única vez**. Ela é guardada
  cifrada com `SECRET_BOX_KEY` e **nunca** é devolvida por nenhuma rota — nem
  para o super-admin. Perder a `SECRET_BOX_KEY` significa perder o acesso a
  essas chaves de forma irreversível: guarde-a junto com os outros segredos.
- Conta criada sem documento aprovado **não recebe**. Quando o Asaas exige
  envio, o cockpit mostra o link de onboarding para a produtora.

### Fiscal (NFS-e) — opcional, mas obrigatório para faturar

| Variável | Origem |
|---|---|
| `FISCAL_PROVIDER` | `mock` (padrão) ou `focusnfe` |
| `FISCAL_API_TOKEN` | token do emissor. **Vazio = modo mock: nada é enviado à prefeitura** |
| `FISCAL_BASE_URL` | endpoint do emissor (padrão: Focus NFe) |
| `FISCAL_SERVICE_CODE` | código do serviço na sua prefeitura (o contador informa) |
| `FISCAL_AUTO_ISSUE` | `true` emite a nota ao confirmar o pagamento. **Padrão `false`** |

> `FISCAL_AUTO_ISSUE` nasce desligado de propósito: emitir nota é ato com efeito
> legal e a casa precisa pedir explicitamente. Com ele desligado, a emissão é
> manual pelo cockpit (`POST /admin/events/{id}/fiscal/issue`).
> O reembolso de um pedido cancela a NFS-e correspondente automaticamente.

## Banco (uma vez, e a cada nova migration)

```bash
DATABASE_URL="postgresql://postgres:[SENHA]@db.[REF].supabase.co:5432/postgres" npm run migrate
```

## Fly.io

```bash
fly launch --no-deploy          # 1ª vez (cria o app a partir do fly.toml)
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ASAAS_WEBHOOK_TOKEN=... \
                TICKET_QR_SECRET=... ADMIN_EMAILS=... CORS_ORIGIN=...
fly deploy
```

## Railway / Render (alternativas)
Ambos leem o `Dockerfile` direto. Configure as mesmas variáveis no painel e defina o healthcheck
em `/api/health`.

## Local

```bash
docker build -t pulsepass-api .
docker run -p 4000:4000 --env-file .env pulsepass-api
```
