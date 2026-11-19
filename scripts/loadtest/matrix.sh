#!/usr/bin/env sh
# Runs one k6 test several times in a row, each time with a different app and db configuration.
# Each line of the matrix file is one variant. The script recreates the app and db containers with
# the variant settings, restores the data, runs k6.sh, and at the end builds one compare report.
#
# Usage: scripts/loadtest/matrix.sh <matrix-file> [script] [-e NAME=VALUE ...]
# Example: scripts/loadtest/matrix.sh loadtest/matrix/example.txt stairs -e STEPS=25,50,75,100 -e HOLD=1m
# Optional environment:
#   REPEAT=2       run each variant 2 times, to see the run-to-run noise (default 1)
#   COOLDOWN=60    seconds to wait between runs, so the host cools down (default 30)
#   DRY_RUN=1      check the matrix file and print the plan without running anything
#
# Matrix file format: one variant per line, "#" starts a comment.
#   <name> KEY=VALUE KEY=VALUE ...
# Allowed keys: DB_POOL_MAX SUT_CPUSET APP_MEM APP_HEAP_MB DB_MEM DB_SHARED_BUFFERS DB_EFFECTIVE_CACHE_SIZE.
# Keys that a line leaves out come from loadtest/.env, or from the compose defaults.

# Stop on any error or unset variable.
set -eu
# Load the compose helper. It moves to the repository root and defines compose() and psql_db().
. "$(dirname "$0")/compose.sh"

# The matrix file is required. The ":?" form stops with a message if it is missing.
MATRIX="${1:?Give a matrix file, for example loadtest/matrix/example.txt}"
# Stop early if the file does not exist.
[ -f "$MATRIX" ] || { echo "No matrix file $MATRIX" >&2; exit 1; }
# Remove the file name from the arguments.
shift
# The k6 script. Default to stairs, because it finds the capacity of a configuration.
SCRIPT="${1:-stairs}"
# Remove the script name if it was given, so "$@" holds only the k6 flags.
[ $# -gt 0 ] && shift
# Runs per variant.
REPEAT="${REPEAT:-1}"
# Seconds between runs.
COOLDOWN="${COOLDOWN:-30}"
# Dry run prints the plan only.
DRY_RUN="${DRY_RUN:-}"
# The batch id groups the runs in the report: the matrix name and a time stamp.
BATCH="$(basename "$MATRIX" .txt)-$(date +%Y%m%d-%H%M%S)"
# The log of the batch. It keeps the per-variant results after the terminal is closed.
mkdir -p loadtest/results/reports
LOG="loadtest/results/reports/batch-$BATCH.log"  # Next to the batch report.

# Prints a message to the terminal and to the batch log.
say() { echo "$*" | tee -a "$LOG"; }

# Reads one value from loadtest/.env, or prints the default. The shell value wins, as in docker compose.
env_value() {
  # $1 is the name, $2 the default.
  eval "cur=\${$1:-}"
  # A value that is already in the environment wins.
  if [ -n "$cur" ]; then echo "$cur"; return; fi
  # Otherwise read the last "NAME=" line of loadtest/.env, if the file exists.
  v=""
  [ -f loadtest/.env ] && v=$(grep -E "^$1=" loadtest/.env | tail -n 1 | cut -d= -f2-)  # The last line wins, as in compose.
  # Fall back to the default.
  echo "${v:-$2}"
}

# Converts a Docker memory size (512m, 1g, 1536m) to MB. Prints nothing for an unknown format.
to_mb() {
  # Match on the unit letter at the end.
  case "$1" in
    *[gG]) echo $(( ${1%[gG]} * 1024 )) ;;  # Gigabytes: times 1024.
    *[mM]) echo "${1%[mM]}" ;;  # Megabytes: the number as it is.
    *) echo "" ;;  # Unknown unit: no derived values.
  esac
}

# Expands a cpuset like "0-1,4" into "0 1 4", for the overlap check.
expand_cpus() {
  # Split on commas, then expand each range.
  echo "$1" | tr ',' '\n' | while IFS=- read -r a b; do
    # A single CPU has no "-b" part.
    [ -z "$b" ] && b="$a"
    # seq prints one number per line.
    seq "$a" "$b"
  done | tr '\n' ' '  # One line, with spaces between the CPUs.
}

# Checks one variant. Prints the problem and returns 1 when the settings are not valid.
check_variant() {
  # The CPUs that the tools (Prometheus, k6, exporters) use. app and db must not share them.
  tools=$(expand_cpus "$(env_value TOOLS_CPUSET 2-5)")
  # The CPUs of the variant.
  sut=$(expand_cpus "$SUT_CPUSET")
  # The number of CPUs in the Docker VM. A cpuset past it makes "compose up" fail.
  ncpu=$(docker info --format '{{.NCPU}}' 2>/dev/null || echo 0)
  for c in $sut; do  # Check each CPU of the variant.
    # A CPU in both sets would let k6 take CPU from the app, and the results would be wrong.
    case " $tools " in *" $c "*) echo "SUT_CPUSET=$SUT_CPUSET overlaps TOOLS_CPUSET (CPU $c)"; return 1 ;; esac
    # A CPU that does not exist.
    if [ "$ncpu" -gt 0 ] && [ "$c" -ge "$ncpu" ]; then echo "SUT_CPUSET=$SUT_CPUSET uses CPU $c, but Docker has $ncpu CPUs"; return 1; fi
  done
  # Postgres allows 100 connections by default. The exporter and psql sessions need some of them.
  # A value that is not a positive whole number makes "[ -gt ]" fail with status 2, which would count as a pass.
  case "$DB_POOL_MAX" in ''|*[!0-9]*|0) echo "DB_POOL_MAX=$DB_POOL_MAX is not a positive whole number"; return 1 ;; esac
  if [ "$DB_POOL_MAX" -gt 90 ]; then echo "DB_POOL_MAX=$DB_POOL_MAX is over 90, too close to max_connections=100"; return 1; fi
  return 0  # All checks passed.
}

# Applies the settings of one matrix line to the environment, and derives the dependent values.
# $1 is the rest of the line after the name.
apply_settings() {
  # Track which keys the line sets, so derived values do not override explicit ones.
  set_heap=""; set_sb=""; set_ecs=""
  # Word splitting on purpose: each KEY=VALUE is one word.
  for kv in $1; do
    # Split KEY=VALUE at the first "=".
    key="${kv%%=*}"; val="${kv#*=}"
    # Only the keys that docker-compose.loadtest.yml reads are allowed. A typo then fails early.
    case "$key" in
      # Plain settings: nothing else depends on the flag.
      DB_POOL_MAX|SUT_CPUSET|APP_MEM|DB_MEM) ;;
      # An explicit heap turns off the 75% rule.
      APP_HEAP_MB) set_heap=1 ;;
      # An explicit shared_buffers turns off the 25% rule.
      DB_SHARED_BUFFERS) set_sb=1 ;;
      # An explicit effective_cache_size turns off the 75% rule.
      DB_EFFECTIVE_CACHE_SIZE) set_ecs=1 ;;
      # Anything else is a typo or a setting that compose does not read.
      *) say "Unknown key $key in line '$1'"; return 1 ;;
    esac
    # Export, so docker compose uses it. Shell values win over loadtest/.env.
    export "$key=$val"
  done
  # Fill the keys that the line did not set from loadtest/.env or the compose defaults.
  export DB_POOL_MAX="$(env_value DB_POOL_MAX 10)" SUT_CPUSET="$(env_value SUT_CPUSET 0-1)"
  export APP_MEM="$(env_value APP_MEM 512m)" DB_MEM="$(env_value DB_MEM 1g)"  # The memory limits.
  # The heap is 75% of APP_MEM, as in .env.example, so Node collects garbage before the kernel kills it.
  app_mb=$(to_mb "$APP_MEM")
  if [ -z "$set_heap" ]; then  # Only when the line has no APP_HEAP_MB.
    if [ -n "$app_mb" ]; then export APP_HEAP_MB=$(( app_mb * 75 / 100 )); else export APP_HEAP_MB="$(env_value APP_HEAP_MB 384)"; fi  # Unknown unit: keep the .env value.
  fi
  # shared_buffers is 25% and effective_cache_size is 75% of DB_MEM, as in .env.example.
  db_mb=$(to_mb "$DB_MEM")
  if [ -z "$set_sb" ]; then  # Only when the line has no DB_SHARED_BUFFERS.
    if [ -n "$db_mb" ]; then export DB_SHARED_BUFFERS="$(( db_mb * 25 / 100 ))MB"; else export DB_SHARED_BUFFERS="$(env_value DB_SHARED_BUFFERS 256MB)"; fi  # 25% of DB_MEM.
  fi
  if [ -z "$set_ecs" ]; then  # Only when the line has no DB_EFFECTIVE_CACHE_SIZE.
    if [ -n "$db_mb" ]; then export DB_EFFECTIVE_CACHE_SIZE="$(( db_mb * 75 / 100 ))MB"; else export DB_EFFECTIVE_CACHE_SIZE="$(env_value DB_EFFECTIVE_CACHE_SIZE 768MB)"; fi  # 75% of DB_MEM.
  fi
}

# Recreates app and db with the current environment and waits until both answer.
# A restart is not enough: Docker sets the cpuset and memory limit, and Postgres reads its -c flags, at create time.
recreate() {
  # --no-deps leaves Prometheus and the exporters running, so their data has no gap.
  # --wait returns when db is healthy and app is running.
  compose up -d --force-recreate --no-deps --wait --wait-timeout 180 db app >> "$LOG" 2>&1 || return 1
  # The app has no health check. Ask it for the home page until it answers, for up to 60 seconds.
  i=0
  until compose exec -T app node -e "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" > /dev/null 2>&1; do  # Port 3000 is the app port in the container.
    # Give up after 60 tries of one second.
    i=$((i + 1)); [ "$i" -ge 60 ] && return 1
    sleep 1  # Wait one second between tries.
  done
}

# Puts app and db back to the loadtest/.env values. It runs at the end, also after Ctrl+C or an error.
restore_default() {
  say "Recreating app and db with the loadtest/.env values"  # Log the step, so the end of the log shows it.
  # A subshell with the variant variables removed, so compose reads loadtest/.env again.
  ( unset DB_POOL_MAX SUT_CPUSET APP_MEM APP_HEAP_MB DB_MEM DB_SHARED_BUFFERS DB_EFFECTIVE_CACHE_SIZE; recreate ) || say "Could not recreate app and db. Run: scripts/loadtest/compose.sh up -d --force-recreate db app"
}

# Read the variants: drop comments and empty lines. Keep the name and the settings.
VARIANTS=$(sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$MATRIX" | grep -v '^[[:space:]]*$' || true)
# Stop if the file has no variants.
[ -n "$VARIANTS" ] || { echo "No variants in $MATRIX" >&2; exit 1; }

say "Batch $BATCH: script $SCRIPT, k6 flags: $*, repeat $REPEAT, log $LOG"  # The header of the batch log.
# Check every line first, so a typo in the last line does not stop the batch after an hour.
# The loop reads from a pipe, so it runs in a subshell. A flag file carries a failure out of it.
rm -f "$LOG.invalid"
echo "$VARIANTS" | while read -r name settings; do  # The first word is the name, the rest the configuration.
  # A subshell per line keeps the exports of one line from leaking into the next.
  (
    # Unknown keys make apply_settings fail. Record that as an invalid line.
    apply_settings "$settings" || { touch "$LOG.invalid"; exit 0; }
    # check_variant prints the problem and returns 1 when a value is not valid.
    if msg=$(check_variant); then
      # Show the full settings, including the derived heap and Postgres sizes.
      say "  $name: DB_POOL_MAX=$DB_POOL_MAX SUT_CPUSET=$SUT_CPUSET APP_MEM=$APP_MEM APP_HEAP_MB=$APP_HEAP_MB DB_MEM=$DB_MEM DB_SHARED_BUFFERS=$DB_SHARED_BUFFERS DB_EFFECTIVE_CACHE_SIZE=$DB_EFFECTIVE_CACHE_SIZE"
    else
      # Show why the line is not valid, and mark the batch as invalid.
      say "  $name: INVALID: $msg"
      touch "$LOG.invalid"  # The flag file that stops the batch below.
    fi
  )
done
# Stop before any run if a line is not valid.
if [ -f "$LOG.invalid" ]; then rm -f "$LOG.invalid"; say "Fix the matrix file and run again."; exit 1; fi
# A dry run ends here.
[ -n "$DRY_RUN" ] && { say "Dry run: nothing started."; exit 0; }

# From here on, put app and db back to the .env values when the script ends for any reason.
trap restore_default EXIT
# Ctrl+C runs the EXIT trap too.
trap 'exit 130' INT TERM

# Choose the stdin of k6. docker compose run gives the container a TTY only when its stdin is a terminal,
# and without a TTY k6 prints a new progress block every second instead of one line that updates in place.
# The loop below takes its stdin from the here-document, so k6 must get the terminal from /dev/tty.
K6_STDIN=/dev/null  # The default when no terminal is present, for example in CI or under nohup.
# Use the terminal only when stdout is a terminal too, so a redirected run gets no progress escape codes.
# The open test in a subshell fails without a message when the shell has no controlling terminal.
if [ -t 1 ] && (: < /dev/tty) 2>/dev/null; then K6_STDIN=/dev/tty; fi

# Run each variant. The here-document keeps the loop in this shell, so traps and counters work.
FIRST=1
while read -r name settings; do  # One variant per line of the here-document below.
  n=1  # The run number of this variant.
  while [ "$n" -le "$REPEAT" ]; do  # Run the variant REPEAT times.
    # Wait between runs, so heat and background work from the last run do not change the next one.
    if [ -z "$FIRST" ]; then say "Cooldown $COOLDOWN s"; sleep "$COOLDOWN"; fi
    FIRST=""  # Every later run gets a cooldown.
    say "=== $name (run $n of $REPEAT)"  # Mark the start of the run in the log.
    # A subshell per run, so the exported settings end with the run.
    (
      apply_settings "$settings"  # Export the configuration of this variant.
      # The labels that k6.sh writes into meta.json and the Prometheus tags.
      export BATCH VARIANT="$name"
      # A failed recreate or restore skips this variant, but the batch goes on.
      recreate || { say "  $name: app or db did not start. Skipped. See $LOG"; exit 0; }
      # Restore the data snapshot, because the write actions of the last run changed it.
      sh scripts/loadtest/restore.sh >> "$LOG" 2>&1 || { say "  $name: restore failed. Skipped."; exit 0; }
      # Run k6. A threshold failure (exit 99) is a normal result for an overload test.
      RC=0
      # "< $K6_STDIN" gives k6 the terminal, so its progress updates in place. It reads /dev/tty, not the variant lines.
      sh scripts/loadtest/k6.sh "$SCRIPT" "$@" < "$K6_STDIN" || RC=$?  # Keep the exit code without a stop from set -e.
      say "  $name: k6 exit code $RC"  # Log the result of the run.
    # docker compose reads stdin. Without /dev/null it would eat the variant lines that the loop reads,
    # and the batch would stop after the first variant.
    ) < /dev/null
    n=$((n + 1))  # Next run of the same variant.
  done
done <<EOF_VARIANTS  # Read the variant lines from the here-document.
$VARIANTS
EOF_VARIANTS

# Build one report with all runs of the batch. The first variant is the baseline.
node scripts/loadtest/report.ts --batch "$BATCH" | tee -a "$LOG" || say "Report failed. Run: node scripts/loadtest/report.ts --batch $BATCH"
