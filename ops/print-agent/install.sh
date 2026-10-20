#!/usr/bin/env bash
# AYVO print agent — install or update on an EXISTING Raspberry Pi OS (doc 030). Repeatable: a
# second run updates the code and the unit and keeps the configuration and the secrets.
# Run from this directory, after preflight.sh passed:
#   sudo bash install.sh --api-base https://dev.ayvo.co/api [--basic-auth-user USER] \
#                        [--set-token] [--set-basic-auth-password]
# Secrets (the agent token, the DEV Basic Auth password) are read from the terminal without echo
# and written only to files of mode 600 owned by the service user — never to argv, the shell
# history, the log or git. Nothing else on the system is changed: no packages, no reboot, no
# formatting, no network or Tailscale changes.
set -euo pipefail
umask 077

API_BASE="https://dev.ayvo.co/api"
BASIC_USER=""
SET_TOKEN=0
SET_PASSWORD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-base) API_BASE="$2"; shift 2 ;;
    --basic-auth-user) BASIC_USER="$2"; shift 2 ;;
    --set-token) SET_TOKEN=1; shift ;;
    --set-basic-auth-password) SET_PASSWORD=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
[[ "$API_BASE" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/api$ ]] || { echo "--api-base must be https://<host>/api" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$HERE/ayvo_print_agent/agent.py" ]] || { echo "run from ops/print-agent" >&2; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "python3 ≥ 3.9 needed" >&2; exit 1; }

USER_NAME=ayvo-print
PREFIX=/opt/ayvo-print-agent
ETC=/etc/ayvo-print-agent
STATE=/var/lib/ayvo-print-agent

step() { printf '==> %s\n' "$*"; }

step "service user $USER_NAME (no login, no home) in group lp"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$USER_NAME"
fi
usermod -a -G lp "$USER_NAME"

step "code → $PREFIX (replaced as a whole)"
install -d -m 755 "$PREFIX"
tmp="$(mktemp -d "$PREFIX/.new.XXXXXX")"
cp -r "$HERE/ayvo_print_agent" "$tmp/"
find "$tmp" -name '__pycache__' -prune -exec rm -rf {} +
chmod -R a+rX,go-w "$tmp"
rm -rf "$PREFIX/ayvo_print_agent.old"
[[ -d "$PREFIX/ayvo_print_agent" ]] && mv "$PREFIX/ayvo_print_agent" "$PREFIX/ayvo_print_agent.old"
mv "$tmp/ayvo_print_agent" "$PREFIX/ayvo_print_agent"
rmdir "$tmp"
rm -rf "$PREFIX/ayvo_print_agent.old"

step "configuration in $ETC"
install -d -m 750 -o root -g "$USER_NAME" "$ETC"
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$STATE"
secret() { # $1 = file, $2 = prompt; reads without echo, writes mode 600 owned by the service user
  local value
  read -r -s -p "$2: " value </dev/tty
  printf '\n'
  [[ -n "$value" ]] || { echo "empty — nothing written" >&2; exit 1; }
  install -m 600 -o "$USER_NAME" -g "$USER_NAME" /dev/null "$1"
  printf '%s\n' "$value" >"$1"
  unset value
}
if [[ ! -s "$ETC/token" || $SET_TOKEN -eq 1 ]]; then
  echo "Paste the print agent token from AYVO OS (Provozovna → Tiskárny; shown once)."
  secret "$ETC/token" "Agent token"
fi
grep -qE '^ayvo_pa_[A-Za-z0-9_-]{43}$' "$ETC/token" || { echo "$ETC/token is not an agent token" >&2; exit 1; }
if [[ -n "$BASIC_USER" && (! -s "$ETC/basic-auth-password" || $SET_PASSWORD -eq 1) ]]; then
  secret "$ETC/basic-auth-password" "DEV Basic Auth password for $BASIC_USER"
fi
if [[ ! -f "$ETC/config.json" || -n "$BASIC_USER" ]]; then
  python3 - "$ETC/config.json" "$API_BASE" "$BASIC_USER" "$ETC" "$STATE" <<'PY'
import json, sys
path, base, user, etc, state = sys.argv[1:]
config = {"api_base": base, "token_file": f"{etc}/token", "journal_dir": state,
          "poll_seconds": 3, "heartbeat_seconds": 30}
if user:
    config["basic_auth_user"] = user
    config["basic_auth_password_file"] = f"{etc}/basic-auth-password"
with open(path, "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2)
PY
fi
chown root:"$USER_NAME" "$ETC/config.json"
chmod 640 "$ETC/config.json"

step "systemd unit (runs as $USER_NAME, restarts on failure and after reboot)"
install -m 644 "$HERE/systemd/ayvo-print-agent.service" /etc/systemd/system/ayvo-print-agent.service
systemctl daemon-reload
systemctl enable ayvo-print-agent.service >/dev/null
systemctl restart ayvo-print-agent.service
sleep 3
systemctl --no-pager --lines=0 status ayvo-print-agent.service || true
echo
echo "Log: journalctl -u ayvo-print-agent -f   (never shows the token)"
echo 'In AYVO OS the agent should now show "Ozval se" and the printer "Připravena".'
