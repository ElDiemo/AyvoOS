#!/usr/bin/env bash
set -euo pipefail
umask 077

root=/opt/ayvo/night-shift
exec 9>"$root/full-run.lock"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) another night shift is already running"
  exit 0
fi

echo "$(date -u +%FT%TZ) AYVO Night Shift started"

# Process at most two independently reviewed PRs in one shift. A failure stops
# the chain immediately; later work never continues on top of a blocked job.
for job_number in 1 2; do
  /usr/bin/python3 "$root/bin/night_shift.py" prepare
  phase=$(/usr/bin/python3 - "$root/state.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle).get("phase", "blocked"))
PY
)
  if [[ "$phase" == "idle" ]]; then
    echo "$(date -u +%FT%TZ) queue empty after $((job_number - 1)) job(s)"
    break
  fi
  if [[ "$phase" == "blocked" ]]; then
    echo "$(date -u +%FT%TZ) active job is blocked; stopping chain" >&2
    exit 1
  fi
  /usr/bin/python3 "$root/bin/night_shift.py" work
  /usr/bin/python3 "$root/bin/night_shift.py" publish
done

echo "$(date -u +%FT%TZ) AYVO Night Shift finished"
