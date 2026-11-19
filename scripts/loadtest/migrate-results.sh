#!/usr/bin/env sh
# Moves the old flat result files into one folder per run, the layout that k6.sh now writes:
#   loadtest/results/<testid>.json       -> loadtest/results/<testid>/summary.json
#   loadtest/results/<testid>-prom.json  -> loadtest/results/<testid>/prom.json
# It is safe to run again: it never overwrites a file that is already in a run folder.
# Usage: scripts/loadtest/migrate-results.sh

# Stop on any error or unset variable.
set -eu
# Move to the repository root, so the paths below work from any folder.
cd "$(dirname "$0")/../.."
# The results folder. Stop quietly if there are no results yet.
DIR=loadtest/results
[ -d "$DIR" ] || { echo "No $DIR folder. Nothing to migrate."; exit 0; }  # Nothing to do without results.

# Go through every flat JSON file. The glob stays literal when nothing matches, so check that the file exists.
for f in "$DIR"/*.json; do
  # Skip the literal pattern when the folder has no JSON files.
  [ -f "$f" ] || continue
  # The file name without the folder.
  base=$(basename "$f" .json)
  # A "-prom" suffix marks the Prometheus export. Everything else is a k6 summary.
  case "$base" in
    *-prom) id="${base%-prom}"; target=prom.json ;;  # The Prometheus export of a run.
    *) id="$base"; target=summary.json ;;  # The k6 summary of a run.
  esac
  # Make the run folder.
  mkdir -p "$DIR/$id"
  # Keep the existing file if the folder already has one, and say so.
  if [ -e "$DIR/$id/$target" ]; then echo "Skip $f: $DIR/$id/$target exists"; continue; fi
  # Move the file into the run folder.
  mv "$f" "$DIR/$id/$target"
  # Report each move, so the user sees what changed.
  echo "Moved $f -> $DIR/$id/$target"
done

# Give every run folder a meta.json, so the report can list it. Old runs did not record one.
for d in "$DIR"/*/; do
  # The run id is the folder name.
  id=$(basename "$d")
  # The reports folder is not a run.
  [ "$id" = reports ] && continue
  # Leave an existing meta.json alone.
  [ -f "$d/meta.json" ] && continue
  # The script name is the part before the date, for example "stairs" in stairs-20261118-205214.
  script="${id%%-[0-9]*}"
  # Write a minimal meta.json. "migrated" tells the report that the configuration was not recorded.
  printf '{\n  "testid": "%s",\n  "script": "%s",\n  "migrated": true,\n  "batch": null,\n  "variant": null\n}\n' "$id" "$script" > "$d/meta.json"
  # Report the new file.
  echo "Wrote $d""meta.json"
  # Old runs have no raw Prometheus points. Prometheus keeps 7 days, so try to fetch them now.
  # --series-only keeps the old prom.json, which has query text that a new export cannot get back.
  # A failure (Prometheus down, run too old) prints a note only. The report then shows tables without those charts.
  if [ ! -f "$d/prom-series.json" ]; then
    node scripts/loadtest/prom-summary.ts "$id" --series-only > /dev/null 2>&1 \
      && echo "Fetched $d""prom-series.json" \
      || echo "No Prometheus data for $id. Its report has tables but no Prometheus charts."
  fi
done
