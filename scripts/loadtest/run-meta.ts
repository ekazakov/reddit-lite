// Writes loadtest/results/<testid>/meta.json: what was run, on which commit, and with which app and db configuration.
// k6.sh calls it twice:
//   node scripts/loadtest/run-meta.ts start <testid> <script> [k6 args...]   before k6 starts
//   node scripts/loadtest/run-meta.ts end <testid> <k6 exit code>            after k6 ends
// BATCH and VARIANT come from the environment. matrix.sh sets them, so the report can group the runs.

// execFileSync runs git.
import { execFileSync } from 'node:child_process';
// File helpers for the meta file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
// join and resolve build paths from this file location.
import { join, resolve } from 'node:path';
// The real container configuration.
import { sutConfig } from './sut-config.ts';

// The repository root is two folders above this file.
const ROOT = resolve(import.meta.dirname, '..', '..');
// The mode, the run id, and the rest of the arguments.
const [mode, testid, ...rest] = process.argv.slice(2);

// Stop with a usage message on wrong arguments.
if (!testid || (mode !== 'start' && mode !== 'end')) {
  console.error('Usage: run-meta.ts start <testid> <script> [k6 args...] | run-meta.ts end <testid> <exit code>');
  process.exit(2);
}

// The run folder and the meta file in it.
const dir = join(ROOT, 'loadtest/results', testid);
const file = join(dir, 'meta.json');

// Runs git and returns the output, or null outside a git checkout.
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

if (mode === 'start') {
  // The first extra argument is the k6 script name, the rest are the k6 flags (for example -e STEPS=10,20).
  const [script, ...args] = rest;
  // Pull the -e NAME=VALUE pairs out of the flags, so the report can show STEPS, HOLD, and MAX_VUS as a table.
  const env: Record<string, string> = {};
  // k6 accepts "-e A=1" and "--env A=1".
  for (let i = 0; i < args.length; i++) if ((args[i] === '-e' || args[i] === '--env') && args[i + 1]?.includes('=')) {
    const kv = args[i + 1];
    env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  }
  // The meta data before the run.
  const meta = {
    testid,
    script,
    k6_args: args,
    k6_env: env,
    // Empty strings become null, so a run outside a batch has no batch.
    batch: process.env.BATCH || null,
    variant: process.env.VARIANT || null,
    // The commit, and whether there were uncommitted changes. A dirty run is harder to repeat.
    git: { commit: git(['rev-parse', 'HEAD']), dirty: (git(['status', '--porcelain']) ?? '') !== '' },
    started_utc: new Date().toISOString(),
    // The configuration that Docker and Postgres applied.
    sut: sutConfig(),
  };
  // k6.sh makes the folder, but make it here too, so the script also works alone.
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(meta, null, 2) + '\n');
} else {
  // Read the start data. If it is missing, start from an empty object.
  const meta = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { testid };
  // The k6 exit code. 0 passed, 99 means that a threshold failed.
  meta.k6_exit_code = Number(rest[0] ?? NaN);
  meta.ended_utc = new Date().toISOString();
  // Read the containers again. An OOM kill or a restart during the run shows here.
  meta.sut_after = sutConfig();
  writeFileSync(file, JSON.stringify(meta, null, 2) + '\n');
}
