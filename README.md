# reddit-lite

A small Reddit-style site. It has posts, threaded comments, votes on posts, likes on comments, and users without passwords.

Stack: Node.js 24 or newer, pnpm, Hono, TypeScript (run by Node type stripping, no build step), Postgres, vanilla JavaScript.

## Run locally

1. Start the database: `docker compose up -d db`
2. Install packages: `pnpm install`
3. Set the connection: `export DATABASE_URL=postgres://postgres:postgres@localhost:5432/reddit_lite`
4. Apply migrations: `pnpm migrate`
5. Optional demo data: `pnpm seed`
6. Start the server: `pnpm dev`
7. Open http://localhost:3000

To run everything in containers instead, run `docker compose up --build`.

## Test

The tests in `test/app.test.ts` reset the `public` schema of the database in `DATABASE_URL`. Use a throwaway database.

```
pnpm typecheck
pnpm test
```

## Users

You pick a username on `/login`. A new name creates a user. An existing name acts as that user. There is no password, so anyone can act as any user. This is a known limit until registration exists.


