import { Hono } from 'hono';
import { isEnhanced, needLogin } from '../auth.ts';
import { config } from '../config.ts';
import { sql } from '../db.ts';
import { buildTree } from '../lib/tree.ts';
import { isHttpUrl, safeNext } from '../lib/util.ts';
import { nextVote, type VoteValue } from '../lib/vote.ts';
import type { CommentRow, Env, PostRow } from '../types.ts';
import { commentForm, commentTree } from '../views/comment.ts';
import { layout } from '../views/layout.ts';
import { pager, postItem, postList, submitPage } from '../views/post.ts';
import { html } from 'hono/html';

export const posts = new Hono<Env>();

posts.get('/', async (c) => {
  const user = c.get('user');
  const sort = c.req.query('sort') === 'top' ? 'top' : 'new';
  const page = Math.max(1, Math.floor(Number(c.req.query('page'))) || 1);
  const order = sort === 'top' ? sql`p.score DESC, p.created_at DESC` : sql`p.created_at DESC`;
  const rows = await sql<PostRow[]>`
    SELECT p.id, p.title, p.body, p.url, p.score, p.comment_count, p.created_at,
           u.name AS author, COALESCE(v.value, 0)::int AS my_vote
    FROM posts p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN post_votes v ON v.post_id = p.id AND v.user_id = ${user?.id ?? 0}
    ORDER BY ${order}
    LIMIT ${config.pageSize + 1} OFFSET ${(page - 1) * config.pageSize}`;
  const hasNext = rows.length > config.pageSize;
  const next = `/?sort=${sort}&page=${page}`;
  return c.html(layout('Posts', user, html`${postList(rows.slice(0, config.pageSize), next)}${pager(sort, page, hasNext)}`));
});

posts.get('/submit', (c) => {
  const user = c.get('user');
  if (!user) return needLogin(c);
  return c.html(layout('Submit', user, submitPage()));
});

posts.post('/submit', async (c) => {
  const user = c.get('user');
  if (!user) return needLogin(c);
  const form = await c.req.parseBody();
  const title = typeof form.title === 'string' ? form.title.trim() : '';
  const url = typeof form.url === 'string' ? form.url.trim() : '';
  const body = typeof form.body === 'string' ? form.body.trim() : '';
  const values = { title, url, body };
  let error = '';
  if (title.length < 1 || title.length > 300) error = 'Title must be 1 to 300 characters.';
  else if (url && !isHttpUrl(url)) error = 'Link must start with http:// or https://.';
  else if (body.length > 10000) error = 'Text must be at most 10000 characters.';
  if (error) return c.html(layout('Submit', user, submitPage(error, values)), 400);
  const rows = await sql<{ id: number }[]>`
    INSERT INTO posts (user_id, title, body, url)
    VALUES (${user.id}, ${title}, ${body}, ${url || null})
    RETURNING id`;
  return c.redirect(`/p/${rows[0]!.id}`);
});

posts.get('/p/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();
  const found = await sql<PostRow[]>`
    SELECT p.id, p.title, p.body, p.url, p.score, p.comment_count, p.created_at,
           u.name AS author, COALESCE(v.value, 0)::int AS my_vote
    FROM posts p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN post_votes v ON v.post_id = p.id AND v.user_id = ${user?.id ?? 0}
    WHERE p.id = ${id}`;
  const post = found[0];
  if (!post) return c.notFound();
  const comments = await sql<CommentRow[]>`
    SELECT c.id, c.post_id, c.parent_id, c.body, c.like_count, c.created_at,
           u.name AS author,
           EXISTS (SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = ${user?.id ?? 0}) AS liked
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ${id}
    ORDER BY c.created_at, c.id`;
  const page = html`${postItem(post, `/p/${id}`)}
    ${post.body ? html`<div class="post-body">${post.body}</div>` : ''}
    <h3>Comments</h3>
    ${commentForm(id, null, user)}
    ${commentTree(buildTree(comments), user)}`;
  return c.html(layout(post.title, user, page));
});

posts.post('/p/:id/vote', async (c) => {
  const user = c.get('user');
  if (!user) return needLogin(c);
  const id = Number(c.req.param('id'));
  const form = await c.req.parseBody();
  const value = Number(form.value);
  if (!Number.isInteger(id) || (value !== 1 && value !== -1)) return c.text('Bad request', 400);

  const result = await sql.begin(async (tx) => {
    // Locking the post row makes concurrent votes update the score one at a time.
    const post = await tx`SELECT id FROM posts WHERE id = ${id} FOR UPDATE`;
    if (post.length === 0) return null;
    const old = await tx<{ value: number }[]>`SELECT value FROM post_votes WHERE user_id = ${user.id} AND post_id = ${id}`;
    const { next, delta } = nextVote((old[0]?.value ?? 0) as VoteValue, value);
    if (next === 0) {
      await tx`DELETE FROM post_votes WHERE user_id = ${user.id} AND post_id = ${id}`;
    } else {
      await tx`
        INSERT INTO post_votes (user_id, post_id, value) VALUES (${user.id}, ${id}, ${next})
        ON CONFLICT (user_id, post_id) DO UPDATE SET value = EXCLUDED.value`;
    }
    const updated = await tx<{ score: number }[]>`UPDATE posts SET score = score + ${delta} WHERE id = ${id} RETURNING score`;
    return { score: updated[0]!.score, myVote: next };
  });
  if (!result) return c.notFound();
  if (isEnhanced(c)) return c.json(result);
  return c.redirect(safeNext(form.next, `/p/${id}`));
});
