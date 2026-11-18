#!/usr/bin/env sh
# Shared helper: the docker compose command for the load test stack.
# Source it from the other scripts in this folder.

# Find the repository root from this file location, so the scripts work from any folder.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Move to the root, because all other paths in the scripts are relative to it.
cd "$ROOT" || exit 1

# Use loadtest/.env only if it exists. Without it, the defaults in the compose file apply.
ENV_FILE=""
if [ -f loadtest/.env ]; then ENV_FILE="--env-file loadtest/.env"; fi

# ShellCheck warns about the unquoted $ENV_FILE. We need word splitting here, so we turn the warning off.
# shellcheck disable=SC2086
# Run docker compose with the base file and the load test overlay, and pass extra arguments through.
compose() {
  docker compose $ENV_FILE -f docker-compose.yml -f docker-compose.loadtest.yml "$@"
}

# Run psql in the db container. -T turns off the TTY, so redirected input works.
# ON_ERROR_STOP=1 makes psql exit on the first SQL error, so a script never continues after a failure.
psql_db() {
  compose exec -T db psql -U postgres -d reddit_lite -v ON_ERROR_STOP=1 "$@"
}

# Run directly, this file passes its arguments to docker compose:
#   scripts/loadtest/compose.sh up -d --build
# The name check keeps this line from running when another script sources the file.
if [ "$(basename "$0")" = compose.sh ]; then compose "$@"; fi
