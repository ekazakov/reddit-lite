#!/bin/sh
# Daily Postgres backup. Cron example (as the user that runs Docker):
#   0 3 * * * /opt/reddit-lite/deploy/backup.sh
set -eu
cd "$(dirname "$0")"
DIR="${BACKUP_DIR:-/var/backups/reddit-lite}"
mkdir -p "$DIR"
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U postgres reddit_lite | gzip > "$DIR/reddit_lite_$(date +%F).sql.gz"
find "$DIR" -name 'reddit_lite_*.sql.gz' -mtime +7 -delete
