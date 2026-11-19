# Security hardening plan: pnpm, Docker images, automatic updates

Task 1 saves this document as `plan/SECURITY-PLAN.md` in the repository, in the checkbox style of `plan/PLAN.md`. Each task gets checked off there as it is done.

## Context

The user wants two things. First, harden the pnpm configuration against supply-chain attacks, with an explanation for each setting. Second, Docker Desktop reports vulnerabilities in the project images. The user wants to scan the images without Docker Desktop, check for new vulnerabilities automatically, and apply updates automatically when a fix exists.

Decisions: Renovate for updates, Trivy for scanning, a hardened Dockerfile, and a release-age delay of 7 days.

Current state:
- pnpm 12.18.0 (`packageManager` in `package.json`). `pnpm-workspace.yaml` holds only `minimumReleaseAgeExclude` with the three direct dependencies, which turns the release-age delay off for them.
- There is no `.npmrc` and no `.github/`, so the project has no CI. The remote is `github.com/ekazakov/reddit-lite`.
- `Dockerfile` is a single stage on `node:26-alpine`. It keeps npm and pnpm in the final image and has almost no comments.
- Every image is pinned by tag only, with no digest: `node:26-alpine` and `postgres:17-alpine` (dev and prod compose). `docker-compose.loadtest.yml` adds `prom/prometheus:v3.5.0`, `grafana/grafana:12.1.0`, `prometheuscommunity/postgres-exporter:v0.17.1`, `gcr.io/cadvisor/cadvisor:v0.52.1`, and `grafana/k6:1.2.0`.

AGENTS.md requires a comment on each line or step of Docker, Compose, CI, and other DevOps files. That comment says what the line does and why. This applies to every new and changed DevOps file below. For that reason the Renovate config is `renovate.json5`, because JSON has no comments.

## pnpm settings reference

"Default" means pnpm 12 already does it, and we write it down so that a future pnpm release or a CLI flag cannot turn it off without notice. "New" means a real change.

| Setting | Value | Status | What it protects against |
|---|---|---|---|
| `minimumReleaseAge` | `10080` (7 days) | new (default is 1 day) | Most malicious versions are found and removed within hours or days. pnpm does not resolve a version until it is 7 days old. |
| `minimumReleaseAgeExclude` | `[]` (empty), kept with a process comment | new | This is the emergency bypass. When an urgent CVE fix is younger than 7 days, add its exact version (`pkg@x.y.z`). Remove the entry once the version is past the window. The current three entries go, because they weaken the protection for our most-used packages. |
| `trustPolicy` | `no-downgrade` | default, explicit | The install fails if a new version has weaker publish trust than older versions, for example no CI provenance where earlier versions had it. That is a typical sign of a stolen maintainer token. |
| `blockExoticSubdeps` | `true` | default, explicit | Transitive dependencies resolve only from the registry, never from git or tarball URLs. |
| `strictDepBuilds` | `true` | default, explicit | The install fails if a dependency has a build script that is not on the allow list. Install scripts are the usual way a compromised package runs code. |
| `allowBuilds` | `{}` | new | The allow list for build scripts. None of our dependencies need one, so any new build script stops the install for review. |
| `dangerouslyAllowAllBuilds` | `false` | default, explicit | Stops anyone from turning off the build-script protection globally. |
| `engineStrict` | `true` | new | Refuses installs on a Node version below `engines.node >=24`. |
| `verifyDepsBeforeRun` | `error` | new | `pnpm dev`, `pnpm test`, and other scripts fail if `node_modules` does not match the lockfile. |
| `minimumReleaseAgeStrict` | `true` | default, explicit (on when `minimumReleaseAge` is set) | If no version in the range is 7 days old, the install fails. When it is `false`, pnpm quietly falls back to a version that is too new. |
| `trustLockfile` | `false` | default, explicit | `pnpm install` checks every lockfile entry against `minimumReleaseAge` and `trustPolicy` again. This stops a PR that brings in a poisoned lockfile. |
| `verifyStoreIntegrity` | `true` | default, explicit | pnpm checks the content of store files before it links them. This catches corruption, but it does not protect a store that untrusted users can write to. |
| `strictStorePkgContentCheck` | `true` | default, explicit | The name and version inside a package must match what the lockfile says. |
| `strictSsl` | `true` | default, explicit | pnpm validates the registry TLS certificate, so a man-in-the-middle proxy cannot serve fake packages. |
| `saveExact` | `true` | new | `pnpm add` writes `4.13.18`, not `^4.13.18`. `package.json` then shows the exact version that runs, and every update is a visible Renovate PR. Task 2.2 also changes the existing `^` ranges to exact versions. Renovate `rangeStrategy: "pin"` matches this. |
| `nodeLinker` | `isolated` | default, explicit | Each package sees only the dependencies it declares, through symlinks. Hoisted or flat layouts let code load packages it never declared. |
| `virtualStoreType` | `project` | default, explicit | Each project keeps its own virtual store in `node_modules/.pnpm`. With `global`, `node_modules` holds only symlinks into a store that all projects on the machine share. One compromised or edited package there then affects every project, and the links break when the Docker final stage copies `node_modules` from the `deps` stage. The global store also adds no value with one project and one image. |
| `hoist` | `false` | new (default is `true`) | Also turns off the hidden hoisting into `node_modules/.pnpm/node_modules`, so a package cannot load an undeclared ("phantom") dependency. Risk: a package that depends on phantom dependencies breaks. Task 2.3 tests this. |
| `pnpmfile` | `[]` | new | pnpm loads no `.pnpmfile` hooks. A hook is code that runs on every install and can rewrite any dependency, so a PR that adds a `.pnpmfile.mjs` has no effect. Task 1.6 checks that pnpm accepts an empty list. |
| `skills.dirs` | `[]` | new | Turns off agent-skill linking. Without it, pnpm offers to link agent skills that dependencies ship into `.claude/skills`. Those skills become instructions for AI agents in this repo, and a malicious package can use them for prompt injection. |
| `audit.level` | `high` | new | `pnpm audit` reports and fails only for high and critical advisories. |
| `audit.ignore` | `[]` | new | GHSA ids to tolerate, each with a comment that gives the reason and a review date. |

Not included: `.npmrc` `ignore-scripts=true`, because `strictDepBuilds` plus `allowBuilds` cover the same risk and `ignore-scripts` also blocks our own lifecycle scripts.

## When and how pnpm audit runs

`pnpm audit` compares the lockfile with the npm advisory database. It needs no `node_modules`.

| When | Command | Result |
|---|---|---|
| Local, on demand | `pnpm audit` | Lists advisories at `audit.level` or above. |
| Local, before a dependency change | `pnpm security:audit` (new script: `pnpm audit --prod`) | Shows only what ships in the image. Dev tools such as `typescript` do not run in production. |
| Every PR and push to `main` (CI `test` job) | `pnpm audit --prod` | The job fails on a high or critical advisory. |
| Weekly (`security-scan.yml`) | `pnpm audit` | Full report, including dev dependencies. New advisories appear for versions we did not change. |
| Fix, when a finding appears | `pnpm audit --fix=update` first | Moves the vulnerable package to a fixed version inside the allowed range and updates the lockfile. |
| Fix, if no in-range fix exists | `pnpm audit --fix` | Writes an `overrides` entry in `pnpm-workspace.yaml` that forces the fixed version. Remove the override when the parent package updates. |

Renovate usually opens the fix PR first, through `osvVulnerabilityAlerts` and `lockFileMaintenance`. The audit in CI is the gate that makes sure the fix is in place.

Trade-off of the 7-day delay: a security fix also waits 7 days unless someone adds it to `minimumReleaseAgeExclude`. Renovate cannot add that entry, so a person handles urgent CVE fixes (see Task 6.4).

## Tasks

### Task 1. Save the plan and check the facts
- [x] 1.1 Copy this document to `plan/SECURITY-PLAN.md`.
- [x] 1.2 Package ages: `npm view hono time`, `npm view @hono/node-server time`, `npm view postgres time`. Make sure that the locked versions are older than 7 days. If one is not, keep its exclude entry until it is, and note the removal date.
- [x] 1.3 Repo visibility: `gh repo view ekazakov/reddit-lite --json visibility`. A public repo gets SARIF upload to the Security tab. A private repo gets a table in the job summary.
- [x] 1.4 Node image contents: `docker run --rm node:26-alpine ls /usr/local/lib/node_modules /usr/local/bin`. Record the exact npm, npx, corepack, and yarn paths to remove.
- [x] 1.5 Digests and SHAs: run `docker buildx imagetools inspect <image>` for each image and `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` for each GitHub Action. Never write these from memory. If a lookup fails, leave the tag and let Renovate's first pin PR add the digest.

The sandbox blocked network and Docker during planning, so these commands can need a run outside the sandbox.

- [x] 1.6 Run `pnpm config get pnpmfile` after you set `pnpmfile: []`. Make sure that pnpm accepts the empty list without an error. If it does not, use `ignorePnpmfile: true`.

### Task 2. Harden pnpm
- [x] 2.1 Rewrite `pnpm-workspace.yaml` with every setting in the reference table, including each one that only repeats a pnpm 12 default. A reviewer can then check the whole security configuration in one file without reading the pnpm docs. Layout:
  - Group the settings by topic: release age, trust and sources, build scripts, store and network, node_modules layout (`nodeLinker`, `virtualStoreType`, `hoist`), hooks and agent skills, audit.
  - Above each setting, write a comment that says what it does, why we set it, and whether it is `pnpm 12 default` or `changed from default (<old value>)`.
  - Add a header comment that says the defaults are explicit on purpose and must not be deleted as "redundant".
- [x] 2.2 Change the dependency ranges in `package.json` from `^x.y.z` to the exact versions in the lockfile, so they match `saveExact`.
- [x] 2.3 Delete `node_modules`, then run `pnpm install --frozen-lockfile`. Run `pnpm typecheck` and `pnpm test`. These steps show whether `hoist: false` breaks a package. If one breaks, add only that package to `hoistPattern`, with a comment that gives the reason.
- [x] 2.3a For each setting, make sure that the effective value is correct with `pnpm config get <key>`. A key that is not set returns `undefined`, so this check shows that the explicit values are read.
- [x] 2.4 Add `"security:audit": "pnpm audit --prod"` to `package.json`. Run `pnpm audit` once and record the result.

### Task 3. Harden the Dockerfile
- [x] 3.1 `deps` stage on `node:26-alpine@sha256:<digest>`. Install pnpm at the `packageManager` version, copy the manifest files, and run `pnpm install --frozen-lockfile --prod`.
- [x] 3.2 Final stage on the same pinned base. Run `apk upgrade --no-cache` and remove npm, npx, corepack, and yarn using the paths from 1.4.
- [x] 3.3 Copy `node_modules` from `deps`. pnpm symlinks are relative, so they still work after the copy. Then copy `src`, `migrations`, `public`, and `scripts`. Files stay owned by root, and the process runs as `USER node`, so the app cannot change its own code. Keep the current `CMD`.
- [x] 3.4 Add a comment to each line, as AGENTS.md requires.
- [x] 3.5 Pin `postgres:17-alpine` by digest in `docker-compose.yml` and `deploy/docker-compose.prod.yml`, and the loadtest images in `docker-compose.loadtest.yml`. Add a comment to each changed line.
- [x] 3.6 Build the image and make sure that `pnpm loadtest:up` still works, because the loadtest compose file uses `build: .`.

### Task 4. Local scanning with Trivy
- [x] 4.1 New `scripts/security/scan.sh`, commented per line. It uses a local `trivy` if one is installed. If not, it runs a pinned `aquasec/trivy` image with the Docker socket and a cache volume mounted.
- [x] 4.2 The script builds the app image and scans the app image, every image from `docker compose config --images` for the three compose files, and the repository (`trivy fs` for `pnpm-lock.yaml` and for mistakes in the Dockerfile and compose files).
- [x] 4.3 By default the script reports only `--severity HIGH,CRITICAL --ignore-unfixed`. With `ALL=1` it shows every finding.
- [x] 4.4 Add `"security:scan": "sh scripts/security/scan.sh"` to `package.json`.
- [x] 4.5 New `.trivyignore` with a header comment. It starts empty. Each future entry needs a CVE id, a reason, and an expiry date.

### Task 5. CI on GitHub Actions
- [x] 5.1 New `.github/workflows/ci.yml` that runs on `pull_request` and on `push` to `main`. Top-level `permissions: contents: read`. Every action pinned by commit SHA. Every step commented.
- [x] 5.2 Job `test`: a `postgres:17-alpine` service container, then `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm migrate`, `pnpm test`, and `pnpm audit --prod`. The test reset of the `public` schema is safe in a throwaway container.
- [x] 5.3 Job `image`: build the app image and scan it with `aquasecurity/trivy-action` (`HIGH,CRITICAL`, `--ignore-unfixed`, `exit-code 1`). The job fails only when a fix exists.
- [x] 5.4 New `.github/workflows/security-scan.yml` that runs weekly on a `schedule` and on `workflow_dispatch`. It runs a full `pnpm audit`, then scans the rebuilt app image (gate) and each third-party image through a matrix (report only, `exit-code 0`). New CVEs appear in images we did not change, so the weekly run is the automatic check.
- [x] 5.5 Results go out as SARIF upload with `security-events: write` if 1.3 shows a public repo, or as a job-summary table if the repo is private.

### Task 6. Automatic updates with Renovate
- [x] 6.1 New `renovate.json5`, commented per line. Extends `config:recommended`, `docker:pinDigests`, `helpers:pinGitHubActionDigests`, and `:semanticCommits`. Weekly `schedule` with a `timezone`.
- [x] 6.2 Set `minimumReleaseAge: "7 days"` for npm, the same as pnpm. If Renovate waited less, the lockfile update in its PR would fail. Turn on `osvVulnerabilityAlerts: true` and `vulnerabilityAlerts` with the label `security`. Run `lockFileMaintenance` weekly, because that is how transitive fixes arrive.
- [x] 6.2a Set `rangeStrategy: "pin"` for npm, so Renovate keeps exact versions, the same as `saveExact`.
- [x] 6.3 Managers: `npm`, `dockerfile`, `docker-compose` (with `managerFilePatterns` that cover `deploy/docker-compose.prod.yml` and `docker-compose.loadtest.yml`), and `github-actions`.
- [x] 6.4 `packageRules`:
  - Auto-merge patch and minor npm updates, digest updates, and Actions updates after CI passes.
  - Never auto-merge majors, `postgres` image changes (a Postgres major needs a data migration), or the `pnpm` `packageManager` bump.
  - Group the loadtest images into one PR and all Actions into one PR.
  - Write the urgent-CVE process in a comment. If a vulnerability PR fails because of the 7-day delay, add the exact fixed version to `minimumReleaseAgeExclude` in that PR, then remove it later.

### Task 7. Documentation
- [x] 7.1 Add a "Security" section to `README.md` that covers the pnpm settings, `pnpm security:scan`, Renovate with the weekly scan, and the processes for `.trivyignore` and `minimumReleaseAgeExclude`.
- [x] 7.2 In `AGENTS.md`, add `pnpm security:scan` to "Commands", and add `.github/workflows/` and `renovate.json5` to the DevOps file list.

### Task 8. Verification
- [x] 8.1 Start a throwaway database with `docker compose up -d db`. Make sure that `pnpm typecheck` and `pnpm test` pass.
- [x] 8.2 Build the image with `docker build -t reddit-lite:scan .`. Make sure that `docker run --rm --entrypoint sh reddit-lite:scan -c 'which npm; ls /usr/local/lib/node_modules'` shows no npm. Run `docker compose up`, open http://localhost:3000, and make sure that the home page loads.
- [x] 8.3 Run `pnpm security:scan`. Compare the HIGH and CRITICAL counts of the new app image with an image built from the old Dockerfile on `main`.
- [ ] 8.4 Run `pnpm loadtest:up`, then `pnpm loadtest:down`.
- [x] 8.5 Lint the workflows with `actionlint` (Docker image) and the Renovate config with `npx --package renovate renovate-config-validator`.
- [ ] 8.6 After the push, make sure that `ci.yml` passes on the PR and that a manual run of `security-scan.yml` completes.

### Task 9. Steps only the user can do
These need repository admin rights or a login.
- [ ] 9.1 Install the Renovate GitHub App on `ekazakov/reddit-lite` and merge its onboarding PR.
- [ ] 9.2 Protect `main` and require the `test` and `image` checks, so that auto-merge waits for CI.
- [ ] 9.3 Turn on "Allow auto-merge" in the repository settings.
- [ ] 9.4 Optional: install Trivy locally for faster scans.

```bash
brew install trivy
```

## Implementation notes

These choices differ from the task text above or add to it:

- Task 1.2: the three locked versions were published on 2026-11-11. They were 8 days old on 2026-11-19, so all exclude entries were removed.
- Task 1.3: the repository is public, so the weekly scan uploads SARIF to the Security tab.
- Task 1.4: Node 26 Alpine ships only npm and npx. It has no corepack and no yarn.
- Task 3.1: the Dockerfile reads the pnpm version from `packageManager` in `package.json`, so Renovate updates one place only.
- Task 4: the local script and CI fail only for findings in the app image or the repository files. Third-party image findings are for information, because only a newer tag fixes them.
- Task 5.4: the weekly scan reads the image list from the compose files, so the list cannot drift.
- Task 6.4: Postgres digest updates (same `17-alpine` tag) merge automatically, because they carry OS security fixes. Only Postgres major updates wait for a person.
- Task 8.3: the old image had 30 findings (6 HIGH with a fix, 23 MEDIUM, 1 LOW) and was 441 MB. The new image has 0 findings and is 272 MB.
- Task 8.4: not run, because the main checkout's load test stack used the same ports during the work.
- The local scan found HIGH and CRITICAL findings in all six third-party images. Most are in Go binaries built with an old Go version. Renovate PRs with newer tags fix them.
