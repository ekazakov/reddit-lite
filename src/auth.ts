import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { config } from './config.ts';
import { sql } from './db.ts';
import type { Env, User } from './types.ts';

const COOKIE = 'rl_user';

export const currentUser = createMiddleware<Env>(async (c, next) => {
  const raw = await getSignedCookie(c, config.sessionSecret, COOKIE);
  let user: User | null = null;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const rows = await sql<User[]>`SELECT id, name FROM users WHERE id = ${Number(raw)}`;
    user = rows[0] ?? null;
  }
  c.set('user', user);
  await next();
});

export async function signIn(c: Context<Env>, userId: number): Promise<void> {
  await setSignedCookie(c, COOKIE, String(userId), config.sessionSecret, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function signOut(c: Context<Env>): void {
  deleteCookie(c, COOKIE, { path: '/' });
}

/** Enhanced requests come from public/app.js and want JSON or fragments, not redirects. */
export function isEnhanced(c: Context<Env>): boolean {
  return c.req.header('x-requested-with') === 'fetch';
}

export function needLogin(c: Context<Env>): Response {
  if (isEnhanced(c)) return c.json({ error: 'login required', login: '/login' }, 401);
  return c.redirect('/login?next=' + encodeURIComponent(c.req.path));
}
