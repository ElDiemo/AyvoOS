#!/usr/bin/env bash
# AYVO OS — deploy the DEV preview (https://dev.ayvo.co) on THIS server. See ADR 0013, ADR 0026.
#
# DEV ONLY (ADR 0008). Manual deployment; there is no CI/CD.
#
# Usage:
#   scripts/deploy-dev.sh                  build images, back up the DB, migrate, start, verify
#   scripts/deploy-dev.sh --check          validate the env file (incl. the WorkOS issuer against the
#                                          client's discovery document) and Compose config; change nothing
#   scripts/deploy-dev.sh --rollback TAG   start previously built images TAG (no build, no migration)
#   scripts/deploy-dev.sh --edge           recreate only Caddy and the private DNS with the RUNNING
#                                          image tag (no build, no migration, no database step), verify
#
# Before anything changes, the running Caddy is backed up exactly as it runs
# (scripts/dev-edge-backup.sh, into AYVO_DEV_BACKUP_DIR/edge-before-<time>-*); if that fails, nothing
# is switched. Restore it, also after a partly failed run:
#   scripts/dev-edge-backup.sh restore <that directory> /opt/ayvo/secrets/dev-preview.env
#   scripts/deploy-dev.sh --help
#
# Environment (all optional):
#   AYVO_DEV_ENV_FILE     server-only env file  (default /opt/ayvo/secrets/dev-preview.env, mode 600)
#   AYVO_DEV_BACKUP_DIR   pre-migration dumps   (default /opt/ayvo/backups/dev-preview)
#   AYVO_DEV_STATE_DIR    deployment log + lock (default /opt/ayvo/logs)
#
# Authenticated verification (required for deploy and rollback):
#   The Basic Auth USER is always DEV_BASIC_AUTH_USER from the env file. Only the PASSWORD is
#   supplied, read once before anything changes, from the first of:
#   AYVO_DEV_VERIFY_PASSWORD_FILE  file holding the password (first line; owned by you, mode 600,
#                                  outside the repo) — e.g. a temporary file deleted afterwards
#   AYVO_DEV_VERIFY_PASSWORD       the password itself, e.g. without shell history:
#                                    read -rsp 'Preview password: ' p; echo
#                                    AYVO_DEV_VERIFY_PASSWORD="$p" scripts/deploy-dev.sh; unset p
#   an interactive prompt on the terminal (no echo)
#   The password is passed to curl on stdin only (never argv, never logged) and the variables are
#   removed from the environment of every child process.
#
# Safety guarantees:
#   - Never runs `docker compose down`, `down -v`, `volume rm` or any prune: data volumes survive.
#   - Migrations use `prisma migrate deploy` only, after a pg_dump of the current database.
#   - Any failure stops the script immediately with a clear report; nothing is cleaned up silently.
#   - Tailnet only (ADR 0026): ports are bound to the server's Tailscale IPv4 address, read from
#     `tailscale ip -4` on every run. Without Tailscale, or without the host guard
#     (deploy/dev/host/install.sh), the script stops — it never falls back to a public binding.

set -Eeuo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly DEPLOY_DIR="$REPO_ROOT/deploy/dev"
readonly COMPOSE_FILE="$DEPLOY_DIR/compose.yml"
readonly ENV_FILE="${AYVO_DEV_ENV_FILE:-/opt/ayvo/secrets/dev-preview.env}"
readonly BACKUP_DIR="${AYVO_DEV_BACKUP_DIR:-/opt/ayvo/backups/dev-preview}"
readonly STATE_DIR="${AYVO_DEV_STATE_DIR:-/opt/ayvo/logs}"
readonly DEPLOY_LOG="$STATE_DIR/deployments-dev-preview.log"
readonly IMAGE_PREFIX="ayvo-dev-preview"
readonly PROJECT="ayvo-dev-preview"
readonly GUARD_UNIT="ayvo-dev-docker-guard.service"
# The only endpoint trusted for the WorkOS discovery document (doc 021 §9); never configurable.
readonly WORKOS_API_ORIGIN="https://api.workos.com"
readonly REQUIRED_VARS=(APP_ENV DEV_DOMAIN ACME_EMAIL DEV_BASIC_AUTH_USER DEV_BASIC_AUTH_HASH
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB WORKOS_API_KEY WORKOS_CLIENT_ID
  WORKOS_JWT_ISSUER)

MODE=deploy
TAG=""
STEP="startup"
VERIFY_PASSWORD=""
EDGE_BODY=""
TAILNET_IPV4=""
EDGE_BACKUP=""

# --- output ------------------------------------------------------------------------------------

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31mERROR\033[0m %s\n' "$*" >&2
  exit 1
}

usage() { awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"; }

# --- failure report ----------------------------------------------------------------------------

last_good_tag() {
  [[ -f $DEPLOY_LOG ]] || return 0
  awk '$2 == "SUCCESS" || $2 == "OK" { for (i = 3; i <= NF; i++) if ($i ~ /^tag=/) t = substr($i, 5) } END { if (t) print t }' "$DEPLOY_LOG"
}

on_exit() {
  local code=$?
  [[ -z $EDGE_BODY ]] || rm -f "$EDGE_BODY"
  [[ $code -eq 0 || $MODE == check ]] && return
  set +e
  trap - ERR
  printf '\n\033[1;31m=== DEV DEPLOYMENT FAILED (exit %s) during: %s ===\033[0m\n' "$code" "$STEP" >&2
  if [[ $STEP != startup && $STEP != validate* ]]; then
    printf '\n--- container status ---\n' >&2
    compose ps --all >&2
    printf '\n--- recent logs (api, web, caddy) ---\n' >&2
    compose logs --no-color --tail 40 api web caddy >&2
    [[ -n $TAG ]] && record "FAILED" "step=${STEP// /_}"
  fi
  local good
  good="$(last_good_tag)"
  printf '\nDatabase and other data volumes were NOT touched.\n' >&2
  if [[ -n $EDGE_BACKUP ]]; then
    printf 'Edge (Caddy) before this run: %s\nRestore it: scripts/dev-edge-backup.sh restore %s %s\n' \
      "$EDGE_BACKUP" "$EDGE_BACKUP" "$ENV_FILE" >&2
  fi
  if [[ -n $good ]]; then
    printf 'Last successful deployment: %s\nRollback: scripts/deploy-dev.sh --rollback %s\n' "$good" "$good" >&2
  fi
  printf 'If migrations already ran, see the rollback notes in docs/013-infrastructure.md.\n' >&2
}
trap on_exit EXIT
trap 'STEP="$STEP (line $LINENO: $BASH_COMMAND)"' ERR

# --- helpers -----------------------------------------------------------------------------------

compose() {
  docker compose --project-directory "$DEPLOY_DIR" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

record() {
  mkdir -p "$STATE_DIR"
  printf '%s %s tag=%s git=%s %s\n' "$(date -u +%FT%TZ)" "$1" "$TAG" \
    "$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)" "${2:-}" >>"$DEPLOY_LOG"
}

# Retry "$@" every 5 s until it succeeds or $1 seconds pass.
retry() {
  local timeout=$1 start=$SECONDS
  shift
  until "$@"; do
    ((SECONDS - start >= timeout)) && return 1
    sleep 5
  done
}

# --- env file ----------------------------------------------------------------------------------

declare -A CFG=()

# Parses the env file without executing it (it is never `source`d). Supported syntax, a subset
# that Docker Compose reads identically: KEY=value, KEY='value', KEY="value", # comments.
parse_env_file() {
  local line key value n=0
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] ||
      die "$ENV_FILE:$n: expected KEY=VALUE (no 'export', no spaces around '=')"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ $value =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    elif [[ $value =~ ^\"(.*)\"$ ]]; then
      value="${BASH_REMATCH[1]}"
      [[ $value != *'$'* ]] || die "$ENV_FILE:$n: $key contains '\$': use single quotes, not double quotes"
    else
      [[ $value != *'$'* ]] || die "$ENV_FILE:$n: $key contains '\$': wrap the value in single quotes"
      [[ $value != *[[:space:]]* ]] || die "$ENV_FILE:$n: $key contains whitespace: quote it (inline comments are not supported)"
    fi
    CFG[$key]="$value"
  done <"$ENV_FILE"
}

check_env_file_location() {
  [[ -f $ENV_FILE ]] || die "env file not found: $ENV_FILE (create it from the DEV preview section of .env.example; see docs/013-infrastructure.md)"
  local real perms owner
  real="$(realpath "$ENV_FILE")"
  [[ $real != "$REPO_ROOT"/* ]] || die "env file must live outside the repository (it holds secrets): $real"
  owner="$(stat -c '%u' "$real")"
  perms="$(stat -c '%a' "$real")"
  [[ $owner == "$(id -u)" ]] || die "env file must be owned by $(id -un): $real"
  [[ $perms =~ ^[0-7]00$ ]] || die "env file must not be readable by group/others (chmod 600 $real); current mode $perms"
}

validate_env() {
  local var missing=()
  for var in "${REQUIRED_VARS[@]}"; do
    [[ -n ${CFG[$var]:-} ]] || missing+=("$var")
  done
  ((${#missing[@]} == 0)) || die "missing required variables in $ENV_FILE: ${missing[*]}"

  [[ ${CFG[APP_ENV]} == development ]] ||
    die "APP_ENV must be 'development' on this DEV-only server (got '${CFG[APP_ENV]}'); see ADR 0008"
  [[ ${CFG[DEV_DOMAIN]} =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] ||
    die "DEV_DOMAIN is not a valid hostname: ${CFG[DEV_DOMAIN]}"
  [[ ${CFG[ACME_EMAIL]} =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$ ]] ||
    die "ACME_EMAIL is not a valid email address"
  [[ ! ${CFG[ACME_EMAIL]} =~ @example\.(com|org|net)$ ]] || die "ACME_EMAIL is still the placeholder"
  [[ ${CFG[DEV_BASIC_AUTH_USER]} =~ ^[A-Za-z0-9._-]{3,64}$ ]] ||
    die "DEV_BASIC_AUTH_USER must be 3-64 characters of [A-Za-z0-9._-]"
  [[ ${CFG[DEV_BASIC_AUTH_USER]} != replace-me ]] || die "DEV_BASIC_AUTH_USER is still the placeholder"
  [[ ${CFG[DEV_BASIC_AUTH_HASH]} =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] ||
    die "DEV_BASIC_AUTH_HASH must be a bcrypt hash from 'caddy hash-password', in single quotes"
  [[ ${CFG[POSTGRES_USER]} =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "POSTGRES_USER must match [a-z_][a-z0-9_]*"
  # Identity provider (ADR 0022, doc 021). Values are never printed.
  [[ ${CFG[WORKOS_API_KEY]} =~ ^sk_[A-Za-z0-9_]{10,}$ ]] ||
    die "WORKOS_API_KEY must be a WorkOS API key (sk_…) from the WorkOS dashboard (doc 021)"
  [[ ${CFG[WORKOS_CLIENT_ID]} =~ ^client_[A-Za-z0-9]{10,}$ ]] ||
    die "WORKOS_CLIENT_ID must be a WorkOS client id (client_…) from the WorkOS dashboard (doc 021)"
  [[ ${CFG[WORKOS_JWT_ISSUER]} =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$ ]] ||
    die "WORKOS_JWT_ISSUER must be the exact https issuer of WorkOS access tokens (doc 021)"
  [[ ${CFG[POSTGRES_DB]} =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "POSTGRES_DB must match [a-z_][a-z0-9_]*"
  # Embedded in DATABASE_URL, so restricted to URL-safe characters (e.g. `openssl rand -hex 32`).
  [[ ${CFG[POSTGRES_PASSWORD]} =~ ^[A-Za-z0-9_-]{24,}$ ]] ||
    die "POSTGRES_PASSWORD must be at least 24 characters of [A-Za-z0-9_-] (try: openssl rand -hex 32)"
  [[ ${CFG[POSTGRES_PASSWORD]} != *change-me* ]] || die "POSTGRES_PASSWORD is still the placeholder"
}

# WORKOS_JWT_ISSUER must be exactly the `issuer` of the client's OIDC discovery document — the `iss`
# of the access tokens the API verifies (doc 021 §9). A generic WorkOS address passes the format
# check but makes every sign-in fail. The client id is already validated (no quoting issues); the
# URL goes to curl on stdin, and neither the client id, the issuer nor the document is printed.
check_workos_issuer() {
  local doc issuer
  doc="$(printf 'url = "%s/user_management/%s/.well-known/openid-configuration"\n' \
    "$WORKOS_API_ORIGIN" "${CFG[WORKOS_CLIENT_ID]}" |
    curl -fsS --proto =https --max-redirs 0 --max-time 15 --max-filesize 65536 --config - 2>/dev/null)" ||
    die "WORKOS_JWT_ISSUER cannot be verified: the WorkOS discovery document for WORKOS_CLIENT_ID could not be fetched (network or HTTP error; doc 021 §9)"
  issuer="$(jq -er 'if type == "object" and (.issuer | type) == "string" then .issuer else empty end' \
    <<<"$doc" 2>/dev/null)" ||
    die "WORKOS_JWT_ISSUER cannot be verified: the WorkOS discovery document is not valid JSON or has no issuer (doc 021 §9)"
  [[ $issuer =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$ ]] ||
    die "WORKOS_JWT_ISSUER cannot be verified: the discovery issuer is not an https URL without query or fragment (doc 021 §9)"
  [[ ${CFG[WORKOS_JWT_ISSUER]} == "$issuer" ]] ||
    die "WORKOS_JWT_ISSUER does not exactly match the issuer of the client's WorkOS discovery document; copy the 'issuer' value from https://api.workos.com/user_management/<WORKOS_CLIENT_ID>/.well-known/openid-configuration (doc 021 §9)"
}

# --- verification credentials ------------------------------------------------------------------

# Reads the Basic Auth password for the authenticated checks into VERIFY_PASSWORD (never exported)
# and removes the input variables from the environment, so no child process inherits them.
load_verify_password() {
  local file=${AYVO_DEV_VERIFY_PASSWORD_FILE:-} from_env=${AYVO_DEV_VERIFY_PASSWORD:-}
  local legacy=${AYVO_DEV_VERIFY_AUTH:+set}
  unset AYVO_DEV_VERIFY_PASSWORD AYVO_DEV_VERIFY_PASSWORD_FILE AYVO_DEV_VERIFY_AUTH
  [[ -z $legacy ]] ||
    die "AYVO_DEV_VERIFY_AUTH (\"user:password\") is no longer supported: the user is always DEV_BASIC_AUTH_USER from the env file; pass only the password (see --help)"

  if [[ -n $file ]]; then
    [[ -f $file ]] || die "AYVO_DEV_VERIFY_PASSWORD_FILE not found: $file"
    local real
    real="$(realpath "$file")"
    [[ $real != "$REPO_ROOT"/* ]] || die "AYVO_DEV_VERIFY_PASSWORD_FILE must live outside the repository: $real"
    [[ $(stat -c '%u' "$real") == "$(id -u)" ]] || die "AYVO_DEV_VERIFY_PASSWORD_FILE must be owned by $(id -un): $real"
    [[ $(stat -c '%a' "$real") =~ ^[0-7]00$ ]] || die "AYVO_DEV_VERIFY_PASSWORD_FILE must be mode 600: $real"
    IFS= read -r VERIFY_PASSWORD <"$real" || [[ -n $VERIFY_PASSWORD ]] || die "AYVO_DEV_VERIFY_PASSWORD_FILE is empty: $real"
    VERIFY_PASSWORD=${VERIFY_PASSWORD%$'\r'}
  elif [[ -n $from_env ]]; then
    VERIFY_PASSWORD=$from_env
  elif { : </dev/tty; } 2>/dev/null; then
    IFS= read -rsp "Basic Auth password for ${CFG[DEV_BASIC_AUTH_USER]}@${CFG[DEV_DOMAIN]} (for verification): " VERIFY_PASSWORD </dev/tty
    printf '\n' >&2
  else
    die "authenticated verification needs the Basic Auth password: set AYVO_DEV_VERIFY_PASSWORD_FILE or AYVO_DEV_VERIFY_PASSWORD, or run from a terminal (see --help)"
  fi
  [[ -n $VERIFY_PASSWORD ]] || die "the Basic Auth verification password is empty"
}

# --- verification ------------------------------------------------------------------------------

api_ready() {
  compose exec -T api node -e "
    fetch('http://127.0.0.1:4000/api/health')
      .then((r) => r.json())
      .then((b) => { console.log(JSON.stringify(b)); process.exit(b.status === 'ok' ? 0 : 1); },
            () => process.exit(1));"
}

# Requests through the Caddy endpoint on this host's Tailscale address (real hostname, SNI and
# certificate; the source address is this server's tailnet address, so Caddy admits it).
# Sets EDGE_STATUS, EDGE_ROBOTS (X-Robots-Tag), EDGE_LOCATION and EDGE_TYPE; the body is written
# to $EDGE_BODY. With a second argument "auth" it sends Basic Auth as DEV_BASIC_AUTH_USER plus
# VERIFY_PASSWORD through a curl config read from stdin, so the password never appears in argv,
# the environment or any output. curl config strings are double-quoted: escape \ and ".
edge() {
  local url=$1 auth=${2:-} meta pass
  local args=(--silent --show-error --max-time 10 --output "$EDGE_BODY"
    --resolve "${CFG[DEV_DOMAIN]}:443:$TAILNET_IPV4" --resolve "${CFG[DEV_DOMAIN]}:80:$TAILNET_IPV4"
    --write-out '%{http_code}\n%header{x-robots-tag}\n%header{location}\n%{content_type}\n')
  : >"$EDGE_BODY"
  if [[ $auth == auth ]]; then
    pass=${VERIFY_PASSWORD//\\/\\\\}
    pass=${pass//\"/\\\"}
    meta="$(printf 'user = "%s:%s"\n' "${CFG[DEV_BASIC_AUTH_USER]}" "$pass" | curl "${args[@]}" --config - "$url")" ||
      return 1
  else
    meta="$(curl "${args[@]}" "$url")" || return 1
  fi
  local lines
  mapfile -t lines <<<"$meta"
  EDGE_STATUS=${lines[0]:-} EDGE_ROBOTS=${lines[1]:-} EDGE_LOCATION=${lines[2]:-} EDGE_TYPE=${lines[3]:-}
}

# expect_edge DESC URL STATUS [auth] — the status must match and X-Robots-Tag must carry
# noindex and nofollow (Caddy sets it on every response of the site, including 401s).
expect_edge() {
  local desc=$1 url=$2 want=$3 auth=${4:-}
  edge "$url" "$auth" || {
    warn "$desc: request to $url failed"
    return 1
  }
  if [[ $auth == auth && $EDGE_STATUS == 401 ]]; then
    warn "$desc: Basic Auth credentials were rejected (401) for user '${CFG[DEV_BASIC_AUTH_USER]}' (DEV_BASIC_AUTH_USER). The password does not match DEV_BASIC_AUTH_HASH."
    return 1
  fi
  if [[ $EDGE_STATUS != "$want" ]]; then
    warn "$desc: expected HTTP $want, got HTTP $EDGE_STATUS"
    return 1
  fi
  if [[ $EDGE_ROBOTS != *noindex* || $EDGE_ROBOTS != *nofollow* ]]; then
    warn "$desc: X-Robots-Tag must include noindex and nofollow, got '$EDGE_ROBOTS'"
    return 1
  fi
  ok "$desc -> $EDGE_STATUS, X-Robots-Tag: $EDGE_ROBOTS"
}

# --- tailnet only (ADR 0026) ---------------------------------------------------------------------

# The server's Tailscale IPv4 address, from tailscaled itself; it must be inside Tailscale's
# 100.64.0.0/10 and present on tailscale0. Never configurable, never a fallback.
tailnet_address() {
  local ip
  ip="$(tailscale ip -4 2>/dev/null | head -n1)" || true
  [[ $ip =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.([0-9]{1,3})\.([0-9]{1,3})$ ]] ||
    die "no Tailscale IPv4 address (is tailscaled running and logged in? 'tailscale status'). The preview is published only on the tailnet (ADR 0026)."
  ip -4 -o addr show dev tailscale0 2>/dev/null | grep -q " inet $ip/" ||
    die "Tailscale address $ip is not on interface tailscale0"
  TAILNET_IPV4=$ip
}

# The root-installed host guard (deploy/dev/host/install.sh): DOCKER-USER rules and the sysctl
# that lets Docker bind the tailnet address at boot. Readable without root.
check_host_guard() {
  systemctl is-active --quiet "$GUARD_UNIT" ||
    die "$GUARD_UNIT is not active. The owner installs it once: sudo bash deploy/dev/host/install.sh (ADR 0026)"
  systemctl is-enabled --quiet "$GUARD_UNIT" || die "$GUARD_UNIT is not enabled (it must survive a reboot)"
  [[ $(sysctl -n net.ipv4.ip_nonlocal_bind 2>/dev/null) == 1 ]] ||
    die "net.ipv4.ip_nonlocal_bind must be 1 (deploy/dev/host/60-ayvo-dev-tailnet.conf)"
}

# The tag of the running api image; web must run the same tag (--edge keeps both untouched).
running_tag() {
  local api web
  api="$(docker inspect --format '{{.Config.Image}}' "$PROJECT-api-1" 2>/dev/null)" || die "the api container is not running; use a normal deployment"
  web="$(docker inspect --format '{{.Config.Image}}' "$PROJECT-web-1" 2>/dev/null)" || die "the web container is not running; use a normal deployment"
  [[ $api == "$IMAGE_PREFIX/api:"* && $web == "$IMAGE_PREFIX/web:${api#"$IMAGE_PREFIX/api:"}" ]] ||
    die "api and web run different images ($api, $web); use a normal deployment"
  printf '%s' "${api#"$IMAGE_PREFIX/api:"}"
}

# Every published port of the project is on the tailnet address, except the public IPv4 :80
# (ACME HTTP-01). Anything else — 0.0.0.0:443, any IPv6, postgres, redis — fails the deployment.
verify_published_ports() {
  local id line bad=()
  local -A allowed=(
    ["caddy $TAILNET_IPV4:443->443/tcp"]=1 ["caddy $TAILNET_IPV4:443->443/udp"]=1
    ["caddy 0.0.0.0:80->80/tcp"]=1
    ["dns $TAILNET_IPV4:53->1053/tcp"]=1 ["dns $TAILNET_IPV4:53->1053/udp"]=1)
  for id in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT"); do
    while IFS= read -r line; do
      [[ -z $line || -n ${allowed[$line]:-} ]] || bad+=("$line")
    done < <(docker inspect "$id" | jq -r '.[0] | .Config.Labels["com.docker.compose.service"] as $s
      | (.NetworkSettings.Ports // {}) | to_entries[] | select(.value != null) | .key as $t
      | .value[] | "\($s) \(.HostIp):\(.HostPort)->\($t)"')
  done
  ((${#bad[@]} == 0)) || die "published ports outside the tailnet rule (ADR 0026): ${bad[*]}"
  ok "published ports: only $TAILNET_IPV4 (443 tcp/udp, 53) and public IPv4 :80 (ACME)"
}

# Local checks of the public side (from this server, so NOT a proof from the internet — the
# owner's test from outside the tailnet is): public IPv4/IPv6 :443 is closed, public :80 aborts
# everything except the challenge directory, and the private DNS answers only DEV_DOMAIN.
verify_tailnet_only() {
  local domain=${CFG[DEV_DOMAIN]} pub4 pub6 code
  pub4="$(ip -4 -o addr show scope global | awk '$2 != "tailscale0" && $2 !~ /^(docker|br-|veth)/ { sub(/\/.*/, "", $4); print $4; exit }')"
  pub6="$(ip -6 -o addr show scope global | awk '$2 != "tailscale0" && $2 !~ /^(docker|br-|veth)/ { sub(/\/.*/, "", $4); print $4; exit }')"
  [[ -n $pub4 ]] || die "cannot determine the public IPv4 address"

  STEP="verify: public IPv4 $pub4 refuses HTTPS"
  log "$STEP"
  code=0
  curl -s -o /dev/null --max-time 5 --resolve "$domain:443:$pub4" "https://$domain/" || code=$?
  [[ $code == 7 || $code == 28 ]] || die "https://$domain via $pub4 must not connect (curl exit $code)"
  ok "https via public IPv4 -> no connection (curl exit $code)"

  STEP="verify: public IPv4 :80 serves only ACME challenges"
  log "$STEP"
  code=0
  curl -s -o /dev/null --max-time 5 --resolve "$domain:80:$pub4" "http://$domain/" || code=$?
  [[ $code == 52 ]] || die "http://$domain/ via $pub4 must be aborted without a response (curl exit $code)"
  code=0
  curl -s -o /dev/null --max-time 5 --resolve "$domain:80:$pub4" "http://$domain/api/health" || code=$?
  [[ $code == 52 ]] || die "http://$domain/api/health via $pub4 must be aborted (curl exit $code)"
  code="$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' --resolve "$domain:80:$pub4" \
    "http://$domain/.well-known/acme-challenge/ayvo-deploy-probe")" || true
  [[ $code == 404 ]] || die "the public ACME challenge path must answer (404 for an unknown token), got '$code'"
  ok "public :80 -> aborted; /.well-known/acme-challenge/ reachable (404 for an unknown token)"

  if [[ -n $pub6 ]]; then
    STEP="verify: public IPv6 $pub6 refuses HTTP and HTTPS"
    log "$STEP"
    for port in 80 443; do
      code=0
      curl -s -o /dev/null --max-time 5 "http://[$pub6]:$port/" || code=$?
      [[ $code == 7 || $code == 28 ]] || die "[$pub6]:$port must not connect (curl exit $code)"
    done
    ok "public IPv6 :80 and :443 -> no connection"
  fi

  STEP="verify: private DNS answers only $domain"
  log "$STEP"
  [[ "$(dig +short +time=3 +tries=1 @"$TAILNET_IPV4" "$domain" A)" == "$TAILNET_IPV4" ]] ||
    die "the private DNS on $TAILNET_IPV4 must answer $domain A $TAILNET_IPV4"
  dig +time=3 +tries=1 @"$TAILNET_IPV4" example.com A | grep -q 'status: REFUSED' ||
    die "the private DNS must refuse other names (it must never be a resolver)"
  ok "dns @$TAILNET_IPV4: $domain -> $TAILNET_IPV4; other names REFUSED"
}

verify() {
  local domain=${CFG[DEV_DOMAIN]} health
  EDGE_BODY="$(mktemp)"

  STEP="verify: API readiness (PostgreSQL + Redis)"
  log "$STEP"
  retry 60 api_ready || die "API health is not 'ok' (PostgreSQL or Redis unreachable from the API)"

  STEP="verify: Caddy upstreams on the internal network"
  log "$STEP"
  compose exec -T caddy wget -q -O /dev/null http://web:3000/ || die "web is not reachable from Caddy"
  compose exec -T caddy wget -q -O /dev/null http://api:4000/api/health || die "api /api/health is not reachable from Caddy"
  ok "caddy -> web:3000/ and api:4000/api/health"

  STEP="verify: public TLS endpoint https://$domain"
  log "$STEP (the first deployment waits for the certificate)"
  retry 180 expect_edge "unauthenticated GET /api/health" "https://$domain/api/health" 401 ||
    die "https://$domain did not answer 401 + X-Robots-Tag. Check DNS for $domain, that ports 80/443 are open, and: docker compose -f deploy/dev/compose.yml logs caddy"
  expect_edge "unauthenticated GET /" "https://$domain/" 401 || die "web route is not protected by Basic Auth"

  STEP="verify: HTTP redirects to HTTPS"
  log "$STEP"
  edge "http://$domain/" || die "request to http://$domain/ failed"
  [[ $EDGE_STATUS =~ ^30[18]$ && $EDGE_LOCATION == "https://$domain/" ]] ||
    die "http://$domain/ must redirect permanently to https://$domain/ (got HTTP $EDGE_STATUS, Location '$EDGE_LOCATION')"
  ok "http://$domain/ -> $EDGE_STATUS $EDGE_LOCATION"

  STEP="verify: web behind Basic Auth and application sign-in"
  log "$STEP (user ${CFG[DEV_BASIC_AUTH_USER]})"
  expect_edge "GET / without an application session" "https://$domain/" 307 auth ||
    die "GET / must redirect to the sign-in page without an application session"
  [[ $EDGE_LOCATION == "/login?next=%2F" || $EDGE_LOCATION == "https://$domain/login?next=%2F" ]] ||
    die "GET / must redirect to /login (got Location '$EDGE_LOCATION')"
  ok "GET / -> sign-in page"
  expect_edge "GET /login" "https://$domain/login" 200 auth || die "the sign-in page is not served"
  if [[ $EDGE_TYPE != text/html* ]] || ! grep -q 'AYVO OS' "$EDGE_BODY"; then
    die "GET /login did not return the AYVO OS web application (Content-Type '$EDGE_TYPE')"
  fi
  ok "GET /login serves the AYVO OS sign-in page ($EDGE_TYPE)"

  STEP="verify: API requires an application session"
  log "$STEP"
  edge "https://$domain/api/auth/me" auth || die "request to /api/auth/me failed"
  [[ $EDGE_STATUS == 401 ]] && jq -e '.code == "UNAUTHENTICATED"' "$EDGE_BODY" >/dev/null ||
    die "GET /api/auth/me must answer 401 UNAUTHENTICATED without a session (got HTTP $EDGE_STATUS)"
  ok "GET /api/auth/me without a session -> 401 UNAUTHENTICATED"

  STEP="verify: authenticated API health"
  log "$STEP"
  expect_edge "GET /api/health" "https://$domain/api/health" 200 auth || die "authenticated API check failed"
  health="$(jq -c '{status, environment, database: .checks.database, redis: .checks.redis}' "$EDGE_BODY" 2>/dev/null)" ||
    die "GET /api/health did not return JSON"
  jq -e '.status == "ok" and .environment == "development" and .database == "up" and .redis == "up"' \
    <<<"$health" >/dev/null || die "GET /api/health is not healthy: $health"
  ok "GET /api/health -> $health"

  STEP="verify: authenticated /api prefix handling"
  log "$STEP"
  expect_edge "GET /api/api/health (prefix not duplicated)" "https://$domain/api/api/health" 404 auth ||
    die "/api prefix handling is wrong"

  STEP="verify: published ports"
  log "$STEP"
  verify_published_ports
  verify_tailnet_only
}

# --- main --------------------------------------------------------------------------------------

while (($#)); do
  case $1 in
    --check) MODE=check ;;
    --edge) MODE=edge ;;
    --rollback)
      MODE=rollback
      TAG=${2:-}
      [[ $TAG =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || die "--rollback needs a valid image tag"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

STEP="validate prerequisites"
for cmd in docker git curl jq awk flock realpath stat tailscale ip systemctl sysctl; do
  command -v "$cmd" >/dev/null || die "required command not found: $cmd"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin is required"

STEP="validate env file"
log "Validating $ENV_FILE"
check_env_file_location
parse_env_file
validate_env
ok "required variables present and valid"
[[ -z ${CFG[DEV_TAILNET_IPV4]:-} ]] ||
  die "remove DEV_TAILNET_IPV4 from $ENV_FILE: it is read from tailscale on every run (ADR 0026)"
check_workos_issuer
ok "WORKOS_JWT_ISSUER matches the client's WorkOS discovery document"

STEP="validate tailnet and host guard"
tailnet_address
export DEV_TAILNET_IPV4="$TAILNET_IPV4"
ok "Tailscale IPv4 $TAILNET_IPV4 on tailscale0"
check_host_guard
ok "$GUARD_UNIT active and enabled; ip_nonlocal_bind=1"

STEP="validate compose config"
export AYVO_IMAGE_TAG="${TAG:-validate}"
compose --profile tools config --quiet || die "deploy/dev/compose.yml is invalid with this env file"
ok "compose config valid"

if [[ $MODE == check ]]; then
  log "Check passed. Nothing was changed."
  exit 0
fi

STEP="validate verification credentials"
load_verify_password
ok "verification password loaded for Basic Auth user ${CFG[DEV_BASIC_AUTH_USER]}"

STEP="validate docker access"
docker info >/dev/null 2>&1 ||
  die "cannot reach the Docker daemon as $(id -un) (is the user in the 'docker' group? re-login after adding)"

mkdir -p "$STATE_DIR" "$BACKUP_DIR"
exec 9>"$STATE_DIR/.deploy-dev-preview.lock"
flock -n 9 || die "another deployment is running (lock: $STATE_DIR/.deploy-dev-preview.lock)"

command -v dig >/dev/null || die "required command not found: dig (verification of the private DNS)"

# The edge exactly as it runs now, verified, BEFORE anything is built, migrated or switched.
STEP="back up the running edge (Caddy)"
if [[ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=caddy")" ]]; then
  log "$STEP"
  EDGE_BACKUP="$("$REPO_ROOT/scripts/dev-edge-backup.sh" backup "$PROJECT" "$BACKUP_DIR" "$ENV_FILE")" ||
    die "the edge backup failed: nothing was changed"
  [[ -f $EDGE_BACKUP/COMPLETE ]] || die "the edge backup is incomplete: nothing was changed"
  ok "edge backup: $EDGE_BACKUP"
elif [[ $MODE == edge ]]; then
  die "no running caddy to back up; --edge needs the running stack (use a normal deployment)"
else
  warn "no running caddy: nothing to back up"
fi

if [[ $MODE == edge ]]; then
  STEP="edge: running image tag"
  TAG="$(running_tag)"
  export AYVO_IMAGE_TAG="$TAG"
  log "Edge only: Caddy and the private DNS; web/api stay on $TAG, no migration, no database step"
elif [[ $MODE == rollback ]]; then
  STEP="rollback: check images"
  for image in api web; do
    docker image inspect "$IMAGE_PREFIX/$image:$TAG" >/dev/null 2>&1 ||
      die "image $IMAGE_PREFIX/$image:$TAG not found (list: docker images '$IMAGE_PREFIX/*')"
  done
  export AYVO_IMAGE_TAG="$TAG"
  warn "Rollback runs no migrations. If the newer release migrated the schema, read the rollback notes in docs/013-infrastructure.md first."
else
  STEP="build images"
  sha="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
  dirty=""
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
    dirty="-dirty"
    warn "working tree has uncommitted changes; the image tag is marked -dirty"
  fi
  TAG="${sha}${dirty}-$(date -u +%Y%m%dT%H%M%SZ)"
  export AYVO_IMAGE_TAG="$TAG"
  log "Building images $IMAGE_PREFIX/{api,web,api-migrate}:$TAG"
  compose --profile tools build --pull api web migrate
  ok "images built"
fi

if [[ $MODE != edge ]]; then
  STEP="start PostgreSQL and Redis"
  log "$STEP"
  compose up --detach --wait --wait-timeout 120 postgres redis
  ok "postgres and redis healthy"
fi

if [[ $MODE == deploy ]]; then
  STEP="pre-migration database backup"
  backup_file="$BACKUP_DIR/ayvo-dev-preview-$(date -u +%Y%m%dT%H%M%SZ)-$TAG.dump"
  log "$STEP -> $backup_file"
  # shellcheck disable=SC2016 # expanded by the shell inside the postgres container
  compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
    >"$backup_file.partial"
  [[ -s $backup_file.partial ]] || die "database backup is empty"
  mv "$backup_file.partial" "$backup_file"
  ok "backup written ($(du -h "$backup_file" | cut -f1))"

  STEP="database migrations (prisma migrate deploy)"
  log "$STEP"
  compose --profile tools run --rm --no-deps migrate
  ok "migrations applied"
fi

if [[ $MODE == edge ]]; then
  STEP="recreate caddy and dns"
  log "$STEP"
  compose up --detach --wait --wait-timeout 120 --no-build --no-deps caddy dns
  ok "caddy and dns running"
else
  STEP="start application stack"
  log "$STEP (tag $AYVO_IMAGE_TAG)"
  compose up --detach --wait --wait-timeout 300 --no-build caddy dns web api postgres redis
  ok "all services running and healthy"
fi

verify

record "SUCCESS" "mode=$MODE"
log "DEV preview deployed: https://${CFG[DEV_DOMAIN]} (tag $TAG)"
compose ps
