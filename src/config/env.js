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
    .map((s) => s.trim()),

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
