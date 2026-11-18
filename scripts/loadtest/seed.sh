#!/usr/bin/env sh
# Loads mock data into the load test database, exports CSV files for k6,
# and saves a snapshot for restore.sh.
# Usage: scripts/loadtest/seed.sh [S|default|L]
# WARNING: this script deletes all rows in the app tables of the local Docker database.
set -eu
. "$(dirname "$0")/compose.sh"

TIER="${1:-default}"
case "$TIER" in
  S)       USERS=5000;   POSTS=50000;   COMMENTS=250000;   VOTES=250000;   LIKES=500000 ;;
  default) USERS=20000;  POSTS=400000;  COMMENTS=2000000;  VOTES=2000000;  LIKES=4000000 ;;
  L)       USERS=200000; POSTS=5000000; COMMENTS=50000000; VOTES=25000000; LIKES=50000000 ;;
  *) echo "Unknown tier: $TIER. Use S, default, or L." >&2; exit 1 ;;
esac

DATA=loadtest/data
mkdir -p "$DATA" loadtest/results

echo "Tier $TIER: $USERS users, $POSTS posts, $COMMENTS comments, $VOTES votes, $LIKES likes"
START=$(date +%s)

compose exec -T app node src/migrate.ts
psql_db -v users="$USERS" -v posts="$POSTS" -v comments="$COMMENTS" \
  -v votes="$VOTES" -v likes="$LIKES" -f - < scripts/loadtest/seed.sql
psql_db -c 'VACUUM ANALYZE'
psql_db -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'

echo 'Exporting CSV files for k6'
psql_db -c "\copy (SELECT name FROM users ORDER BY id) TO STDOUT WITH CSV HEADER" > "$DATA/bots.csv"
# Hot posts: the top 1% by comment count, at most 2,000.
psql_db -c "\copy (SELECT id FROM posts ORDER BY comment_count DESC LIMIT least(2000, greatest(10, $POSTS / 100))) TO STDOUT WITH CSV HEADER" > "$DATA/posts_hot.csv"
psql_db -c "\copy (SELECT id FROM posts WHERE comment_count < 50 ORDER BY random() LIMIT 50000) TO STDOUT WITH CSV HEADER" > "$DATA/posts_cold.csv"
psql_db -c "\copy (SELECT id FROM comments ORDER BY random() LIMIT 100000) TO STDOUT WITH CSV HEADER" > "$DATA/comments.csv"
psql_db -tA -c "SELECT json_build_object('tier', '$TIER', 'posts', count(*), 'pageSize', 25) FROM posts" > "$DATA/meta.json"

echo 'Saving snapshot'
compose exec -T db pg_dump -U postgres -Fc reddit_lite > "$DATA/snapshot.dump"

END=$(date +%s)
echo "Done in $((END - START)) s"
psql_db -tA -c "SELECT 'Database size: ' || pg_size_pretty(pg_database_size('reddit_lite'))"
