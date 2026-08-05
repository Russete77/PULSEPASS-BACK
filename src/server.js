import { createApp } from './app.js';
import { env } from './config/env.js';
import { asaasMode } from './modules/payments/provider.js';
import { initObservability } from './lib/observability.js';
import { supabase } from './config/supabase.js';

await initObservability();

const app = createApp();

/**
 * Aquece a conexão com o banco antes do primeiro cliente chegar.
 *
 * A primeira consulta paga DNS + handshake TLS com o Supabase (~700ms em rede
 * boa, bem mais em rede fria). Sem isto, quem paga essa conta é o primeiro
 * visitante da vitrine — e em plataforma que hiberna a máquina ociosa (Fly com
 * auto_stop_machines), isso se repete a cada vez que ela acorda.
 *
 * Falhar aqui é irrelevante: a requisição real tentará de novo.
 */
async function warmup() {
  const t0 = Date.now();
  await supabase.from('events').select('id', { head: true, count: 'exact' }).limit(1);
  console.log(`  ▸ conexão aquecida em ${Date.now() - t0}ms\n`);
}

const server = app.listen(env.port, () => {
  console.log(`\n  PulsePass API`);
  console.log(`  ▸ http://localhost:${env.port}/api/health`);
  console.log(`  ▸ ambiente: ${env.nodeEnv}`);
  console.log(`  ▸ Asaas:    ${asaasMode}`);
  console.log(`  ▸ CORS:     ${env.corsOrigin.join(', ')}`);
  warmup().catch(() => { /* a primeira requisição real reconecta */ });
});

function shutdown(signal) {
  console.log(`\n[${signal}] encerrando…`);
  server.close(() => { console.log('servidor fechado.'); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref(); // força saída se travar
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
