import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { User } from '../types.ts';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export function layout(title: string, user: User | null, body: Html): Html {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · reddit-lite</title>
  <link rel="stylesheet" href="/style.css">
  <script src="/app.js" defer></script>
</head>
<body>
  <header class="top">
    <a class="brand" href="/">reddit-lite</a>
    <nav>
      <a href="/">new</a>
      <a href="/?sort=top">top</a>
      <a href="/submit">submit</a>
    </nav>
    <span class="who">
      ${user
        ? html`<a href="/u/${user.name}">${user.name}</a>
            <form method="post" action="/logout" class="inline"><button class="link">log out</button></form>`
        : html`<a href="/login">log in</a>`}
    </span>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

export const empty = raw('');
