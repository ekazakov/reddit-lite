import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sql } from './db.ts';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await sql.begin(async (tx) => {
      // The advisory lock stops two app containers from migrating at once.
      await tx`SELECT pg_advisory_xact_lock(727274)`;
      const done = await tx`SELECT 1 FROM schema_migrations WHERE name = ${file}`;
      if (done.length > 0) return;
      await tx.unsafe(await readFile(dir + file, 'utf8'));
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      console.log(`applied ${file}`);
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate();
  await sql.end();
}
