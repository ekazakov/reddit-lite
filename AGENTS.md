# AGENTS.md

Guidance for AI coding agents that work in this repository.

## Project

reddit-lite is a small Reddit-style site. It has posts, threaded comments, votes on posts, likes on comments, and users without passwords. The README has the full description.

Stack: Node.js 24 or newer, pnpm, Hono, TypeScript, Postgres, vanilla JavaScript.

## Commands

- Install packages: `pnpm install`
- Start the database: `docker compose up -d db`
- Set the connection: `export DATABASE_URL=postgres://postgres:postgres@localhost:5432/reddit_lite`
- Apply migrations: `pnpm migrate`
- Load demo data: `pnpm seed`
- Run the dev server: `pnpm dev` (opens on http://localhost:3000)
- Check types: `pnpm typecheck`
- Run tests: `pnpm test`

The tests in `test/app.test.ts` reset the `public` schema of the database in `DATABASE_URL`. Point `DATABASE_URL` at a throwaway database before you run them.

## Layout

- `src/app.ts`, `src/server.ts`: Hono app and server entry point.
- `src/routes/`: HTTP handlers for auth, posts, comments, and users.
- `src/views/`: server-rendered HTML.
- `src/lib/`: shared helpers (comment tree, voting, utilities).
- `src/db.ts`, `src/migrate.ts`, `migrations/`: database access and SQL migrations.
- `public/`: browser JavaScript and CSS, served as static files.
- `test/`: tests that use the Node test runner.
- `scripts/`: seed script and load test helpers.
- `loadtest/`: k6 load tests.
- `infra/`, `deploy/`: Ansible and deployment files.

## Conventions

- TypeScript runs through Node type stripping. There is no build step. Use syntax that type stripping supports, and do not use enums or namespaces.
- Add a new numbered SQL file to `migrations/` for each schema change. Do not edit a migration that already ran.
- Keep the browser code in `public/` as plain JavaScript with no bundler.
- Run `pnpm typecheck` and `pnpm test` before you finish a change.

## Known limits

Users have no passwords. Anyone can act as any user. Do not treat this as a bug to fix unless the task asks for it.
