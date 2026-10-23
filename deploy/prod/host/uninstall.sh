#!/usr/bin/env bash
# AYVO OS — remove the PROD host guard (doc 036 §3, rollback). Run as root:
#   sudo bash deploy/prod/host/uninstall.sh
# Removes the DOCKER-USER rules, the unit, the script and the sysctl file; sets ip_nonlocal_bind
# back to 0 and Tailscale's SNAT back on (its default). Stop Caddy and the DNS container FIRST
# (`docker compose -p ayvo-prod stop caddy dns`): without the guard their ports would no longer be
# filtered on the public interface. UFW and SSH are not touched. The backups in
# /var/backups/ayvo-prod-host stay (iptables-restore can bring back an exact earlier state).
set -Eeuo pipefail
[[ $(id -u) == 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
if docker ps --format '{{.Names}}' | grep -qE '^ayvo-prod-(caddy|dns)-'; then
  echo "ayvo-prod caddy/dns are still running: stop them first (docker compose -p ayvo-prod stop caddy dns)" >&2
  exit 1
fi
systemctl disable --now ayvo-prod-docker-guard.service 2>/dev/null || true
[[ ! -x /usr/local/sbin/ayvo-prod-docker-guard ]] || /usr/local/sbin/ayvo-prod-docker-guard remove
rm -f /etc/systemd/system/ayvo-prod-docker-guard.service /usr/local/sbin/ayvo-prod-docker-guard \
  /etc/sysctl.d/60-ayvo-prod-tailnet.conf
systemctl daemon-reload
sysctl -w net.ipv4.ip_nonlocal_bind=0
tailscale set --snat-subnet-routes=true
echo "guard removed"
