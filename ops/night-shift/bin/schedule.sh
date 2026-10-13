#!/usr/bin/env bash
set -euo pipefail
umask 077

root=/opt/ayvo/night-shift
export TZ=Europe/Prague

# Cron runs this every ten minutes so daylight-saving changes do not shift the Czech start time.
if [[ "$(date +%H:%M)" != "22:30" ]]; then
  exit 0
fi

today=$(date +%F)
stamp="$root/last-scheduled-date"
if [[ -f "$stamp" ]] && [[ "$(<"$stamp")" == "$today" ]]; then
  exit 0
fi
tmp="$stamp.tmp"
printf '%s\n' "$today" >"$tmp"
chmod 600 "$tmp"
mv "$tmp" "$stamp"

exec "$root/bin/run-night.sh"
