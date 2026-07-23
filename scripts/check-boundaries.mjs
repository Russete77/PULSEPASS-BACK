#!/usr/bin/env node
// Lint de fronteira dos módulos verticais (F1.5), sem dependências externas.
// Regras (ver src/modules/MODULES.md):
//   1. Nenhum módulo importa o repo.js de OUTRO módulo (cross-module só via fachada).
//   2. O cliente supabase só é importado em repo.js / provider.js / access.js
//      (arquivos de acesso a dados). Exceções transitórias explícitas abaixo.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const MODULES_DIR = join(process.cwd(), 'src', 'modules');

// Arquivos autorizados a importar o cliente supabase diretamente.
const SUPABASE_ALLOWED_BASENAMES = new Set(['repo.js', 'provider.js', 'access.js']);
// Exceções transitórias (TODO: remover quando identity expor fachada de perfil).
const SUPABASE_ALLOWED_PATHS = new Set([
  join('cashless', 'controller.js'),
  join('orders', 'controller.js'),
]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const IMPORT_RE = /import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const errors = [];
const warnings = [];

for (const file of walk(MODULES_DIR)) {
  const relFromModules = relative(MODULES_DIR, file);       // ex: cashless/controller.js
  const moduleName = relFromModules.split(sep)[0];
  const basename = relFromModules.split(sep).pop();
  const src = readFileSync(file, 'utf8');

  let m;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const spec = m[1];

    // Regra 1: import de repo.js de outro módulo
    const repoMatch = spec.match(/(?:^|\/)\.\.\/([^/]+)\/repo(?:\.js)?$/) || spec.match(/^\.\.\/([^/]+)\/repo(?:\.js)?$/);
    if (repoMatch && repoMatch[1] !== moduleName) {
      errors.push(`[cross-repo] ${relFromModules} importa repo de "${repoMatch[1]}" (use a fachada service.js)`);
    }

    // Regra 2: import do cliente supabase
    if (/config\/supabase(\.js)?$/.test(spec)) {
      if (!SUPABASE_ALLOWED_BASENAMES.has(basename)) {
        if (SUPABASE_ALLOWED_PATHS.has(relFromModules)) {
          warnings.push(`[supabase-transitório] ${relFromModules} importa supabase fora de repo.js (exceção conhecida)`);
        } else {
          errors.push(`[supabase] ${relFromModules} importa o cliente supabase fora de repo.js/provider.js/access.js`);
        }
      }
    }
  }
}

for (const w of warnings) console.warn('⚠ ' + w);
if (errors.length) {
  for (const e of errors) console.error('✖ ' + e);
  console.error(`\nFronteira: ${errors.length} violação(ões).`);
  process.exit(1);
}
console.log(`✓ Fronteira dos módulos OK${warnings.length ? ` (${warnings.length} aviso transitório)` : ''}.`);
