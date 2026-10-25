#!/usr/bin/env bash
# AYVO OS — deploy the public marketing site's DEV preview (ADR 0040), on its own.
#
# DEV ONLY. Manual; only when the owner asks. Changes nothing but the `marketing` container:
#   scripts/deploy-marketing-dev.sh                 build the image from this clean checkout, start
#                                                   ONLY the marketing container, verify it through
#                                                   https://<DEV_DOMAIN>:8443 (tailnet) and print the
#                                                   content digest to accept for PROD
#   scripts/deploy-marketing-dev.sh --check         validate the env file and Compose; change nothing
#   scripts/deploy-marketing-dev.sh --rollback TAG  start a previously built marketing image again
#   scripts/deploy-marketing-dev.sh --help
#
# Prerequisite: the core is deployed with this commit (scripts/deploy-dev.sh) — Caddy publishes
# :8443 on the tailnet address and shares the internal `marketing` network. The site needs no
# database, Redis, API or secret. Never runs `down`, `volume rm` or a prune.

set -Eeuo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly DEPLOY_DIR="$REPO_ROOT/deploy/dev"
readonly COMPOSE_FILE="$DEPLOY_DIR/compose.yml"
readonly ENV_FILE="${AYVO_DEV_ENV_FILE:-/opt/ayvo/secrets/dev-preview.env}"
readonly STATE_DIR="${AYVO_DEV_STATE_DIR:-/opt/ayvo/logs}"
readonly DEPLOY_LOG="$STATE_DIR/deployments-dev-marketing.log"
readonly IMAGE="ayvo-dev-preview/marketing"
readonly PROJECT="ayvo-dev-preview"

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

on_exit() {
  local code=$?
  [[ $code -eq 0 || $MODE == check ]] && return
  printf '\n\033[1;31m=== MARKETING DEPLOYMENT FAILED (exit %s) during: %s ===\033[0m\n' "$code" "$STEP" >&2
  [[ -n $TAG ]] && printf '%s FAILED tag=%s step=%s\n' "$(date -u +%FT%TZ)" "$TAG" "${STEP// /_}" >>"$DEPLOY_LOG"
  printf 'Only the marketing container was being changed. Earlier releases: grep SUCCESS %s; %s --rollback TAG\n' \
    "$DEPLOY_LOG" "$0" >&2
}
trap on_exit EXIT
trap 'STEP="$STEP (line $LINENO: $BASH_COMMAND)"' ERR

env_value() {
  grep -E "^$1=" "$ENV_FILE" | tail -n1 | sed -E "s/^$1=//; s/^\"(.*)\"\$/\\1/; s/^'(.*)'\$/\\1/"
}

verify() {
  STEP="verify: the running content is the built artifact"
  local digest
  digest="$(docker exec "$PROJECT-marketing-1" site-digest /etc/caddy/Caddyfile /srv)"
  [[ $digest == "$1" ]] || die "the running site has digest $digest, expected $1"
  ok "running digest $digest"

  STEP="verify: through the edge (tailnet)"
  local domain base via code robots
  domain="$(env_value DEV_DOMAIN)"
  base="https://$domain:8443"
  via=(--max-time 10 --resolve "$domain:8443:$DEV_TAILNET_IPV4")
  code="$(curl -sS "${via[@]}" -o /dev/null -w '%{http_code}' "$base/cz/")"
  [[ $code == 200 ]] || die "GET $base/cz/ answered $code"
  robots="$(curl -sS "${via[@]}" -o /dev/null -w '%header{x-robots-tag}' "$base/")"
  [[ $robots == *noindex* ]] || die "the DEV preview must not be indexed (X-Robots-Tag: '$robots')"
  code="$(curl -sS "${via[@]}" -o /dev/null -w '%{http_code}' -X POST "$base/")"
  [[ $code == 405 ]] || die "POST $base/ must be refused (got $code)"
  code="$(curl -sS "${via[@]}" -o /dev/null -w '%{http_code}' "$base/api/health")"
  [[ $code == 404 ]] || die "$base/api/health must be a plain 404, never the OS (got $code)"
  ok "$base serves the marketing site (tailnet only, not indexed, GET/HEAD, no OS routes)"
}

while (($#)); do
  case $1 in
    --check) MODE=check ;;
    --rollback)
      MODE=rollback
      TAG=${2:-}
      [[ $TAG =~ ^[0-9a-f]{12}(-dirty)?-[0-9]{8}T[0-9]{6}Z$ ]] || die "--rollback needs a marketing image tag"
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
for cmd in docker git curl tailscale sha256sum; do
  command -v "$cmd" >/dev/null || die "required command not found: $cmd"
done
[[ -f $ENV_FILE ]] || die "env file not found: $ENV_FILE"
DEV_TAILNET_IPV4="$(tailscale ip -4 | head -n1)"
export DEV_TAILNET_IPV4
export AYVO_IMAGE_TAG=unused
export MARKETING_IMAGE_TAG="${TAG:-validate}"
STEP="validate compose config"
compose --profile marketing config --quiet || die "deploy/dev/compose.yml is invalid with this env file"
ok "compose config valid"
if [[ $MODE == check ]]; then
  log "Check passed. Nothing was changed."
  exit 0
fi

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/.deploy-dev-preview.lock"
flock -n 9 || die "another deployment is running (lock: $STATE_DIR/.deploy-dev-preview.lock)"
STEP="check the edge"
docker inspect --format '{{range $p, $_ := .NetworkSettings.Ports}}{{$p}} {{end}}' "$PROJECT-caddy-1" |
  grep -q '8443/tcp' || die "Caddy does not publish :8443 yet: deploy the core with this commit first (scripts/deploy-dev.sh)"

if [[ $MODE == rollback ]]; then
  STEP="rollback: check image"
  docker image inspect "$IMAGE:$TAG" >/dev/null 2>&1 || die "image $IMAGE:$TAG not found"
  expected="$(awk -v t="$TAG" '$3 == "tag="t { for (i = 4; i <= NF; i++) if ($i ~ /^digest=/) d = substr($i, 8) } END { print d }' "$DEPLOY_LOG")"
  [[ -n $expected ]] || die "no recorded digest for $TAG"
else
  STEP="build the marketing image"
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] || die "the working tree is not clean"
  TAG="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
  expected="$(cd "$REPO_ROOT/apps/marketing" && sh ./site-digest.sh Caddyfile site)"
  export MARKETING_IMAGE_TAG="$TAG"
  log "Building $IMAGE:$TAG (content digest $expected)"
  compose --profile marketing build --pull marketing
  ok "image built"
fi
export MARKETING_IMAGE_TAG="$TAG"

STEP="start the marketing container"
log "$STEP (tag $TAG) — only the marketing container"
compose --profile marketing up --detach --wait --wait-timeout 60 --no-build --no-deps marketing
ok "marketing running and healthy"

verify "$expected"
printf '%s SUCCESS tag=%s git=%s digest=%s mode=%s\n' "$(date -u +%FT%TZ)" "$TAG" \
  "$(git -C "$REPO_ROOT" rev-parse HEAD)" "$expected" "$MODE" >>"$DEPLOY_LOG"
log "Marketing preview deployed (tag $TAG). For PROD after acceptance:"
log "  scripts/deploy-prod.sh --marketing --release $(git -C "$REPO_ROOT" rev-parse HEAD) --expect-digest $expected"
