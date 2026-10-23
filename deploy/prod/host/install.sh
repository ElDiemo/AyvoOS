#!/usr/bin/env bash
# AYVO OS — install the PROD host guard (doc 036 §3). Run as root on AyvoOS-PROD only, after
# Docker and Tailscale are installed and BEFORE the first `scripts/deploy-prod.sh`:
#   sudo bash deploy/prod/host/install.sh --check   # verifies the prerequisites, changes nothing
#   sudo bash deploy/prod/host/install.sh           # installs
# Backs up the current firewall state, sysctl and Tailscale prefs first (/var/backups/ayvo-prod-
# host/<time>), then installs the sysctl (ip_nonlocal_bind), /usr/local/sbin/ayvo-prod-docker-guard
# and its systemd unit (enabled, applied now and on every Docker start), and turns Tailscale's SNAT
# of forwarded traffic off — only after checking that this node shares no subnet routes, is no exit
# node, and no Docker network overlaps the tailnet's 100.64.0.0/10. It never touches UFW, SSH
# (public SSH stays as the fallback), other Tailscale settings or any container.
# Idempotent. Undo: sudo bash deploy/prod/host/uninstall.sh
set -Eeuo pipefail
umask 022
[[ $(id -u) == 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_ONLY=false
[[ ${1:-} == --check ]] && CHECK_ONLY=true
fail() { echo "install.sh: $*" >&2; exit 1; }

for cmd in docker tailscale iptables ip6tables iptables-save ip6tables-save jq sysctl systemctl ip; do
  command -v "$cmd" >/dev/null || fail "$cmd is missing"
done
systemctl is-active --quiet docker || fail "Docker is not running"
ts4="$(tailscale ip -4 2>/dev/null | head -n1)"
[[ $ts4 =~ ^100\. ]] || fail "no Tailscale IPv4 address (tailscale status)"
prefs="$(tailscale debug prefs)"
routes="$(jq -c '.AdvertiseRoutes // []' <<<"$prefs")"
[[ $routes == '[]' ]] ||
  fail "this node shares subnet routes $routes: SNAT would matter for them — not changing it"
# Docker networks inside Tailscale's range would make tailnet peers and containers ambiguous.
while read -r subnet; do
  [[ -z $subnet || ! $subnet =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]] ||
    fail "Docker network $subnet overlaps the tailnet range 100.64.0.0/10"
done < <(docker network inspect $(docker network ls -q) --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n')
ext="$(ip -4 route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')"
[[ -n $ext && $ext != tailscale0 ]] || fail "the default route must use the public interface (now: '${ext:-none}')"
echo "prerequisites OK: tailnet $ts4, public interface $ext, no shared subnet routes, no overlapping Docker network"
echo "current: NoSNAT=$(jq -r .NoSNAT <<<"$prefs"), ip_nonlocal_bind=$(sysctl -n net.ipv4.ip_nonlocal_bind)"
$CHECK_ONLY && exit 0

BACKUP="/var/backups/ayvo-prod-host/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP"
chmod 700 "$BACKUP"
iptables-save >"$BACKUP/iptables.rules"
ip6tables-save >"$BACKUP/ip6tables.rules"
sysctl net.ipv4.ip_nonlocal_bind >"$BACKUP/sysctl.txt"
printf '%s\n' "$prefs" >"$BACKUP/tailscale-prefs.json"
for f in /etc/sysctl.d/60-ayvo-prod-tailnet.conf /usr/local/sbin/ayvo-prod-docker-guard \
  /etc/systemd/system/ayvo-prod-docker-guard.service; do
  [[ ! -e $f ]] || cp -a "$f" "$BACKUP/"
done
echo "backup: $BACKUP"

install -m 644 "$HERE/60-ayvo-prod-tailnet.conf" /etc/sysctl.d/60-ayvo-prod-tailnet.conf
sysctl -q -p /etc/sysctl.d/60-ayvo-prod-tailnet.conf
install -m 755 "$HERE/ayvo-prod-docker-guard" /usr/local/sbin/ayvo-prod-docker-guard
install -m 644 "$HERE/ayvo-prod-docker-guard.service" /etc/systemd/system/ayvo-prod-docker-guard.service
systemctl daemon-reload
systemctl enable ayvo-prod-docker-guard.service
systemctl restart ayvo-prod-docker-guard.service
tailscale set --snat-subnet-routes=false

echo
sysctl net.ipv4.ip_nonlocal_bind
systemctl is-active ayvo-prod-docker-guard.service
/usr/local/sbin/ayvo-prod-docker-guard status
echo "tailscale NoSNAT: $(tailscale debug prefs | jq -r .NoSNAT)"
echo "Next: the negative test FROM OUTSIDE the tailnet (doc 036 §5) — a test from this server is no proof."
