const isProd = process.env.NODE_ENV === 'production';

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (value) return value;
  if (isProd) throw new Error('SESSION_SECRET is required in production');
  return 'dev-only-secret-change-me';
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/reddit_lite',
  sessionSecret: secret(),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  maxDepth: 8,
  pageSize: 25,
};
