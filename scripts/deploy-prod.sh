#!/usr/bin/env bash
# AYVO OS — deploy PRODUCTION (https://os.ayvo.co) on AyvoOS-PROD. Doc 036, ADR 0033.
#
# Manual, by the owner, one approved release at a time. There is no CI/CD.
#
# Usage:
#   scripts/deploy-prod.sh --check   --release <commit>   verify host, env files, release and Compose
#                                                         configuration (exports the release; starts,
#                                                         builds and migrates nothing)
#   scripts/deploy-prod.sh --release <commit>             export, build, back up, migrate, start, verify
#   scripts/deploy-prod.sh --rollback <release>           start the images of an earlier release again
#                                                         (no build, no migration; doc 036 §7)
#   scripts/deploy-prod.sh --bootstrap-admin --email <e-mail> --name "<name>"
#                                                         the one-time first administrator (doc 021 §8)
#
# <commit> is a full 40-character commit that is already on origin/main (merged = approved). The
# images are built from a clean `git archive` of exactly that commit — never from a working copy.
#
# Run it with sudo (doc 036 §6: `ayvo` is not in the docker group). The approved owner of the
# repository and of the env files stays `ayvo`; git runs as that user (its read-only deploy key
# and known_hosts), never as root and never with safe.directory or relaxed host key checking.
#
# Environment (optional):
#   AYVO_PROD_OWNER        approved owner of the checkout and the env files (default ayvo)
#   AYVO_PROD_SECRETS_DIR  server-only env files          (default /opt/ayvo/secrets)
#   AYVO_PROD_DIR          releases, pre-migration dumps,
#                          state, lock and log            (default /opt/ayvo/prod)
#
# Safety guarantees:
#   - Refuses to run on the DEV server, without the host guard, with Tailscale SNAT on, with env
#     files readable by others, or with a missing required key (names are reported, values never).
#   - Never runs `down`, `down -v`, `volume rm`, `system prune` or `image prune`; data volumes stay.
#     After a successful release only this project's own images of releases older than the three
#     newest are removed, by name, and never one that a container uses.
#   - Migrations run only after a verified dump of a non-empty database (and, when the backup tool
#     of doc 035 is installed, a verified upload to S3). A database is never restored automatically.
#   - Never prints the resolved Compose configuration (it would contain secrets): `config --quiet`.
#   - Any failure stops immediately with the failed step and what to do; nothing is undone silently.
set -Eeuo pipefail
umask 077

readonly PROJECT=ayvo-prod
readonly DOMAIN=os.ayvo.co
readonly IMAGE_PREFIX=ayvo-prod
readonly GUARD_UNIT=ayvo-prod-docker-guard.service
readonly SECRETS="${AYVO_PROD_SECRETS_DIR:-/opt/ayvo/secrets}"
readonly DEPLOY_OWNER="${AYVO_PROD_OWNER:-ayvo}"
readonly PROD_DIR="${AYVO_PROD_DIR:-/opt/ayvo/prod}"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly MIN_FREE_GB=8
readonly KEEP_RELEASES=3

# Required and allowed keys per env file (doc 036 §4). Anything else is refused: a file given to a
# container through `env_file` must not inject e.g. NODE_OPTIONS, AWS_ENDPOINT_URL or a test
# switch. Values are never printed.
readonly KEYS_PROD="POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB ACME_EMAIL PUBLIC_QR_BASE_URL"
# The physically validated QR label settings are optional (ADR 0034): both or neither.
readonly QR_LABEL_KEYS="LABEL_QR_MIN_SIZE_MM LABEL_QR_ERROR_CORRECTION"
readonly ALLOW_PROD="$KEYS_PROD $QR_LABEL_KEYS CARRIER_CREDENTIALS_KEY"
readonly KEYS_WORKOS="WORKOS_API_KEY"
# Client ID and issuer may be in the file too; compose.yml's fixed values take precedence.
readonly ALLOW_WORKOS="$KEYS_WORKOS WORKOS_CLIENT_ID WORKOS_JWT_ISSUER"
readonly KEYS_S3="AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY"
# Region, bucket and owner may be in the file too; compose.yml's fixed values take precedence.
readonly ALLOW_S3="$KEYS_S3 AWS_REGION S3_BUCKET S3_EXPECTED_BUCKET_OWNER"
# The only endpoint trusted for the WorkOS discovery document (doc 021 §9); never configurable.
readonly WORKOS_API_ORIGIN="https://api.workos.com"

MODE=deploy
RELEASE=""
ROLLBACK=""
ADMIN_EMAIL=""
ADMIN_NAME=""
STEP="start"
BACKUP_FILE=""
MIGRATED=false
PREVIOUS=""

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31mFAILED\033[0m at "%s": %s\n' "$STEP" "$*" >&2
  exit 1
}
usage() { sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

on_exit() {
  local code=$?
  trap - ERR
  ((code == 0)) && return
  {
    echo
    echo "Production deployment stopped (step: $STEP). Nothing more was changed after it."
    [[ -n $BACKUP_FILE ]] && echo "Pre-migration dump: $BACKUP_FILE"
    if $MIGRATED; then
      echo "Migrations of $RELEASE were started. Starting an older release is safe only if its code works"
      echo "with the new schema (doc 036 §7); otherwise restore deliberately (doc 035 §4) — never"
      echo "automatically."
    fi
    [[ -n $PREVIOUS ]] && echo "Previous release: $PREVIOUS  (scripts/deploy-prod.sh --rollback ${PREVIOUS:0:12})"
    echo "Logs: docker compose -p $PROJECT logs --tail 200 api web caddy"
  } >&2
}
trap on_exit EXIT
trap 'STEP="$STEP (line $LINENO: $BASH_COMMAND)"' ERR

# --- checks ----------------------------------------------------------------------------------

require_commands() {
  local cmd
  for cmd in docker git curl jq awk flock tar sha256sum stat tailscale ip systemctl sysctl df getent runuser; do
    command -v "$cmd" >/dev/null || die "$cmd is not installed"
  done
  docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing"
}

# Production never runs next to DEV, and DEV material never reaches this host: the declared
# production host (deploy/prod/host/prod-host.sh: hostname, Tailscale IPv4, no DEV traces).
not_dev_server() {
  # shellcheck source=../deploy/prod/host/prod-host.sh
  source "$REPO_ROOT/deploy/prod/host/prod-host.sh"
  assert_prod_host || die "not the production host"
}

# Kept as a second, independent check.
not_dev_preview() {
  [[ ! -e /opt/ayvo/secrets/dev-preview.env ]] || die "this is the DEV server (dev-preview.env exists): production is never deployed here"
  local names
  names="$(docker ps -a --format '{{.Names}}')" || die "cannot list the containers (is Docker running, is $(id -un) in the docker group?)"
  ! grep -q '^ayvo-dev-preview-' <<<"$names" ||
    die "DEV preview containers exist on this host: production is never deployed next to DEV"
}

tailnet_address() {
  local ip4
  ip4="$(tailscale ip -4 2>/dev/null | head -n1)" || true
  [[ $ip4 =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.([0-9]{1,3})\.([0-9]{1,3})$ ]] ||
    die "no Tailscale IPv4 address (tailscale status). Production is published only on the tailnet."
  ip -4 -o addr show dev tailscale0 2>/dev/null | grep -q " inet $ip4/" ||
    die "Tailscale address $ip4 is not on interface tailscale0"
  PROD_TAILNET_IPV4=$ip4
}

check_host_guard() {
  systemctl is-active --quiet "$GUARD_UNIT" ||
    die "$GUARD_UNIT is not active: sudo bash deploy/prod/host/install.sh (doc 036 §3)"
  systemctl is-enabled --quiet "$GUARD_UNIT" || die "$GUARD_UNIT is not enabled (it must survive a reboot)"
  [[ $(sysctl -n net.ipv4.ip_nonlocal_bind 2>/dev/null) == 1 ]] ||
    die "net.ipv4.ip_nonlocal_bind must be 1 (deploy/prod/host/60-ayvo-prod-tailnet.conf)"
  [[ "$(tailscale debug prefs 2>/dev/null | jq -r '.NoSNAT')" == true ]] ||
    die "Tailscale SNAT is on: Caddy would see the Docker gateway instead of the tailnet peer (deploy/prod/host/install.sh)"
}

# Keys of a KEY=VALUE file, without ever evaluating or printing a value.
env_keys() { grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$1" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/'; }
# One key's value (unquoted), for comparisons only — never printed, never evaluated.
env_value() {
  grep -E "^[[:space:]]*(export[[:space:]]+)?$2=" "$1" | tail -n1 |
    sed -E "s/^[[:space:]]*(export[[:space:]]+)?$2=[[:space:]]*//; s/[[:space:]]+\$//; s/^\"(.*)\"\$/\\1/; s/^'(.*)'\$/\\1/"
}

# The approved owner's UID; the script runs as root (sudo) or as that owner, nobody else.
owner_uid() { id -u "$DEPLOY_OWNER" 2>/dev/null || die "the approved owner $DEPLOY_OWNER does not exist"; }
check_runner() {
  local me
  me="$(id -u)"
  [[ $me == 0 || $me == "$(owner_uid)" ]] || die "run as root (sudo) or as $DEPLOY_OWNER, not as $(id -un)"
}

# git always as the approved owner: its checkout, its read-only deploy key, its known_hosts.
repo_git() {
  if [[ $(id -u) == 0 ]]; then
    runuser -u "$DEPLOY_OWNER" -- env HOME="$(getent passwd "$DEPLOY_OWNER" | cut -d: -f6)" \
      git -C "$REPO_ROOT" "$@"
  else
    git -C "$REPO_ROOT" "$@"
  fi
}
check_checkout() {
  [[ $(stat -c '%U' "$REPO_ROOT/.git") == "$DEPLOY_OWNER" ]] ||
    die "$REPO_ROOT must belong to $DEPLOY_OWNER (the read-only checkout, doc 036 §6)"
}

check_env_file() {
  local file=$1 required=$2 allowed=$3
  [[ -f $file ]] || die "$file does not exist (doc 036 §4)"
  local mode owner
  mode="$(stat -c '%a' "$file")"
  owner="$(stat -c '%u' "$file")"
  [[ $mode =~ ^[0-7]00$ ]] || die "$file must not be readable by group or others (mode $mode, expected 600)"
  # The approved owner (ayvo, also when the script runs with sudo) or root; nobody else.
  [[ $owner == "$(owner_uid)" || $owner == 0 ]] || die "$file must belong to $DEPLOY_OWNER or root"
  # Every line is a comment, empty, or KEY=VALUE: a bare KEY would be filled from the environment.
  grep -vqE '^[[:space:]]*(#.*)?$|^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$file" &&
    die "$file has a line that is not KEY=VALUE (line $(grep -nvE '^[[:space:]]*(#.*)?$|^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' "$file" | head -n1 | cut -d: -f1))"
  local keys missing=() bad=() key
  keys="$(env_keys "$file")"
  for key in $required; do grep -qx "$key" <<<"$keys" || missing+=("$key"); done
  while read -r key; do
    [[ -z $key || " $allowed " == *" $key "* ]] || bad+=("$key")
  done <<<"$keys"
  ((${#missing[@]} == 0)) || die "$file lacks ${missing[*]} (doc 036 §4)"
  ((${#bad[@]} == 0)) || die "$file must not set ${bad[*]} (allowed: $allowed; doc 036 §4)"
  for key in $required; do
    [[ -n $(env_value "$file" "$key") ]] || die "$file: $key is empty"
  done
  ok "$file: mode $mode, required keys present, no other keys"
}

# Both QR label settings, or neither (then only our QR label operations are refused, ADR 0034).
# Never a default, never a value from DEV: only the recorded physical validation (doc 036 §8).
check_qr_label_settings() {
  local file=$1 key set=()
  for key in $QR_LABEL_KEYS; do [[ -n $(env_value "$file" "$key") ]] && set+=("$key"); done
  case ${#set[@]} in
    0) ok "QR label settings not set: the application runs, our QR labels are refused (ADR 0034)" ;;
    2) ok "QR label settings set (the owner's recorded physical validation)" ;;
    *) die "$file sets only ${set[*]}: set both $QR_LABEL_KEYS or neither (ADR 0034)" ;;
  esac
}

check_env_files() {
  STEP="check the server-only env files"
  log "$STEP"
  check_env_file "$SECRETS/prod.env" "$KEYS_PROD" "$ALLOW_PROD"
  check_qr_label_settings "$SECRETS/prod.env"
  check_env_file "$SECRETS/prod-workos.env" "$KEYS_WORKOS" "$ALLOW_WORKOS"
  check_env_file "$SECRETS/prod-s3.env" "$KEYS_S3" "$ALLOW_S3"
  # The backup identity is never given to the application (doc 035).
  if [[ -r $SECRETS/prod-s3-backup.env ]] &&
    [[ $(env_value "$SECRETS/prod-s3.env" AWS_ACCESS_KEY_ID) == "$(env_value "$SECRETS/prod-s3-backup.env" AWS_ACCESS_KEY_ID)" ]]; then
    die "prod-s3.env holds the backup identity: the application uses its own S3 identity (ADR 0032)"
  fi
  if [[ -f $SECRETS/prod-workos-client.env ]]; then
    ok "prod-workos-client.env is not read by this release (keys: $(env_keys "$SECRETS/prod-workos-client.env" | tr '\n' ' '))"
  fi
}

check_release() {
  STEP="check the release $RELEASE"
  log "$STEP"
  check_checkout
  [[ $RELEASE =~ ^[0-9a-f]{40}$ ]] || die "--release needs a full 40-character commit"
  repo_git fetch --quiet origin main || die "cannot fetch origin/main"
  repo_git cat-file -e "$RELEASE^{commit}" 2>/dev/null || die "commit $RELEASE is not in the repository"
  repo_git merge-base --is-ancestor "$RELEASE" origin/main ||
    die "$RELEASE is not on origin/main: only a merged (approved) commit is released"
  repo_git cat-file -e "$RELEASE:deploy/prod/compose.yml" 2>/dev/null ||
    die "$RELEASE has no deploy/prod/compose.yml"
  repo_git show "$RELEASE:apps/api/src/config/env.ts" | grep -q "'s3'" ||
    die "$RELEASE has no S3 file storage (ADR 0032, #47): production cannot start on local storage"
  ok "$RELEASE is on origin/main ($(repo_git log -1 --format='%cs %s' "$RELEASE"))"
}

# The issuer fixed in the release's compose.yml must be exactly the `issuer` of the WorkOS
# client's discovery document (as DEV, doc 021 §9). Nothing secret is involved.
check_workos_issuer() {
  STEP="check the WorkOS issuer against the client's discovery document"
  local file client issuer doc found
  file="$(release_dir "$RELEASE")/deploy/prod/compose.yml"
  client="$(sed -nE 's/^ +WORKOS_CLIENT_ID: ([A-Za-z0-9_]+)$/\1/p' "$file" | head -n1)"
  issuer="$(sed -nE 's/^ +WORKOS_JWT_ISSUER: (https:[^ ]+)$/\1/p' "$file" | head -n1)"
  [[ -n $client && -n $issuer ]] || die "compose.yml has no fixed WorkOS client ID and issuer"
  doc="$(printf 'url = "%s/user_management/%s/.well-known/openid-configuration"\n' "$WORKOS_API_ORIGIN" "$client" |
    curl -fsS --proto =https --max-redirs 0 --max-time 15 --max-filesize 65536 --config - 2>/dev/null)" ||
    die "the WorkOS discovery document of $client could not be fetched"
  found="$(jq -er 'if type == "object" and (.issuer | type) == "string" then .issuer else empty end' <<<"$doc" 2>/dev/null)" ||
    die "the WorkOS discovery document has no issuer"
  [[ $found == "$issuer" ]] || die "WORKOS_JWT_ISSUER in compose.yml ($issuer) is not the discovery issuer ($found)"
  ok "WorkOS issuer matches the discovery document of $client"
}

check_resources() {
  STEP="check disk and memory"
  local free_gb mem_mb swap_mb
  free_gb="$(df -BG --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -dc 0-9)"
  [[ -n $free_gb ]] || free_gb="$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"
  ((free_gb >= MIN_FREE_GB)) || die "only ${free_gb} GB free for Docker (at least $MIN_FREE_GB GB before a build)"
  mem_mb="$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)"
  swap_mb="$(awk '/^SwapFree:/ { print int($2 / 1024) }' /proc/meminfo)"
  ((mem_mb + swap_mb >= 3000)) ||
    die "only ${mem_mb} MB RAM + ${swap_mb} MB swap available: the web build needs about 3 GB (doc 036 §2: swap)"
  ok "disk ${free_gb} GB free, memory ${mem_mb} MB + swap ${swap_mb} MB"
}

# --- Compose ----------------------------------------------------------------------------------

release_dir() { printf '%s/releases/%s' "$PROD_DIR" "${1:0:12}"; }

compose() {
  local dir
  dir="$(release_dir "$AYVO_RELEASE")"
  PROD_DOMAIN=$DOMAIN PROD_TAILNET_IPV4=$PROD_TAILNET_IPV4 AYVO_RELEASE=$AYVO_RELEASE \
    AYVO_RELEASE_DIR=$dir AYVO_PROD_SECRETS_DIR=$SECRETS \
    docker compose -p "$PROJECT" --project-directory "$dir/deploy/prod" \
    -f "$dir/deploy/prod/compose.yml" --env-file "$SECRETS/prod.env" "$@"
}

export_release() {
  STEP="export the release"
  local dir
  dir="$(release_dir "$RELEASE")"
  if [[ -f $dir/.ayvo-release ]] && [[ $(<"$dir/.ayvo-release") == "$RELEASE" ]]; then
    ok "release already exported: $dir"
    return
  fi
  log "$STEP -> $dir"
  rm -rf "$dir.partial"
  # Readable modes: the images copy the files with their modes and run as a non-root user, and
  # CoreDNS reads its Corefile as non-root (the script's own umask is 077 for its secrets' sake).
  (
    umask 022
    mkdir -p "$dir.partial"
    repo_git archive --format=tar "$RELEASE" | tar -x --no-same-owner -C "$dir.partial"
    printf '%s\n' "$RELEASE" >"$dir.partial/.ayvo-release"
  )
  chmod -R a+rX,go-w "$dir.partial"
  [[ ! -e $dir ]] || die "$dir exists but is not a complete export of $RELEASE: inspect and remove it by hand"
  mv "$dir.partial" "$dir"
  ok "exported $RELEASE (no .git, no .env)"
}

validate_compose() {
  STEP="validate the Compose configuration"
  compose config --quiet || die "deploy/prod/compose.yml does not validate with the env files (see the message above)"
  ok "Compose configuration valid (not printed: it contains secrets)"
}

current_release() { docker inspect --format '{{.Config.Image}}' "$PROJECT-api-1" 2>/dev/null | sed -n "s|^$IMAGE_PREFIX/api:||p"; }

# --- deploy steps -----------------------------------------------------------------------------

build_images() {
  # One image at a time: the server has 4 GB RAM (doc 036 §2).
  local service
  for service in api migrate web; do
    STEP="build the $service image"
    log "$STEP ($IMAGE_PREFIX/*:$AYVO_RELEASE)"
    compose build "$service" || die "building $service failed"
  done
  ok "images built for $AYVO_RELEASE"
}

wait_healthy() {
  local service=$1 id state i
  for ((i = 0; i < 90; i++)); do
    id="$(compose ps -q "$service")"
    state="$(docker inspect --format '{{.State.Health.Status}}' "$id" 2>/dev/null || true)"
    [[ $state == healthy ]] && return 0
    sleep 2
  done
  return 1
}

backup_before_migration() {
  STEP="stop the application writers (api, web) for a consistent backup"
  # Nothing may be written after the dump, and the old code must not run against the new schema:
  # the application is unavailable from here until start_services (doc 036 §7).
  if [[ -n $(compose ps -q api web) ]]; then
    log "$STEP"
    compose stop web api || die "api/web did not stop"
    ok "api and web stopped (the new release starts after the migration)"
  fi
  STEP="back up the database before migrating"
  log "$STEP"
  local tables
  tables="$(compose exec -T postgres sh -c 'psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = '\''public'\''"')" ||
    die "cannot read the database"
  if [[ $tables == 0 ]]; then
    ok "empty database (first installation from the migrations): nothing to back up"
    return
  fi
  mkdir -p "$PROD_DIR/backups"
  BACKUP_FILE="$PROD_DIR/backups/predeploy-$(date -u +%Y%m%dT%H%M%SZ)-${AYVO_RELEASE}.dump"
  compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6' \
    >"$BACKUP_FILE.partial" || die "pg_dump failed"
  [[ -s $BACKUP_FILE.partial ]] || die "the dump is empty"
  compose exec -T postgres pg_restore --list <"$BACKUP_FILE.partial" >/dev/null || die "the dump is not readable"
  mv "$BACKUP_FILE.partial" "$BACKUP_FILE"
  sha256sum "$BACKUP_FILE" >"$BACKUP_FILE.sha256"
  ok "dump $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
  if [[ -d /usr/local/lib/ayvo-backup ]]; then
    STEP="upload a backup to S3 before migrating (doc 035)"
    log "$STEP"
    local attempt rc
    for attempt in 1 2 3 4 5; do
      rc=0
      PYTHONPATH=/usr/local/lib/ayvo-backup PYTHONDONTWRITEBYTECODE=1 \
        python3 -m ayvo_backup run --kind daily --reason "pre-deploy ${AYVO_RELEASE}" || rc=$?
      # 75: a scheduled backup is running right now — wait for it, then take our own.
      ((rc == 75)) || break
      warn "a scheduled backup is running; retrying in 60 s ($attempt/5)"
      sleep 60
    done
    ((rc == 0)) || die "the S3 backup failed (exit $rc): no migration without it (the local dump is $BACKUP_FILE)"
    ok "backup uploaded and verified"
  else
    warn "the backup tool (doc 035) is not installed: only the local dump protects this migration"
  fi
}

migrate() {
  STEP="migrate the database (prisma migrate deploy)"
  log "$STEP"
  MIGRATED=true
  compose --profile tools run --rm migrate || die "the migration failed"
  ok "migrations applied"
}

start_services() {
  STEP="start api and web, then caddy and dns"
  log "$STEP"
  compose up -d --no-build api web || die "api/web did not start"
  wait_healthy api || die "api did not become healthy"
  wait_healthy web || die "web did not become healthy"
  compose up -d --no-build caddy dns || die "caddy/dns did not start"
  ok "services running $AYVO_RELEASE"
}

# --- verification -----------------------------------------------------------------------------

edge_status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$DOMAIN:443:$PROD_TAILNET_IPV4" "$@"; }

verify() {
  local i code health
  STEP="verify: API health (PostgreSQL, Redis, production)"
  log "$STEP"
  health="$(compose exec -T caddy wget -q -O - http://api:4000/api/health 2>/dev/null)" ||
    die "api /api/health is not reachable from Caddy"
  jq -e '.status == "ok" and .environment == "production" and .checks.database == "up" and .checks.redis == "up"' \
    <<<"$health" >/dev/null || die "the API is not healthy: $(jq -c '{status, environment, checks}' <<<"$health")"
  compose exec -T caddy wget -q -O /dev/null http://web:3000/login || die "web is not reachable from Caddy"
  ok "api: production, database up, redis up; web reachable"

  STEP="verify: https://$DOMAIN through the tailnet (the first installation waits for the certificate)"
  log "$STEP"
  for ((i = 0; i < 90; i++)); do
    code="$(edge_status "https://$DOMAIN/login" || true)"
    [[ $code == 200 ]] && break
    sleep 2
  done
  [[ $code == 200 ]] || die "https://$DOMAIN/login answered '$code' (Tailscale split DNS, ACME on public :80, Caddy logs)"
  [[ $(edge_status "https://$DOMAIN/") == 307 ]] || die "GET / must redirect to the sign-in page without a session"
  [[ $(edge_status "https://$DOMAIN/api/auth/me") == 401 ]] || die "GET /api/auth/me must answer 401 without a session"
  [[ $(edge_status "https://$DOMAIN/api/admin/sites") == 401 ]] || die "the administration must require a session"
  ok "sign-in page served; / and the API require the application sign-in"

  STEP="verify: published ports"
  log "$STEP"
  local id line bad=()
  local -A allowed=(
    ["caddy $PROD_TAILNET_IPV4:443->443/tcp"]=1 ["caddy $PROD_TAILNET_IPV4:443->443/udp"]=1
    ["caddy 0.0.0.0:80->80/tcp"]=1
    ["dns $PROD_TAILNET_IPV4:53->1053/tcp"]=1 ["dns $PROD_TAILNET_IPV4:53->1053/udp"]=1)
  for id in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT"); do
    while IFS= read -r line; do
      [[ -z $line || -n ${allowed[$line]:-} ]] || bad+=("$line")
    done < <(docker inspect "$id" | jq -r '.[0] | .Config.Labels["com.docker.compose.service"] as $s
      | (.NetworkSettings.Ports // {}) | to_entries[] | select(.value != null) | .key as $t
      | .value[] | "\($s) \(.HostIp):\(.HostPort)->\($t)"')
  done
  ((${#bad[@]} == 0)) || die "published ports outside the rule (doc 036 §3): ${bad[*]}"
  ok "published: only $PROD_TAILNET_IPV4 (443 tcp/udp, 53) and public IPv4 :80 (ACME)"

  # From this server — NOT a proof for the internet (doc 036 §5: the owner's test from outside).
  STEP="verify (local hint only): the public addresses refuse HTTPS"
  local pub4
  pub4="$(ip -4 -o addr show scope global | awk '$2 != "tailscale0" && $2 !~ /^(docker|br-|veth)/ { sub(/\/.*/, "", $4); print $4; exit }')"
  if [[ -n $pub4 ]]; then
    code=0
    curl -s -o /dev/null --max-time 5 --resolve "$DOMAIN:443:$pub4" "https://$DOMAIN/" || code=$?
    [[ $code == 7 || $code == 28 ]] || die "https via the public IPv4 $pub4 must not connect (curl exit $code)"
    code=0
    curl -s -o /dev/null --max-time 5 --resolve "$DOMAIN:80:$pub4" "http://$DOMAIN/" || code=$?
    [[ $code == 52 ]] || die "http via the public IPv4 must be aborted without an answer (curl exit $code)"
    ok "public $pub4: no HTTPS, :80 aborted (local hint; the external test is doc 036 §5)"
  fi
}

record_release() {
  mkdir -p "$PROD_DIR/state"
  [[ -n $PREVIOUS ]] && printf '%s\n' "$PREVIOUS" >"$PROD_DIR/state/previous-release"
  printf '%s %s\n' "$RELEASE" "$(date -u +%FT%TZ)" >>"$PROD_DIR/state/releases.log"
  printf '%s\n' "$RELEASE" >"$PROD_DIR/state/current-release"
}

# Only this project's images and release exports, only of releases other than the newest
# $KEEP_RELEASES distinct ones and the previous one, never an image a container uses.
remove_old_images() {
  STEP="remove old release images"
  local keep in_use tag image dir
  keep="$( (
    cut -c1-12 "$PROD_DIR/state/releases.log" | tac | awk '!seen[$0]++' | head -n "$KEEP_RELEASES"
    [[ -z $PREVIOUS ]] || printf '%s\n' "${PREVIOUS:0:12}"
  ) | sort -u)"
  in_use="$(docker ps -a --format '{{.Image}}')" || die "cannot list the containers"
  for image in $(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E "^$IMAGE_PREFIX/(api|api-migrate|web):[0-9a-f]{12}$"); do
    tag=${image##*:}
    grep -qx "$tag" <<<"$keep" && continue
    grep -qx "$image" <<<"$in_use" && continue
    docker image rm "$image" >/dev/null && ok "removed old image $image"
  done
  for dir in "$PROD_DIR"/releases/*; do
    [[ -d $dir && ${dir##*/} =~ ^[0-9a-f]{12}$ ]] || continue
    grep -qx "${dir##*/}" <<<"$keep" && continue
    rm -rf "$dir" && ok "removed old release export ${dir##*/}"
  done
}

backup_status() {
  if [[ -d /usr/local/lib/ayvo-backup ]]; then
    PYTHONPATH=/usr/local/lib/ayvo-backup PYTHONDONTWRITEBYTECODE=1 python3 -m ayvo_backup status ||
      warn "the scheduled backups are not fresh (doc 035 §5)"
  else
    warn "the backup tool is not installed yet (doc 035 §6)"
  fi
}

# --- main ---------------------------------------------------------------------------------------

while (($#)); do
  case $1 in
    --check) MODE=check ;;
    --release)
      RELEASE=${2:-}
      shift
      ;;
    --rollback)
      MODE=rollback
      ROLLBACK=${2:-}
      shift
      ;;
    --bootstrap-admin) MODE=bootstrap ;;
    --email)
      ADMIN_EMAIL=${2:-}
      shift
      ;;
    --name)
      ADMIN_NAME=${2:-}
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
# The right host before the first write of any kind (no directory, no log on another host).
require_commands
not_dev_server
not_dev_preview
check_runner
if [[ $MODE == deploy || $MODE == rollback ]]; then
  mkdir -p "$PROD_DIR"
  exec > >(tee -a "$PROD_DIR/deploy.log") 2>&1
fi
tailnet_address
check_host_guard
check_env_files
mkdir -p "$PROD_DIR"
exec 9>"$PROD_DIR/.deploy.lock"
flock -n 9 || die "another production deployment is running"
PREVIOUS="$(current_release || true)"

case $MODE in
  check)
    [[ -n $RELEASE ]] || die "--check needs --release <commit>"
    check_release
    check_resources
    export_release
    check_workos_issuer
    AYVO_RELEASE=${RELEASE:0:12}
    validate_compose
    backup_status
    ok "ready to deploy $RELEASE (running now: ${PREVIOUS:-nothing})"
    ;;
  deploy)
    [[ -n $RELEASE ]] || die "--release <commit> is required (see --help)"
    log "AYVO OS production deployment of $RELEASE at $(date -u +%FT%TZ) (running: ${PREVIOUS:-nothing})"
    check_release
    check_resources
    export_release
    check_workos_issuer
    AYVO_RELEASE=${RELEASE:0:12}
    validate_compose
    backup_status
    build_images
    STEP="start postgres and redis"
    compose up -d --no-build postgres redis || die "postgres/redis did not start"
    wait_healthy postgres || die "postgres did not become healthy"
    wait_healthy redis || die "redis did not become healthy"
    backup_before_migration
    migrate
    start_services
    verify
    record_release
    remove_old_images
    ok "production runs $RELEASE"
    echo "Next: the external negative test (doc 036 §5) after the first installation and every edge change."
    ;;
  rollback)
    [[ $ROLLBACK =~ ^[0-9a-f]{12}$ ]] || die "--rollback needs the 12-character release of an earlier deployment"
    [[ -f $(release_dir "$ROLLBACK")/.ayvo-release ]] || die "release $ROLLBACK was never exported here"
    for image in api web; do
      docker image inspect "$IMAGE_PREFIX/$image:$ROLLBACK" >/dev/null 2>&1 || die "image $IMAGE_PREFIX/$image:$ROLLBACK is gone"
    done
    log "rollback to $ROLLBACK at $(date -u +%FT%TZ) (running: ${PREVIOUS:-nothing}). No migration runs."
    warn "the database keeps its current schema: this is safe only if $ROLLBACK works with it (doc 036 §7)"
    RELEASE=$(<"$(release_dir "$ROLLBACK")/.ayvo-release")
    AYVO_RELEASE=$ROLLBACK
    validate_compose
    start_services
    verify
    record_release
    ok "production runs $RELEASE again"
    ;;
  bootstrap)
    STEP="bootstrap the first administrator"
    [[ -n $ADMIN_EMAIL && -n $ADMIN_NAME ]] || die "--bootstrap-admin needs --email and --name"
    [[ -n $PREVIOUS ]] || die "production is not running: deploy a release first"
    AYVO_RELEASE=$PREVIOUS
    log "$STEP: $ADMIN_EMAIL (one time only; the person then signs in with WorkOS and MFA)"
    compose run --rm --no-deps api node dist/identity/bootstrap-admin.js --email "$ADMIN_EMAIL" --name "$ADMIN_NAME" ||
      die "the bootstrap was refused (see the message above)"
    ok "first administrator created; further users only by invitation"
    ;;
esac
