#!/usr/bin/env node
// Runner de migrations — aplica migrations/*.sql EM ORDEM, idempotente.
// Registra o que já rodou em public.schema_migrations, então rodar de novo é seguro.
//
// Uso:
//   DATABASE_URL="postgresql://postgres:[SENHA]@db.[REF].supabase.co:5432/postgres" node scripts/migrate.mjs
//
// A connection string vem do painel Supabase → Settings → Database → Connection string
// (use a "Direct connection" ou "Session pooler", porta 5432 — DDL não roda no transaction pooler).
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const url = process.env.DATABASE_URL;
const poolerUrl = process.env.DATABASE_URL_POOLER;
if (!url && !poolerUrl) {
  console.error('✖ Defina DATABASE_URL (connection string do Postgres do Supabase).');
  process.exit(1);
}

// A "Direct connection" do Supabase resolve só em IPv6. Em rede sem IPv6 ela
// expira sem explicação — por isso o Session pooler (IPv4, porta 5432, aceita
// DDL) entra como alternativa automática em vez de travar a migration.
let client;
async function connect() {
  let ultimoErro;
  for (const [nome, conn] of [['direta', url], ['pooler IPv4', poolerUrl]].filter(([, c]) => c)) {
    const c = new pg.Client({
      connectionString: conn, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
    });
    try {
      await c.connect();
      console.log(`· conexão ${nome}`);
      return c;
    } catch (e) {
      ultimoErro = e;
      console.log(`· conexão ${nome} indisponível (${e.code || e.message})`);
      try { await c.end(); } catch { /* já caiu */ }
    }
  }
  throw ultimoErro;
}

async function main() {
  client = await connect();
  await client.query(`create table if not exists public.schema_migrations (
    version text primary key, applied_at timestamptz not null default now()
  )`);
  // Tabela de ops interna: trancada (RLS on, sem política) — nunca exposta via PostgREST.
  await client.query('alter table public.schema_migrations enable row level security');
  await client.query('revoke all on public.schema_migrations from anon, authenticated');

  const applied = new Set(
    (await client.query('select version from public.schema_migrations')).rows.map((r) => r.version),
  );
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  let ran = 0;
  for (const file of files) {
    const version = file.replace('.sql', '');
    if (applied.has(version)) { console.log(`· já aplicada  ${version}`); continue; }
    const sql = readFileSync(join(DIR, file), 'utf8');
    process.stdout.write(`→ aplicando   ${version} … `);
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into public.schema_migrations(version) values ($1)', [version]);
      await client.query('commit');
      console.log('ok');
      ran++;
    } catch (e) {
      await client.query('rollback');
      console.error(`\n✖ FALHOU em ${version}:\n  ${e.message}`);
      process.exit(1);
    }
  }
  console.log(`\n✓ ${ran} migration(s) aplicada(s), ${files.length} no total.`);
  await client.end();
}

main().catch((e) => { console.error('✖', e.message); process.exit(1); });
