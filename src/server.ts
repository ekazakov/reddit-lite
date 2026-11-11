import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { config } from './config.ts';
import { sql } from './db.ts';

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`listening on :${info.port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
