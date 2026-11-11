#!/usr/bin/env bash
# AYVO OS — prove that certificate renewal still works for the tailnet-only DEV preview (ADR 0026).
#
# Port 443 is not public, so Caddy renews through ACME HTTP-01 on public IPv4 :80 only. This script
# runs the same challenge from Let's Encrypt's validation servers (on the internet) against that
# path, using the STAGING CA: the resulting certificate is untrusted, never installed and deleted
# at once; the live certificate, its ACME account and the production rate limits are untouched.
# The challenge file is written to the acme-webroot volume, which Caddy serves read-only at
# /.well-known/acme-challenge/ (and which is empty otherwise).
#
#   scripts/verify-dev-acme.sh [domain]     (default: dev.ayvo.co; AYVO_DEV_ENV_FILE for ACME_EMAIL)
set -Eeuo pipefail
umask 077

readonly DOMAIN=${1:-dev.ayvo.co}
readonly VOLUME=ayvo-dev-preview-acme-webroot
readonly LEGO_IMAGE=goacme/lego:v4.19.2
readonly STAGING=https://acme-staging-v02.api.letsencrypt.org/directory

[[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || { echo "invalid domain" >&2; exit 1; }
docker volume inspect "$VOLUME" >/dev/null 2>&1 ||
  { echo "volume $VOLUME missing: deploy the tailnet-only Caddy first (scripts/deploy-dev.sh --edge)" >&2; exit 1; }

# The ACME account contact: ACME_EMAIL from the server env file (lego requires one), never printed.
env_file=${AYVO_DEV_ENV_FILE:-/opt/ayvo/secrets/dev-preview.env}
email="$(sed -n "s/^ACME_EMAIL=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}$/\1/p" "$env_file" 2>/dev/null | tail -n1)"
[[ $email =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$ ]] || { echo "ACME_EMAIL missing or invalid in $env_file" >&2; exit 1; }

# lego's state lives in a throwaway Docker volume (not a host path: the image's binary is /lego,
# so the state is mounted at /state), removed on exit with the staging certificate in it.
state="ayvo-acme-staging-$$"
docker volume create "$state" >/dev/null
trap 'docker volume rm -f "$state" >/dev/null 2>&1 || true' EXIT

echo "==> Let's Encrypt STAGING, HTTP-01 for $DOMAIN via public IPv4 :80"
docker run --rm --security-opt no-new-privileges:true \
  -v "$VOLUME:/webroot" -v "$state:/state" "$LEGO_IMAGE" \
  --server "$STAGING" --accept-tos --email "$email" --key-type ec256 \
  --domains "$DOMAIN" --http --http.webroot /webroot --path /state run
echo " ok staging certificate issued: the public HTTP-01 path works (certificate discarded)"
