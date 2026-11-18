const isProd = process.env.NODE_ENV === 'production';

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (value) return value;
  if (isProd) throw new Error('SESSION_SECRET is required in production');
  return 'dev-only-secret-change-me';
}

// The most connections that the app opens to Postgres. Read at startup, so a
// new value needs a new container, not a new image.
function dbPoolMax(): number {
  const raw = process.env.DB_POOL_MAX;
  if (raw === undefined || raw === '') return 10;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`DB_POOL_MAX must be a positive integer, got "${raw}"`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/reddit_lite',
  sessionSecret: secret(),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  maxDepth: 8,
  pageSize: 25,
  dbPoolMax: dbPoolMax(),
};
