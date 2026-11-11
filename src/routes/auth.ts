import { Hono } from 'hono';
import { signIn, signOut } from '../auth.ts';
import { sql } from '../db.ts';
import { safeNext } from '../lib/util.ts';
import type { Env } from '../types.ts';
import { layout } from '../views/layout.ts';
import { loginPage } from '../views/post.ts';

export const auth = new Hono<Env>();

const NAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

auth.get('/login', (c) => {
  const next = safeNext(c.req.query('next'));
  return c.html(layout('Log in', c.get('user'), loginPage(next)));
});

auth.post('/login', async (c) => {
  const form = await c.req.parseBody();
  const name = typeof form.name === 'string' ? form.name.trim() : '';
  const next = safeNext(form.next);
  if (!NAME_RE.test(name)) {
    return c.html(layout('Log in', null, loginPage(next, 'Use 3 to 20 letters, digits, "_" or "-".', name)), 400);
  }
  // The no-op update makes RETURNING work for names that already exist.
  const rows = await sql<{ id: number }[]>`
    INSERT INTO users (name) VALUES (${name})
    ON CONFLICT (name) DO UPDATE SET name = users.name
    RETURNING id`;
  await signIn(c, rows[0]!.id);
  return c.redirect(next);
});

auth.post('/logout', (c) => {
  signOut(c);
  return c.redirect('/');
});
