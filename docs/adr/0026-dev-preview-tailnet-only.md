# ADR 0026: DEV preview reachable only through our Tailscale tailnet

- **Status:** Accepted — directed by owner 2026-10-17 (DEV only)
- **Date:** 2026-10-17
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Supersedes / Superseded by:** supersedes the public-reachability part of
  [ADR 0013](0013-dev-preview-deployment.md) ("reachable from anywhere with credentials, no IP
  allowlist", "Caddy binds public ports 80/443"). Everything else of ADR 0013 stays: Caddy,
  same-origin `/api`, Basic Auth, `X-Robots-Tag`, manual deployment, named volumes.

## Context

`dev.ayvo.co` (web, `/api`, the DEV QR passports) was public behind HTTP Basic Auth. The owner
wants the internal DEV application reachable **only from approved devices connected to our
Tailscale tailnet**, without per-device `/etc/hosts` entries, while keeping the domain, HTTPS,
WorkOS sign-in, Basic Auth and `noindex`. Constraints:

- Docker-published ports bypass UFW; the DEV server has public IPv4 and IPv6.
- The public zone `ayvo.co` is hosted elsewhere (Netim) and must not change; no other domain, no
  e-mail record changes. MagicDNS cannot serve records of our own domain.
- Certificates must keep renewing without making the application public.
- Public SSH stays until the owner confirms the tailnet path and the provider's rescue console.
- No Tailscale SSH, exit node or subnet sharing; no plan or billing change.

## Decision

1. **Bind, don't open.** Caddy publishes 443 (TCP + UDP/HTTP3) **only on the server's Tailscale
   IPv4 address**. `scripts/deploy-dev.sh` reads it from `tailscale ip -4` on every run, checks it
   is in `100.64.0.0/10` and on `tailscale0`, and stops otherwise — it never falls back to
   `0.0.0.0`. Nothing is published on IPv6 (Docker would proxy IPv6 in userland and hide the
   client address). PostgreSQL and Redis stay unpublished; Caddy's admin API stays inside its
   container.
2. **Narrow public ACME exception.** Only IPv4 TCP :80 stays public, for ACME HTTP-01. There Caddy
   answers its own challenges and the (normally empty) `/.well-known/acme-challenge/` directory;
   every other request — any path, any host, bare IP — is aborted without a response. TLS-ALPN is
   disabled, so renewal never needs a public 443. No DNS API credential is needed, so none is
   stored. The public `A dev.ayvo.co` record stays (Let's Encrypt validates through it); it leads
   only to that exception.
3. **Caddy checks the real peer.** Every HTTPS and HTTP request whose TCP peer is outside
   `100.64.0.0/10` is aborted before Basic Auth (`remote_ip`, never a forwarded header). This is a
   second layer: reaching the address at all already requires the tailnet.
4. **Host guard.** A root-installed systemd unit (`deploy/dev/host/`) puts a chain into Docker's
   `DOCKER-USER` (IPv4 and IPv6): new connections entering through the public interface to any
   container are dropped, except IPv4 TCP :80; replies to the containers' own outbound
   connections pass. It is re-applied on every Docker start. The sysctl
   `net.ipv4.ip_nonlocal_bind=1` lets Docker bind the tailnet address at boot before tailscaled has
   assigned it (so the stack starts after a reboot; it is reachable once the tailnet is up). The
   deploy script refuses to run without both.
5. **Private DNS via Tailscale split DNS.** A CoreDNS container (`dns`), published on the Tailscale
   IPv4 address :53 only, is authoritative for `DEV_DOMAIN` alone: `A` = the Tailscale address,
   other types NOERROR/empty, names below it NXDOMAIN, **every other name REFUSED** (no recursion,
   no forwarding — never an open resolver). In the Tailscale admin console the owner adds this
   server as a nameserver **restricted to `dev.ayvo.co`** (split DNS). No other name of `ayvo.co`
   is affected.
6. **Who may connect** is the Tailscale access policy (owner, admin console): tailnet members may
   reach the server on tcp/udp 443, tcp 80 and tcp/udp 53; admins also tcp 22. Not "all of
   100.64.0.0/10": a connection on `tailscale0` is authenticated by WireGuard per device, and the
   policy decides which devices.
7. **Deployment checks** (every deploy, rollback and `--edge`): published ports are exactly the
   tailnet rule; public IPv4/IPv6 :443 do not connect; public :80 aborts `/` and `/api/health` and
   serves the challenge path (404 for an unknown token); the private DNS answers only the domain.
   These run on the server and are no proof from the internet — the owner's test from outside the
   tailnet is. `scripts/verify-dev-acme.sh` proves renewal from the internet with the Let's
   Encrypt **staging** CA (certificate discarded). `--edge` recreates only Caddy and DNS with the
   running image tag (no build, no migration, no database step).

Unchanged: `id.ayvo.co` (other server), the future public `qr.ayvo.co` and `portal.ayvo.co`
(own rules), `os.ayvo.co`, production, the Raspberry Pi, the printer, the night runner, WorkOS.
The DEV QR passport (`https://dev.ayvo.co/q/…`) is tailnet-only too.

## Consequences

- Without Tailscale the DEV preview, its API and DEV QR passports are unreachable (connection
  refused/aborted). Scanning a DEV QR needs a phone in the tailnet.
- Public SSH (22) and Tailscale's own UDP 41641 remain public; closing public SSH is a later owner
  decision after the tailnet SSH path and the rescue console are confirmed.
- The host guard and sysctl are installed by the owner with sudo (`deploy/dev/host/install.sh`);
  rollback is `uninstall.sh` after Caddy no longer binds the tailnet address.
- If Tailscale is down on the server, the preview is down (fail closed), and deployments stop.

## Reuse as the basis for a separate production server (not implemented)

Owner 2026-10-17: keep this as the starting point for a future production server, without building
a generic installer now. Nothing here is production-ready, and production is not deployed.

- **Environment values, never in the repo files:** the domain, ACME e-mail and Basic Auth come from
  the server's env file (`/opt/ayvo/secrets/<env>.env`); the Tailscale IPv4 address
  (`tailscale ip -4`) and the public interface (the default route) are detected on every run.
- **Reusable as they are:** `Caddyfile` (tailnet peer check, ACME-only :80), `Corefile`
  (one name, everything else REFUSED), `deploy/dev/host/` (guard + sysctl), the deploy checks.
- **DEV-specific names to replace for another environment:** the Compose project and container
  names (`ayvo-dev-preview-*`), the unit name `ayvo-dev-docker-guard`, the backup path
  `/var/backups/ayvo-dev-tailnet`, and `APP_ENV=development`.
- **The only manual steps, all documented here:** the `install.sh` run (sudo), the Tailscale admin
  console (access policy, split-DNS nameserver restricted to the domain), the public `A` record
  for ACME HTTP-01. Production has its own decisions (public `qr.ayvo.co`, `portal.ayvo.co`) that
  this ADR does not make.

## Backup and rollback (exact)

**Backup (before the host guard, and automatically before every switch).**
`scripts/dev-edge-backup.sh backup` saves the running Caddy exactly as it runs into
`/opt/ayvo/backups/dev-preview/edge-before-<time>-<id>/`: every bind-mounted file read from inside
the running container, the published ports, `docker inspect`, `runtime.env` (the image tag and,
after the switch, the tailnet address exactly as the container got them — so a restore needs
nothing exported by hand), and the Compose file it was created from. That Compose file is the one
at the container's path or — when the checkout has already moved to a newer `main` — the same path
in git at the commit recorded on the container (`com.ayvo.edge-commit`) or in the image tag
(`<sha12>-<time>`); the first that reproduces the running image and **exactly** its ports is
saved, none ⇒ no backup. Checksums, then `COMPLETE`, are written last. Rendering always uses the
env file plus `runtime.env` in a clean environment. `deploy/dev/host/install.sh` refuses to run
without a complete, verified backup named on its command line, and `scripts/deploy-dev.sh`
(`--edge`, deploy, rollback) takes another one before it builds or switches anything — **if that
fails, nothing is changed.** The directory is printed and repeated in the failure report.

**Rollback** — also after a partly failed switch (new Caddy missing, unhealthy or half-created,
DNS failing):

1. Restore the previous Caddy and remove the containers that did not exist before (the `dns`),
   from any shell (no exported variables needed):
   ```bash
   scripts/dev-edge-backup.sh restore /opt/ayvo/backups/dev-preview/edge-before-<time>-<id> \
     /opt/ayvo/secrets/dev-preview.env
   ```
   It checks the checksums first, recreates only `caddy` from the saved files with the saved tag
   (no build; web, api, database untouched) and fails unless the published ports equal the saved
   ones. Tested on throwaway Compose projects (`apps/api/test/deploy-dev-edge.test.ts`): checkout
   already on the new Compose while the old Caddy runs, a partly failed switch, a tampered backup,
   and a tailnet-era backup restored from a clean shell.
2. `sudo bash deploy/dev/host/uninstall.sh` (removes the guard and resets the sysctl) — only after
   step 1.
3. Tailscale admin console: remove the split-DNS nameserver; restore the saved access policy.
4. Revert the commit of this ADR before the next normal deployment (otherwise it re-applies the
   tailnet binding — by design).
