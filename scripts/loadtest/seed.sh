#!/usr/bin/env sh
# Loads mock data into the load test database, exports CSV files for k6,
# and saves a snapshot for restore.sh.
# Usage: scripts/loadtest/seed.sh [S|default|L]
# WARNING: this script deletes all rows in the app tables of the load test database (Compose project reddit-lite-loadtest).

# Stop on any error or unset variable.
set -eu
# Load the compose helper. It also moves to the repository root.
. "$(dirname "$0")/compose.sh"

# The size tier. Use "default" if the caller gives none.
TIER="${1:-default}"
# Row counts for each tier. S is for quick checks, L is for large-data tests.
case "$TIER" in
  S)       USERS=5000;   POSTS=50000;   COMMENTS=250000;   VOTES=250000;   LIKES=500000 ;;
  default) USERS=20000;  POSTS=400000;  COMMENTS=2000000;  VOTES=2000000;  LIKES=4000000 ;;
  L)       USERS=200000; POSTS=5000000; COMMENTS=50000000; VOTES=25000000; LIKES=50000000 ;;
  # Reject any other value, so a typo does not start a long, wrong load.
  *) echo "Unknown tier: $TIER. Use S, default, or L." >&2; exit 1 ;;
esac

# Where the CSV files go. k6 reads them from this folder.
DATA=loadtest/data
# Make sure that both output folders exist.
mkdir -p "$DATA" loadtest/results

# Tell the user what will happen.
echo "Tier $TIER: $USERS users, $POSTS posts, $COMMENTS comments, $VOTES votes, $LIKES likes"
# Record the start time, to report the duration at the end.
START=$(date +%s)

# Create the tables first. The seed SQL needs them.
compose exec -T app node src/migrate.ts
# Run the seed SQL from stdin. Each -v flag passes a row count as a psql variable.
psql_db -v users="$USERS" -v posts="$POSTS" -v comments="$COMMENTS" \
  -v votes="$VOTES" -v likes="$LIKES" -f - < scripts/loadtest/seed.sql
# Update planner statistics and free dead rows, so the first test run is not slowed by a cold planner.
psql_db -c 'VACUUM ANALYZE'
# Make sure that the query statistics extension exists, because the dashboards need it.
psql_db -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'

# Export lists of real IDs, so k6 requests existing data and not random numbers.
echo 'Exporting CSV files for k6'
# All user names, for the bot logins.
psql_db -c "\copy (SELECT name FROM users ORDER BY id) TO STDOUT WITH CSV HEADER" > "$DATA/bots.csv"
# Hot posts: the top 1% by comment count, at most 2,000.
# They model the popular posts that most readers open.
psql_db -c "\copy (SELECT id FROM posts ORDER BY comment_count DESC LIMIT least(2000, greatest(10, $POSTS / 100))) TO STDOUT WITH CSV HEADER" > "$DATA/posts_hot.csv"
# Cold posts: a random sample of quiet posts. They model rare reads that miss the cache.
psql_db -c "\copy (SELECT id FROM posts WHERE comment_count < 50 ORDER BY random() LIMIT 50000) TO STDOUT WITH CSV HEADER" > "$DATA/posts_cold.csv"
# A random sample of comments, for like requests.
psql_db -c "\copy (SELECT id FROM comments ORDER BY random() LIMIT 100000) TO STDOUT WITH CSV HEADER" > "$DATA/comments.csv"
# Save the tier and post count, so k6 can check that the data exists and pick page sizes.
psql_db -tA -c "SELECT json_build_object('tier', '$TIER', 'posts', count(*), 'pageSize', 25) FROM posts" > "$DATA/meta.json"

# Save a dump in Postgres custom format (-Fc). restore.sh uses it to reset the data between runs.
echo 'Saving snapshot'
compose exec -T db pg_dump -U postgres -Fc reddit_lite > "$DATA/snapshot.dump"

# Report the duration and the database size.
END=$(date +%s)
echo "Done in $((END - START)) s"
psql_db -tA -c "SELECT 'Database size: ' || pg_size_pretty(pg_database_size('reddit_lite'))"
