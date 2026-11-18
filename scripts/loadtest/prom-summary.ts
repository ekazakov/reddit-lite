// Saves a summary of the Prometheus metrics for one load test run to loadtest/results/<testid>-prom.json.
// The k6 summary JSON has only k6 numbers. This file adds app and db CPU, memory, Postgres activity,
// locks, and the slowest queries, and splits the run into time buckets so you can find the knee.
// Usage: node scripts/loadtest/prom-summary.ts <testid> [bucket-seconds]
// Example: node scripts/loadtest/prom-summary.ts stairs-20261118-205214 30
// PROM_URL changes the Prometheus address. The file records the app and db cpuset, read from the db container.

// execFileSync runs psql in the db container, to look up the query text for each query id.
import { execFileSync } from 'node:child_process';
// writeFileSync and mkdirSync save the result file.
import { mkdirSync, writeFileSync } from 'node:fs';
// join and resolve build paths from this file location, so the script works from any folder.
import { join, resolve } from 'node:path';

// The repository root is two folders above this file.
const ROOT = resolve(import.meta.dirname, '..', '..');
// Prometheus is published on host port 9090 by docker-compose.loadtest.yml.
const PROM = process.env.PROM_URL ?? 'http://localhost:9090';
// The run id that k6.sh puts on every k6 metric, for example stairs-20261118-205214.
const testid = process.argv[2];
// Bucket size for the timeline. 30 s gives about two buckets per stair step with the default 1m hold.
const bucketSeconds = Number(process.argv[3] ?? 30);
// Prometheus scrapes and k6 pushes every 5 s, so a finer step adds no information.
const STEP = 5;
// Extra time on each side of the run, so the first and last pushes and scrapes are inside the window.
const PAD = 10;
// The p95 limit from the thresholds in loadtest/k6/lib.js. The first bucket above it is the knee.
const P95_LIMIT_MS = 500;

// Stop with a usage message if the run id is missing.
if (!testid) {
  // Print the usage to stderr, so it does not mix with normal output.
  console.error('Usage: node scripts/loadtest/prom-summary.ts <testid> [bucket-seconds]');
  // Exit code 2 means a usage error.
  process.exit(2);
}

// One Prometheus sample series: its labels and its [time, value] points.
type Series = { metric: Record<string, string>; values?: [number, string][]; value?: [number, string] };

// Runs a Prometheus HTTP API call and returns the result list. It fails loudly on an API error.
async function prom(path: string, params: Record<string, string>): Promise<Series[]> {
  // URLSearchParams encodes the PromQL text, which has braces, quotes, and spaces.
  const url = `${PROM}/api/v1/${path}?${new URLSearchParams(params)}`;
  // Node has fetch built in, so the script needs no packages.
  const res = await fetch(url);
  // Prometheus returns JSON with a status field for both success and error.
  const body = (await res.json()) as { status: string; error?: string; data: { result: Series[] } };
  // Show the query with the error, so a bad PromQL line is easy to find.
  if (body.status !== 'success') throw new Error(`Prometheus: ${body.error} in ${params.query}`);
  // The caller only needs the series list.
  return body.data.result;
}

// Runs an instant query at time t and returns a map from label text to number.
async function instant(query: string, t: number): Promise<Record<string, number>> {
  // An instant query evaluates the expression at one time.
  const result = await prom('query', { query, time: String(t) });
  // Collect one number per series, keyed by its labels.
  const out: Record<string, number> = {};
  // Each series has a single [time, value] pair in "value".
  for (const s of result) out[labelKey(s.metric)] = Number(s.value![1]);
  // Return the map, which is empty when the metric has no data.
  return out;
}

// Turns a label set into a short key. A series without labels gets the key "all".
function labelKey(metric: Record<string, string>): string {
  // Leave out the metric name, because the caller already knows it.
  const parts = Object.entries(metric).filter(([k]) => k !== '__name__').map(([, v]) => v);
  // Join the values, for example "active" or "app".
  return parts.length ? parts.join(',') : 'all';
}

// Average and maximum of a list of numbers. NaN values (for example 0/0) are skipped.
function stats(xs: number[]): { avg: number; max: number } | null {
  // Keep only real numbers.
  const ok = xs.filter((x) => Number.isFinite(x));
  // No data in this range: return null, so the JSON shows that the value is missing.
  if (!ok.length) return null;
  // Round to 4 significant digits, so the file stays readable.
  const r = (x: number) => Number(x.toPrecision(4));
  // Return both numbers. The max shows short spikes that the average hides.
  return { avg: r(ok.reduce((a, b) => a + b, 0) / ok.length), max: r(Math.max(...ok)) };
}

// The k6 label filter for this run.
const T = `testid="${testid}"`;
// The Postgres label filter. The exporter also reports the "postgres" maintenance database.
const DB = 'datname="reddit_lite"';
// The cAdvisor filter for the two cgroups that the overlay creates.
const C = 'id=~"/loadtest-(app|db)"';
// Renames the cgroup id label to a short "service" label (app or db), as the Grafana dashboard does.
const svc = (e: string) => `label_replace(${e}, "service", "$1", "id", "/loadtest-(app|db)")`;
// Keeps only the "service" label, so the keys in the file are "app" and "db".
const bySvc = (e: string) => `sum by (service) (${svc(e)})`;

// The time series to sample. Each entry has a name, a unit, and a PromQL expression.
// Rates use a 30 s window, the same as the Grafana dashboards, so the numbers match the panels.
const SERIES: { name: string; unit: string; expr: string }[] = [
  // Iterations that k6 tried to start per second. Done plus dropped equals the target rate of the step.
  { name: 'k6_offered_rps', unit: 'iterations/s', expr: `sum(rate(k6_iterations_total{${T}}[30s])) + (sum(rate(k6_dropped_iterations_total{${T}}[30s])) or vector(0))` },
  // Iterations that k6 started and finished per second.
  { name: 'k6_iterations_rps', unit: 'iterations/s', expr: `sum(rate(k6_iterations_total{${T}}[30s]))` },
  // Iterations that k6 could not start because all VUs were busy.
  { name: 'k6_dropped_rps', unit: 'iterations/s', expr: `sum(rate(k6_dropped_iterations_total{${T}}[30s])) or vector(0)` },
  // HTTP requests per second that the app answered.
  { name: 'k6_http_rps', unit: 'requests/s', expr: `sum(rate(k6_http_reqs_total{${T}}[30s]))` },
  // Busy VUs. A value at MAX_VUS means k6 is out of VUs and drops iterations.
  { name: 'k6_vus', unit: 'VUs', expr: `sum(k6_vus{${T}})` },
  // The worst p95 over all actions in each 5 s push window, in ms (k6 sends seconds).
  { name: 'k6_p95_ms_worst', unit: 'ms', expr: `max(k6_http_req_duration_p95{${T}}) * 1000` },
  // The p95 for each action, in ms. It shows which page gets slow first.
  { name: 'k6_p95_ms_by_action', unit: 'ms', expr: `max by (action) (k6_http_req_duration_p95{${T}}) * 1000` },
  // Share of failed requests. k6 counts timeouts and unexpected status codes as failed.
  { name: 'k6_failed_rate', unit: 'ratio', expr: `avg(k6_http_req_failed_rate{${T}})` },
  // CPU use in cores. 1.0 is one full CPU. Compare app + db with cpu_limit.cores.
  { name: 'cpu_cores', unit: 'cores', expr: bySvc(`rate(container_cpu_usage_seconds_total{${C}}[30s])`) },
  // Share of time that tasks wait for CPU. Above 0 with CPU at the limit means CPU starvation.
  { name: 'cpu_pressure', unit: 'ratio', expr: bySvc(`rate(container_pressure_cpu_waiting_seconds_total{${C}}[30s])`) },
  // Share of time that tasks wait for disk.
  { name: 'io_pressure', unit: 'ratio', expr: bySvc(`rate(container_pressure_io_waiting_seconds_total{${C}}[30s])`) },
  // Memory that the kernel counts against the container limit, in MiB.
  { name: 'memory_working_set_mib', unit: 'MiB', expr: bySvc(`container_memory_working_set_bytes{${C}}`) + ' / 1048576' },
  // Database connections by state. Many "active" connections at the pool size means requests wait for the pool.
  { name: 'pg_connections', unit: 'connections', expr: `sum by (state) (pg_stat_activity_count{${DB}})` },
  // Average number of busy backends: active time in seconds per second.
  { name: 'pg_busy_backends', unit: 'backends', expr: `sum(rate(pg_stat_database_active_time_seconds_total{${DB}}[30s])) / 1000` },
  // Held and waiting locks by mode.
  { name: 'pg_locks', unit: 'locks', expr: `sum by (mode) (pg_locks_count{${DB}})` },
  // The longest open transaction of a client that is not idle, in seconds. It catches stuck transactions.
  { name: 'pg_max_tx_seconds', unit: 's', expr: `max(pg_stat_activity_max_tx_duration{${DB},backend_type="client backend",state!="idle"})` },
  // Committed transactions per second.
  { name: 'pg_commits_per_s', unit: 'tx/s', expr: `sum(rate(pg_stat_database_xact_commit{${DB}}[30s]))` },
  // Rolled back transactions per second. A rise often means lock timeouts or errors.
  { name: 'pg_rollbacks_per_s', unit: 'tx/s', expr: `sum(rate(pg_stat_database_xact_rollback{${DB}}[30s]))` },
  // Rows that queries returned per second. A high value per request points to scans.
  { name: 'pg_rows_fetched_per_s', unit: 'rows/s', expr: `sum(rate(pg_stat_database_tup_fetched{${DB}}[30s]))` },
  // Rows that queries read per second, including rows that filters threw away.
  { name: 'pg_rows_returned_per_s', unit: 'rows/s', expr: `sum(rate(pg_stat_database_tup_returned{${DB}}[30s]))` },
  // Share of page reads served from shared_buffers. Below 0.99 means reads go to disk.
  { name: 'pg_cache_hit_ratio', unit: 'ratio', expr: `sum(rate(pg_stat_database_blks_hit{${DB}}[1m])) / (sum(rate(pg_stat_database_blks_hit{${DB}}[1m])) + sum(rate(pg_stat_database_blks_read{${DB}}[1m])))` },
  // Bytes per second that sorts and hashes spilled to temp files, because work_mem was too small.
  { name: 'pg_temp_bytes_per_s', unit: 'bytes/s', expr: `sum(rate(pg_stat_database_temp_bytes{${DB}}[1m]))` },
];

// Counters to total over the whole run. increase() handles counter resets, unlike end minus start.
const TOTALS: Record<string, string> = {
  // Requests and iterations, to compare with the k6 summary.
  k6_http_reqs: `sum(increase(k6_http_reqs_total{${T}}[$R]))`,
  // Finished iterations.
  k6_iterations: `sum(increase(k6_iterations_total{${T}}[$R]))`,
  // Dropped iterations.
  k6_dropped_iterations: `sum(increase(k6_dropped_iterations_total{${T}}[$R]))`,
  // CPU seconds that the app used in the run.
  app_cpu_seconds: `sum(increase(container_cpu_usage_seconds_total{id="/loadtest-app"}[$R]))`,
  // CPU seconds that the database used in the run.
  db_cpu_seconds: `sum(increase(container_cpu_usage_seconds_total{id="/loadtest-db"}[$R]))`,
  // Committed transactions.
  pg_commits: `sum(increase(pg_stat_database_xact_commit{${DB}}[$R]))`,
  // Rolled back transactions.
  pg_rollbacks: `sum(increase(pg_stat_database_xact_rollback{${DB}}[$R]))`,
  // Deadlocks. Any value above 0 is a bug in the write paths.
  pg_deadlocks: `sum(increase(pg_stat_database_deadlocks{${DB}}[$R]))`,
  // Temp files that queries created.
  pg_temp_files: `sum(increase(pg_stat_database_temp_files{${DB}}[$R]))`,
  // Pages read from disk instead of the cache.
  pg_blocks_read: `sum(increase(pg_stat_database_blks_read{${DB}}[$R]))`,
  // Pages found in the cache.
  pg_blocks_hit: `sum(increase(pg_stat_database_blks_hit{${DB}}[$R]))`,
  // Inserted rows: posts, comments, votes, likes, users.
  pg_rows_inserted: `sum(increase(pg_stat_database_tup_inserted{${DB}}[$R]))`,
  // Updated rows: score and count columns.
  pg_rows_updated: `sum(increase(pg_stat_database_tup_updated{${DB}}[$R]))`,
};

// Finds the first and last time that k6 pushed a metric for this run.
async function runWindow(): Promise<{ start: number; end: number }> {
  // Prometheus keeps 7 days, so a 7 day subquery always covers the run. min() drops the labels.
  const first = await instant(`min(min_over_time(timestamp(k6_vus{${T}})[7d:${STEP}s]))`, Date.now() / 1000);
  // The same subquery with max gives the last push.
  const last = await instant(`max(max_over_time(timestamp(k6_vus{${T}})[7d:${STEP}s]))`, Date.now() / 1000);
  // Without k6 data, the run id is wrong or older than the retention time.
  if (first.all === undefined) throw new Error(`No k6 metrics for ${testid} in ${PROM}. Check the testid label.`);
  // Pad both sides, so the scrapes around the start and the end are inside the window.
  return { start: Math.floor(first.all) - PAD, end: Math.ceil(last.all!) + PAD };
}

// Reads the query text for each query id from pg_stat_statements in the db container.
function queryTexts(): Record<string, string> {
  // Collapse white space and cut the text, so each query fits on one line in the JSON.
  const sql = "SELECT DISTINCT ON (queryid) queryid, left(regexp_replace(query, '\\s+', ' ', 'g'), 300) FROM pg_stat_statements";
  // compose.sh moves to the repository root and runs docker compose with the overlay.
  try {
    // -A turns off alignment, -t drops headers, and -F sets a tab between columns.
    const out = execFileSync('sh', [join(ROOT, 'scripts/loadtest/compose.sh'), 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'reddit_lite', '-AtF', '\t', '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // Build a map from query id to text. The first tab separates the id from the text.
    return Object.fromEntries(out.trim().split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('\t')), l.slice(l.indexOf('\t') + 1)]));
  } catch {
    // The db container can be down or the stats can be reset. The file then has ids without text.
    return {};
  }
}

// Counts the CPUs in a cpuset list such as "0-1" or "0,2-3". Each item is one CPU or a range.
function countCpus(list: string): number {
  // Add 1 for a single CPU, or the range length for "a-b".
  return list.split(',').filter(Boolean).reduce((n, part) => {
    const [a, b = a] = part.split('-').map(Number);
    return n + (b - a + 1);
  }, 0);
}

// Reads the CPUs that the app and db may use. cAdvisor does not export the cpuset, so the script asks the db container.
function cpuLimit() {
  try {
    // The kernel file lists the CPUs that the cgroup of the container can run on.
    const cpuset = execFileSync('sh', [join(ROOT, 'scripts/loadtest/compose.sh'), 'exec', '-T', 'db', 'cat', '/sys/fs/cgroup/cpuset.cpus.effective'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { cpuset, cores: countCpus(cpuset), shared_by: ['app', 'db'], source: 'db container cgroup' };
  } catch {
    // The db container can be down. Then record the configured value, or the compose default.
    const cpuset = process.env.SUT_CPUSET ?? '0-1';
    return { cpuset, cores: countCpus(cpuset), shared_by: ['app', 'db'], source: process.env.SUT_CPUSET ? 'env' : 'default in docker-compose.loadtest.yml' };
  }
}

// Collects all numbers and writes the result file.
async function main() {
  // Find the run window from the k6 metrics.
  const { start, end } = await runWindow();
  // The window length in seconds, for the increase() range.
  const range = `${end - start}s`;
  // Fetch every series at a 5 s step over the run window, in parallel.
  const sampled = await Promise.all(SERIES.map((s) => prom('query_range', { query: s.expr, start: String(start), end: String(end), step: String(STEP) })));

  // Whole-run average and max for each series and label.
  const overall: Record<string, { unit: string; values: Record<string, unknown> }> = {};
  // The timeline: one row per bucket with the average and max of each series.
  const timeline: { from_s: number; to_s: number; values: Record<string, Record<string, unknown>> }[] = [];
  // Make the empty bucket rows first. Offsets are seconds from the start of the run.
  for (let t = start; t < end; t += bucketSeconds) timeline.push({ from_s: t - start, to_s: Math.min(t + bucketSeconds, end) - start, values: {} });

  // Fill both tables, one series at a time.
  SERIES.forEach((s, i) => {
    // Make the overall entry with the unit, so the reader knows how to read the numbers.
    overall[s.name] = { unit: s.unit, values: {} };
    // A series with labels (for example by state) has one result per label value.
    for (const r of sampled[i]) {
      // The label value, or "all" for a single total.
      const key = labelKey(r.metric);
      // The sample values as numbers.
      const pts = (r.values ?? []).map(([t, v]) => [t, Number(v)] as const);
      // The whole-run stats.
      overall[s.name].values[key] = stats(pts.map(([, v]) => v));
      // The stats per bucket.
      for (const row of timeline) {
        // Pick the samples that fall in this bucket.
        const inBucket = pts.filter(([t]) => t - start >= row.from_s && t - start < row.to_s).map(([, v]) => v);
        // Skip empty buckets, so the file does not fill with nulls.
        const st = stats(inBucket);
        // Store the bucket stats under the series name and label.
        if (st) (row.values[s.name] ??= {})[key] = st;
      }
    }
  });

  // Total each counter over the window, evaluated at the end of the run.
  const totals: Record<string, number | null> = {};
  // Run the queries in parallel.
  await Promise.all(Object.entries(TOTALS).map(async ([name, expr]) => {
    // Put the window length in the range placeholder.
    const v = await instant(expr.replaceAll('$R', range), end);
    // Round to whole numbers, because these are counts.
    totals[name] = v.all === undefined ? null : Math.round(v.all);
  }));

  // The queries with the most total execution time in the run. Top 15, the same as the README query.
  const top = await instant(`topk(15, sum by (queryid) (increase(pg_stat_statements_seconds_total{${DB}}[${range}])))`, end);
  // Calls of the same queries in the run.
  const calls = await instant(`sum by (queryid) (increase(pg_stat_statements_calls_total{${DB}}[${range}]))`, end);
  // Rows of the same queries in the run.
  const rows = await instant(`sum by (queryid) (increase(pg_stat_statements_rows_total{${DB}}[${range}]))`, end);
  // The query text, if the db container is up.
  const texts = queryTexts();
  // The total db execution time of all queries, to show the share of each query.
  const allSeconds = Object.values(await instant(`sum(increase(pg_stat_statements_seconds_total{${DB}}[${range}]))`, end))[0] ?? 0;
  // Build the list. The queries above group by queryid, so each key is a query id.
  const topQueries = Object.entries(top)
    // Largest time first. topk does not sort the result.
    .sort((a, b) => b[1] - a[1])
    // Turn each entry into a readable record.
    .map(([queryid, seconds]) => {
      // Calls for this query in the run.
      const c = calls[queryid] ?? 0;
      // Return the numbers that the README slow query table also shows.
      return {
        // The id from pg_stat_statements.
        queryid,
        // Total seconds that the database spent in this query during the run.
        total_seconds: Number(seconds.toFixed(1)),
        // Share of all query time in the run.
        share: Number((seconds / allSeconds).toFixed(3)),
        // Number of calls.
        calls: Math.round(c),
        // Average time per call in ms.
        mean_ms: c ? Number(((seconds / c) * 1000).toFixed(2)) : null,
        // Average rows per call.
        rows_per_call: c ? Number(((rows[queryid] ?? 0) / c).toFixed(1)) : null,
        // The query text, or null when it is not available.
        query: texts[queryid] ?? null,
      };
    });

  // The worst p95 average of a bucket, or undefined when the bucket has no k6 data.
  const p95 = (r: (typeof timeline)[number] | undefined) => (r?.values.k6_p95_ms_worst?.all as { avg: number } | undefined)?.avg;
  // The knee is the first bucket where p95 is over the limit in it and in the next bucket.
  // One slow bucket alone is often the warm-up at the start (logins, cold caches), not overload.
  const kneeRow = timeline.find((r, i) => (p95(r) ?? 0) > P95_LIMIT_MS && (p95(timeline[i + 1]) ?? 0) > P95_LIMIT_MS);

  // The full result.
  const result = {
    // Which run this file describes.
    testid,
    // Where the numbers came from.
    prometheus: PROM,
    // The run window, in Unix seconds and as readable UTC times.
    window: { start, end, seconds: end - start, start_utc: new Date(start * 1000).toISOString(), end_utc: new Date(end * 1000).toISOString(), padding_seconds: PAD },
    // The CPUs that the app and db shared during the run. Their cpu_cores values together cannot go above cores.
    cpu_limit: cpuLimit(),
    // Notes that explain how to read the file.
    notes: [
      // Explain why the p95 numbers here differ from the k6 summary.
      'k6 p95 values here are per 5 s push window. Use the k6 summary JSON for the true whole-run percentiles.',
      // Explain the connection counts.
      'pg_connections counts every client of reddit_lite, including the exporter and any IDE connection.',
      // Explain the timeline offsets.
      `timeline rows are ${bucketSeconds} s buckets. from_s and to_s are seconds from window.start.`,
    ],
    // The knee: the first bucket over the p95 limit, with the load at that time.
    knee: kneeRow ? { p95_limit_ms: P95_LIMIT_MS, from_s: kneeRow.from_s, offered_rps: kneeRow.values.k6_offered_rps?.all, http_rps: kneeRow.values.k6_http_rps?.all, cpu_cores: kneeRow.values.cpu_cores } : null,
    // Counter totals over the run.
    totals,
    // Whole-run average and max of each series.
    overall,
    // The slowest queries by total time.
    top_queries: topQueries,
    // The per-bucket table.
    timeline,
  };

  // Make sure that the results folder exists, because it is not in git.
  mkdirSync(join(ROOT, 'loadtest/results'), { recursive: true });
  // Save next to the k6 summary, with the same run id in the name.
  const file = join(ROOT, 'loadtest/results', `${testid}-prom.json`);
  // Indent the JSON, so it is easy to read and to diff between runs.
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');

  // Print a short table, so the main numbers show in the terminal after a run.
  const n = (x: unknown, d = 0) => (x === undefined ? '-' : (x as { avg: number }).avg.toFixed(d));
  // The table header. Each row is one bucket.
  console.log('from_s  offered  http_rps  p95_ms  vus   app_cpu  db_cpu  pg_active');
  // One line per bucket with the average values.
  for (const r of timeline) {
    // Shorter names for the row values.
    const v = r.values;
    // Fixed-width columns, so the numbers line up.
    console.log([String(r.from_s).padStart(6), n(v.k6_offered_rps?.all, 1).padStart(8), n(v.k6_http_rps?.all, 1).padStart(9), n(v.k6_p95_ms_worst?.all).padStart(7), n(v.k6_vus?.all).padStart(5), n(v.cpu_cores?.app, 2).padStart(8), n(v.cpu_cores?.db, 2).padStart(7), n(v.pg_connections?.active).padStart(10)].join(' '));
  }
  // Show where the knee is, or that there was none.
  console.log(kneeRow ? `Knee: p95 over ${P95_LIMIT_MS} ms from ${kneeRow.from_s} s` : `No bucket with p95 over ${P95_LIMIT_MS} ms`);
  // Show where the file is.
  console.log(`Saved ${file}`);
}

// Run, and exit with code 1 on any error, so k6.sh can report it.
main().catch((err: unknown) => {
  // Print the message only. A stack trace adds nothing for a user of the script.
  console.error(err instanceof Error ? err.message : err);
  // A non-zero code tells the caller that the export failed.
  process.exit(1);
});
