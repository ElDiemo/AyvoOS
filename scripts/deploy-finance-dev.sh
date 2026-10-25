#!/usr/bin/env bash
# AYVO OS — deploy the Finance unit (ADR 0039) on the DEV preview, on its own.
#
# DEV ONLY. Manual; only when the owner asks. Changes nothing but the Finance unit:
#   scripts/deploy-finance-dev.sh                 build the Finance image (same Dockerfile, its own
#                                                 tag), back up the database, set up the Finance
#                                                 roles/schema, migrate schema "finance" as its
#                                                 owner, replace ONLY the `finance` container, verify
#   scripts/deploy-finance-dev.sh --check         validate the env file and Compose; change nothing
#   scripts/deploy-finance-dev.sh --rollback TAG  start a previously built Finance image (no build,
#                                                 no migration)
#   scripts/deploy-finance-dev.sh --help
#
# Prerequisites: the core is deployed with this commit (scripts/deploy-dev.sh) — the API holds
# FINANCE_SERVICE_TOKEN_SHA256, the web app FINANCE_API_URL, Caddy the /api/admin/finance route and
# PostgreSQL the finance-db network. Server env file (never Git): FINANCE_DB_PASSWORD,
# FINANCE_DB_OWNER_PASSWORD (24+ chars [A-Za-z0-9_-]), FINANCE_SERVICE_TOKEN (43+ chars base64url)
# and FINANCE_SERVICE_TOKEN_SHA256 = its SHA-256 (checked here).
#
# Never touches api, web, caddy, dns, postgres or redis containers, never runs `down`, `volume rm`
# or a prune; the core database is only backed up (pg_dump) and read by the role setup.

set -Eeuo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly DEPLOY_DIR="$REPO_ROOT/deploy/dev"
readonly COMPOSE_FILE="$DEPLOY_DIR/compose.yml"
readonly ENV_FILE="${AYVO_DEV_ENV_FILE:-/opt/ayvo/secrets/dev-preview.env}"
readonly BACKUP_DIR="${AYVO_DEV_BACKUP_DIR:-/opt/ayvo/backups/dev-preview}"
readonly STATE_DIR="${AYVO_DEV_STATE_DIR:-/opt/ayvo/logs}"
readonly DEPLOY_LOG="$STATE_DIR/deployments-dev-finance.log"
readonly IMAGE_PREFIX="ayvo-dev-preview"
readonly FINANCE_VARS=(POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DEV_DOMAIN FINANCE_DB_PASSWORD
  FINANCE_DB_OWNER_PASSWORD FINANCE_SERVICE_TOKEN FINANCE_SERVICE_TOKEN_SHA256)

MODE=deploy
TAG=""
STEP="startup"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31mERROR\033[0m %s\n' "$*" >&2
  exit 1
}
usage() { awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"; }

compose() {
  docker compose --project-directory "$DEPLOY_DIR" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

record() {
  mkdir -p "$STATE_DIR"
  printf '%s %s tag=%s git=%s %s\n' "$(date -u +%FT%TZ)" "$1" "$TAG" \
    "$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)" "${2:-}" >>"$DEPLOY_LOG"
}

on_exit() {
  local code=$?
  [[ $code -eq 0 || $MODE == check ]] && return
  printf '\n\033[1;31m=== FINANCE DEPLOYMENT FAILED (exit %s) during: %s ===\033[0m\n' "$code" "$STEP" >&2
  [[ -n $TAG ]] && record "FAILED" "step=${STEP// /_}"
  printf 'Only the Finance unit was being changed; the core containers were not touched.\n' >&2
  printf 'Previous Finance releases: grep SUCCESS %s; rollback: %s --rollback TAG\n' \
    "$DEPLOY_LOG" "$0" >&2
}
trap on_exit EXIT
trap 'STEP="$STEP (line $LINENO: $BASH_COMMAND)"' ERR

declare -A CFG=()
# The env file is parsed, never `source`d (KEY=value, KEY='value', KEY="value", # comments).
parse_env_file() {
  local line key value n=0
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || die "$ENV_FILE:$n: expected KEY=VALUE"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ $value =~ ^\'(.*)\'$ || $value =~ ^\"(.*)\"$ ]]; then value="${BASH_REMATCH[1]}"; fi
    CFG[$key]="$value"
  done <"$ENV_FILE"
}

validate_finance_env() {
  local v
  for v in "${FINANCE_VARS[@]}"; do
    [[ -n ${CFG[$v]:-} ]] || die "$ENV_FILE: $v is required for the Finance unit"
  done
  [[ ${CFG[FINANCE_DB_PASSWORD]} =~ ^[A-Za-z0-9_-]{24,128}$ ]] ||
    die "FINANCE_DB_PASSWORD: 24–128 chars of [A-Za-z0-9_-] (openssl rand -hex 24)"
  [[ ${CFG[FINANCE_DB_OWNER_PASSWORD]} =~ ^[A-Za-z0-9_-]{24,128}$ ]] ||
    die "FINANCE_DB_OWNER_PASSWORD: 24–128 chars of [A-Za-z0-9_-] (openssl rand -hex 24)"
  [[ ${CFG[FINANCE_DB_PASSWORD]} != "${CFG[FINANCE_DB_OWNER_PASSWORD]}" ]] ||
    die "FINANCE_DB_PASSWORD and FINANCE_DB_OWNER_PASSWORD must differ"
  [[ ${CFG[FINANCE_SERVICE_TOKEN]} =~ ^[A-Za-z0-9_-]{43,128}$ ]] ||
    die "FINANCE_SERVICE_TOKEN: 43+ chars base64url (openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  local sha
  sha="$(printf '%s' "${CFG[FINANCE_SERVICE_TOKEN]}" | sha256sum | cut -d' ' -f1)"
  [[ $sha == "${CFG[FINANCE_SERVICE_TOKEN_SHA256]}" ]] ||
    die "FINANCE_SERVICE_TOKEN_SHA256 is not the SHA-256 of FINANCE_SERVICE_TOKEN"
}

# The core must already run with this contract (deployed by scripts/deploy-dev.sh).
check_core_ready() {
  local env_sha
  env_sha="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
    "$(compose ps -q api)" | sed -n 's/^FINANCE_SERVICE_TOKEN_SHA256=//p')"
  [[ $env_sha == "${CFG[FINANCE_SERVICE_TOKEN_SHA256]}" ]] ||
    die "the running API does not hold this FINANCE_SERVICE_TOKEN_SHA256: deploy the core first (scripts/deploy-dev.sh)"
}

verify() {
  STEP="verify: Finance container health"
  log "$STEP"
  compose --profile finance exec -T finance node -e \
    "fetch('http://127.0.0.1:4010/api/admin/finance/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" ||
    die "Finance is not ready (its database or the core contract does not answer)"
  ok "finance live and ready (database + core contract)"

  STEP="verify: routes through the edge"
  local base="https://${CFG[DEV_DOMAIN]}" code
  local via=(--max-time 10 --resolve "${CFG[DEV_DOMAIN]}:443:$DEV_TAILNET_IPV4")
  code="$(curl -sS "${via[@]}" -o /dev/null -w '%{http_code}' "$base/api/admin/finance/documents")"
  [[ $code == 401 ]] || die "GET /api/admin/finance/documents without a session: expected 401 from Finance, got $code"
  ok "/api/admin/finance/* reaches the Finance unit and refuses without a session (401)"
  if curl -sS "${via[@]}" -o /dev/null "$base/api/internal/v1/finance/suppliers" 2>/dev/null; then
    die "/api/internal/* answered through the edge — it must be aborted"
  fi
  ok "/api/internal/* is not reachable through the edge"
}

while (($#)); do
  case $1 in
    --check) MODE=check ;;
    --rollback)
      MODE=rollback
      TAG=${2:-}
      [[ $TAG =~ ^finance-[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$ ]] || die "--rollback needs a Finance image tag (finance-…)"
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
for cmd in docker git curl flock sha256sum tailscale; do
  command -v "$cmd" >/dev/null || die "required command not found: $cmd"
done
[[ -f $ENV_FILE ]] || die "env file not found: $ENV_FILE"
parse_env_file
validate_finance_env
ok "Finance variables present; the service token matches its SHA-256"

# Compose interpolates the whole file (the edge needs the tailnet address, ADR 0026).
DEV_TAILNET_IPV4="$(tailscale ip -4 | head -n1)"
export DEV_TAILNET_IPV4
export AYVO_IMAGE_TAG=unused
export FINANCE_IMAGE_TAG="${TAG:-validate}"
STEP="validate compose config"
compose --profile finance --profile finance-tools config --quiet ||
  die "deploy/dev/compose.yml is invalid with this env file"
ok "compose config valid"
if [[ $MODE == check ]]; then
  log "Check passed. Nothing was changed."
  exit 0
fi

mkdir -p "$STATE_DIR" "$BACKUP_DIR"
exec 9>"$STATE_DIR/.deploy-dev-preview.lock"
flock -n 9 || die "another deployment is running (lock: $STATE_DIR/.deploy-dev-preview.lock)"
STEP="check the core"
check_core_ready
ok "the running API holds the Finance contract"

if [[ $MODE == rollback ]]; then
  STEP="rollback: check image"
  docker image inspect "$IMAGE_PREFIX/api:$TAG" >/dev/null 2>&1 || die "image $IMAGE_PREFIX/api:$TAG not found"
  export FINANCE_IMAGE_TAG="$TAG"
else
  STEP="build the Finance image"
  TAG="finance-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] || die "the working tree is not clean"
  export FINANCE_IMAGE_TAG="$TAG"
  log "Building $IMAGE_PREFIX/{api,api-migrate}:$TAG (Finance only)"
  compose --profile finance --profile finance-tools build --pull finance finance-migrate
  ok "image built"

  STEP="pre-migration database backup"
  backup_file="$BACKUP_DIR/ayvo-dev-preview-$(date -u +%Y%m%dT%H%M%SZ)-$TAG.dump"
  log "$STEP -> $backup_file"
  # shellcheck disable=SC2016 # expanded by the shell inside the postgres container
  compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
    >"$backup_file.partial"
  [[ -s $backup_file.partial ]] || die "database backup is empty"
  mv "$backup_file.partial" "$backup_file"
  ok "backup written ($(du -h "$backup_file" | cut -f1))"

  STEP="Finance roles, schema and migrations"
  log "$STEP"
  compose --profile finance-tools run --rm --no-deps finance-migrate
  ok "roles ready; schema finance migrated by its owner"
fi

STEP="start the Finance unit"
log "$STEP (tag $FINANCE_IMAGE_TAG) — only the finance container"
compose --profile finance up --detach --wait --wait-timeout 120 --no-build --no-deps finance
ok "finance running and healthy"

verify
record "SUCCESS" "mode=$MODE"
log "Finance unit deployed on DEV (tag $FINANCE_IMAGE_TAG)"
