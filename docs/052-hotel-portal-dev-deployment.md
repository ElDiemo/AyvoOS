# Hotel portal on the private DEV preview

Runtime and data boundaries are in ADR 0045, PR #127. This is the deployment step for the
already-reviewed application. The portal runs separately as `portal-web`. It owns no data and uses
the existing Core and Finance HTTP contracts. It has no published ports and does not join the
staff, database or Redis networks. The shared DEV host, Caddy, DNS, PostgreSQL and Redis remain
shared failure domains.

## Configuration and preflight

- The DEV portal profile is opt-in. Leave `DEV_PORTAL_DOMAIN` empty for ordinary DEV deployments.
  This leaves the real portal host without a Caddy TLS site or a CoreDNS answer, and leaves the
  two receiving service contracts closed.
- Use the reviewed commit for the Core, Finance and portal-web images. The Core schema needs the
  identity audience and grant migrations. Verify the deployment scripts' normal database and edge
  backups before changing the stack. Save the previous env file separately with mode 600.
- After approval for the DEV DNS and release, set `DEV_PORTAL_DOMAIN=dev-portal.ayvo.co` in
  `/opt/ayvo/secrets/dev-preview.env`. Put two independently generated URL-safe tokens in
  `PORTAL_CORE_TOKEN` and `PORTAL_FINANCE_TOKEN`. Generate them on the server
  with `openssl rand -hex 32`. Store their SHA-256 values in
  `PORTAL_SERVICE_TOKEN_SHA256` and `PORTAL_FINANCE_TOKEN_SHA256`, respectively. Hash the
  value without a newline. Keep the existing Finance-to-Core token separate. Only portal-web
  receives these new plain tokens. Core and Finance each receive only the hash they verify.
- An approved public IPv4 A record for the DEV portal points at the DEV host for HTTP-01. Set no
  public AAAA record. Add a restricted Tailscale nameserver rule for the exact portal name,
  pointing at the existing CoreDNS listener on the DEV host's Tailscale address. Caddy continues
  to publish HTTPS only on the Tailscale IPv4 address and applies the real-peer check for the
  portal too. The HTTP route outside the tailnet aborts except for Caddy's ACME challenge.
- Run `scripts/deploy-dev.sh --check` and `scripts/deploy-finance-dev.sh --check` using the
  approved server env. The Core preflight checks the exact portal name, both tokens and their
  matching hashes before changing anything. Keep bank and invoice mail in simulation on DEV.

## Deploy the reviewed commit

Use the same clean checkout for these steps. Run with a protected env file and without tracing
or printing the rendered Compose environment. The portal uses the same deployment lock as the
other DEV units.

```bash
export DEV_TAILNET_IPV4="$(tailscale ip -4)"
export PORTAL_IMAGE_TAG="$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
# A shell export must not override the approved server-only values.
unset DEV_PORTAL_DOMAIN PORTAL_CORE_TOKEN PORTAL_FINANCE_TOKEN
portal_compose=(docker compose -f deploy/dev/compose.yml
  --env-file /opt/ayvo/secrets/dev-preview.env --profile portal)
flock -n /opt/ayvo/logs/.deploy-dev-preview.lock "${portal_compose[@]}" build --pull portal-web
flock -n /opt/ayvo/logs/.deploy-dev-preview.lock "${portal_compose[@]}" up \
  --detach --wait --wait-timeout 120 --no-deps --no-build portal-web
scripts/deploy-dev.sh
scripts/deploy-finance-dev.sh
```

Check the image tags and portal limits (256 MiB, half a CPU and 128 PIDs). DEV pins Caddy
2.11.9 because 2.11.7 could hang HTTP/1.1 after an upload timeout (Caddy #8165). Caddy limits
all proxied portal bodies to 4 KiB and bounds stalled or trickled requests. It proxies GET and
HEAD, plus POST to auth routes. Portal-web separately enforces its five-second total body deadline. No request to the portal host routes to the
internal web, Core or Finance directly. Before the first switch or a tagged portal release,
`deploy-dev.sh` requires a healthy portal container. It records the checked image on success.
Ordinary staff redeploys with an already active portal do not require the portal to be healthy.

## Verify and disable

1. Verify the TLS certificate and DNS answer over the tailnet. Verify from outside the tailnet
   that HTTPS is unreachable, HTTP other than the ACME challenge is aborted and IPv6 does not
   expose the site. Verify the staff login still works.
2. Confirm `/api/internal/v1/portal/session` aborts at the portal host and `/login` has a nonce CSP.
   Test an oversized auth body and an interrupted upload.
3. With synthetic accounts and an approved test mail path, use the walk from ADR 0045 §11.
   Verify invite → TOTP → own hotel and invoice → PDF, denial for another hotel and revocation.
   Stop only portal-web in a controlled test and verify the internal application and Finance.
4. To disable the portal, unset `DEV_PORTAL_DOMAIN` in the server env, run
   `scripts/deploy-dev.sh --edge` and stop only portal-web with the same Compose profile.
   This removes the portal route and DNS answer. Redeploy the current reviewed Core and Finance
   releases with the domain blank to clear both receiving hashes, then remove the portal's DNS
   records and restricted nameserver rule through the approved infrastructure workflow. Use the
   previous env and the pre-switch Caddy backup if the edge update fails. Restoring the Caddy
   backup only restores Caddy. With the previous env, run `scripts/deploy-dev.sh --edge` from
   the reviewed checkout to restore the CoreDNS configuration as well. Verify that
   `dig @"$DEV_TAILNET_IPV4" dev-portal.ayvo.co A` returns REFUSED for the disabled portal.
   A Core release predating portal audiences must never be restored once a portal account or
   session exists. Keep the data and recover using the reviewed version or a forward fix.

A customer-facing address and its edge are a separate release.
