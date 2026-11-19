#!/usr/bin/env sh
# Scans the app image, the third-party images in the compose files, and the repository files with Trivy.
# Usage: pnpm security:scan           (HIGH and CRITICAL findings that have a fix)
#        ALL=1 pnpm security:scan     (every finding, also unfixed and low ones)

# Stop on the first failed command and on unset variables, so a broken step never looks like a clean scan.
set -eu

# Find the repository root from this file location, so the script works from any folder.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Move to the root, because the compose file paths below are relative to it.
cd "$ROOT"

# Tag for the locally built app image, so the scan does not touch the tags that deploy uses.
APP_IMAGE="reddit-lite:scan"
# Trivy image, pinned by tag and digest. Used only when trivy is not installed on the host.
TRIVY_IMAGE="aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb"

# By default show only HIGH and CRITICAL findings that have a fixed version, because those are the ones an update can remove.
if [ "${ALL:-0}" = 1 ]; then
  # Show every severity and also findings with no fix yet.
  FILTER="--severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL"
else
  # The same filter that the CI gate uses.
  FILTER="--severity HIGH,CRITICAL --ignore-unfixed"
fi

# Run trivy from the host when it is installed (faster, uses the host cache).
# Otherwise run the pinned Trivy image. It gets the Docker socket to read local images,
# a named volume to keep the vulnerability database between runs, and the repository as read-only /src.
trivy_run() {
  if command -v trivy >/dev/null 2>&1; then
    trivy "$@"
  else
    docker run --rm \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v reddit-lite-trivy-cache:/root/.cache/trivy \
      -v "$ROOT":/src:ro \
      -w /src \
      "$TRIVY_IMAGE" "$@"
  fi
}

# Build the app image from the current Dockerfile, so the scan sees the code as it is now.
echo "==> Building $APP_IMAGE"
docker build -q -t "$APP_IMAGE" . >/dev/null

# List the third-party images in all three compose files. The app image is left out, because it is scanned above as $APP_IMAGE.
IMAGES="$(grep -h -E '^[[:space:]]*image:' docker-compose.yml docker-compose.loadtest.yml deploy/docker-compose.prod.yml \
  | awk '{print $2}' | grep -v '^reddit-lite' | sort -u)"

# Count scans with findings, so the script scans everything and still reports a result at the end.
# FAILED counts what we fix ourselves (app image, repository). THIRD_PARTY counts upstream images, which only a tag bump fixes.
FAILED=0
THIRD_PARTY=0

# Scan the app image. --exit-code 1 marks the scan as failed when findings match the filter.
# .trivyignore holds accepted findings with a reason and an expiry date.
echo "==> Scanning $APP_IMAGE"
# shellcheck disable=SC2086  # FILTER must split into separate flags.
trivy_run image --quiet --ignorefile .trivyignore --exit-code 1 $FILTER "$APP_IMAGE" || FAILED=$((FAILED + 1))

# Scan each third-party image. Findings here are fixed by a tag or digest bump from Renovate, so they do not fail the script.
for IMAGE in $IMAGES; do
  echo "==> Scanning $IMAGE"
  # shellcheck disable=SC2086  # FILTER must split into separate flags.
  trivy_run image --quiet --ignorefile .trivyignore --exit-code 1 $FILTER "$IMAGE" || THIRD_PARTY=$((THIRD_PARTY + 1))
done

# Scan the repository: known vulnerabilities in pnpm-lock.yaml, and misconfigurations in the Dockerfile and compose files.
# Skip .claude (agent worktrees hold copies of other branches) and node_modules (the lockfile already covers it). Trivy does not read .gitignore.
echo "==> Scanning repository files"
# shellcheck disable=SC2086  # FILTER must split into separate flags.
trivy_run fs --quiet --ignorefile .trivyignore --skip-dirs .claude --skip-dirs node_modules --scanners vuln,misconfig --exit-code 1 $FILTER . || FAILED=$((FAILED + 1))

# Report the third-party result for information. The fix is to merge the Renovate PR that bumps the image.
if [ "$THIRD_PARTY" -gt 0 ]; then
  echo "==> $THIRD_PARTY third-party image(s) have findings. Merge the Renovate image updates to fix them."
fi
# Exit non-zero only for findings in our own image or files, the same rule as the CI gate.
if [ "$FAILED" -gt 0 ]; then
  echo "==> $FAILED scan(s) of the app image or repository reported findings"
  exit 1
fi
echo "==> No findings in the app image or repository"
