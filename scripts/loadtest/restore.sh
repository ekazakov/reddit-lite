#!/usr/bin/env sh
# Restores the snapshot from seed.sh, so each test run starts with the same data.
# WARNING: this script replaces all data in the load test database (Compose project reddit-lite-loadtest).

# Stop on any error or unset variable.
set -eu
# Load the compose helper. It also moves to the repository root.
. "$(dirname "$0")/compose.sh"

# The dump file that seed.sh saved.
SNAPSHOT=loadtest/data/snapshot.dump
# Stop early with a clear message if there is no snapshot.
if [ ! -f "$SNAPSHOT" ]; then
  echo "No snapshot at $SNAPSHOT. Run scripts/loadtest/seed.sh first." >&2
  exit 1
fi

# Record the start time, to report how long the restore took.
START=$(date +%s)
# Restore from the file on stdin. The flags:
#   --clean --if-exists  drop each object before it is created, and ignore missing ones
#   --no-owner           skip ownership commands, which could fail in the container
compose exec -T db pg_restore -U postgres -d reddit_lite --clean --if-exists --no-owner < "$SNAPSHOT"
# pg_restore does not restore planner statistics in Postgres 17.
# Without statistics, the planner picks bad plans, so rebuild them.
psql_db -c 'ANALYZE'
# Make sure that the extension exists, then clear old query statistics. The next run then starts from zero. Hide the output.
psql_db -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements' -c 'SELECT pg_stat_statements_reset()' > /dev/null
# Report the time and remind the user that the statistics are reset.
echo "Restored in $(( $(date +%s) - START )) s. Query statistics are reset."
