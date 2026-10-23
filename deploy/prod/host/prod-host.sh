# AYVO OS — is this AyvoOS-PROD? Sourced by the PROD installers and the deploy script BEFORE any
# change (doc 035 §6, doc 036 §3). Refuses another hostname, another Tailscale address, and any trace of the DEV
# preview on this host (its env file, host guard, sysctl or containers). Fails closed: if the
# containers cannot be listed, it refuses too. The expected values are the owner's
# (2026-10-22); if the server is renamed or re-addressed, change them here in a reviewed commit.
AYVO_PROD_HOSTNAME=AyvoOS-PROD
AYVO_PROD_TAILNET_IPV4=100.88.139.2

assert_prod_host() {
  local name ts names marker
  name="$(hostname 2>/dev/null || true)"
  [[ ${name,,} == "${AYVO_PROD_HOSTNAME,,}" ]] ||
    { echo "refusing: this host is '$name', not $AYVO_PROD_HOSTNAME (nothing was changed)" >&2; return 1; }
  for marker in /opt/ayvo/secrets/dev-preview.env /usr/local/sbin/ayvo-dev-docker-guard \
    /etc/systemd/system/ayvo-dev-docker-guard.service /etc/sysctl.d/60-ayvo-dev-tailnet.conf; do
    [[ ! -e $marker ]] ||
      { echo "refusing: DEV preview found on this host ($marker; nothing was changed)" >&2; return 1; }
  done
  names="$(docker ps -a --format '{{.Names}}' 2>/dev/null)" ||
    { echo "refusing: cannot list the containers to rule out DEV (nothing was changed)" >&2; return 1; }
  ! grep -q '^ayvo-dev-preview-' <<<"$names" ||
    { echo "refusing: DEV preview containers run on this host (nothing was changed)" >&2; return 1; }
  ts="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
  [[ $ts == "$AYVO_PROD_TAILNET_IPV4" ]] ||
    { echo "refusing: Tailscale IPv4 is '${ts:-none}', not $AYVO_PROD_TAILNET_IPV4 (nothing was changed)" >&2; return 1; }
}
