#!/usr/bin/env sh
# Shared helper: the docker compose command for the load test stack.
# Source it from the other scripts in this folder.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

ENV_FILE=""
if [ -f loadtest/.env ]; then ENV_FILE="--env-file loadtest/.env"; fi

# shellcheck disable=SC2086
compose() {
  docker compose $ENV_FILE -f docker-compose.yml -f docker-compose.loadtest.yml "$@"
}

psql_db() {
  compose exec -T db psql -U postgres -d reddit_lite -v ON_ERROR_STOP=1 "$@"
}

# Run directly, this file passes its arguments to docker compose:
#   scripts/loadtest/compose.sh up -d --build
if [ "$(basename "$0")" = compose.sh ]; then compose "$@"; fi
