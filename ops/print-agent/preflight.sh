#!/usr/bin/env bash
# AYVO print agent — pre-flight check of an EXISTING Raspberry Pi OS (doc 030). Read-only: changes
# nothing, installs nothing, needs no secret. Run as the normal user (sudo not needed):
#   bash preflight.sh [https://dev.ayvo.co/api]
# Prints what it found and ends with "PREFLIGHT OK" or the list of problems.
set -uo pipefail

API_BASE="${1:-https://dev.ayvo.co/api}"
# Overridable only for the agent's own tests (a fake sysfs); never needed on a Raspberry Pi.
USBMISC="${AYVO_PREFLIGHT_USBMISC:-/sys/class/usbmisc}"
HOST="$(printf '%s' "$API_BASE" | sed -E 's#^https://([^/:]+).*#\1#')"
problems=()
ok() { printf '  ok    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
bad() {
  printf '  FAIL  %s\n' "$*"
  problems+=("$*")
}

echo "== System"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  (. /etc/os-release && ok "OS: ${PRETTY_NAME:-unknown}")
else
  warn "no /etc/os-release"
fi
[[ -r /proc/device-tree/model ]] && ok "Hardware: $(tr -d '\0' </proc/device-tree/model)"
ok "Architecture: $(uname -m), kernel $(uname -r)"
if command -v systemctl >/dev/null; then ok "systemd present"; else bad "systemd missing"; fi
if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -qx yes; then
  ok "clock synchronised (needed for TLS)"
else
  warn "clock not reported as synchronised (TLS may fail): timedatectl"
fi
ok "free disk on /: $(df -h / | awk 'NR==2 {print $4}')"

echo "== Python"
if command -v python3 >/dev/null; then
  ver="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  if python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
    ok "python3 $ver (needs ≥ 3.9; tested with 3.12)"
  else
    bad "python3 $ver is too old (needs ≥ 3.9)"
  fi
else
  bad "python3 missing"
fi

echo "== Tailscale and the AYVO server"
if command -v tailscale >/dev/null; then
  if tailscale status >/dev/null 2>&1; then
    ok "tailscale up, this device: $(tailscale ip -4 2>/dev/null | head -1)"
  else
    bad "tailscale installed but not connected (tailscale status)"
  fi
else
  bad "tailscale missing — the server is reachable only through the tailnet"
fi
addr="$(getent hosts "$HOST" | awk '{print $1}' | head -1)"
if [[ "$addr" =~ ^100\. ]]; then
  ok "$HOST resolves to $addr (tailnet)"
elif [[ -n "$addr" ]]; then
  bad "$HOST resolves to $addr — not a tailnet address (MagicDNS / split DNS for $HOST?)"
else
  bad "$HOST does not resolve"
fi
if command -v curl >/dev/null; then
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$API_BASE/health" 2>/dev/null || true)"
  case "$code" in
    401) ok "$API_BASE/health answers 401 (reachable; Basic Auth required — expected on DEV)" ;;
    200) ok "$API_BASE/health answers 200 (reachable)" ;;
    *) bad "$API_BASE/health not reachable (HTTP '${code:-none}')" ;;
  esac
else
  warn "curl missing — reachability not checked (the agent itself needs only python3)"
fi

echo "== USB printer (Zebra)"
if command -v lsusb >/dev/null; then
  zebra="$(lsusb | grep -i ' 0a5f:' || true)"
  if [[ -n "$zebra" ]]; then ok "Zebra on USB: $zebra"; else bad "no Zebra (USB vendor 0a5f) found by lsusb"; fi
else
  warn "lsusb missing (package usbutils) — checking sysfs only"
fi
if lsmod 2>/dev/null | grep -q '^usblp'; then ok "kernel module usblp loaded"; else warn "usblp not loaded (it loads when the printer is plugged in)"; fi
found=0
for lp in "$USBMISC"/lp*; do
  [[ -e "$lp" ]] || continue
  found=1
  name="$(basename "$lp")"
  serial="$(cat "$lp/device/../serial" 2>/dev/null || echo '?')"
  product="$(cat "$lp/device/../product" 2>/dev/null || echo '?')"
  dev="/dev/usb/$name"
  perm="$(stat -c '%U:%G %a' "$dev" 2>/dev/null || echo 'missing')"
  ok "$name: product '$product', USB serial '$serial', device $dev ($perm)"
done
[[ $found -eq 1 ]] || bad "no USB printer device in $USBMISC (printer off or unplugged?)"
if command -v lpstat >/dev/null && lpstat -v 2>/dev/null | grep -qi 'usb://Zebra'; then
  # PRINT38-R4: no USB device may have been found above — never refer to one here.
  warn "CUPS has a queue for the Zebra — it may hold the printer; the agent writes to /dev/usb/lpN directly (CUPS is left as it is)"
fi

echo "== Existing agent installation"
if id ayvo-print >/dev/null 2>&1; then ok "user ayvo-print exists (groups: $(id -nG ayvo-print))"; else ok "user ayvo-print not yet created"; fi
if systemctl list-unit-files ayvo-print-agent.service >/dev/null 2>&1 &&
  systemctl list-unit-files ayvo-print-agent.service | grep -q ayvo-print-agent; then
  ok "service ayvo-print-agent: $(systemctl is-active ayvo-print-agent 2>/dev/null)"
else
  ok "service ayvo-print-agent not installed yet"
fi

echo
if [[ ${#problems[@]} -eq 0 ]]; then
  echo "PREFLIGHT OK — note the USB serial of the Zebra above for AYVO OS (Provozovna → Tiskárny)."
else
  echo "PREFLIGHT: ${#problems[@]} problem(s):"
  printf '  - %s\n' "${problems[@]}"
  exit 1
fi
