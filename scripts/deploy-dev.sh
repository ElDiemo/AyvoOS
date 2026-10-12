#!/usr/bin/env bash
# AYVO OS — deploy the DEV preview (https://dev.ayvo.co) on THIS server. See ADR 0013.
#
# DEV ONLY (ADR 0008). Manual deployment; there is no CI/CD.
#
# Usage:
#   scripts/deploy-dev.sh                  build images, back up the DB, migrate, start, verify
#   scripts/deploy-dev.sh --check          validate the env file (incl. the WorkOS issuer against the
#                                          client's discovery document) and Compose config; change nothing
#   scripts/deploy-dev.sh --rollback TAG   start previously built images TAG (no build, no migration)
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

# Requests through the public Caddy endpoint on this host (real hostname, SNI and certificate).
# Sets EDGE_STATUS, EDGE_ROBOTS (X-Robots-Tag), EDGE_LOCATION and EDGE_TYPE; the body is written
# to $EDGE_BODY. With a second argument "auth" it sends Basic Auth as DEV_BASIC_AUTH_USER plus
# VERIFY_PASSWORD through a curl config read from stdin, so the password never appears in argv,
# the environment or any output. curl config strings are double-quoted: escape \ and ".
edge() {
  local url=$1 auth=${2:-} meta pass
  local args=(--silent --show-error --max-time 10 --output "$EDGE_BODY"
    --resolve "${CFG[DEV_DOMAIN]}:443:127.0.0.1" --resolve "${CFG[DEV_DOMAIN]}:80:127.0.0.1"
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
}

# --- main --------------------------------------------------------------------------------------

while (($#)); do
  case $1 in
    --check) MODE=check ;;
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
for cmd in docker git curl jq awk flock realpath stat; do
  command -v "$cmd" >/dev/null || die "required command not found: $cmd"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin is required"

STEP="validate env file"
log "Validating $ENV_FILE"
check_env_file_location
parse_env_file
validate_env
ok "required variables present and valid"
check_workos_issuer
ok "WORKOS_JWT_ISSUER matches the client's WorkOS discovery document"

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

if [[ $MODE == rollback ]]; then
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

STEP="start PostgreSQL and Redis"
log "$STEP"
compose up --detach --wait --wait-timeout 120 postgres redis
ok "postgres and redis healthy"

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

STEP="start application stack"
log "$STEP (tag $AYVO_IMAGE_TAG)"
compose up --detach --wait --wait-timeout 300 --no-build caddy web api postgres redis
ok "all services running and healthy"

verify

record "SUCCESS" "mode=$MODE"
log "DEV preview deployed: https://${CFG[DEV_DOMAIN]} (tag $TAG)"
compose ps
