#!/usr/bin/env bash
# AYVO OS — deploy the public marketing site's DEV preview (ADR 0040), on its own.
#
# DEV ONLY. Manual; only when the owner asks. Changes nothing but the `marketing` container:
#   scripts/deploy-marketing-dev.sh                 build the image from this clean checkout (pinned
#                                                   base, source revision label), start ONLY the
#                                                   marketing container (the previous one restored if
#                                                   the new one fails), verify it through
#                                                   https://<DEV_DOMAIN>:8443 (tailnet), save the TESTED
#                                                   image as an archive and print its image ID and
#                                                   content digest — what PROD loads after acceptance
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
readonly ARTIFACT_DIR="${AYVO_MARKETING_ARTIFACT_DIR:-/opt/ayvo/artifacts/marketing}"
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

# Replace only the marketing container; Compose removes the running one before the new one is
# healthy, so a failed start restores the previous tag (the outage lasts until it is healthy again).
start_marketing() {
  local tag=$1 image=$2 digest=$3 previous=$4
  export MARKETING_IMAGE_TAG="$tag"
  if compose --profile marketing up --detach --wait --wait-timeout 60 --no-build --no-deps marketing &&
    [[ $(docker inspect --format '{{.Image}}' "$PROJECT-marketing-1" 2>/dev/null) == "$image" ]] &&
    [[ $(docker exec "$PROJECT-marketing-1" site-digest /etc/caddy/Caddyfile /srv 2>/dev/null) == "$digest" ]]; then
    ok "marketing $tag running: image $image, content $digest"
    return 0
  fi
  if [[ -n $previous && $previous != "$tag" ]]; then
    export MARKETING_IMAGE_TAG="$previous"
    compose --profile marketing up --detach --wait --wait-timeout 60 --no-build --no-deps marketing &&
      die "the new marketing container failed; the previous $previous runs again"
    die "the new marketing container failed AND $previous did not come back: the preview is unavailable"
  fi
  die "the new marketing container failed (nothing to restore): the preview is unavailable"
}

verify() {
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
      [[ $TAG =~ ^[0-9a-f]{12}-[0-9]{8}T[0-9]{6}Z$ ]] || die "--rollback needs a marketing image tag"
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

previous="$(docker inspect --format '{{.Config.Image}}' "$PROJECT-marketing-1" 2>/dev/null | sed -n "s|^$IMAGE:||p")" || true
if [[ $MODE == rollback ]]; then
  STEP="rollback: check image"
  read -r image expected <<<"$(awk -v t="tag=$TAG" '$2 == "SUCCESS" && $3 == t { for (i = 4; i <= NF; i++) { if ($i ~ /^image=/) m = substr($i, 7); if ($i ~ /^digest=/) d = substr($i, 8) } } END { print m, d }' "$DEPLOY_LOG")" || true
  [[ -n ${image:-} && -n ${expected:-} ]] || die "no successful deployment of $TAG is recorded"
  [[ $(docker image inspect --format '{{.Id}}' "$IMAGE:$TAG" 2>/dev/null) == "$image" ]] ||
    die "image $IMAGE:$TAG is gone or is not the recorded $image"
else
  STEP="build the marketing image"
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] || die "the working tree is not clean"
  revision="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  TAG="${revision:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
  expected="$(cd "$REPO_ROOT/apps/marketing" && sh ./site-digest.sh Caddyfile site)"
  log "Building $IMAGE:$TAG (pinned base; revision $revision; content $expected)"
  docker build --quiet --label "org.opencontainers.image.revision=$revision" -t "$IMAGE:$TAG" \
    "$REPO_ROOT/apps/marketing" >/dev/null
  image="$(docker image inspect --format '{{.Id}}' "$IMAGE:$TAG")"
  ok "image $image built"
fi

STEP="start the marketing container"
log "$STEP (tag $TAG) — only the marketing container"
start_marketing "$TAG" "$image" "$expected" "$previous"

verify
printf '%s SUCCESS tag=%s image=%s digest=%s git=%s mode=%s\n' "$(date -u +%FT%TZ)" "$TAG" "$image" \
  "$expected" "$(git -C "$REPO_ROOT" rev-parse HEAD)" "$MODE" >>"$DEPLOY_LOG"

if [[ $MODE == deploy ]]; then
  STEP="save the tested image for PROD"
  mkdir -p "$ARTIFACT_DIR"
  archive="$ARTIFACT_DIR/marketing-$TAG.tar.gz"
  docker save "$IMAGE:$TAG" | gzip -n >"$archive.partial"
  mv "$archive.partial" "$archive"
  chmod 0644 "$archive"
  ok "saved $archive ($(du -h "$archive" | cut -f1), sha256 $(sha256sum "$archive" | cut -d' ' -f1))"
  log "Marketing preview deployed (tag $TAG). After acceptance copy the archive to PROD and run:"
  log "  scripts/deploy-prod.sh --marketing --image-archive <file> --expect-image $image --expect-digest $expected"
fi
