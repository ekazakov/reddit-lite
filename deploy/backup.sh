#!/bin/sh
# Daily Postgres backup. Cron example (as the user that runs Docker):
#   0 3 * * * /opt/reddit-lite/deploy/backup.sh

# Stop on any error (-e) and on unset variables (-u), so a failed dump never looks like a good backup.
set -eu
# Move to the script folder, so the compose file path below works from cron, where the folder is unknown.
cd "$(dirname "$0")"
# Pick the backup folder. BACKUP_DIR overrides the default, so you can store backups on another disk.
DIR="${BACKUP_DIR:-/var/backups/reddit-lite}"
# Create the folder if it is missing. The -p flag also makes a repeat run safe.
mkdir -p "$DIR"
# Dump the database from the running db container and compress it. The -T flag turns off the TTY, because cron has none and a TTY would corrupt the pipe. The date in the name keeps one file per day.
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U postgres reddit_lite | gzip > "$DIR/reddit_lite_$(date +%F).sql.gz"
# Delete backups older than 7 days, so the disk does not fill up.
find "$DIR" -name 'reddit_lite_*.sql.gz' -mtime +7 -delete
