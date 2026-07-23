import { createApp } from './app.js';
import { env } from './config/env.js';
import { asaasMode } from './modules/payments/provider.js';
import { initObservability } from './lib/observability.js';

await initObservability();

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`\n  PulsePass API`);
  console.log(`  ▸ http://localhost:${env.port}/api/health`);
  console.log(`  ▸ ambiente: ${env.nodeEnv}`);
  console.log(`  ▸ Asaas:    ${asaasMode}`);
  console.log(`  ▸ CORS:     ${env.corsOrigin.join(', ')}\n`);
});

function shutdown(signal) {
  console.log(`\n[${signal}] encerrando…`);
  server.close(() => { console.log('servidor fechado.'); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref(); // força saída se travar
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
