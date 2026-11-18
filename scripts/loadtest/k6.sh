#!/usr/bin/env sh
# Runs a k6 script in the k6 container and saves the summary in loadtest/results/.
# Usage: scripts/loadtest/k6.sh smoke|stairs|soak|spike [-e NAME=VALUE ...]
# Example: scripts/loadtest/k6.sh stairs -e STEPS=10,20 -e HOLD=1m

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

# Make sure that the results folder exists, because k6 does not create it.
mkdir -p loadtest/results
# A time stamp makes each run name unique, so results never overwrite each other.
STAMP=$(date +%Y%m%d-%H%M%S)
# Run k6 in a throwaway container (--rm). The flags below:
#   -o experimental-prometheus-rw  push live metrics to Prometheus
#   --tag testid=...               label the metrics, so Grafana can select one run
#   --summary-export ...           save the final numbers as JSON
#   "$@"                           pass the extra flags from the caller
# k6 exits with 99 when a threshold fails. "|| RC=$?" keeps that code without a stop from set -e,
# so the Prometheus export below also runs for failed runs, which are the most useful ones.
RC=0
compose run --rm k6 run \
  -o experimental-prometheus-rw \
  --tag testid="$NAME-$STAMP" \
  --summary-export "results/$NAME-$STAMP.json" \
  "$@" "k6/$NAME.js" || RC=$?

# Wait for the last k6 push and the last exporter scrape. Both happen every 5 seconds.
sleep 10
# Save the db, CPU, and memory metrics of the run next to the k6 summary, as <testid>-prom.json.
# It runs now because the next restore.sh resets pg_stat_statements, and the query text is then lost.
# A failed export prints a warning only, so it never hides the k6 result.
node scripts/loadtest/prom-summary.ts "$NAME-$STAMP" || echo "Prometheus export failed. Run it later: node scripts/loadtest/prom-summary.ts $NAME-$STAMP" >&2
# Exit with the k6 code, so callers still see a threshold failure.
exit "$RC"
