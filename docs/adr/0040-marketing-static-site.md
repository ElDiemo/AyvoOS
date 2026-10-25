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
4. **Public contract.** GET/HEAD only (others 405); strict CSP without inline styles or scripts,
   `nosniff`, `DENY` framing, no `Server` header; real 404 page (never the home page with 200);
   exact 301s for the old WordPress addresses (`/en`, `/cz`, `/de`, `/sitemap.html` and the five
   public media files); every other WordPress path is a 404. `X-Robots-Tag` from
   `AYVO_MARKETING_ROBOTS` (DEV preview: `noindex, nofollow`). `/healthz` for the health check.
5. **No third parties.** No Google tag, CookieYes, Google Fonts or the "Fiona" logo face
   (licence unverified): system fonts. With no cookies and no tracking there is no consent
   banner. Tests fail on any external request.
6. **Edge and TLS are not part of this unit.** Public names (ayvo.co, www.ayvo.co), certificates
   and the route from the existing public edge to this container are a second, separate PR
   (ADR amendment if needed): it must keep the QR/ID/VPN guards, add no path from the public
   edge to the OS API/DB/Redis, and prove certificates for both names before any DNS change.

## Failure domains (honest)

- Down: OS API, web, PostgreSQL, Redis, identity → **the site keeps answering** (it has no
  dependency on them; proven by the `--network none` container test).
- Shared and named: the host/VPS and the public edge in front of it (once connected) — a host or
  edge outage takes the site down with everything else on that host.

## Release and rollback

An image per commit; a release replaces the container with the new image only after its health
check passes, so a failed or interrupted publication leaves the previous complete version
running — never a half-copied directory. Rollback = start the previous image tag; no OS
database restore is involved. (Wiring into the deploy scripts: the second PR.)

## Open points for the owner

1. The old footer link "Client login" → `portal.ayvo.co` is **removed**: the hotel portal does
   not exist yet, and a working-looking sign-in would be untrue. It returns with the portal.
2. Titles/meta descriptions for CZ/DE are now built from each page's own headline and lead
   (the old ones were "CZ – AYVO" / "DE – AYVO"); no new claims.
3. The header is sticky so the language switch (which keeps the section being read) is at
   hand; otherwise the layout and texts are the WordPress page's own.
4. Logo typeface: the licensed "Fiona" font may be added as a local file once its licence for
   web use is confirmed; until then a system serif.
