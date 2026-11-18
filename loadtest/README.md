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

   Warning: this command deletes all rows in the local Docker database.

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

Each run saves its summary to `loadtest/results/<script>-<time>.json`. Restore the snapshot before each run, because the write actions change the data.

After k6 ends, `k6.sh` also saves the Prometheus metrics of the run to `loadtest/results/<script>-<time>-prom.json`. The file has app and db CPU, memory, connections, locks, and the slowest queries. It also has a timeline in 30 s buckets and the knee (the first time p95 stays over 500 ms). Prometheus keeps 7 days of data, so you can also export an older run:

```bash
pnpm loadtest:prom stairs-20261118-205214
```

The restore resets `pg_stat_statements`. If you want query text in the file, export before the next `restore.sh`.

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

The data stays in the `pgdata` volume. The development stack (`docker compose up`) uses the same volume. If you want the small development data after a load test, run `pnpm seed` again.
