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
- Audit runtime dependencies: `pnpm security:audit`
- Scan images and files with Trivy: `pnpm security:scan`

The tests in `test/app.test.ts` drop the `public` schema of their database. `pnpm test` does not read `DATABASE_URL`. It uses `TEST_DATABASE_URL`, and the default is the local `reddit_lite_test` database. Create that database once with `pnpm db:test:setup`. The tests refuse to run on a database whose name does not end with `_test`. Do not remove this check.

The load test stack (`pnpm loadtest:*`) runs in its own Compose project, `reddit-lite-loadtest`, with its own `pgdata` volume. Its host ports are 5433 for the db and 3100 for the app. `pnpm loadtest:seed` and `pnpm loadtest:restore` do not touch the development database.

A Claude Code hook in `.claude/settings.json` runs `pnpm typecheck` and `pnpm test` before each `git commit`, and blocks the commit if they fail.

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
- `scripts/security/`, `.github/workflows/`, `renovate.json5`, `.trivyignore`: security scans, CI, and automatic updates.

## Conventions

- TypeScript runs through Node type stripping. There is no build step. Use syntax that type stripping supports, and do not use enums or namespaces.
- Add a new numbered SQL file to `migrations/` for each schema change. Do not edit a migration that already ran.
- Keep the browser code in `public/` as plain JavaScript with no bundler.
- Run `pnpm typecheck` and `pnpm test` before you finish a change.

## DevOps, infra, and load testing

When you write or change files for DevOps, infrastructure, or load testing, add a comment to each line or step. The comment must say what the line does and why. This rule covers these files:

- Ansible files in `infra/`
- Deployment files in `deploy/`
- Docker and Compose files
- Shell scripts in `scripts/loadtest/`
- k6 tests in `loadtest/`
- Security scripts in `scripts/security/`
- GitHub Actions workflows in `.github/workflows/`
- The Renovate configuration in `renovate.json5`

Keep the security settings in `pnpm-workspace.yaml` explicit, including the ones that repeat a pnpm default. Do not remove them as redundant.

## Known limits

Users have no passwords. Anyone can act as any user. Do not treat this as a bug to fix unless the task asks for it.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `ekazakov/reddit-lite`, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
