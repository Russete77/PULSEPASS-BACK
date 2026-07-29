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
