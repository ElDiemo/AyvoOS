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
`deploy-dev.sh` requires a healthy portal container. With an explicit `PORTAL_IMAGE_TAG`, the
running container must also be the image that tag names now (same image ID), so a tag reused by a
later build cannot pass. On success the deployment log records `portal_image=` and
`portal_image_id=`. Ordinary staff redeploys with an already active portal and no
`PORTAL_IMAGE_TAG` do not check the portal.

## Keep the running Caddy's source

The next deployment first backs up the running edge (`scripts/dev-edge-backup.sh`) and finds its
Compose file only through Caddy's own labels (`com.docker.compose.project.working_dir` and
`…config_files`). Caddy runs from one of two sources, and each must stay intact while it runs:

- **a deploy checkout**: the label is `<checkout>/deploy/dev`, written when `deploy-dev.sh`
  recreated Caddy from that checkout;
- **a verified edge backup**: the label is a backup directory
  `/opt/ayvo/backups/dev-preview/edge-before-*`, written by `dev-edge-backup.sh restore`.

Neither the last `SUCCESS` line nor Caddy's image tag says which commit Caddy runs from:
`deploy-dev.sh` switches Caddy before its verification and writes `SUCCESS` only afterwards, so a
run whose verification failed (`FAILED step=verify…`) can leave Caddy on its new checkout while the
last `SUCCESS` names an older one. The image is plain `caddy:<version>`, and the label
`com.ayvo.edge-commit` is the last change of `deploy/dev`, not the release's HEAD.

**0. Read-only check before every deployment.** It changes nothing on DEV and stops on any doubt;
a failing `git` is a stop, never a clean result:

```bash
bash <<'CHECK'
set -uo pipefail
stop() { echo "STOP: $*" >&2; exit 1; }
dir="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' \
  ayvo-dev-preview-caddy-1)" || stop "Caddy is not running or has no Compose labels"
case "$dir" in
  /opt/ayvo/backups/dev-preview/edge-before-*)
    [[ -f $dir/COMPLETE ]] || stop "$dir is not a complete edge backup"
    (cd "$dir" && sha256sum --quiet -c SHA256SUMS) || stop "checksums in $dir do not match"
    echo "OK backup $dir" ;;
  */deploy/dev)
    checkout="${dir%/deploy/dev}"
    [[ -f $dir/compose.yml ]] || stop "$dir/compose.yml is missing"
    head="$(git -C "$checkout" rev-parse --short=12 HEAD)" || stop "git cannot read $checkout"
    changes="$(git -C "$checkout" status --porcelain)" || stop "git status failed in $checkout"
    [[ -z $changes ]] || stop "$checkout has local changes"
    echo "OK checkout $checkout $head" ;;
  *) stop "unknown Caddy source: $dir" ;;
esac
CHECK
```

1. Deploy from a detached checkout of the reviewed commit named after it, for example
   `git worktree add --detach /opt/ayvo/repos/AyvoOS-deploy-<sha7> <commit>`, and never edit it.
2. Keep the checkout or backup that the check names until the next deployment's check names
   another one. Remove an old checkout only when the check names a different source.
3. **A normal deployment** (`SUCCESS`): the check then names the new checkout; the previous
   checkout may be removed.
4. **Verification failed after the switch** (`FAILED step=verify…`, Caddy recreated): run the check.
   It names the source Caddy really runs from, usually the new checkout; keep both checkouts.
   Either deploy again from a checkout, or restore the edge with the backup the failure printed
   (`scripts/dev-edge-backup.sh restore <edge-before-…> <env file>`); then the check names that
   backup.
5. **Running from a restored backup**: keep that `edge-before-*` directory; the check verifies
   `COMPLETE` and the checksums. The next deployment backs it up from there. Never remove or edit
   it while Caddy runs from it.
6. **The checkout is gone** (the check stops): restore it only if its commit is proven, otherwise
   stop and ask before any deployment. Proof: the checkout's name holds its commit
   (`AyvoOS-deploy-<sha7>`) and the first line after Caddy's creation time
   (`docker inspect --format '{{.Created}}' ayvo-dev-preview-caddy-1`) in
   `/opt/ayvo/logs/deployments-dev-preview.log` — the run that recreated it, `SUCCESS` or
   `FAILED` — has a `git=` starting with the same `<sha7>`. Then
   `git worktree add --detach <that path> <that commit>`, run the check again. Never bypass or skip
   the edge backup.

## Acceptance: invoice ZIP and PDF (synthetic account with an invoice)

Only in an already approved signed-in test session of a synthetic portal account whose payer has
at least one TEST invoice; never a real customer's account, another person's password, a new
account or an invitation for the smoke test. Without such a session, record the authenticated
smoke as not run and rely on the isolated real-units walk (`PORTAL_WEB_WALK=1`, doc 057).

1. Without a session: `/invoices` redirects to `/login`; `/invoices/package?from=…&to=…` and
   `/invoices/<id>/pdf` answer 401.
2. Signed in: "Faktury" lists the account's invoices first; open one and "Stáhnout PDF" saves
   `<number>.pdf`, which opens as a PDF.
3. Open "Stáhnout faktury za období (ZIP)", choose the invoice's month as from and to and download:
   `AYVO-faktury-<from>-<to>.zip` contains `manifest.csv`, `README.txt` and
   `faktury/<number>.pdf`; the PDF's SHA-256 equals the manifest's.
4. A month without invoices comes back to "Faktury" with "V tomto období nejsou žádné faktury…";
   more than 12 months with the period message. Nothing is downloaded then.
5. Record the commit, the time and the results in the deployment notes; no screenshots with real
   data.

## Verify and disable

1. Verify the TLS certificate and DNS answer over the tailnet. Verify from outside the tailnet
   that HTTPS is unreachable, HTTP other than the ACME challenge is aborted and IPv6 does not
   expose the site. Verify the staff login still works.
2. Confirm `/api/internal/v1/portal/session` aborts at the portal host and `/login` has a nonce CSP.
   Test an oversized auth body and an interrupted upload.
3. With synthetic accounts and an approved test mail path, use the walk from ADR 0045 §11.
   Verify invite → TOTP → own hotel and invoice → PDF, denial for another hotel and revocation.
   Stop only portal-web in a controlled test and verify the internal application and Finance.
4. To disable the portal, follow "Disable the portal" below.

## Return portal-web to the previous image

Portal-web owns no data, so a bad portal release is reverted by running the previous image again.
Keep the previous image until the new one is accepted. Never re-point or delete a released tag.

1. Find the last `SUCCESS` line before the bad release in `/opt/ayvo/logs/deployments-dev-preview.log`
   that names `portal_image=` and `portal_image_id=`. Use it only if it was recorded with the
   running Core release, so both sides speak the same contract.
2. Check that the image still exists with that ID:
   `docker image inspect --format '{{.Id}}' ayvo-dev-preview/portal-web:<previous tag>`. If the ID
   differs or the image is gone, do not rebuild under the old tag. Build the reviewed commit under
   a new tag and treat it as a new release.
3. Replace only portal-web, using `portal_compose` from the deployment above:

   ```bash
   export PORTAL_IMAGE_TAG=<previous tag>
   flock -n /opt/ayvo/logs/.deploy-dev-preview.lock "${portal_compose[@]}" up \
     --detach --wait --wait-timeout 120 --no-deps --no-build portal-web
   ```

4. With the same export, run `scripts/deploy-dev.sh --edge`. The preflight requires the healthy
   previous image with the recorded ID, the verification loads `/login` over the tailnet and the
   log records the image again. Core, Finance and the database are not touched.

## Disable the portal

Use these steps for a planned disable and after a failed first activation. If the first
`deploy-dev.sh` with the portal domain fails, do not retry it. Keep its log and follow every
step, because Core may already hold the portal service hash and Finance its own.

1. Restore the previous env file, which has `DEV_PORTAL_DOMAIN` blank. For a planned disable,
   blank it in the server env. Unset `PORTAL_IMAGE_TAG` in the shell.
2. Only if Caddy is not running or not serving the staff site, restore the pre-switch backup the
   failed run printed. This restores Caddy only, never CoreDNS:

   ```bash
   scripts/dev-edge-backup.sh restore <backup directory> /opt/ayvo/secrets/dev-preview.env
   ```

3. From the reviewed checkout, run `scripts/deploy-dev.sh --edge`. It recreates Caddy and
   CoreDNS without the portal site and fails unless
   `dig @"$DEV_TAILNET_IPV4" dev-portal.ayvo.co A` returns REFUSED.
4. Stop only portal-web with the same Compose profile:
   `flock -n /opt/ayvo/logs/.deploy-dev-preview.lock "${portal_compose[@]}" stop portal-web`.
5. Close the receiving contracts without a new build or migration. Re-apply the running Core
   image with `scripts/deploy-dev.sh --rollback <running Core tag>`. The tag is the part after
   `ayvo-dev-preview/api:` in `docker inspect --format '{{.Config.Image}}' ayvo-dev-preview-api-1`.
   Then run `scripts/deploy-finance-dev.sh --rollback <running Finance tag>` (`finance-…`, read the
   same way from `ayvo-dev-preview-finance-1`). With the domain blank, neither container receives
   a portal hash. Confirm it without printing values; each count must be 0:

   ```bash
   for c in ayvo-dev-preview-api-1 ayvo-dev-preview-finance-1; do
     docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" |
       grep -c '^PORTAL_[A-Z_]*SHA256=.' || true
   done
   ```

6. Verify the staff login and Finance, and that `dig` still returns REFUSED for the portal name.
7. Remove the portal's DNS records and restricted nameserver rule through the approved
   infrastructure workflow.

A Core release predating portal audiences must never be restored once a portal account or
session exists. Keep the data and recover using the reviewed version or a forward fix.

A customer-facing address and its edge are a separate release.
