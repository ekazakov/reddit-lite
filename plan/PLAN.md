# Reddit-lite: implementation plan

Package manager: pnpm. Reverse proxy and HTTPS are out of scope for now.

## Status

- All steps are written and verified.
- `pnpm typecheck` passes. All 8 tests pass against Postgres 17 in Docker (3 unit, 5 integration).
- The production image builds, applies migrations on start, and serves `/healthz`.
- Browser check passed with JavaScript on (nested replies, vote toggle and flip, like toggle, no page reload) and with plain form posts (redirects, escaping, redirect safety).
- Bugs found and fixed during verification: `onError` turned the CSRF 403 into a 500, `public/app.js` lost the vote value (it read the form data after disabling the buttons), and browsers cached stale static files (now `Cache-Control: no-cache`).

## Context

The project folder is empty. You want a small Reddit-style site with posts, threaded comments, votes on posts, likes on comments, and users without registration. The stack is Node.js with Hono, TypeScript, Postgres, and vanilla JavaScript in the browser. The site is a multi-page app. It ships as Docker containers on DigitalOcean droplets.

Decisions from the clarifying questions:

- Users: the visitor types a username. The server creates the user if the name is new. A signed cookie holds the identity. There is no password.
- Votes and likes: posts get up and down votes with a score. Comments get a single like toggle.
- Language: TypeScript, run directly by Node 26 type stripping. There is no build step.
- Rendering: the server renders HTML pages. Small vanilla JS adds votes, likes, and replies without a page reload.

Known limitation: anyone can type an existing username and act as that user. This is acceptable until registration exists.

## Tech constraints from Node type stripping

Node 26 removes type annotations but does no other transform. Because of this:

- Use `html` tagged templates from `hono/html` for all views. Do not use `hono/jsx`, because JSX needs a compile step.
- The `html` template escapes interpolated values. This protects post and comment bodies from XSS. Use `raw()` only for trusted markup.
- Use only erasable syntax: no `enum`, no parameter properties, no namespaces.
- Write imports with explicit `.ts` extensions. Write type-only imports with `import type`.
- `tsconfig.json` is for the editor and type check only: `noEmit`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `strict`.

## File layout

```
package.json            pnpm scripts: dev, start, migrate, seed, test, typecheck
tsconfig.json
src/server.ts           @hono/node-server, serveStatic for public/, middleware
src/app.ts              builds the Hono app (tests import this)
src/db.ts               `postgres` package client from DATABASE_URL
src/auth.ts             signed cookie helpers, currentUser middleware
src/migrate.ts          runs migrations/*.sql in order, tracks schema_migrations
src/routes/auth.ts      GET/POST /login, POST /logout
src/routes/posts.ts     /, /p/:id, /submit, POST /p/:id/vote
src/routes/comments.ts  POST /p/:id/comments, POST /c/:id/like, GET /c/:id
src/routes/users.ts     /u/:name
src/views/layout.ts     page shell, header with current user
src/views/*.ts          one module per page, plus comment tree fragments
src/lib/tree.ts         builds the nested comment tree from a flat list
migrations/001_init.sql
public/app.js           progressive enhancement
public/style.css
scripts/seed.ts         demo users, posts, nested comments
test/*.test.ts          node --test
Dockerfile
.dockerignore
docker-compose.yml      local development
pnpm-lock.yaml
pnpm-workspace.yaml
deploy/docker-compose.prod.yml
deploy/backup.sh
README.md
```

## Database schema

`migrations/001_init.sql`:

- `users(id bigserial PK, name citext UNIQUE, created_at)`. The name must match `^[a-zA-Z0-9_-]{3,20}$`.
- `posts(id, user_id FK, title, body, url NULL, score int default 0, comment_count int default 0, created_at)`. Index on `created_at` and on `score`.
- `post_votes(user_id, post_id, value smallint CHECK (value IN (-1, 1)), PK(user_id, post_id))`.
- `comments(id, post_id FK, parent_id NULL FK comments, user_id FK, body, like_count int default 0, created_at)`. Index on `post_id`.
- `comment_likes(user_id, comment_id, PK(user_id, comment_id))`.

`posts.score`, `posts.comment_count`, and `comments.like_count` are cached counters. The app updates each counter in the same transaction as the row change that affects it.

## Behavior

Vote toggle on a post, inside one transaction:

1. Read the old vote value (0 if there is none).
2. If the new value equals the old value, delete the vote. The score change is `-old`.
3. Else upsert the vote. The score change is `new - old`.
4. Apply the change to `posts.score` and return the new score and the user's vote.

Like toggle on a comment: insert into `comment_likes`. If the row exists, delete it. Change `like_count` by +1 or -1.

Comment threads: load all comments for a post with one query, ordered by `created_at`. `src/lib/tree.ts` builds the tree in memory. The page renders to a depth of 8. Deeper replies show a "continue thread" link to `GET /c/:id`, which renders that comment and its subtree.

Sorting on `/`: `?sort=new` (default) and `?sort=top`. Pagination uses `?page=N`, 25 posts per page.

## Pages

| Route | Content |
|---|---|
| `/` | Post list with score, vote buttons, author, comment count |
| `/p/:id` | Post, vote buttons, comment form, threaded comments |
| `/c/:id` | One comment with its subtree |
| `/submit` | New post form (login required) |
| `/u/:name` | User's posts and comments |
| `/login` | Username form. `POST /logout` clears the cookie |

## Auth and security

- `setSignedCookie` from `hono/cookie` with `SESSION_SECRET` from the environment. The cookie holds the user id.
- Cookie flags: `httpOnly`, `SameSite=Lax`, 30 days. `secure` is on when `COOKIE_SECURE=true`.
- The `hono/csrf` middleware protects all POST routes, because forms use cookie auth.
- Write actions without a user redirect to `/login?next=...`.
- Length limits: title 300 characters, body 10000 characters, comment 5000 characters.

## Progressive enhancement

Every vote, like, and reply is a normal `<form method="post">`. Without JavaScript, the route redirects back to the page. So the site works with JavaScript off.

`public/app.js` intercepts these forms with `fetch` and sends `Accept: application/json`:

- Vote and like routes return JSON `{ score, myVote }` or `{ likeCount, liked }`. The script updates the counter and button state.
- The reply route returns the new comment as an HTML fragment. The script inserts it under its parent.
- A "reply" link under each comment shows an inline form. One delegated click listener on `document` handles all reply links.

## Deploy

- `Dockerfile`: one stage on `node:26-alpine` (make sure that the tag exists at build time). It installs pnpm with npm, runs `pnpm install --frozen-lockfile --prod`, copies the source, and runs as the `node` user. The command runs migrations, then starts the server with `exec node`.
- `docker-compose.yml` (local): app plus `postgres:17` on a named volume, with a `pg_isready` healthcheck. The app uses `depends_on: condition: service_healthy`.
- `deploy/docker-compose.prod.yml`: app and Postgres. The app publishes port 80 on the droplet directly. There is no reverse proxy and no HTTPS for now. Because of this, the `secure` cookie flag stays off until HTTPS exists. A `COOKIE_SECURE` environment variable controls it.
- Add a reverse proxy (for example Caddy) later, when you have a domain.
- One droplet runs both containers by default. To use more than one app droplet, move Postgres to DO Managed Postgres and put a DO load balancer in front. The signed cookie keeps the app stateless, so this needs no code change.
- `deploy/backup.sh`: a daily `pg_dump` from cron, kept for 7 days.
- `README.md` lists the droplet steps: install Docker, copy the deploy folder, write `.env`, run `docker compose up -d`.

## Implementation order

1. Package, tsconfig, Hono server with a health route at `/healthz`.
2. Database client, migration runner, schema.
3. Login, logout, cookie middleware.
4. Post list, post page, submit form.
5. Comments, tree builder, threaded rendering.
6. Votes and likes with transactions.
7. `public/app.js` and `public/style.css`.
8. Seed script, tests.
9. Dockerfile, compose files, backup script, README.

## Verification

- `pnpm typecheck` runs `tsc --noEmit` with no errors.
- `pnpm test` runs `node --test` against a test database. Tests use Hono `app.request()` and cover the vote toggle math (up, up again, up then down), the like toggle, the tree builder with three levels, CSRF rejection, and login redirects.
- `docker compose up` starts the app and Postgres. `pnpm seed` loads demo data.
- In the browser pane: log in, create a post, reply three levels deep, vote, and like. Make sure that the counters update without a reload.
- Repeat the same flow with JavaScript off. Make sure that every form still works through redirects.
- Build the production image with `docker build` and make sure that it starts and runs migrations.

## Task list

- [x] 1. Scaffold package, tsconfig, health route
- [x] 2. Database client, migrations, schema
- [x] 3. Login, logout, cookie middleware
- [x] 4. Post list, post page, submit form
- [x] 5. Comments, tree builder, threaded views
- [x] 6. Votes and likes with transactions
- [x] 7. Client JS and CSS
- [x] 8. Seed script and tests written
- [x] 9. Dockerfile, compose files, backup script, README
- [x] 10. Switch project to pnpm
- [x] 11. Run integration tests against Postgres
- [x] 12. Smoke test in the browser pane, JavaScript on and off
- [x] 13. Build and run the Docker image
