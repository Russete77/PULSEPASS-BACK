# Módulos verticais (backend)

Cada bounded context é uma pasta em `src/modules/<dominio>/` com 4 camadas:

```
modules/<dominio>/
  routes.js       # superfície HTTP: monta os endpoints, aplica requireAuth
  controller.js   # valida entrada (zod) e delega ao service; nada de regra
  service.js      # regra de negócio; fala com o banco SÓ via repo.js
  repo.js         # ÚNICA camada que toca supabase; retorna { data, error }
```

## Regras de fronteira (a serem impostas por lint — F1.5)

1. **`repo.js` é o único lugar** que importa `supabase`/faz query. Service nunca chama `supabase.from(...)` direto.
2. Um módulo importa de outro **apenas via o `service.js` (fachada) do outro** — nunca o `repo.js` alheio.
3. Infra transversal (hoje em `config/`, `middleware/`, `lib/`, `utils/`; alvo: `platform/`) pode ser importada por qualquer módulo.
4. Sem ciclos entre módulos de negócio. Kernels (`payments`, `identity`) podem ser dependidos por todos.

## Mapa de módulos (alvo)

| Módulo | Origem atual | Status |
|---|---|---|
| **tickets** | tickets/transfers (service+controller+routes) | ✅ migrado (padrão de referência) |
| **catalog** | events (+ menu público, delega a cashless) | ✅ migrado e verificado |
| **cashless** | wallet, bar | ✅ migrado e verificado (fachada usada por catalog/ops/webhooks) |
| **orders** | orders (checkout, reembolso) → usa payments/cashless | ✅ migrado e verificado (fachada usada por webhooks) |
| **guestlist** | lists, promoters, guestlist.service | ✅ migrado e verificado (admin monta promoters via fachada) |
| **door** | ops (check-in, offline, PDV) → usa cashless.placeBarOrder | ✅ migrado e verificado (rotas via admin.routes) |
| **payments** | webhooks, provider Asaas | ✅ migrado e verificado (provider usado por orders/cashless) |
| **identity** | admin (orgs/staff/perfil/eventos), access; cockpit `/admin` | ✅ migrado e verificado |
| **notifications** | delivery (e-mail/PDF) | ✅ migrado e verificado (usado por orders) |
| **coupons** | CRUD de cupons (gestão pelo produtor) | ✅ novo (F2.5); rotas sob /admin via cockpit; redenção fica em orders |

**Backend 100% modular.** `services/` e `controllers/` eliminados; `routes/index.js` só agrega; `lib/` = infra pura (logger, observability). Falta: lint de fronteira (F1.5) para congelar as regras acima automaticamente.

## Como migrar um módulo (checklist)

1. Criar `modules/<d>/{repo,service,controller,routes}.js`.
2. Extrair as queries do service antigo para `repo.js`.
3. Apontar `routes/index.js` para o novo `routes.js`.
4. Remover os arquivos antigos (`services/*.js`, `controllers/*.js`, `routes/*.routes.js`).
5. `grep` por imports órfãos; subir o servidor e bater um endpoint (401 = rota montada).
