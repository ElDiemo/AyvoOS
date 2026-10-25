#!/bin/sh
# AYVO marketing site — the content digest of one release (ADR 0040): SHA-256 over the sorted list
# "<sha256>  Caddyfile" and "<sha256>  site/<path>" of every served file. The same digest from the
# repository (site-digest.sh Caddyfile site) and inside the running container
# (site-digest /etc/caddy/Caddyfile /srv) proves DEV and PROD serve the same artifact.
set -eu
caddyfile=$1
site=$2
{
  printf '%s  Caddyfile\n' "$(sha256sum "$caddyfile" | cut -d' ' -f1)"
  cd "$site"
  find . -type f | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s  site/%s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "${f#./}"
  done
} | sha256sum | cut -d' ' -f1
