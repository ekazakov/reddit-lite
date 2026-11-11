import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { currentUser } from './auth.ts';
import { sql } from './db.ts';
import { auth } from './routes/auth.ts';
import { comments } from './routes/comments.ts';
import { posts } from './routes/posts.ts';
import { users } from './routes/users.ts';
import type { Env } from './types.ts';
import { layout } from './views/layout.ts';
import { html } from 'hono/html';

export const app = new Hono<Env>();

app.get('/healthz', async (c) => {
  await sql`SELECT 1`;
  return c.text('ok');
});

app.use('/*', serveStatic({ root: './public' }));
app.use('*', csrf());
app.use('*', currentUser);

app.route('/', auth);
app.route('/', posts);
app.route('/', comments);
app.route('/', users);

app.notFound((c) => c.html(layout('Not found', c.get('user') ?? null, html`<h1>Not found</h1>`), 404));

app.onError((err, c) => {
  console.error(err);
  return c.text('Server error', 500);
});
