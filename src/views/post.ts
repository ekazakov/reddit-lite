import { html } from 'hono/html';
import type { PostRow } from '../types.ts';
import { ago } from '../lib/util.ts';
import type { Html } from './layout.ts';

export function voteForm(p: Pick<PostRow, 'id' | 'score' | 'my_vote'>, next: string): Html {
  return html`<form method="post" action="/p/${p.id}/vote" class="vote" data-enhance="vote">
    <input type="hidden" name="next" value="${next}">
    <button name="value" value="1" class="${p.my_vote === 1 ? 'active' : ''}" aria-label="upvote">▲</button>
    <span class="score">${p.score}</span>
    <button name="value" value="-1" class="${p.my_vote === -1 ? 'active down' : ''}" aria-label="downvote">▼</button>
  </form>`;
}

export function postItem(p: PostRow, next: string): Html {
  const host = p.url ? new URL(p.url).hostname : null;
  return html`<article class="post">
    ${voteForm(p, next)}
    <div class="post-main">
      <h2>
        ${p.url ? html`<a href="${p.url}" rel="nofollow noopener">${p.title}</a> <small>(${host})</small>` : html`<a href="/p/${p.id}">${p.title}</a>`}
      </h2>
      <p class="meta">
        by <a href="/u/${p.author}">${p.author}</a> · ${ago(p.created_at)} ·
        <a href="/p/${p.id}">${p.comment_count} ${p.comment_count === 1 ? 'comment' : 'comments'}</a>
      </p>
    </div>
  </article>`;
}

export function postList(posts: PostRow[], next: string): Html {
  if (posts.length === 0) return html`<p class="empty">No posts yet. <a href="/submit">Write the first one.</a></p>`;
  return html`${posts.map((p) => postItem(p, next))}`;
}

export function pager(sort: string, page: number, hasNext: boolean): Html {
  return html`<nav class="pager">
    ${page > 1 ? html`<a href="/?sort=${sort}&page=${page - 1}">← newer</a>` : ''}
    ${hasNext ? html`<a href="/?sort=${sort}&page=${page + 1}">older →</a>` : ''}
  </nav>`;
}

export function submitPage(error?: string, values: { title?: string; url?: string; body?: string } = {}): Html {
  return html`<h1>Submit a post</h1>
  ${error ? html`<p class="error">${error}</p>` : ''}
  <form method="post" action="/submit" class="stack">
    <label>Title <input name="title" maxlength="300" required value="${values.title ?? ''}"></label>
    <label>Link (optional) <input name="url" type="url" value="${values.url ?? ''}"></label>
    <label>Text (optional) <textarea name="body" rows="6" maxlength="10000">${values.body ?? ''}</textarea></label>
    <button>Post</button>
  </form>`;
}

export function loginPage(next: string, error?: string, name = ''): Html {
  return html`<h1>Pick a username</h1>
  <p>There is no password. Use a new name to create a user. Use an existing name to act as that user.</p>
  ${error ? html`<p class="error">${error}</p>` : ''}
  <form method="post" action="/login" class="stack">
    <input type="hidden" name="next" value="${next}">
    <label>Username <input name="name" required minlength="3" maxlength="20" pattern="[a-zA-Z0-9_\\-]{3,20}" value="${name}" autofocus></label>
    <button>Continue</button>
  </form>`;
}
