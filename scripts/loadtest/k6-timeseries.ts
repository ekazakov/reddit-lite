// Turns the raw k6 CSV of a run (loadtest/results/<testid>/k6.csv.gz) into 1 s and 10 s buckets in timeseries.json.
// Prometheus only has cumulative percentiles: k6 computes each pushed p95 over all requests since the run started.
// The CSV has every request, so the buckets here
// have exact per-second rates and exact p50/p95/p99, also per action.
// Usage: node scripts/loadtest/k6-timeseries.ts <testid> [--force]
// The result is cached. It is built again only when the CSV is newer than timeseries.json, or with --force.

// Streams read the gzip file line by line, so a large CSV never sits in memory at once.
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
// readline splits the stream into lines.
import { createInterface } from 'node:readline';
// The k6 CSV is gzipped.
import { createGunzip } from 'node:zlib';
// join and resolve build paths from this file location.
import { join, resolve } from 'node:path';

// The repository root is two folders above this file.
const ROOT = resolve(import.meta.dirname, '..', '..');

// The result shape for one bucket size. Arrays are columns: index i covers start + i * step seconds.
// Counts are per second (the bucket total divided by step), so 1 s and 10 s buckets use the same unit.
export type TimeSeries = {
  testid: string;
  // Bucket size in seconds.
  step: number;
  // Unix seconds of the first bucket.
  start: number;
  // Number of buckets.
  length: number;
  // Iterations that k6 tried to start: finished plus dropped.
  offered: number[];
  // Iterations that finished in this second.
  iterations: number[];
  // Iterations that k6 could not start because all VUs were busy.
  dropped: number[];
  // HTTP requests that finished in this second.
  http: number[];
  // Failed HTTP requests (timeouts and unexpected status codes).
  failed: number[];
  // Busy VUs. null when k6 did not report a value in this second.
  vus: (number | null)[];
  // Request duration percentiles in ms. null when the second has no requests.
  p50: (number | null)[];
  p95: (number | null)[];
  p99: (number | null)[];
  max: (number | null)[];
  // The same per action tag (feed, login, vote, ...): requests per second and percentiles.
  by_action: Record<string, { count: number[]; p50: (number | null)[]; p95: (number | null)[]; p99: (number | null)[] }>;
};

// The value at percentile p (0-100) of a sorted list, with the nearest-rank rule.
// k6 interpolates between ranks, so the numbers can differ a little from the k6 summary.
export function percentile(sorted: number[], p: number): number | null {
  // An empty list has no percentile.
  if (!sorted.length) return null;
  // The nearest rank: the smallest value with at least p% of the values at or below it.
  const rank = Math.ceil((p / 100) * sorted.length);
  // Clamp to the list, so p=0 gives the first value.
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

// Splits one CSV line into fields. k6 quotes a field only when it has a comma or a quote.
export function parseCsvLine(line: string): string[] {
  // The fields found so far.
  const out: string[] = [];
  // The field being read.
  let cur = '';
  // True inside a quoted field.
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      // Two quotes inside a quoted field are one literal quote.
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      // A single quote ends the quoted part.
      else if (ch === '"') quoted = false;
      // Any other character is part of the field.
      else cur += ch;
    } else if (ch === '"') quoted = true;
    // A comma outside quotes ends the field.
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  // The last field has no comma after it.
  out.push(cur);
  return out;
}

// Reads the "action" tag. k6 writes custom tags in extra_tags as "a=1&b=2".
function actionOf(extraTags: string): string | null {
  // URLSearchParams parses the "a=1&b=2" form.
  return extraTags ? new URLSearchParams(extraTags).get('action') : null;
}

// The metrics that Aggregator.add() reads. All other rows are skipped.
const USED = new Set(['iterations', 'dropped_iterations', 'http_reqs', 'http_req_failed', 'vus', 'http_req_duration']);

// Collects rows and builds the buckets. Exported for the test.
export class Aggregator {
  // The column index of each header name.
  private col: Record<string, number> = {};
  // Counters per second, keyed by Unix second.
  private counts = new Map<number, { iterations: number; dropped: number; http: number; failed: number; vus: number | null }>();
  // Request durations per second.
  private durations = new Map<number, number[]>();
  // Request durations per action, then per second.
  private actions = new Map<string, Map<number, number[]>>();

  // Reads the header line, so the columns are found by name, not by position.
  header(line: string) {
    parseCsvLine(line).forEach((name, i) => (this.col[name] = i));
  }

  // The counter row of a second. It is made on first use.
  private row(t: number) {
    let r = this.counts.get(t);
    if (!r) this.counts.set(t, (r = { iterations: 0, dropped: 0, http: 0, failed: 0, vus: null }));
    return r;
  }

  // Adds one data line.
  add(line: string) {
    // Most lines are metrics this script does not need. k6 writes the name first, and a name has no comma,
    // so the text before the first comma is enough to skip a line before the full parse.
    if (this.col.metric_name === 0 && !USED.has(line.slice(0, line.indexOf(',')))) return;
    const f = parseCsvLine(line);
    const name = f[this.col.metric_name];
    // k6 writes Unix seconds by default. Math.floor also handles a time format with fractions.
    const t = Math.floor(Number(f[this.col.timestamp]));
    const v = Number(f[this.col.metric_value]);
    // Skip broken lines, for example a line cut off when k6 was stopped.
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    switch (name) {
      case 'iterations':
        this.row(t).iterations += v;
        break;
      case 'dropped_iterations':
        this.row(t).dropped += v;
        break;
      case 'http_reqs':
        this.row(t).http += v;
        break;
      case 'http_req_failed':
        // The value is 1 for a failed request and 0 for a good one.
        this.row(t).failed += v;
        break;
      case 'vus':
        // A gauge: keep the highest value in the second.
        this.row(t).vus = Math.max(this.row(t).vus ?? 0, v);
        break;
      case 'http_req_duration': {
        // Make sure that the second exists in the counters, so it gets a bucket.
        this.row(t);
        // Keep the duration for the overall percentiles.
        let list = this.durations.get(t);
        if (!list) this.durations.set(t, (list = []));
        list.push(v);
        // Keep it again under its action, if the request has one.
        const action = this.col.extra_tags === undefined ? null : actionOf(f[this.col.extra_tags]);
        if (action) {
          let byT = this.actions.get(action);
          if (!byT) this.actions.set(action, (byT = new Map()));
          let al = byT.get(t);
          if (!al) byT.set(t, (al = []));
          al.push(v);
        }
        break;
      }
    }
  }

  // Builds the column arrays for buckets of `step` seconds, from the first to the last second that has data.
  // Percentiles are computed from all durations in the bucket, so 10 s buckets have exact 10 s percentiles.
  finish(testid: string, step = 1): TimeSeries {
    // The seconds that have data.
    const times = [...this.counts.keys()];
    // An empty CSV gives an empty result.
    const start = times.length ? Math.min(...times) : 0;
    const length = times.length ? Math.floor((Math.max(...times) - start) / step) + 1 : 0;
    // The bucket index of a second.
    const bucket = (t: number) => Math.floor((t - start) / step);
    // Round to 0.1, so the file stays small.
    const r = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
    // Merges per-second lists into per-bucket lists, sorted for the percentiles.
    const merge = (m: Map<number, number[]>) => {
      const out = Array.from({ length }, () => [] as number[]);
      for (const [t, l] of m) out[bucket(t)].push(...l);
      for (const l of out) l.sort((a, b) => a - b);
      return out;
    };
    // Sum the counters per bucket, and keep the highest VU value.
    const sums = Array.from({ length }, () => ({ iterations: 0, dropped: 0, http: 0, failed: 0, vus: null as number | null }));
    for (const [t, c] of this.counts) {
      const b = sums[bucket(t)];
      b.iterations += c.iterations; b.dropped += c.dropped; b.http += c.http; b.failed += c.failed;
      if (c.vus !== null) b.vus = Math.max(b.vus ?? 0, c.vus);
    }
    // The last bucket can be shorter than step. Divide by its real length, so its rate is not too low.
    const last = times.length ? Math.max(...times) : 0;
    const span = (i: number) => Math.min(step, last - (start + i * step) + 1);
    // A per-second rate of a bucket total.
    const rate = (key: 'iterations' | 'dropped' | 'http' | 'failed') => sums.map((b, i) => r(b[key] / span(i)) ?? 0);
    const all = merge(this.durations);
    const by_action: TimeSeries['by_action'] = {};
    // One count and p95 column per action, in name order so the legend is stable.
    for (const [action, byT] of [...this.actions].sort(([a], [b]) => a.localeCompare(b))) {
      const lists = merge(byT);
      by_action[action] = {
        count: lists.map((l, i) => r(l.length / span(i)) ?? 0),
        p50: lists.map((l) => r(percentile(l, 50))),
        p95: lists.map((l) => r(percentile(l, 95))),
        p99: lists.map((l) => r(percentile(l, 99))),
      };
    }
    return {
      testid,
      step,
      start,
      length,
      offered: sums.map((b, i) => r((b.iterations + b.dropped) / span(i)) ?? 0),
      iterations: rate('iterations'),
      dropped: rate('dropped'),
      http: rate('http'),
      failed: rate('failed'),
      vus: sums.map((b) => b.vus),
      p50: all.map((l) => r(percentile(l, 50))),
      p95: all.map((l) => r(percentile(l, 95))),
      p99: all.map((l) => r(percentile(l, 99))),
      max: all.map((l) => r(l.at(-1) ?? null)),
      by_action,
    };
  }
}

// The cached file: the same data in 1 s and 10 s buckets.
// total is one bucket over the whole run: exact whole-run percentiles per action, which the k6 summary does not have.
export type TimeSeriesFile = { testid: string; s1: TimeSeries; s10: TimeSeries; total: TimeSeries };

// Builds timeseries.json for a run, or reads the cached file. Returns null when the run has no CSV.
export async function buildTimeSeries(testid: string, force = false): Promise<TimeSeriesFile | null> {
  // The run folder and its files.
  const dir = join(ROOT, 'loadtest/results', testid);
  const csv = join(dir, 'k6.csv.gz');
  const out = join(dir, 'timeseries.json');
  // Old runs and migrated runs have no CSV. The report then uses Prometheus only.
  if (!existsSync(csv)) return null;
  // Use the cache when it is newer than the CSV.
  if (!force && existsSync(out) && statSync(out).mtimeMs >= statSync(csv).mtimeMs) {
    const cached = JSON.parse(readFileSync(out, 'utf8')) as TimeSeriesFile;
    // A file from an older version of this script has no s1 key. Build it again.
    if (cached.s1 && cached.total) return cached;
  }
  // Read the gzip file line by line.
  const lines = createInterface({ input: createReadStream(csv).pipe(createGunzip()), crlfDelay: Infinity });
  const agg = new Aggregator();
  // The first line is the header.
  let first = true;
  for await (const line of lines) {
    // Skip empty lines, for example at the end of the file.
    if (!line) continue;
    if (first) { agg.header(line); first = false; } else agg.add(line);
  }
  // A step longer than any run puts every second into one bucket.
  const ts: TimeSeriesFile = { testid, s1: agg.finish(testid, 1), s10: agg.finish(testid, 10), total: agg.finish(testid, 1e9) };
  // Save without indentation: the file is for the report, and the columns are long.
  writeFileSync(out, JSON.stringify(ts) + '\n');
  return ts;
}

// Run as a script: build the file for one run and print a short line.
// import.meta.main needs Node 24.2, so compare the started script with this file. That works on every Node 24.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const testid = process.argv[2];
  if (!testid) {
    console.error('Usage: node scripts/loadtest/k6-timeseries.ts <testid> [--force]');
    process.exit(2);
  }
  buildTimeSeries(testid, process.argv.includes('--force')).then((ts) => {
    // A run without a CSV is not an error, but say so.
    console.log(ts ? `Saved loadtest/results/${testid}/timeseries.json (${ts.s1.length} s)` : `No k6.csv.gz for ${testid}`);
  }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
