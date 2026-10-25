#!/usr/bin/env bash
# AYVO OS — deploy PRODUCTION (https://os.ayvo.co) on AyvoOS-PROD. Doc 036, ADR 0033; the public
# QR edge (https://<QR host>/<token>): doc 037, ADR 0035.
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
#   scripts/deploy-prod.sh --activate-bootstrap --email <e-mail> [--resend]
#                                                         e-mail the native activation link to that
#                                                         existing, not yet activated bootstrap ADMIN
#                                                         (doc 038 §4; nobody else, nothing created);
#                                                         --resend: a new link, the old one stops
#   scripts/deploy-prod.sh --marketing --release <commit> --expect-digest <sha256>
#                                                         the public marketing site alone (ADR 0040):
#                                                         build its image from <commit>, require the
#                                                         content digest accepted on DEV, replace only
#                                                         the `marketing` container (no OS restart)
#   scripts/deploy-prod.sh --marketing-rollback <release> start an earlier marketing image again
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
# ID_DOMAIN (optional): the public employee-card host; unset = no ID edge at all (compose.id.yml).
# MARKETING_DOMAIN (optional): the public marketing site's apex (served with www.<apex>); unset = no
# marketing site at all (compose.marketing.yml, ADR 0040).
readonly ALLOW_PROD="$KEYS_PROD $QR_LABEL_KEYS CARRIER_CREDENTIALS_KEY ID_DOMAIN MARKETING_DOMAIN"
readonly KEYS_AUTH="AUTH_ENCRYPTION_KEY AUTH_MAIL_DRIVER AUTH_MAIL_FROM"
readonly ALLOW_AUTH="$KEYS_AUTH AUTH_SMTP_HOST AUTH_SMTP_PORT AUTH_SMTP_USER AUTH_SMTP_PASSWORD"
readonly KEYS_S3="AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY"
# Region, bucket and owner may be in the file too; compose.yml's fixed values take precedence.
readonly ALLOW_S3="$KEYS_S3 AWS_REGION S3_BUCKET S3_EXPECTED_BUCKET_OWNER"

MODE=deploy
RELEASE=""
ROLLBACK=""
ADMIN_EMAIL=""
ADMIN_NAME=""
RESEND=""
STEP="start"
BACKUP_FILE=""
MIGRATED=false
PREVIOUS=""
EXPECT_DIGEST=""
MARKETING_ROLLBACK=""
MARKETING_RELEASE=""
MARKETING_RELEASE_DIR=""

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31mFAILED\033[0m at "%s": %s\n' "$STEP" "$*" >&2
  exit 1
}
usage() { sed -n '2,39p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

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
  for cmd in docker git curl jq awk flock tar sha256sum stat tailscale ip systemctl sysctl df getent base64 runuser; do
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

# The public QR edge listens only on the server's public IPv4 (never 0.0.0.0, never IPv6).
public_address() {
  local ext
  ext="$(ip -4 route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')"
  [[ -n $ext && $ext != tailscale0 ]] || die "no public default route (or it is the tailnet)"
  PROD_PUBLIC_IPV4="$(ip -4 -o addr show dev "$ext" scope global | awk '{ sub(/\/.*/, "", $4); print $4; exit }')"
  [[ $PROD_PUBLIC_IPV4 =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "no public IPv4 address on $ext"
}

# The QR host is the one of PUBLIC_QR_BASE_URL (the API accepts only the production QR host there,
# ADR 0014) — never a second, independently configured name.
qr_domain() {
  local base
  base="$(env_value "$SECRETS/prod.env" PUBLIC_QR_BASE_URL)"
  [[ $base =~ ^https://([a-z0-9]([a-z0-9.-]*[a-z0-9])?)$ ]] ||
    die "PUBLIC_QR_BASE_URL must be https://<host> without a path (doc 037)"
  QR_DOMAIN=${BASH_REMATCH[1]}
  [[ $QR_DOMAIN != "$DOMAIN" ]] || die "the QR host must not be $DOMAIN (the internal application)"
}

# The optional public ID host (employee business cards). Unset or empty: nothing of the ID edge is
# created. Its DNS is NOT required to point here: the certificate can be obtained before the DNS
# change through the old server's challenge-only forward (HTTP-01 via public :80).
id_domain() {
  # Absent key = no ID edge (env_value fails when grep finds nothing).
  ID_DOMAIN="$(env_value "$SECRETS/prod.env" ID_DOMAIN || true)"
  [[ -z $ID_DOMAIN ]] && return
  [[ $ID_DOMAIN =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
    die "ID_DOMAIN must be a plain host name (e.g. id.ayvo.co)"
  [[ $ID_DOMAIN != "$DOMAIN" && $ID_DOMAIN != "$QR_DOMAIN" ]] ||
    die "ID_DOMAIN must differ from $DOMAIN and the QR host"
}

# The optional public marketing site (ADR 0040): MARKETING_DOMAIN is its apex; www.<apex> is served
# too (redirected to the apex). Unset or empty: nothing of the marketing site is created. Its DNS
# may still point to the old server (certificates through the challenge-only forward, as for ID).
marketing_domain() {
  MARKETING_DOMAIN="$(env_value "$SECRETS/prod.env" MARKETING_DOMAIN || true)"
  [[ -z $MARKETING_DOMAIN ]] && return
  [[ $MARKETING_DOMAIN =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
    die "MARKETING_DOMAIN must be a plain host name (the apex, e.g. ayvo.co)"
  [[ $MARKETING_DOMAIN != www.* ]] || die "MARKETING_DOMAIN is the apex; www.<apex> is served by itself"
  local other
  for other in "$DOMAIN" "$QR_DOMAIN" "${ID_DOMAIN:-}"; do
    [[ -z $other ]] && continue
    [[ $other != "$MARKETING_DOMAIN" && $other != "www.$MARKETING_DOMAIN" ]] ||
      die "MARKETING_DOMAIN (and www.) must differ from $other"
  done
}

# Information only: where the ID host points now (before the DNS change it is the old server).
id_dns_info() {
  [[ -n $ID_DOMAIN ]] || return 0
  local a
  a="$(getent ahostsv4 "$ID_DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ')" || true
  if [[ $a == "$PROD_PUBLIC_IPV4 " ]]; then
    ok "$ID_DOMAIN -> $PROD_PUBLIC_IPV4"
  else
    warn "$ID_DOMAIN points to ${a:-nothing} (not this server): its certificate needs the old server's challenge-only forward until the DNS change"
  fi
}

# DNS of the QR host must point at this server (certificate issuance needs it; no AAAA yet).
check_qr_dns() {
  local a aaaa
  a="$(getent ahostsv4 "$QR_DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ')" || true
  [[ " $a" == *" $PROD_PUBLIC_IPV4 "* ]] ||
    die "$QR_DOMAIN must resolve to $PROD_PUBLIC_IPV4 (A record), found: ${a:-nothing}"
  aaaa="$(getent ahostsv6 "$QR_DOMAIN" 2>/dev/null | awk '$1 ~ /:/ && $1 !~ /^::ffff:/ { print $1 }' | sort -u | tr '\n' ' ')" || true
  [[ -z $aaaa ]] || warn "$QR_DOMAIN has AAAA records ($aaaa): IPv6 is not served (doc 037)"
  ok "$QR_DOMAIN -> $PROD_PUBLIC_IPV4"
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
# Authentication mail (doc 038): exactly one explicit mode, the same rules as the API. Values are
# never printed. google-relay = the approved Google Workspace relay (fixed host, TLS, IPv4
# allowlist, no credentials); smtp = authenticated submission with user AND password.
check_auth_mail() {
  local driver=$1 host=$2 user=$3 pass=$4 port=$5
  case $driver in
    google-relay)
      [[ -z $host && -z $user && -z $pass ]] ||
        die "AUTH_MAIL_DRIVER=google-relay uses no SMTP host or credentials: remove AUTH_SMTP_HOST/USER/PASSWORD" ;;
    smtp)
      [[ -n $host && -n $user && -n $pass ]] ||
        die "AUTH_MAIL_DRIVER=smtp needs AUTH_SMTP_HOST, AUTH_SMTP_USER and AUTH_SMTP_PASSWORD"
      [[ ${port:-465} == 465 || ${port:-465} == 587 ]] || die "AUTH_SMTP_PORT must be 465 or 587 (TLS required)" ;;
    *) die "AUTH_MAIL_DRIVER must be smtp or google-relay" ;;
  esac
}

# A generated key has ~16 distinct hex digits; a test key or a typed pattern has few.
check_auth_key() {
  [[ $1 =~ ^[a-fA-F0-9]{64}$ ]] || die "$2: AUTH_ENCRYPTION_KEY must be a separately generated 32-byte hex key"
  (( $(fold -w1 <<<"${1,,}" | sort -u | wc -l) >= 10 )) ||
    die "$2: AUTH_ENCRYPTION_KEY is not random; generate it with: openssl rand -hex 32"
}

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
  check_env_file "$SECRETS/prod-auth.env" "$KEYS_AUTH" "$ALLOW_AUTH"
  local auth="$SECRETS/prod-auth.env"
  check_auth_key "$(env_value "$auth" AUTH_ENCRYPTION_KEY)" prod-auth.env
  check_auth_mail "$(env_value "$auth" AUTH_MAIL_DRIVER)" "$(env_value "$auth" AUTH_SMTP_HOST)" \
    "$(env_value "$auth" AUTH_SMTP_USER)" "$(env_value "$auth" AUTH_SMTP_PASSWORD)" \
    "$(env_value "$auth" AUTH_SMTP_PORT)"
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

# The compose files of a release: compose.yml, plus compose.id.yml only when ID_DOMAIN is set and
# that release has it (an older release rolled back to simply runs without the ID edge).
compose_files() {
  local dir=$1
  printf '%s\n' -f "$dir/deploy/prod/compose.yml"
  if [[ -n ${ID_DOMAIN:-} && -f $dir/deploy/prod/compose.id.yml ]]; then
    printf '%s\n' -f "$dir/deploy/prod/compose.id.yml"
  fi
  # The marketing site (ADR 0040) only when MARKETING_DOMAIN is set and the release has it.
  if [[ -n ${MARKETING_DOMAIN:-} && -f $dir/deploy/prod/compose.marketing.yml ]]; then
    printf '%s\n' -f "$dir/deploy/prod/compose.marketing.yml"
  fi
}

compose() {
  local dir files
  dir="$(release_dir "$AYVO_RELEASE")"
  mapfile -t files < <(compose_files "$dir")
  PROD_DOMAIN=$DOMAIN PROD_TAILNET_IPV4=$PROD_TAILNET_IPV4 AYVO_RELEASE=$AYVO_RELEASE \
    PROD_PUBLIC_IPV4=$PROD_PUBLIC_IPV4 QR_DOMAIN=$QR_DOMAIN ID_DOMAIN=${ID_DOMAIN:-} \
    MARKETING_DOMAIN=${MARKETING_DOMAIN:-} MARKETING_RELEASE=${MARKETING_RELEASE:-none} \
    MARKETING_RELEASE_DIR=${MARKETING_RELEASE_DIR:-/nonexistent} \
    AYVO_RELEASE_DIR=$dir AYVO_PROD_SECRETS_DIR=$SECRETS \
    docker compose -p "$PROJECT" --project-directory "$dir/deploy/prod" \
    "${files[@]}" --env-file "$SECRETS/prod.env" "$@"
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
current_marketing() { docker inspect --format '{{.Config.Image}}' "$PROJECT-marketing-1" 2>/dev/null | sed -n "s|^$IMAGE_PREFIX/marketing:||p"; }

# --- the marketing site (ADR 0040) -------------------------------------------------------------

marketing_dir() { printf '%s/marketing/%s' "$PROD_DIR" "${1:0:12}"; }

# apps/marketing of exactly that commit, in its own directory (never touched by remove_old_images).
export_marketing() {
  STEP="export the marketing site of $RELEASE"
  local dir
  dir="$(marketing_dir "$RELEASE")"
  if [[ -f $dir/.ayvo-release ]] && [[ $(<"$dir/.ayvo-release") == "$RELEASE" ]]; then
    ok "marketing release already exported: $dir"
    return
  fi
  rm -rf "$dir.partial"
  (
    umask 022
    mkdir -p "$dir.partial"
    repo_git archive --format=tar "$RELEASE" apps/marketing | tar -x --no-same-owner -C "$dir.partial"
    printf '%s\n' "$RELEASE" >"$dir.partial/.ayvo-release"
  )
  chmod -R a+rX,go-w "$dir.partial"
  [[ ! -e $dir ]] || die "$dir exists but is not a complete export of $RELEASE: inspect and remove it by hand"
  mv "$dir.partial" "$dir"
  ok "exported apps/marketing of $RELEASE"
}

# The content digest of a release directory and of the running container (apps/marketing/site-digest.sh).
marketing_digest() { (cd "$1/apps/marketing" && sh ./site-digest.sh Caddyfile site); }
running_marketing_digest() { docker exec "$PROJECT-marketing-1" site-digest /etc/caddy/Caddyfile /srv; }

record_marketing() {
  mkdir -p "$PROD_DIR/state"
  printf '%s %s digest=%s\n' "$MARKETING_RELEASE" "$(date -u +%FT%TZ)" "$1" >>"$PROD_DIR/state/marketing.log"
}
recorded_marketing_digest() {
  [[ -f $PROD_DIR/state/marketing.log ]] || return 0
  awk -v t="$1" '$1 == t { for (i = 3; i <= NF; i++) if ($i ~ /^digest=/) d = substr($i, 8) } END { if (d) print d }' \
    "$PROD_DIR/state/marketing.log"
}

start_marketing() {
  STEP="start only the marketing container ($MARKETING_RELEASE)"
  log "$STEP"
  compose up -d --no-build --no-deps marketing || die "the marketing container did not start"
  wait_healthy marketing || die "the marketing container did not become healthy"
  local digest
  digest="$(running_marketing_digest)" || die "cannot read the digest of the running marketing site"
  [[ $digest == "$1" ]] || die "the running marketing site has digest $digest, not $1"
  ok "marketing $MARKETING_RELEASE running, digest $digest"
}

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

# The S3 backup tool's state (lock, results, tmp) — owned by the approved owner, like the timer's
# StateDirectory=ayvo-backup (ops/prod-backup/systemd/ayvo-prod-backup@.service).
readonly BACKUP_STATE_DIR=/var/lib/ayvo-backup # = ayvo_backup STATE_DIR

# Entries of the backup state that the owner does not own (names only, never contents).
foreign_backup_state() { find "$BACKUP_STATE_DIR" ! -user "$(owner_uid)" -printf '%P\n' 2>/dev/null | head -n 5; }

# The pre-deploy S3 backup in the context of the scheduled one (User=ayvo, its primary group,
# SupplementaryGroups=docker, UMask=0077): its credentials stay ayvo:600 and everything it writes
# stays usable by the timer. A root run was refused by those credentials and left a root-owned
# result that broke `status` for ayvo (PROD 2026-10-24). docker is given to this one process
# only (runuser -G), never permanently. Returns the tool's exit code (75 = busy).
s3_backup_as_owner() {
  local reason=$1 owner group home rc=0 foreign
  owner=$DEPLOY_OWNER
  group="$(id -gn "$owner")" || die "the approved owner $owner has no group"
  home="$(getent passwd "$owner" | cut -d: -f6)"
  if [[ ! -d $BACKUP_STATE_DIR ]]; then
    install -d -o "$owner" -g "$group" -m 0750 "$BACKUP_STATE_DIR" || die "cannot create $BACKUP_STATE_DIR"
  fi
  foreign="$(foreign_backup_state)"
  [[ -z $foreign ]] || die "$BACKUP_STATE_DIR has entries not owned by $owner (${foreign//$'\n'/, }): the backup timer could not use them — inspect and restore their owner, never delete results blindly"
  # systemd's default PATH, as the timer's service gets it. The reason is an argument of sh, not code.
  # shellcheck disable=SC2016
  local cmd=(env -i "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" "HOME=$home" "PYTHONPATH=/usr/local/lib/ayvo-backup"
    PYTHONDONTWRITEBYTECODE=1 sh -c 'umask 077 && exec python3 -m ayvo_backup run --kind daily --reason "$1"' sh "$reason")
  if [[ $(id -u) == 0 ]]; then
    runuser -u "$owner" -g "$group" -G docker -- "${cmd[@]}" || rc=$?
  else
    "${cmd[@]}" || rc=$? # check_runner: the approved owner itself
  fi
  foreign="$(foreign_backup_state)"
  [[ -z $foreign ]] || die "the backup left entries not owned by $owner in $BACKUP_STATE_DIR (${foreign//$'\n'/, })"
  return "$rc"
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
      s3_backup_as_owner "pre-deploy ${AYVO_RELEASE}" || rc=$?
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
  STEP="start api and web, then caddy, dns and the public QR edge"
  log "$STEP"
  compose up -d --no-build api web || die "api/web did not start"
  wait_healthy api || die "api did not become healthy"
  wait_healthy web || die "web did not become healthy"
  compose up -d --no-build caddy dns qr-edge || die "caddy/dns/qr-edge did not start"
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
    ["dns $PROD_TAILNET_IPV4:53->1053/tcp"]=1 ["dns $PROD_TAILNET_IPV4:53->1053/udp"]=1
    ["qr-edge $PROD_PUBLIC_IPV4:443->443/tcp"]=1)
  for id in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT"); do
    while IFS= read -r line; do
      [[ -z $line || -n ${allowed[$line]:-} ]] || bad+=("$line")
    done < <(docker inspect "$id" | jq -r '.[0] | .Config.Labels["com.docker.compose.service"] as $s
      | (.NetworkSettings.Ports // {}) | to_entries[] | select(.value != null) | .key as $t
      | .value[] | "\($s) \(.HostIp):\(.HostPort)->\($t)"')
  done
  ((${#bad[@]} == 0)) || die "published ports outside the rule (doc 036 §3): ${bad[*]}"
  ok "published: $PROD_TAILNET_IPV4 (443 tcp/udp, 53), public IPv4 :80 (ACME) and $PROD_PUBLIC_IPV4:443 (QR edge)"

  # From this server — NOT a proof for the internet (doc 037 §5: the owner's test from outside).
  STEP="verify (local hint only): the public address serves only the QR passport"
  local pub4=$PROD_PUBLIC_IPV4 unknown
  unknown="$(head -c 16 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
  qr_status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$QR_DOMAIN:443:$pub4" "$@"; }
  for ((i = 0; i < 90; i++)); do
    code="$(qr_status "https://$QR_DOMAIN/$unknown" || true)"
    [[ $code == 404 ]] && break
    sleep 2
  done
  [[ $code == 404 ]] || die "https://$QR_DOMAIN/<unknown token> answered '$code' (DNS A record, TLS-ALPN on public :443, qr-edge logs)"
  local path
  for path in /login / /api/health /api/public/bottles/$unknown /q/$unknown /admin /sales; do
    [[ $(qr_status "https://$QR_DOMAIN$path") == 404 ]] || die "https://$QR_DOMAIN$path must be a plain 404 (doc 037)"
  done
  # The internal application's name on the public address: no certificate, no answer.
  code=0
  curl -s -o /dev/null --max-time 5 --resolve "$DOMAIN:443:$pub4" "https://$DOMAIN/" || code=$?
  [[ $code != 0 ]] || die "https://$DOMAIN must not be served on the public IPv4 $pub4"
  # The QR certificate with another Host header: refused (strict SNI), never the application.
  [[ $(qr_status -H "Host: $DOMAIN" "https://$QR_DOMAIN/login") == 421 ]] ||
    die "a request for $DOMAIN through the QR name must be refused (421)"
  code=0
  curl -s -o /dev/null --max-time 5 --resolve "$DOMAIN:80:$pub4" "http://$DOMAIN/" || code=$?
  [[ $code == 52 ]] || die "http via the public IPv4 must be aborted without an answer (curl exit $code)"
  ok "public $pub4: only GET /<token> of $QR_DOMAIN; $DOMAIN and other paths refused (local hint; the external test is doc 037 §5)"
  verify_id_edge "$pub4"
  verify_marketing_edge "$pub4"
}

# The public ID edge (only when enabled). Its certificate may not exist yet (DNS still on the old
# server, forward not in place): that is reported, never a reason to fail the deployment.
verify_id_edge() {
  [[ -n ${ID_DOMAIN:-} && -f $(release_dir "$AYVO_RELEASE")/deploy/prod/compose.id.yml ]] || return 0
  local pub4=$1 code unknown
  STEP="verify (local hint only): the public ID edge"
  # :80 for the ID host: only the challenge path reaches qr-edge (an HTTP answer); all else aborted.
  code=0
  curl -s -o /dev/null --max-time 5 --resolve "$ID_DOMAIN:80:$pub4" "http://$ID_DOMAIN/admin" || code=$?
  [[ $code == 52 ]] || die "http://$ID_DOMAIN/admin via the public IPv4 must be aborted (curl exit $code)"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$ID_DOMAIN:80:$pub4" \
    "http://$ID_DOMAIN/.well-known/acme-challenge/ayvo-deploy-check" || true)"
  [[ $code =~ ^[1-5][0-9][0-9]$ ]] || die "the ACME challenge path of $ID_DOMAIN does not reach the ID edge (got '$code')"
  unknown="zz-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  id_status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$ID_DOMAIN:443:$pub4" "$@"; }
  code="$(id_status "https://$ID_DOMAIN/$unknown" || true)"
  if [[ $code == 000 ]]; then
    warn "https://$ID_DOMAIN has no valid certificate yet (expected before the challenge forward / DNS change)"
    return 0
  fi
  [[ $code == 404 ]] || die "https://$ID_DOMAIN/<unknown slug> answered '$code'"
  local path
  for path in /admin /login /api/health /q/$unknown /employee-card/README.md "/$unknown/x"; do
    [[ $(id_status "https://$ID_DOMAIN$path") == 404 ]] || die "https://$ID_DOMAIN$path must be a plain 404"
  done
  [[ $(id_status -H "Host: $DOMAIN" "https://$ID_DOMAIN/") == 421 ]] ||
    die "a request for $DOMAIN through the ID name must be refused (421)"
  ok "public $pub4: $ID_DOMAIN serves only the card routes (valid certificate; local hint)"
}

# The public marketing site (only when enabled). Before the DNS change and the challenge forward its
# certificates may not exist, and before the first `--marketing` deployment its container may not
# run: both are reported, never a reason to fail an OS deployment.
verify_marketing_edge() {
  [[ -n ${MARKETING_DOMAIN:-} && -f $(release_dir "$AYVO_RELEASE")/deploy/prod/compose.marketing.yml ]] || return 0
  local pub4=$1 code host path
  STEP="verify (local hint only): the public marketing site"
  for host in "$MARKETING_DOMAIN" "www.$MARKETING_DOMAIN"; do
    # :80 — the challenge path reaches qr-edge (an HTTP answer); everything else → https, same name.
    code="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 5 --resolve "$host:80:$pub4" "http://$host/cz/" || true)"
    [[ $code == "301 https://$host/cz/" ]] || die "http://$host/cz/ via the public IPv4 must redirect to https://$host/cz/ (got '$code')"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$host:80:$pub4" \
      "http://$host/.well-known/acme-challenge/ayvo-deploy-check" || true)"
    [[ $code =~ ^[1-5][0-9][0-9]$ ]] || die "the ACME challenge path of $host does not reach the public edge (got '$code')"
  done
  mk_status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$1:443:$pub4" "${@:2}"; }
  code="$(mk_status "$MARKETING_DOMAIN" "https://$MARKETING_DOMAIN/" || true)"
  if [[ $code == 000 ]]; then
    warn "https://$MARKETING_DOMAIN has no valid certificate yet (expected before the challenge forward / DNS change)"
    return 0
  fi
  if [[ $code == 503 ]]; then
    warn "https://$MARKETING_DOMAIN: the marketing container is not running yet (deploy it with --marketing)"
    return 0
  fi
  [[ $code == 200 ]] || die "https://$MARKETING_DOMAIN/ answered '$code'"
  [[ $(mk_status "$MARKETING_DOMAIN" -X POST "https://$MARKETING_DOMAIN/") == 405 ]] ||
    die "https://$MARKETING_DOMAIN must refuse POST (405)"
  for path in /api/health /login /q/x /wp-admin/; do
    [[ $(mk_status "$MARKETING_DOMAIN" "https://$MARKETING_DOMAIN$path") == 404 ]] ||
      die "https://$MARKETING_DOMAIN$path must be a plain 404"
  done
  [[ $(mk_status "$MARKETING_DOMAIN" -H "Host: $DOMAIN" "https://$MARKETING_DOMAIN/") == 421 ]] ||
    die "a request for $DOMAIN through the marketing name must be refused (421)"
  code="$(mk_status "www.$MARKETING_DOMAIN" "https://www.$MARKETING_DOMAIN/cz/" || true)"
  [[ $code == 301 || $code == 000 ]] || die "https://www.$MARKETING_DOMAIN must redirect to the apex (got '$code')"
  [[ $code == 301 ]] || warn "https://www.$MARKETING_DOMAIN has no valid certificate yet"
  ok "public $pub4: $MARKETING_DOMAIN serves the marketing site only (local hint)"
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
    --marketing) MODE=marketing ;;
    --expect-digest)
      EXPECT_DIGEST=${2:-}
      shift
      ;;
    --marketing-rollback)
      MODE=marketing-rollback
      MARKETING_ROLLBACK=${2:-}
      shift
      ;;
    --activate-bootstrap) MODE=activate ;;
    --resend) RESEND=--resend ;;
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
if [[ $MODE == deploy || $MODE == rollback || $MODE == marketing || $MODE == marketing-rollback ]]; then
  mkdir -p "$PROD_DIR"
  exec > >(tee -a "$PROD_DIR/deploy.log") 2>&1
fi
tailnet_address
public_address
check_host_guard
check_env_files
qr_domain
id_domain
marketing_domain
mkdir -p "$PROD_DIR"
exec 9>"$PROD_DIR/.deploy.lock"
flock -n 9 || die "another production deployment is running"
PREVIOUS="$(current_release || true)"
# An OS deployment keeps whatever marketing image runs (it never builds, starts or stops it).
MARKETING_RELEASE="$(current_marketing || true)"

case $MODE in
  check)
    [[ -n $RELEASE ]] || die "--check needs --release <commit>"
    check_release
    check_resources
    export_release
    ok "native authentication: no external identity-provider discovery"
    check_qr_dns
    id_dns_info
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
    ok "native authentication: no external identity-provider discovery"
    check_qr_dns
    id_dns_info
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
  marketing)
    [[ -n $RELEASE ]] || die "--marketing needs --release <commit>"
    [[ $EXPECT_DIGEST =~ ^[0-9a-f]{64}$ ]] ||
      die "--marketing needs --expect-digest <sha256> (the digest of the release accepted on DEV)"
    [[ -n ${MARKETING_DOMAIN:-} ]] || die "MARKETING_DOMAIN is not set in prod.env"
    [[ -n $PREVIOUS ]] || die "production is not running: deploy the OS release first"
    AYVO_RELEASE=$PREVIOUS
    [[ -f $(release_dir "$AYVO_RELEASE")/deploy/prod/compose.marketing.yml ]] ||
      die "the running OS release $AYVO_RELEASE has no compose.marketing.yml: deploy an OS release with it first"
    log "marketing site of $RELEASE at $(date -u +%FT%TZ) (OS stays $AYVO_RELEASE; marketing now: ${MARKETING_RELEASE:-nothing})"
    check_release
    repo_git cat-file -e "$RELEASE:apps/marketing/site-digest.sh" 2>/dev/null || die "$RELEASE has no apps/marketing"
    export_marketing
    MARKETING_RELEASE=${RELEASE:0:12}
    MARKETING_RELEASE_DIR="$(marketing_dir "$RELEASE")"
    STEP="check the marketing digest"
    digest="$(marketing_digest "$MARKETING_RELEASE_DIR")" || die "cannot compute the marketing digest"
    [[ $digest == "$EXPECT_DIGEST" ]] || die "the marketing site of $RELEASE has digest $digest, not the accepted $EXPECT_DIGEST"
    ok "the content of $RELEASE is the accepted artifact ($digest)"
    validate_compose
    STEP="build the marketing image"
    compose build marketing || die "building the marketing image failed"
    start_marketing "$digest"
    verify_marketing_edge "$PROD_PUBLIC_IPV4"
    record_marketing "$digest"
    ok "the marketing site runs $RELEASE; the OS was not restarted"
    ;;
  marketing-rollback)
    [[ $MARKETING_ROLLBACK =~ ^[0-9a-f]{12}$ ]] || die "--marketing-rollback needs the 12-character release of an earlier marketing deployment"
    [[ -n $PREVIOUS ]] || die "production is not running"
    AYVO_RELEASE=$PREVIOUS
    docker image inspect "$IMAGE_PREFIX/marketing:$MARKETING_ROLLBACK" >/dev/null 2>&1 ||
      die "image $IMAGE_PREFIX/marketing:$MARKETING_ROLLBACK is gone"
    digest="$(recorded_marketing_digest "$MARKETING_ROLLBACK")"
    [[ -n $digest ]] || die "no recorded digest for marketing $MARKETING_ROLLBACK"
    MARKETING_RELEASE=$MARKETING_ROLLBACK
    log "marketing rollback to $MARKETING_ROLLBACK (OS stays $AYVO_RELEASE)"
    validate_compose
    start_marketing "$digest"
    verify_marketing_edge "$PROD_PUBLIC_IPV4"
    record_marketing "$digest"
    ok "the marketing site runs $MARKETING_ROLLBACK again"
    ;;
  bootstrap)
    STEP="bootstrap the first administrator"
    [[ -n $ADMIN_EMAIL && -n $ADMIN_NAME ]] || die "--bootstrap-admin needs --email and --name"
    [[ -n $PREVIOUS ]] || die "production is not running: deploy a release first"
    AYVO_RELEASE=$PREVIOUS
    log "$STEP: $ADMIN_EMAIL (one time only; then --activate-bootstrap sends the activation link)"
    compose run --rm --no-deps api node dist/identity/bootstrap-admin.js --email "$ADMIN_EMAIL" --name "$ADMIN_NAME" ||
      die "the bootstrap was refused (see the message above)"
    ok "first administrator created; further users only by invitation"
    ;;
  activate)
    STEP="send the native activation link to the bootstrap administrator"
    [[ -n $ADMIN_EMAIL ]] || die "--activate-bootstrap needs --email"
    [[ -n $PREVIOUS ]] || die "production is not running: deploy a release first"
    AYVO_RELEASE=$PREVIOUS
    log "$STEP: $ADMIN_EMAIL (no link, password or MFA secret is printed)"
    # Exit 1 = refused or still queued; 2 = the link was opened or its delivery is exhausted
    # (then --resend). The command's own message says which; nothing secret is printed.
    compose run --rm --no-deps api node dist/identity/native-invite-bootstrap.js --email "$ADMIN_EMAIL" ${RESEND:+"$RESEND"} ||
      die "no new activation e-mail was accepted (see the message above)"
    ok "see the message above; delivery to the mailbox is confirmed by the person"
    ;;
esac
