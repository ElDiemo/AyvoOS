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

- **Identity = the image ID of the tested build** (review MKT70-R1). The base image is pinned by
  digest (`caddy:2.11.7-alpine@sha256:…`); DEV builds the image once from a clean checkout with its
  source revision as a label, tests it, and saves THAT image as an archive (`docker save`, a file —
  no registry, no vendor). PROD never builds the marketing site: `deploy-prod.sh --marketing
--image-archive <file> --expect-image <sha256:id> --expect-digest <sha256>` loads the archive and
  refuses any other image ID (a changed Dockerfile or base with the same content has another ID —
  tested), requires the revision to be on origin/main, and checks the served files' content digest
  (`apps/marketing/site-digest.sh`, also computed in the running container) as an additional check.
- **A failed switch:** Compose removes the running container before the new one is healthy (no
  blue/green). If the new container does not become healthy with the expected image and content,
  the deploy step starts the previous image again, checks it and fails; the site is unavailable
  from the switch until the previous one is healthy (seconds: the health check probes every second
  while starting). If the previous one does not come back either, the step says so. Tested with a
  wrong artifact and a container that never becomes healthy.
- **Prepared ≠ released** (review MKT70-R2). An OS deployment with `MARKETING_DOMAIN` only
  PREPARES the edge: its :80 answers are required, HTTPS is reported as the named state
  "PREPARED, NOT LIVE" (certificates pending or site not deployed) — never success. `--marketing`
  and `--marketing-rollback` record SUCCESS only after the strict check: valid HTTPS (certificate
  verified) on the apex and www, the site on the apex, www → apex (GET/HEAD), 405 for other methods
  on both names, 404 for OS/API/old paths, 421 for another host; otherwise the release is recorded
  UNVERIFIED and the command fails.
- DEV: `scripts/deploy-marketing-dev.sh` (the same restore behaviour) prints the image ID, content
  digest and archive for PROD. Order: OS deploy (edge prepared) → certificates (challenge forward
  on the old server) → `--marketing` (strict, before DNS, via the server's address) → DNS.

## Open points for the owner

1. The old footer link "Client login" → `portal.ayvo.co` is **removed**: the hotel portal does
   not exist yet, and a working-looking sign-in would be untrue. It returns with the portal.
2. Titles/meta descriptions for CZ/DE are now built from each page's own headline and lead
   (the old ones were "CZ – AYVO" / "DE – AYVO"); no new claims.
3. The header is sticky so the language switch (which keeps the section being read) is at
   hand; otherwise the layout and texts are the WordPress page's own.
4. Logo: the owner's wordmark SVG (also used by the OS) replaces the WordPress text set in the
   "Fiona" font; the band image (`logoy.png`) is the WordPress one.
