import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
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

// no-cache makes browsers refetch app.js and style.css, so a deploy shows up at once.
app.use('/*', serveStatic({ root: './public', onFound: (_path, c) => { c.header('Cache-Control', 'no-cache'); } }));
app.use('*', csrf());
app.use('*', currentUser);

app.route('/', auth);
app.route('/', posts);
app.route('/', comments);
app.route('/', users);

app.notFound((c) => c.html(layout('Not found', c.get('user') ?? null, html`<h1>Not found</h1>`), 404));

app.onError((err, c) => {
  // Keep intended statuses such as the 403 from csrf().
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.text('Server error', 500);
});
