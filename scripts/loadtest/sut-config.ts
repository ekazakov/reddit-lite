// Prints the real configuration of the system under test (the app and db containers) as JSON.
// It reads what Docker and Postgres applied, not what loadtest/.env asked for, so a setting that
// did not take effect (for example after a restart instead of a recreate) shows up in the report.
// Usage: node scripts/loadtest/sut-config.ts
// k6.sh runs it before and after each run and stores both results in meta.json.

// execFileSync runs docker and psql through compose.sh.
import { execFileSync } from 'node:child_process';
// join and resolve build paths from this file location, so the script works from any folder.
import { join, resolve } from 'node:path';

// The repository root is two folders above this file.
const ROOT = resolve(import.meta.dirname, '..', '..');
// compose.sh runs docker compose with the load test overlay and loadtest/.env.
const COMPOSE = join(ROOT, 'scripts/loadtest/compose.sh');

// Runs compose.sh with the given arguments and returns the trimmed output.
function compose(args: string[]): string {
  // stderr is dropped, so compose warnings do not mix with the JSON on stdout.
  return execFileSync('sh', [COMPOSE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// Counts the CPUs in a cpuset list such as "0-1" or "0,2-3". The same rule as in prom-summary.ts.
export function countCpus(list: string): number {
  // Add 1 for a single CPU, or the range length for "a-b".
  return list.split(',').filter(Boolean).reduce((n, part) => {
    const [a, b = a] = part.split('-').map(Number);
    return n + (b - a + 1);
  }, 0);
}

// The fields of `docker inspect` output that this script reads.
type Inspect = {
  Config: { Env: string[] };
  State: { OOMKilled: boolean; StartedAt: string; Status: string };
  RestartCount: number;
  HostConfig: { CpusetCpus: string; Memory: number };
};

// Reads the docker inspect data of one compose service, or null when it does not run.
function inspect(service: string): Inspect | null {
  try {
    // "ps -q" gives the container id of the service.
    const id = compose(['ps', '-q', service]);
    // No id means that the service is not running.
    if (!id) return null;
    // docker inspect prints a JSON array with one entry per id.
    const out = execFileSync('docker', ['inspect', id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // Return the single entry.
    return (JSON.parse(out) as Inspect[])[0];
  } catch {
    // Docker can be down. The caller then records null.
    return null;
  }
}

// Reads one Postgres setting with SHOW, or null when the db does not answer.
function pgSetting(name: string): string | null {
  try {
    // -A turns off alignment and -t drops headers, so the output is the bare value.
    return compose(['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'reddit_lite', '-At', '-c', `SHOW ${name}`]) || null;
  } catch {
    // The db can be down or still starting.
    return null;
  }
}

// Turns an env list like ["A=1", "B=2"] into a map.
function envMap(env: string[]): Record<string, string> {
  // Split on the first "=" only, because values can contain "=".
  return Object.fromEntries(env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
}

// The fields that both containers share.
function common(c: Inspect) {
  return {
    // The CPUs the container can run on. Docker leaves it empty when there is no cpuset.
    cpuset: c.HostConfig.CpusetCpus || null,
    // The number of CPUs in the cpuset.
    cores: c.HostConfig.CpusetCpus ? countCpus(c.HostConfig.CpusetCpus) : null,
    // The memory limit in MiB. Docker uses 0 for no limit.
    memory_mib: c.HostConfig.Memory ? Math.round(c.HostConfig.Memory / 1048576) : null,
    // True if the kernel killed the container for using too much memory.
    oom_killed: c.State.OOMKilled,
    // Restarts after a crash. A rise during a run means that the container died.
    restart_count: c.RestartCount,
    // The container start time, to show if it was recreated for this run.
    started_utc: c.State.StartedAt,
    // running, exited, and so on.
    status: c.State.Status,
  };
}

// Builds the configuration object.
export function sutConfig() {
  // Read both containers.
  const app = inspect('app');
  const db = inspect('db');
  // The app reads the pool size and the heap limit from its environment.
  const appEnv = app ? envMap(app.Config.Env) : {};
  // NODE_OPTIONS has the heap limit as --max-old-space-size=<MB>.
  const heap = /--max-old-space-size=(\d+)/.exec(appEnv.NODE_OPTIONS ?? '');
  return {
    // When the values were read.
    captured_utc: new Date().toISOString(),
    // App container values, or null when it is not running.
    app: app ? { ...common(app), heap_mb: heap ? Number(heap[1]) : null, db_pool_max: appEnv.DB_POOL_MAX ? Number(appEnv.DB_POOL_MAX) : null } : null,
    // Db container values, plus the Postgres settings that depend on DB_MEM.
    db: db ? { ...common(db), shared_buffers: pgSetting('shared_buffers'), effective_cache_size: pgSetting('effective_cache_size'), max_connections: Number(pgSetting('max_connections')) || null } : null,
  };
}

// Print the JSON when the file runs as a script, not when a test imports it.
if (import.meta.main) console.log(JSON.stringify(sutConfig(), null, 2));
