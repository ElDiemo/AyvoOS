#!/usr/bin/env bash
# AYVO OS — install the PROD backup tool and its systemd units (doc 035). Run as root on the
# PRODUCTION server only, from a checkout of the approved release:
#   sudo bash ops/prod-backup/install.sh
# Installs the code to /usr/local/lib/ayvo-backup, the units to /etc/systemd/system and the login
# message to /etc/update-motd.d. It ENABLES NO TIMER: the owner does that once the first manual
# backup and restore check have passed (doc 035 §6). Idempotent. Undo: ops/prod-backup/uninstall.sh
set -Eeuo pipefail
umask 022
[[ $(id -u) == 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The right server, and no DEV here, before the first change.
# shellcheck source=prod-host.sh
source "$HERE/prod-host.sh"
assert_prod_host || exit 1
id ayvo >/dev/null 2>&1 || { echo "the user ayvo does not exist" >&2; exit 1; }
getent group docker >/dev/null || { echo "Docker is not installed (no docker group)" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is missing" >&2; exit 1; }
CREDS=/opt/ayvo/secrets/prod-s3-backup.env
if [[ -e $CREDS ]]; then
  [[ $(stat -c '%U %a' "$CREDS") == 'ayvo 600' ]] ||
    echo "WARNING: $CREDS should be owned by ayvo with mode 600 (now: $(stat -c '%U %a' "$CREDS"))" >&2
else
  echo "WARNING: $CREDS does not exist yet; backups will fail until it does" >&2
fi

install -d -m 755 /usr/local/lib/ayvo-backup/ayvo_backup
install -m 644 "$HERE"/ayvo_backup/*.py /usr/local/lib/ayvo-backup/ayvo_backup/
for unit in "$HERE"/systemd/*.service "$HERE"/systemd/*.timer; do
  install -m 644 "$unit" /etc/systemd/system/
done
install -m 755 "$HERE/systemd/90-ayvo-backup" /etc/update-motd.d/90-ayvo-backup
systemctl daemon-reload

echo "installed: /usr/local/lib/ayvo-backup, $(cd "$HERE/systemd" && ls ./*.service ./*.timer | tr '\n' ' ')"
echo "timers enabled: none (see doc 035 §6 for the first manual backup, restore check and enabling)"
systemctl list-timers --all 'ayvo-prod-*' --no-pager || true
