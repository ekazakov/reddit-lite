#!/usr/bin/env sh
# Runs a k6 script in the k6 container and saves everything about the run in loadtest/results/<testid>/.
# Usage: scripts/loadtest/k6.sh smoke|stairs|soak|spike [-e NAME=VALUE ...]
# Example: scripts/loadtest/k6.sh stairs -e STEPS=10,20 -e HOLD=1m
# Optional environment: BATCH and VARIANT label the run. matrix.sh sets them for each configuration.

# Stop on any error or unset variable.
set -eu
# Load the compose helper. It also moves to the repository root.
. "$(dirname "$0")/compose.sh"

# The first argument is the test name. The ":?" form stops with a message if it is missing.
NAME="${1:?Give a script name: smoke, stairs, soak, or spike}"
# Remove the name, so "$@" holds only the extra k6 flags.
shift
# Stop early with a clear message if the script does not exist.
if [ ! -f "loadtest/k6/$NAME.js" ]; then echo "No script loadtest/k6/$NAME.js" >&2; exit 1; fi
# The tests read CSV files that seed.sh makes. Without them, k6 fails in a confusing way.
if [ ! -f loadtest/data/meta.json ]; then echo "No mock data. Run scripts/loadtest/seed.sh first." >&2; exit 1; fi

# A time stamp makes each run name unique, so results never overwrite each other.
STAMP=$(date +%Y%m%d-%H%M%S)
# The run id. Prometheus labels, the folder name, and the report all use it.
TESTID="$NAME-$STAMP"
# One folder per run keeps the summary, raw data, Prometheus export, and report together.
RUN="loadtest/results/$TESTID"
# Make the folder, because k6 does not create folders for its output files.
mkdir -p "$RUN"
# Default the labels to empty, so "set -u" does not stop on a run outside a batch.
BATCH="${BATCH:-}"
# The variant name of a matrix line, or empty.
VARIANT="${VARIANT:-}"
# Export them, so run-meta.ts can read them.
export BATCH VARIANT

# Record the script, flags, commit, and the real app and db configuration before the run.
# A failure here prints a warning only, so a missing Docker detail never blocks a test.
node scripts/loadtest/run-meta.ts start "$TESTID" "$NAME" "$@" || echo "Could not write $RUN/meta.json" >&2

# Add the variant tag only inside a batch. "set --" puts it in front of the caller's flags.
# An empty tag value is not useful in Prometheus, so a run outside a batch gets no variant label.
if [ -n "$VARIANT" ]; then set -- --tag "variant=$VARIANT" "$@"; fi

# Run k6 in a throwaway container (--rm). The flags below:
#   -o experimental-prometheus-rw    push live metrics to Prometheus for Grafana and prom-summary.ts
#   --out csv=.../k6.csv.gz          save every sample, so the report can compute exact per-second percentiles
#                                    (k6 gzips the file because the name ends in .gz)
#   --tag testid=...                 label the metrics, so Grafana and prom-summary.ts can select one run
#   --summary-export ...             save the final numbers as JSON
#   "$@"                             pass the extra flags from the caller, and the variant tag
# Paths are relative to /loadtest, the working folder of the k6 container, which maps to ./loadtest.
# k6 exits with 99 when a threshold fails. "|| RC=$?" keeps that code without a stop from set -e,
# so the exports below also run for failed runs, which are the most useful ones.
RC=0
compose run --rm k6 run \
  -o experimental-prometheus-rw \
  --out "csv=results/$TESTID/k6.csv.gz" \
  --tag testid="$TESTID" \
  --summary-export "results/$TESTID/summary.json" \
  "$@" "k6/$NAME.js" || RC=$?

# Add the end time, the exit code, and the container state after the run (OOM kills, restarts).
node scripts/loadtest/run-meta.ts end "$TESTID" "$RC" || echo "Could not update $RUN/meta.json" >&2

# Wait for the last k6 push and the last exporter scrape. Both happen every 5 seconds.
sleep 10
# Save the db, CPU, and memory metrics of the run as prom.json and prom-series.json in the run folder.
# It runs now because the next restore.sh resets pg_stat_statements, and the query text is then lost.
# A failed export prints a warning only, so it never hides the k6 result.
node scripts/loadtest/prom-summary.ts "$TESTID" || echo "Prometheus export failed. Run it later: node scripts/loadtest/prom-summary.ts $TESTID" >&2
# Build the single-run HTML report. It also turns k6.csv.gz into timeseries.json.
node scripts/loadtest/report.ts "$TESTID" || echo "Report failed. Run it later: node scripts/loadtest/report.ts $TESTID" >&2
# Exit with the k6 code, so callers still see a threshold failure.
exit "$RC"
