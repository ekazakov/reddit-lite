#!/usr/bin/env sh
# Restores the snapshot from seed.sh, so each test run starts with the same data.
# WARNING: this script replaces all data in the local Docker database.
set -eu
. "$(dirname "$0")/compose.sh"

SNAPSHOT=loadtest/data/snapshot.dump
if [ ! -f "$SNAPSHOT" ]; then
  echo "No snapshot at $SNAPSHOT. Run scripts/loadtest/seed.sh first." >&2
  exit 1
fi

START=$(date +%s)
compose exec -T db pg_restore -U postgres -d reddit_lite --clean --if-exists --no-owner < "$SNAPSHOT"
# pg_restore does not restore planner statistics in Postgres 17.
psql_db -c 'ANALYZE'
psql_db -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements' -c 'SELECT pg_stat_statements_reset()' > /dev/null
echo "Restored in $(( $(date +%s) - START )) s. Query statistics are reset."
