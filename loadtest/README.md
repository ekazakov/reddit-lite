# Load tests

This folder holds the k6 load tests for reddit-lite. The tests run on local Docker. The app and db containers have resource limits that match a 2 vCPU / 2 GB droplet.

For an explanation of each tool, diagrams, and a guide to the dashboards, see [How the load tests work](HOW-IT-WORKS.md).

The plan and the task list are in these documents:

- [Load test plan](https://claude.ai/artifact/9ha7oyfkHyaVyqtFAMsn5J)
- [Task list](https://claude.ai/artifact/4NP5riJjSgtQAMoX5k55TR)

## Before you start

1. Set the Docker Desktop VM to at least 6 CPUs and 6 GB of memory (Settings > Resources). The app and db share CPUs 0 and 1. The monitoring containers and k6 run on CPUs 2 to 5, so they take no CPU from the app and db.
2. If you want other limits, copy `loadtest/.env.example` to `loadtest/.env` and change the values. If `loadtest/.env` exists, the scripts read it.

| Variable | Default | Meaning |
|---|---|---|
| `SUT_CPUSET` | `0-1` | Docker VM CPUs that the app and db share, like the 2 vCPUs of the droplet |
| `TOOLS_CPUSET` | `2-5` | Docker VM CPUs for Prometheus, Grafana, the exporters, and k6. Must not overlap `SUT_CPUSET` |
| `APP_MEM` | `512m` | Memory limit for the app container |
| `APP_HEAP_MB` | `384` | Node heap limit, about 75% of `APP_MEM` |
| `DB_MEM` | `1g` | Memory limit for the db container |
| `DB_SHARED_BUFFERS` | `256MB` | Postgres `shared_buffers`, about 25% of `DB_MEM` |
| `DB_EFFECTIVE_CACHE_SIZE` | `768MB` | Postgres `effective_cache_size`, about 75% of `DB_MEM` |

## Run the tests

Run these commands from the repo root, in this order.

1. Start the stack:

   ```bash
   pnpm loadtest:up
   ```

2. Load the mock data. The tiers are `S`, `default`, and `L`.

   Warning: this command deletes all rows in the load test database. The development database is safe, because the load test stack uses its own Compose project (`reddit-lite-loadtest`) and its own volume.

   ```bash
   pnpm loadtest:seed default
   ```

   The script writes CSV files and a snapshot to `loadtest/data/`.

3. Run the smoke test. All checks must pass before you continue.

   ```bash
   pnpm loadtest:smoke
   ```

4. Restore the snapshot, then run the staircase test:

   ```bash
   pnpm loadtest:restore
   ```

   ```bash
   pnpm loadtest:stairs
   ```

5. Open Grafana at http://localhost:3001 and open the "Load test" folder.

You can pass k6 options after the script name. For example, a short staircase:

```bash
pnpm loadtest:stairs -e STEPS=10,20 -e HOLD=1m
```

| Script | Variables | Defaults |
|---|---|---|
| `smoke` | `DURATION` | `1m` |
| `stairs` | `STEPS`, `RAMP`, `HOLD`, `PRE_VUS`, `MAX_VUS` | `25,50,100,200,400,800`, `30s`, `4m`, `200`, `2000` |
| `soak` | `RATE`, `DURATION` | `50`, `1h` |
| `spike` | `BASE_RATE`, `PEAK` | `20`, `200` (the spike goes to 2 times `PEAK`) |

Restore the snapshot before each run, because the write actions change the data.

## Run results

Each run saves its files in one folder, `loadtest/results/<script>-<time>/`. The folder name is the test id. Grafana and Prometheus use the same id in the `testid` label.

| File | Content |
|---|---|
| `meta.json` | What ran: the script, the `-e` flags, the git commit, the times, and the k6 exit code. It also has the real app and db configuration before and after the run. |
| `summary.json` | The k6 summary (`--summary-export`) |
| `k6.csv.gz` | Every k6 sample (`--out csv`). It has one row per request metric, so it is the largest file. |
| `prom.json` | App and db CPU, memory, connections, locks, and the slowest queries. It also has a timeline in 30 s buckets and the knee (the first time p95 stays over 500 ms). |
| `prom-series.json` | The raw 5 s Prometheus points of every series in `prom.json` |
| `timeseries.json` | 1 s and 10 s buckets from `k6.csv.gz`, with exact p50, p95, and p99 overall and per action. The report builds it on first use. |
| `report.html` | The report of this run |

The real configuration comes from `docker inspect` and `SHOW` in Postgres (`scripts/loadtest/sut-config.ts`), not from `loadtest/.env`. If a value did not apply, the report shows it.

Prometheus keeps 7 days of data, so you can export the Prometheus files of an older run again:

```bash
pnpm loadtest:prom stairs-20261118-205214
```

The restore resets `pg_stat_statements`. If you want query text in `prom.json`, export before the next `restore.sh`.

If you have result files from before the run folders (`<testid>.json` and `<testid>-prom.json`), move them into folders once:

```bash
pnpm loadtest:migrate-results
```

## HTML report

`k6.sh` builds `report.html` in the run folder after each run. The page is one file with the charts and the data inline, so it opens from disk without a server or internet.

To compare runs on one page, pass the run ids or a selection. The page is saved in `loadtest/results/reports/`:

```bash
pnpm loadtest:report stairs-20261118-205214 stairs-20261119-091500
```

```bash
pnpm loadtest:report --last 3 --baseline stairs-20261118-205214
```

| Option | Selects |
|---|---|
| `<testid> ...` | The given runs |
| `--all` | Every run folder |
| `--last N` | The N newest runs |
| `--match TEXT` | Runs whose id has TEXT |
| `--batch ID` | The runs of one `matrix.sh` batch |
| `--baseline ID` | The run that the deltas compare against. The default is the first run. |
| `--out FILE` | Another output file |

The page has these parts:

- Runs and Configuration: what ran, and the pool size, cpuset, and memory of each run. Cells that differ between runs have a yellow background.
- Summary: the main numbers of each run, with the change against the baseline. Green is better and red is worse.
- Over time: k6 load and latency, container CPU and memory, and Postgres charts. Runs line up at the first k6 sample. Dashed lines show the limits: p95 500 ms, the core count, the memory limits, and `DB_POOL_MAX`.
- Against offered rate: one point per 10 s bucket, with the offered rate on the x axis. Runs with different `STEPS` compare directly here. The rate where the p95 points leave the bottom is the knee.
- Slowest queries and checks.

The summary row "Max sustained rate" is the highest offered rate that stays in the limits for 30 s, which is 3 buckets of 10 s in a row. The limits are p95 at or under 500 ms, no dropped iterations, and under 1% errors. Use it as the capacity of a configuration.

## Compare configurations

`scripts/loadtest/matrix.sh` runs the same test with several app and db configurations in a row. Each line of a matrix file is one variant:

```
# name        configuration
pool10        DB_POOL_MAX=10 SUT_CPUSET=0-1 APP_MEM=512m DB_MEM=1g
pool20        DB_POOL_MAX=20 SUT_CPUSET=0-1 APP_MEM=512m DB_MEM=1g
pool10-1cpu   DB_POOL_MAX=10 SUT_CPUSET=0   APP_MEM=512m DB_MEM=1g
```

The allowed keys are `DB_POOL_MAX`, `SUT_CPUSET`, `APP_MEM`, `APP_HEAP_MB`, `DB_MEM`, `DB_SHARED_BUFFERS`, and `DB_EFFECTIVE_CACHE_SIZE`. Keys that a line leaves out come from `loadtest/.env`. If a line sets `APP_MEM` but not `APP_HEAP_MB`, the heap is 75% of `APP_MEM`. If a line sets `DB_MEM`, `shared_buffers` is 25% and `effective_cache_size` is 75% of it. These are the same ratios as in `.env.example`. App and db always share the one `SUT_CPUSET`.

1. Make sure that the matrix is valid. A dry run checks every line and prints the configuration, but starts nothing:

   ```bash
   DRY_RUN=1 pnpm loadtest:matrix loadtest/matrix/example.txt
   ```

2. Run the batch. The script name and the k6 flags follow the file name:

   ```bash
   pnpm loadtest:matrix loadtest/matrix/example.txt stairs -e STEPS=25,50,75,100 -e HOLD=1m
   ```

For each variant, the script recreates the app and db containers with the variant configuration, restores the snapshot, and runs `k6.sh`. Docker applies the cpuset and the memory limit only when it creates a container. Postgres reads its `-c` flags at the same time. For these reasons a restart is not enough. At the end the script recreates app and db with the `loadtest/.env` values, and builds `loadtest/results/reports/batch-<batch>.html`. The first line is the baseline. The log of the batch is next to the report.

| Variable | Default | Meaning |
|---|---|---|
| `REPEAT` | `1` | Runs per variant. Use 2 or 3 to see how much results change between equal runs. |
| `COOLDOWN` | `30` | Seconds between runs |
| `DRY_RUN` | empty | Set to 1 to check the matrix only |

`SUT_CPUSET` must not overlap `TOOLS_CPUSET`. To test more cores for app and db, first make `TOOLS_CPUSET` smaller in `loadtest/.env`, and run `scripts/loadtest/compose.sh up -d` so that the tools move.

## Find the slow queries

```bash
sh scripts/loadtest/compose.sh exec db psql -U postgres -d reddit_lite -c "SELECT calls, round(mean_exec_time::numeric, 1) AS mean_ms, round(total_exec_time::numeric) AS total_ms, left(query, 100) AS query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15"
```

Postgres also writes each query over 200 ms to the db container log:

```bash
sh scripts/loadtest/compose.sh logs db
```

## Reading the results

| What you see | What it means |
|---|---|
| App CPU plus db CPU flat at 2.0 (the size of `SUT_CPUSET`) and CPU pressure above 0 | The droplet is out of CPU. The service with the larger share is the one to optimize. |
| App CPU flat at 1.0 while the db CPU is low, and CPU pressure above 0 for the app | The Node event loop is the limit. It uses one core only. A second free core does not help it. |
| Db CPU high and CPU pressure above 0 for the db | Postgres needs more CPU than it gets. Find the query with `pg_stat_statements`. |
| Many connections in state `active` or `idle in transaction`, and the app CPU is low | The postgres.js pool (10 connections) is the limit. Requests wait for a connection. |
| The cache hit ratio falls below 99% | The data does not fit in the db memory. Reads go to disk. |
| Many `RowExclusiveLock` or `ExclusiveLock` locks during comment writes | Comments on a hot post wait for the `FOR UPDATE` lock on the post row. |
| `dropped iterations / s` above 0 | k6 has too few VUs for the rate. Increase `MAX_VUS` before you read the latency numbers. |
| Many 403 responses | A POST has no correct `Origin` header. This is a test error, not a load result. |

## Stop the stack

```bash
pnpm loadtest:down
```

The data stays in the `reddit-lite-loadtest_pgdata` volume. The development stack (`docker compose up`) uses a different volume, so its data does not change. The load test stack publishes the db on host port 5433 and the app on host port 3100. Because of this, both stacks can run at the same time.
