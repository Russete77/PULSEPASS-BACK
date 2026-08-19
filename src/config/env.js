import 'dotenv/config';

/** Lê uma env obrigatória; lança erro claro se faltar (fail-fast). */
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`[env] variável obrigatória ausente: ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Sufixos de domínio aceitos ALÉM da lista exata.
   *
   * A Vercel dá uma URL nova a cada deploy
   * (`pulsepass-admin-448i1gf7m-russete77s-projects.vercel.app`), então lista
   * exata nunca acompanha: todo deploy quebraria o app com erro de CORS até
   * alguém editar a variável à mão.
   *
   * CUIDADO COM O QUE SE COLOCA AQUI. A Vercel separa o time por HÍFEN, não
   * por ponto — o sufixo do time é `-russete77s-projects.vercel.app`. Hífen
   * não é fronteira de domínio como o ponto é: alguém que crie um projeto
   * chamado `x-russete77s-projects` recebe `x-russete77s-projects.vercel.app`,
   * que termina com esse mesmo sufixo. Ou seja, isto NÃO é garantia
   * criptográfica de origem — é conveniência de ambiente de teste.
   *
   * Por isso: use em preview, e mantenha só os domínios ESTÁVEIS em
   * CORS_ORIGIN quando o app for pra produção de verdade.
   *
   * `.vercel.app` sozinho é recusado sempre: liberaria a internet inteira.
   */
  corsOriginSuffix: (process.env.CORS_ORIGIN_SUFFIX ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && !/^\.?vercel\.app$/.test(s) && s.length > 12),

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: process.env.SUPABASE_ANON_KEY ?? '',
  },

  asaas: {
    baseUrl: process.env.ASAAS_BASE_URL ?? 'https://api-sandbox.asaas.com/v3',
    apiKey: process.env.ASAAS_API_KEY ?? '',
    webhookToken: process.env.ASAAS_WEBHOOK_TOKEN ?? '',
    // Split/repasse: taxa da plataforma (%) retida em cada venda.
    platformFeePercent: Number(process.env.PLATFORM_FEE_PERCENT ?? 0),
  },

  publicApiUrl: process.env.PUBLIC_API_URL ?? 'http://localhost:4000',

  // Super-admin (PulseADM): e-mails com acesso ao god-mode da plataforma.
  // Em dev, default inclui as contas de teste para facilitar. Em prod, defina ADMIN_EMAILS.
  adminEmails: (process.env.ADMIN_EMAILS
    ?? (process.env.NODE_ENV === 'production'
      ? ''
      : 'atendimento.smu@gmail.com,erickrussomat@gmail.com,e2e_produtora@pulsepass.test'))
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  // Ingressos: segredo p/ assinar o QR rotativo (anti-golpe). Dev tem fallback;
  // em produção é obrigatório (senão qualquer um forjaria um token de entrada).
  tickets: {
    qrSecret: process.env.TICKET_QR_SECRET ?? 'dev-only-qr-secret-change-me',
    qrTtlSeconds: Number(process.env.TICKET_QR_TTL ?? 30),
  },

  // Observabilidade (opcional). Se vazio, Sentry fica desativado.
  sentryDsn: process.env.SENTRY_DSN ?? '',

  // Entrega de ingresso por e-mail (opcional, via Resend).
  email: {
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    from: process.env.EMAIL_FROM ?? '',
  },

  // Chave que cifra segredos de terceiros no banco (hoje: apiKey da subconta
  // Asaas da produtora). Fica FORA do banco de propósito — quem tiver só o dump
  // não abre nada. Sem ela, criar subconta é recusado.
  secretBoxKey: process.env.SECRET_BOX_KEY ?? '',

  // Fiscal (NFS-e). Sem credencial o provedor roda em MOCK: a nota é registrada
  // com número simulado, o fluxo inteiro fica testável e NADA é enviado à
  // prefeitura. Em produção sem credencial a nota fica 'pending' — o sistema
  // nunca finge que emitiu um documento fiscal.
  fiscal: {
    provider: process.env.FISCAL_PROVIDER ?? 'mock',    // mock | focusnfe
    apiToken: process.env.FISCAL_API_TOKEN ?? '',
    baseUrl: process.env.FISCAL_BASE_URL ?? 'https://api.focusnfe.com.br',
    serviceCode: process.env.FISCAL_SERVICE_CODE ?? '', // código municipal do serviço
    autoIssue: (process.env.FISCAL_AUTO_ISSUE ?? 'false') === 'true',
  },
};

// Guard de produção: sem ASAAS_WEBHOOK_TOKEN o webhook seria fail-open
// (qualquer um forjaria PAYMENT_CONFIRMED e mintaria saldo/ingressos). Recusa subir.
if (env.isProd && !env.asaas.webhookToken) {
  throw new Error('[env] ASAAS_WEBHOOK_TOKEN é obrigatório em produção (webhook seria fail-open).');
}
if (env.isProd && (!process.env.TICKET_QR_SECRET || process.env.TICKET_QR_SECRET.length < 16)) {
  throw new Error('[env] TICKET_QR_SECRET (>=16 chars) é obrigatório em produção (QR de entrada seria forjável).');
}

// ── Coerência entre a chave do Asaas e o endereço da API ──
//
// O default de ASAAS_BASE_URL é o SANDBOX, de propósito: em desenvolvimento é o
// certo. Mas subir em produção sem trocar apontaria dinheiro real para um
// ambiente de teste — e o erro só apareceria quando a venda não caísse.
//
// A própria doc do Asaas alerta para o par errado: chave de sandbox
// ($aact_hmlg_) só funciona em api-sandbox, e chave de produção ($aact_prod_)
// só em api.asaas.com. Trocar os dois é erro de configuração silencioso.
const ehSandbox = /api-sandbox\.asaas\.com/.test(env.asaas.baseUrl);
const chave = env.asaas.apiKey || '';
if (env.isProd && ehSandbox) {
  throw new Error(
    '[env] ASAAS_BASE_URL aponta para o SANDBOX em produção. '
    + 'Use https://api.asaas.com/v3 — senão as vendas reais iriam para um ambiente de teste.',
  );
}
if (chave.startsWith('$aact_hmlg_') && !ehSandbox) {
  throw new Error('[env] chave de SANDBOX ($aact_hmlg_) com endereço de PRODUÇÃO. Confira ASAAS_BASE_URL.');
}
if (chave.startsWith('$aact_prod_') && ehSandbox) {
  throw new Error('[env] chave de PRODUÇÃO ($aact_prod_) apontando para o SANDBOX. Confira ASAAS_BASE_URL.');
}
