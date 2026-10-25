# ADR 0040: The public marketing site (ayvo.co) as its own static runtime unit

- **Status:** Proposed — for review (PR "marketing static site"). Approved by the owner as a
  boundary on 2026-10-25 ("samostatný statický web na vlastní infrastruktuře, EN/CZ/DE, bez
  analytického trackingu"; editing through Claude and Git). Not deployed anywhere.
- **Date:** 2026-10-25
- **Context:** ayvo.co runs on WordPress (Elementor) on the old server; that server is to be
  removed after the ID and web moves. Inventory: `MARKETING-WEB-MIGRATION-PREP-20261024.md`
  (outside the repository). Fits ADR 0038 (Proposed): new parts are separate units.

## Decision

1. **Unit.** `apps/marketing`: static files (`site/`) and their own Caddy config in their own
   image (`apps/marketing/Dockerfile`, `caddy:2-alpine`). One process, port 8080, plain HTTP.
   It has **no database, no Redis, no secrets, no calls to the OS API** and no outbound network
   need at all; the image runs with `--network none` in its tests.
2. **Content source of truth = Git.** EN `/`, CZ `/cz/`, DE `/de/` as plain HTML, one shared
   stylesheet and a small progressive-enhancement script. **No CMS and no web editor in v1:**
   changes are made by editing the HTML (through Claude) → PR → CI → DEV preview → owner
   acceptance → the same commit on PROD. A visual editor would be a separate task.
3. **Isolation.** Read-only root filesystem, user 65534, all capabilities dropped (the binary's
   `cap_net_bind_service` file capability is removed — port 8080 needs none),
   `no-new-privileges`, memory 64 MiB / 0.25 CPU / 64 pids in tests (the same limits are
   proposed for DEV/PROD), no mounts, no Docker socket, Caddy admin API off.
4. **Public contract.** GET/HEAD only — on every path, including `/healthz` and the redirects
   (the method rule is the first step of one ordered route); others 405. Strict CSP without inline styles or scripts,
   `nosniff`, `DENY` framing, no `Server` header; real 404 page (never the home page with 200);
   exact 301s for the old WordPress addresses (`/en`, `/cz`, `/de`, `/sitemap.html` and the five
   public media files); every other WordPress path is a 404. `X-Robots-Tag` from
   `AYVO_MARKETING_ROBOTS` (DEV preview: `noindex, nofollow`). `/healthz` for the health check.
   Caching: the asset URLs are not content-addressed, so pages **and** assets are served with
   `Cache-Control: no-cache` and revalidated (ETag → 304): after a release or a rollback a
   browser never combines new HTML with old CSS/JS. (Fingerprinted asset names would allow long
   caching; not needed for a site of this size.)
5. **No third parties.** No Google tag, CookieYes, Google Fonts or the "Fiona" font file
   (licence unverified): system fonts for text; the logo is the owner's AYVO wordmark SVG that
   the OS already uses (`apps/web/public/brand/ayvo-wordmark.svg`), not a font imitation. With no cookies and no tracking there is no consent
   banner. Tests fail on any external request.
6. **Edge and TLS (PR 2).** The unit sits behind the existing edges without replacing any of
   their configuration:
   - **PROD:** with `MARKETING_DOMAIN=<apex>` in prod.env, `deploy/prod/compose.marketing.yml` is
     added. It mounts one site file into qr-edge (`sites/marketing.caddy`: apex + www, TLS, HSTS,
     www → apex 301, only GET/HEAD to `marketing:8080`) and one into the internal Caddy
     (`acme.d/marketing.caddy`: on public :80 the ACME challenges of apex and www go to qr-edge, all
     else → https). `Caddyfile.qr` and `Caddyfile` only gained an `import` of those directories —
     with no file there, QR and ID behave exactly as before (their tests run unchanged). The
     marketing container is on its own internal network with qr-edge only (no web, API, DB, Redis,
     egress). Certificates for apex and www can be obtained before the DNS change through the old
     server's challenge-only forward (tested with Pebble), exactly like the ID host.
   - **DEV:** `https://<DEV_DOMAIN>:8443` (the same certificate, published on the tailnet address
     only, the same real-peer check), `noindex`; the container on its own internal network with
     Caddy only.

## Release, the same artifact, rollback

- The content digest (`apps/marketing/site-digest.sh`: SHA-256 over the Caddyfile and every served
  file) is the identity of a release; the image carries the script, so the digest is also read from
  the running container.
- DEV: `scripts/deploy-marketing-dev.sh` builds the image from a clean checkout, replaces only the
  `marketing` container, verifies the running digest and the route through the edge, and prints
  the digest to accept.
- PROD: `scripts/deploy-prod.sh --marketing --release <commit on origin/main> --expect-digest
<accepted digest>` exports `apps/marketing` of that commit into its own directory, refuses any
  other digest, builds, replaces only the `marketing` container, checks the running digest and the
  public routes (local hint). `--marketing-rollback <release>` starts an earlier image again (its
  recorded digest is checked). An OS deployment never builds, starts or stops the marketing site;
  rolling the OS back to a release without `compose.marketing.yml` takes the site off the edge.
- No registry and no vendor: the image is rebuilt from the same commit on each server and proven
  identical by the digest.

## Failure domains (honest)

- Down: OS API, web, PostgreSQL, Redis, identity → **the site keeps answering** (it has no
  dependency on them; proven by the `--network none` container test).
- Shared and named: the host/VPS and the public edge in front of it (once connected) — a host or
  edge outage takes the site down with everything else on that host.

A failed or interrupted publication leaves the previous complete version running (the container
is replaced only by a complete image) — never a half-copied directory; no OS database restore is
involved in a rollback.

## Open points for the owner

1. The old footer link "Client login" → `portal.ayvo.co` is **removed**: the hotel portal does
   not exist yet, and a working-looking sign-in would be untrue. It returns with the portal.
2. Titles/meta descriptions for CZ/DE are now built from each page's own headline and lead
   (the old ones were "CZ – AYVO" / "DE – AYVO"); no new claims.
3. The header is sticky so the language switch (which keeps the section being read) is at
   hand; otherwise the layout and texts are the WordPress page's own.
4. Logo: the owner's wordmark SVG (also used by the OS) replaces the WordPress text set in the
   "Fiona" font; the band image (`logoy.png`) is the WordPress one.
