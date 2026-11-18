#!/usr/bin/env sh
# Runs a k6 script in the k6 container and saves the summary in loadtest/results/.
# Usage: scripts/loadtest/k6.sh smoke|stairs|soak|spike [-e NAME=VALUE ...]
# Example: scripts/loadtest/k6.sh stairs -e STEPS=10,20 -e HOLD=1m
set -eu
. "$(dirname "$0")/compose.sh"

NAME="${1:?Give a script name: smoke, stairs, soak, or spike}"
shift
if [ ! -f "loadtest/k6/$NAME.js" ]; then echo "No script loadtest/k6/$NAME.js" >&2; exit 1; fi
if [ ! -f loadtest/data/meta.json ]; then echo "No mock data. Run scripts/loadtest/seed.sh first." >&2; exit 1; fi

mkdir -p loadtest/results
STAMP=$(date +%Y%m%d-%H%M%S)
compose run --rm k6 run \
  -o experimental-prometheus-rw \
  --tag testid="$NAME-$STAMP" \
  --summary-export "results/$NAME-$STAMP.json" \
  "$@" "k6/$NAME.js"
