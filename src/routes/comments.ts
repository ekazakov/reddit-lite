import { Hono } from 'hono';
import { isEnhanced, needLogin } from '../auth.ts';
import { sql } from '../db.ts';
import { buildTree, findNode } from '../lib/tree.ts';
import { safeNext } from '../lib/util.ts';
import type { CommentRow, Env } from '../types.ts';
import { commentItem, commentTree } from '../views/comment.ts';
import { layout } from '../views/layout.ts';
import { html } from 'hono/html';

export const comments = new Hono<Env>();

comments.post('/p/:id/comments', async (c) => {
  const user = c.get('user');
  if (!user) return needLogin(c);
  const postId = Number(c.req.param('id'));
  const form = await c.req.parseBody();
  const body = typeof form.body === 'string' ? form.body.trim() : '';
  const parentId = form.parent_id ? Number(form.parent_id) : null;
  if (!Number.isInteger(postId) || body.length < 1 || body.length > 5000) return c.text('Bad request', 400);
  if (parentId !== null && !Number.isInteger(parentId)) return c.text('Bad request', 400);

  const created = await sql.begin(async (tx) => {
    const post = await tx`SELECT id FROM posts WHERE id = ${postId} FOR UPDATE`;
    if (post.length === 0) return null;
    if (parentId !== null) {
      const parent = await tx`SELECT 1 FROM comments WHERE id = ${parentId} AND post_id = ${postId}`;
      if (parent.length === 0) return 'bad-parent' as const;
    }
    const rows = await tx<CommentRow[]>`
      INSERT INTO comments (post_id, parent_id, user_id, body)
      VALUES (${postId}, ${parentId}, ${user.id}, ${body})
      RETURNING id, post_id, parent_id, body, like_count, created_at, ${user.name}::text AS author, false AS liked`;
    await tx`UPDATE posts SET comment_count = comment_count + 1 WHERE id = ${postId}`;
    return rows[0]!;
  });
  if (created === null) return c.notFound();
  if (created === 'bad-parent') return c.text('Bad request', 400);

  if (isEnhanced(c)) return c.html(commentItem({ ...created, children: [] }, user, 1));
  return c.redirect(`/p/${postId}#c-${created.id}`);
});

comments.post('/c/:id/like', async (c) => {
  const user = c.get('user');
  if (!user) return needLogin(c);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.text('Bad request', 400);

  const result = await sql.begin(async (tx) => {
    const target = await tx<{ post_id: number }[]>`SELECT post_id FROM comments WHERE id = ${id} FOR UPDATE`;
    if (target.length === 0) return null;
    const removed = await tx`DELETE FROM comment_likes WHERE user_id = ${user.id} AND comment_id = ${id} RETURNING 1`;
    const liked = removed.length === 0;
    if (liked) await tx`INSERT INTO comment_likes (user_id, comment_id) VALUES (${user.id}, ${id})`;
    const updated = await tx<{ like_count: number }[]>`
      UPDATE comments SET like_count = like_count + ${liked ? 1 : -1} WHERE id = ${id} RETURNING like_count`;
    return { postId: target[0]!.post_id, liked, likeCount: updated[0]!.like_count };
  });
  if (!result) return c.notFound();
  if (isEnhanced(c)) return c.json({ liked: result.liked, likeCount: result.likeCount });
  const form = await c.req.parseBody();
  return c.redirect(safeNext(form.next, `/p/${result.postId}#c-${id}`));
});

comments.get('/c/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();
  const target = await sql<{ post_id: number; title: string }[]>`
    SELECT c.post_id, p.title FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ${id}`;
  if (target.length === 0) return c.notFound();
  const { post_id, title } = target[0]!;
  const all = await sql<CommentRow[]>`
    SELECT c.id, c.post_id, c.parent_id, c.body, c.like_count, c.created_at, u.name AS author,
           EXISTS (SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = ${user?.id ?? 0}) AS liked
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ${post_id}
    ORDER BY c.created_at, c.id`;
  const node = findNode(buildTree(all), id);
  if (!node) return c.notFound();
  // Show the subtree as a root, so depth counting starts again here.
  const root = { ...node, parent_id: null };
  const page = html`<p class="meta"><a href="/p/${post_id}">← ${title}</a>
      ${node.parent_id ? html` · <a href="/c/${node.parent_id}">parent comment</a>` : ''}</p>
    ${commentTree([root], user)}`;
  return c.html(layout('Comment thread', user, page));
});
