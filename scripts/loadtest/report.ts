// Builds one self-contained HTML report for one or more load test runs.
// The page has the charts library, the browser code, and the data inline, so it opens offline from disk.
//
// Usage:
//   node scripts/loadtest/report.ts <testid>                         one run, saved as results/<testid>/report.html
//   node scripts/loadtest/report.ts <id> <id> ... [--baseline <id>]  compare runs
//   node scripts/loadtest/report.ts --last 5                         the 5 newest runs
//   node scripts/loadtest/report.ts --all                            every run
//   node scripts/loadtest/report.ts --match stairs                   runs whose id contains "stairs"
//   node scripts/loadtest/report.ts --batch <batch>                  the runs of one matrix.sh batch
//   --out <file>                                                     write somewhere else
// Several runs are saved as loadtest/results/reports/compare-<time>.html, or batch-<batch>.html for --batch.

// File helpers.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
// join and resolve build paths from this file location.
import { join, relative, resolve } from 'node:path';
// Builds or reads the per-second data from k6.csv.gz.
import { buildTimeSeries } from './k6-timeseries.ts';

// The repository root is two folders above this file.
const ROOT = resolve(import.meta.dirname, '..', '..');
// All run folders are here.
const RESULTS = join(ROOT, 'loadtest/results');
// The browser code and the page template.
const REPORT_SRC = join(ROOT, 'loadtest/report');
// uPlot comes from the uplot devDependency, so nothing is copied into the repository by hand.
const UPLOT = join(ROOT, 'node_modules/uplot/dist');

// Reads a JSON file, or returns null when it is missing or broken. A missing file hides its part of the report.
function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Lists the run ids: folders in loadtest/results that have at least one of the run files.
function allRuns(): string[] {
  if (!existsSync(RESULTS)) return [];
  return readdirSync(RESULTS, { withFileTypes: true })
    // Skip files and the reports folder.
    .filter((d) => d.isDirectory() && d.name !== 'reports')
    // A folder without any run file is not a run.
    .filter((d) => ['meta.json', 'summary.json', 'prom.json'].some((f) => existsSync(join(RESULTS, d.name, f))))
    .map((d) => d.name)
    // Oldest first. The id ends with a sortable time stamp, for example stairs-20261118-205214.
    .sort((a, b) => stamp(a).localeCompare(stamp(b)) || a.localeCompare(b));
}

// The time stamp part of a run id, for sorting runs of different scripts by time.
function stamp(id: string): string {
  return /(\d{8}-\d{6})$/.exec(id)?.[1] ?? id;
}

// Parses the command line into run ids, the baseline, and the output file.
function parseArgs(argv: string[]) {
  const ids: string[] = [];
  let baseline: string | null = null;
  let out: string | null = null;
  let batch: string | null = null;
  const runs = allRuns();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') ids.push(...runs);
    else if (a === '--last') ids.push(...runs.slice(-Number(argv[++i] ?? 5)));
    else if (a === '--match') { const m = argv[++i] ?? ''; ids.push(...runs.filter((r) => r.includes(m))); }
    else if (a === '--batch') { batch = argv[++i] ?? ''; ids.push(...runs.filter((r) => readJson(join(RESULTS, r, 'meta.json'))?.batch === batch)); }
    else if (a === '--baseline') baseline = argv[++i] ?? null;
    else if (a === '--out') out = argv[++i] ?? null;
    else ids.push(a);
  }
  // Remove duplicates but keep the order.
  return { ids: [...new Set(ids)], baseline, out, batch };
}

// Loads everything the page needs for one run.
async function loadRun(id: string) {
  const dir = join(RESULTS, id);
  if (!existsSync(dir)) throw new Error(`No run folder ${relative(ROOT, dir)}`);
  const meta = readJson(join(dir, 'meta.json'));
  const prom = readJson(join(dir, 'prom.json'));
  // The 30 s timeline is a copy of data that prom-series.json has at 5 s. Drop it to keep the page small.
  if (prom) delete prom.timeline;
  return {
    id,
    // The variant name of a matrix line reads better in legends than the run id.
    label: (meta?.variant as string | undefined) || id,
    meta,
    summary: readJson(join(dir, 'summary.json')),
    prom,
    promSeries: readJson(join(dir, 'prom-series.json')),
    // Built from k6.csv.gz on first use and cached. null for runs without a CSV.
    ts: await buildTimeSeries(id),
  };
}

// Escapes "</script" inside inline JSON and code, so the text cannot close the script tag early.
function inline(text: string): string {
  return text.replaceAll('</script', '<\\/script');
}

async function main() {
  const { ids, baseline, out, batch } = parseArgs(process.argv.slice(2));
  if (!ids.length) {
    console.error('No runs selected. Usage: node scripts/loadtest/report.ts <testid>... | --all | --last N | --match TEXT | --batch ID [--baseline ID] [--out FILE]');
    process.exit(2);
  }
  const runs = await Promise.all(ids.map(loadRun));
  // Two runs with the same variant name (REPEAT > 1) get a number, so the legend stays clear.
  const seen = new Map<string, number>();
  for (const r of runs) {
    const n = (seen.get(r.label) ?? 0) + 1;
    seen.set(r.label, n);
    if (n > 1) r.label = `${r.label} #${n}`;
  }
  // The data for the page. The baseline defaults to the first run.
  const data = { generated_utc: new Date().toISOString(), batch, baseline: baseline && ids.includes(baseline) ? baseline : ids[0], runs };
  // Fill the template. Each placeholder is a comment, so the template is still valid HTML.
  const title = runs.length === 1 ? `Load test ${ids[0]}` : batch ? `Load test batch ${batch}` : `Load test compare (${runs.length} runs)`;
  const html = readFileSync(join(REPORT_SRC, 'template.html'), 'utf8')
    .replace('<!--TITLE-->', title)
    .replace('/*UPLOT_CSS*/', readFileSync(join(UPLOT, 'uPlot.min.css'), 'utf8'))
    .replace('/*REPORT_CSS*/', readFileSync(join(REPORT_SRC, 'report.css'), 'utf8'))
    .replace('/*DATA*/', () => inline(JSON.stringify(data)))
    .replace('/*UPLOT_JS*/', () => inline(readFileSync(join(UPLOT, 'uPlot.iife.min.js'), 'utf8')))
    .replace('/*REPORT_JS*/', () => inline(readFileSync(join(REPORT_SRC, 'report.js'), 'utf8')));
  // One run: save the report in its folder. Several: save it in the reports folder.
  // Local time, in the same form as the run ids that k6.sh makes with "date +%Y%m%d-%H%M%S".
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const time = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const file = out ? resolve(out) : runs.length === 1 ? join(RESULTS, ids[0], 'report.html') : join(RESULTS, 'reports', batch ? `batch-${batch}.html` : `compare-${time}.html`);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, html);
  console.log(`Saved ${relative(ROOT, file)} (${runs.length} run${runs.length > 1 ? 's' : ''})`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
