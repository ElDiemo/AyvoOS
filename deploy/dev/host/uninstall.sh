#!/usr/bin/env bash
# AYVO OS — remove the DEV host guard (ADR 0026 rollback). Run as root:
#   sudo bash deploy/dev/host/uninstall.sh
# Removes the DOCKER-USER guard rules, the unit, the script and the sysctl file, and sets
# net.ipv4.ip_nonlocal_bind back to 0. Run it only AFTER Caddy no longer binds the tailnet address
# (see the rollback in docs/adr/0026-dev-preview-tailnet-only.md), never before.
set -Eeuo pipefail
[[ $(id -u) == 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
systemctl disable --now ayvo-dev-docker-guard.service 2>/dev/null || true
[[ ! -x /usr/local/sbin/ayvo-dev-docker-guard ]] || /usr/local/sbin/ayvo-dev-docker-guard remove
rm -f /etc/systemd/system/ayvo-dev-docker-guard.service /usr/local/sbin/ayvo-dev-docker-guard \
  /etc/sysctl.d/60-ayvo-dev-tailnet.conf
systemctl daemon-reload
sysctl -w net.ipv4.ip_nonlocal_bind=0
echo "guard removed"
