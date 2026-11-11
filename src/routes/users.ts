import { Hono } from 'hono';
import { html } from 'hono/html';
import { sql } from '../db.ts';
import { ago } from '../lib/util.ts';
import type { Env, PostRow } from '../types.ts';
import { layout } from '../views/layout.ts';
import { postList } from '../views/post.ts';

export const users = new Hono<Env>();

users.get('/u/:name', async (c) => {
  const me = c.get('user');
  const name = c.req.param('name');
  const found = await sql<{ id: number; name: string; created_at: Date }[]>`
    SELECT id, name, created_at FROM users WHERE name = ${name}`;
  const user = found[0];
  if (!user) return c.notFound();
  const posts = await sql<PostRow[]>`
    SELECT p.id, p.title, p.body, p.url, p.score, p.comment_count, p.created_at,
           u.name AS author, COALESCE(v.value, 0)::int AS my_vote
    FROM posts p JOIN users u ON u.id = p.user_id
    LEFT JOIN post_votes v ON v.post_id = p.id AND v.user_id = ${me?.id ?? 0}
    WHERE p.user_id = ${user.id} ORDER BY p.created_at DESC LIMIT 50`;
  const recent = await sql<{ id: number; post_id: number; body: string; created_at: Date }[]>`
    SELECT id, post_id, body, created_at FROM comments
    WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 50`;
  const page = html`<h1>${user.name}</h1>
    <p class="meta">Joined ${ago(user.created_at)}</p>
    <h3>Posts</h3>${postList(posts, `/u/${user.name}`)}
    <h3>Comments</h3>
    ${recent.length === 0
      ? html`<p class="empty">No comments yet.</p>`
      : recent.map((r) => html`<div class="user-comment"><a href="/p/${r.post_id}#c-${r.id}">${ago(r.created_at)}</a>
          <div class="comment-body">${r.body.slice(0, 300)}</div></div>`)}`;
  return c.html(layout(user.name, me, page));
});
