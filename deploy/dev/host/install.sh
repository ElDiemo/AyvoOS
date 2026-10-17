#!/usr/bin/env bash
# AYVO OS — install the DEV host guard (ADR 0026). Run as root on the DEV server only, naming a
# complete edge backup taken BEFORE (scripts/dev-edge-backup.sh backup …; it is checked here):
#   sudo bash deploy/dev/host/install.sh /opt/ayvo/backups/dev-preview/edge-before-<time>-<id>
# Backs up the current firewall state and sysctl first (to /var/backups/ayvo-dev-tailnet/<time>),
# then installs: the sysctl (ip_nonlocal_bind), /usr/local/sbin/ayvo-dev-docker-guard and its
# systemd unit (enabled, applied now and on every Docker start). It does not touch UFW, SSH,
# Tailscale or any container. Undo: sudo bash deploy/dev/host/uninstall.sh
set -Eeuo pipefail
umask 022
[[ $(id -u) == 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDGE_BACKUP=${1:-}
[[ -n $EDGE_BACKUP && -f $EDGE_BACKUP/COMPLETE && -f $EDGE_BACKUP/runtime.env ]] || {
  echo "name a complete edge backup first: scripts/dev-edge-backup.sh backup … (ADR 0026)" >&2
  exit 1
}
(cd "$EDGE_BACKUP" && sha256sum --quiet -c SHA256SUMS) || { echo "edge backup checksums do not match" >&2; exit 1; }
echo "edge backup verified: $EDGE_BACKUP"
BACKUP="/var/backups/ayvo-dev-tailnet/$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP"
chmod 700 "$BACKUP"
iptables-save >"$BACKUP/iptables.rules"
ip6tables-save >"$BACKUP/ip6tables.rules"
sysctl net.ipv4.ip_nonlocal_bind >"$BACKUP/sysctl.txt"
for f in /etc/sysctl.d/60-ayvo-dev-tailnet.conf /usr/local/sbin/ayvo-dev-docker-guard \
  /etc/systemd/system/ayvo-dev-docker-guard.service; do
  [[ ! -e $f ]] || cp -a "$f" "$BACKUP/"
done
echo "backup: $BACKUP"

install -m 644 "$HERE/60-ayvo-dev-tailnet.conf" /etc/sysctl.d/60-ayvo-dev-tailnet.conf
sysctl -q -p /etc/sysctl.d/60-ayvo-dev-tailnet.conf
install -m 755 "$HERE/ayvo-dev-docker-guard" /usr/local/sbin/ayvo-dev-docker-guard
install -m 644 "$HERE/ayvo-dev-docker-guard.service" /etc/systemd/system/ayvo-dev-docker-guard.service
systemctl daemon-reload
systemctl enable ayvo-dev-docker-guard.service
systemctl restart ayvo-dev-docker-guard.service

echo
sysctl net.ipv4.ip_nonlocal_bind
systemctl is-active ayvo-dev-docker-guard.service
/usr/local/sbin/ayvo-dev-docker-guard status
