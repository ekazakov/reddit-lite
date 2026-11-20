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

The tests in `test/app.test.ts` drop the `public` schema of their database. For this reason, they use a separate database, `reddit_lite_test`, and never `reddit_lite`. The tests refuse to run on a database whose name does not end with `_test`.

`pnpm test` ignores `DATABASE_URL`. It reads `TEST_DATABASE_URL`, and the default is `postgres://postgres:postgres@localhost:5432/reddit_lite_test`.

Before the first test run, start the database (`docker compose up -d db`) and create the test database:

```
pnpm db:test:setup
```

Then run the checks:

```
pnpm typecheck
pnpm test
```

## Users

You pick a username on `/login`. A new name creates a user. An existing name acts as that user. There is no password, so anyone can act as any user. This is a known limit until registration exists.


## Security

### pnpm settings

`pnpm-workspace.yaml` holds the supply-chain settings. It lists every setting, including the ones that repeat a pnpm 12 default, so you can review the whole configuration in one file. A comment above each setting says what it does and whether it changes a default. `plan/SECURITY-PLAN.md` gives the full reasons.

The main rules:

- pnpm installs a version only when it is at least 7 days old (`minimumReleaseAge: 10080`).
- Dependency build scripts do not run unless they are listed in `allowBuilds`. The list is empty.
- Each install checks the lockfile entries again against the release age and the trust policy (`trustLockfile: false`).
- `pnpm dev`, `pnpm test`, and other scripts fail if `node_modules` does not match the lockfile.

### Urgent security fix for an npm package

pnpm also refuses a security fix that is younger than 7 days. If you must install it now, do these steps:

1. Add the exact version, for example `hono@4.13.20`, to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.
2. Above the entry, write a comment with the CVE id and the date to remove the entry.
3. Run `pnpm install`.
4. Remove the entry when the version is older than 7 days.

### Audit and scan

- `pnpm security:audit` checks the runtime dependencies in the lockfile against the npm advisory database. `pnpm audit` also checks the dev dependencies.
- If the audit reports a finding, run `pnpm audit --fix=update` first. It updates the package inside its version range. If no fixed version fits the range, `pnpm audit --fix` writes an override in `pnpm-workspace.yaml`.
- `pnpm security:scan` builds the app image and scans it with Trivy. It also scans the images in the compose files and the repository files. If Trivy is not installed, the script runs the Trivy Docker image. `ALL=1 pnpm security:scan` shows every finding.

The script exits with an error only for findings in the app image or the repository files. Findings in third-party images are for information, because a newer image tag from Renovate is the only fix.

To accept a finding, add its CVE id to `.trivyignore` with a reason and an expiry date.

### Automatic checks and updates

- CI (`.github/workflows/ci.yml`) runs on each pull request. It runs the typecheck, the tests, `pnpm security:audit`, and a Trivy scan of the app image. The scan fails on HIGH or CRITICAL findings that have a fix.
- The weekly scan (`.github/workflows/security-scan.yml`) runs every Monday at 05:00 UTC. It sends all findings to the repository Security tab.
- Renovate (`renovate.json5`) opens update PRs on Mondays. Security fixes come at any time.
- Patch, minor, and digest updates merge automatically after CI passes. Major updates, Postgres major versions, and pnpm updates wait for a review.
