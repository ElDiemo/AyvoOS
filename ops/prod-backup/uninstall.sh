#!/usr/bin/env bash
# AYVO OS — remove the PROD backup units and tool (doc 035). Run as root:
#   sudo bash ops/prod-backup/uninstall.sh
# Stops and disables the timers, removes the units, the code and the login message. Keeps the
# state in /var/lib/ayvo-backup and never touches S3 (no object is deleted).
set -Eeuo pipefail
[[ $(id -u) == 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The right server, and no DEV here, before the first change.
# shellcheck source=prod-host.sh
source "$HERE/prod-host.sh"
assert_prod_host || exit 1
for t in ayvo-prod-backup-hourly ayvo-prod-backup-daily ayvo-prod-restore-check ayvo-prod-backup-check; do
  systemctl disable --now "$t.timer" 2>/dev/null || true
done
rm -f /etc/systemd/system/ayvo-prod-backup@.service /etc/systemd/system/ayvo-prod-backup-*.timer \
  /etc/systemd/system/ayvo-prod-backup-check.service /etc/systemd/system/ayvo-prod-restore-check.* \
  /etc/update-motd.d/90-ayvo-backup
rm -rf /usr/local/lib/ayvo-backup
systemctl daemon-reload
echo "backup units removed; /var/lib/ayvo-backup and the bucket are untouched"
