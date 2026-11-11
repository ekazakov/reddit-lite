import { html } from 'hono/html';
import type { CommentRow, User } from '../types.ts';
import type { TreeNode } from '../lib/tree.ts';
import { ago } from '../lib/util.ts';
import { config } from '../config.ts';
import type { Html } from './layout.ts';

type Node = TreeNode<CommentRow>;

export function commentForm(postId: number, parentId: number | null, user: User | null): Html {
  if (!user) return html`<p class="meta"><a href="/login?next=/p/${postId}">Log in</a> to comment.</p>`;
  return html`<form method="post" action="/p/${postId}/comments" class="stack comment-form" data-enhance="comment">
    ${parentId ? html`<input type="hidden" name="parent_id" value="${parentId}">` : ''}
    <textarea name="body" rows="3" maxlength="5000" required placeholder="Write a comment"></textarea>
    <button>Reply</button>
  </form>`;
}

export function commentItem(c: Node, user: User | null, depth: number): Html {
  const deep = depth >= config.maxDepth;
  return html`<li id="c-${c.id}" class="comment">
    <div class="comment-head meta">
      <a href="/u/${c.author}">${c.author}</a> · <a href="/c/${c.id}">${ago(c.created_at)}</a>
    </div>
    <div class="comment-body">${c.body}</div>
    <div class="comment-actions">
      <form method="post" action="/c/${c.id}/like" class="like" data-enhance="like">
        <button class="${c.liked ? 'active' : ''}" aria-label="like">♥ <span class="count">${c.like_count}</span></button>
      </form>
      <details class="reply"><summary>reply</summary>${commentForm(c.post_id, c.id, user)}</details>
    </div>
    <ul class="children" id="children-${c.id}">
      ${deep && c.children.length > 0
        ? html`<li class="more"><a href="/c/${c.id}">continue thread (${countDescendants(c)} more) →</a></li>`
        : c.children.map((child) => commentItem(child, user, depth + 1))}
    </ul>
  </li>`;
}

function countDescendants(n: Node): number {
  return n.children.reduce((sum, ch) => sum + 1 + countDescendants(ch), 0);
}

export function commentTree(roots: Node[], user: User | null): Html {
  return html`<ul class="children" id="comments">${roots.map((r) => commentItem(r, user, 1))}</ul>`;
}
