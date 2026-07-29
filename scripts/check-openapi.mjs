#!/usr/bin/env node
// Guard de contrato: falha se existir rota registrada que NÃO está no openapi.yaml.
// Impede o contrato (fonte da verdade front↔back) de desatualizar silenciosamente.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Prefixo de montagem de cada router (de src/routes/index.js).
// cashless expõe dois routers no mesmo arquivo; idem guestlist.
const MOUNTS = [
  { file: 'catalog/routes.js', prefix: '/events' },
  { file: 'orders/routes.js', prefix: '/orders' },
  { file: 'tickets/routes.js', prefix: '/tickets' },
  { file: 'tables/routes.js', prefix: '/tables' },
  { file: 'payments/routes.js', prefix: '/webhooks' },
  { file: 'platform/routes.js', prefix: '/platform' },
  { file: 'identity/routes.js', prefix: '/admin' },
  // arquivos com múltiplos routers → varremos por nome do router
  { file: 'cashless/routes.js', prefix: '/wallet', only: 'walletRouter' },
  { file: 'cashless/routes.js', prefix: '/bar-orders', only: 'barRouter' },
  { file: 'guestlist/routes.js', prefix: '/lists', only: 'router' },
  { file: 'guestlist/routes.js', prefix: '/promoter', only: 'promoterRouter' },
];

const norm = (p) => p.replace(/:(\w+)/g, '{$1}').replace(/\/$/, '') || '/';

function routesFrom(file, prefix, only) {
  const src = readFileSync(join(ROOT, 'src', 'modules', file), 'utf8');
  const rx = /(\w+)\.(get|post|patch|put|delete)\(\s*'([^']*)'/g;
  const out = [];
  let m;
  while ((m = rx.exec(src))) {
    const [, routerVar, method, path] = m;
    if (only && routerVar !== only) continue;
    if (!only && routerVar !== 'router') continue;
    if (path === '/' && prefix) out.push(`${method.toUpperCase()} ${prefix}`);
    else out.push(`${method.toUpperCase()} ${norm(prefix + path)}`);
  }
  return out;
}

const real = new Set(MOUNTS.flatMap((m) => routesFrom(m.file, m.prefix, m.only)));

// Paths declarados no spec (YAML simples: "  /path:" e verbos indentados).
const spec = readFileSync(join(ROOT, 'openapi.yaml'), 'utf8').split('\n');
const specPaths = new Set();
let cur = null;
for (const line of spec) {
  const p = line.match(/^ {2}(\/\S*):\s*$/);
  if (p) { cur = norm(p[1]); continue; }
  const v = line.match(/^ {4}(get|post|patch|put|delete):/);
  if (v && cur) specPaths.add(`${v[1].toUpperCase()} ${cur}`);
}

const missing = [...real].filter((r) => !specPaths.has(r)).sort();
console.log(`Contrato OpenAPI: ${specPaths.size} operações documentadas · ${real.size} rotas reais.`);
if (missing.length) {
  console.error(`\n✖ ${missing.length} rota(s) SEM documentação no openapi.yaml:`);
  for (const r of missing) console.error('   ' + r);
  console.error('\nDocumente-as em openapi.yaml (path + método) para o contrato voltar a bater.');
  process.exit(1);
}
console.log('✓ Toda rota registrada está no contrato.');
