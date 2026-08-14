import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const file = process.argv[2];
const version = process.argv[3];

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL_POOLER,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});
await c.connect();
console.log('· conectado (pooler)');

const sql = readFileSync(file, 'utf8');
try {
  await c.query('begin');
  await c.query(sql);
  await c.query(
    'insert into public.schema_migrations(version) values ($1) on conflict do nothing',
    [version],
  );
  await c.query('commit');
  console.log(`✓ ${version} aplicada`);
} catch (e) {
  await c.query('rollback');
  console.error(`✖ FALHOU: ${e.message}`);
  if (e.position) console.error(`  posição ${e.position}: ...${sql.slice(Math.max(0, e.position - 200), Number(e.position) + 120)}...`);
  process.exitCode = 1;
}
await c.end();
