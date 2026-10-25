# AYVO marketing site (ayvo.co)

Static EN / CZ / DE site in its own container — see
[ADR 0040](../../docs/adr/0040-marketing-static-site.md). No CMS: content lives here in Git.

```
site/index.html        EN  (https://ayvo.co/)
site/cz/index.html     CZ  (https://ayvo.co/cz/)
site/de/index.html     DE  (https://ayvo.co/de/)
site/404.html          the real 404 page
site/assets/site.css   all styles (no inline styles: the CSP forbids them)
site/assets/site.js    footer year + language switch keeping the section
site/assets/img/       images (with width/height and alt in the HTML)
site/robots.txt, site/sitemap.xml
Caddyfile              headers, redirects of the old WordPress addresses, 404, /healthz
Dockerfile             the image (read-only, unprivileged)
```

## Changing content

1. Edit the text in all three language files (the sections have the same ids everywhere:
   `top`, `value`, `includes`, `how`, `why`, `pilot`, `standard` — keep them).
2. Use classes from `site.css`, never `style="…"` or inline `<script>`.
3. A new image: put it in `site/assets/img/`, reference it as `/assets/img/…` with its real
   `width`, `height` and an `alt` text.
4. `pnpm --filter @ayvo/marketing test` (files, links, languages, no tracking), then a PR →
   CI (also the container and browser tests) → DEV preview → acceptance → the same commit on PROD.

## Tests

- `pnpm test` — static checks of the files; container tests of the real image run in CI or
  with `AYVO_DOCKER_TESTS=1` (no network, read-only, headers, redirects, 404, 405).
- `pnpm test:e2e` — Chromium against the real image on 127.0.0.1:3300: every language at
  1440 / 390 / 320 px, no external requests, no CSP errors, images, favicon, language switch,
  CTAs, 404; screenshots to `docs/screenshots/marketing/`.

## Release (DEV preview → PROD, the same image)

1. Merge → `scripts/deploy-dev.sh` (once: Caddy gets :8443 and the `marketing` network), then
   `scripts/deploy-marketing-dev.sh`: builds the image (pinned base, revision label), replaces only
   the marketing container (restores the previous one if it fails), verifies
   `https://<DEV_DOMAIN>:8443` (tailnet), saves the tested image as an archive and prints its image
   ID and content digest.
2. PROD (after acceptance): `MARKETING_DOMAIN` in prod.env and an OS release with
   `compose.marketing.yml` → the edge is PREPARED; the certificates of apex and www are obtained
   (challenge-only forward on the old server); copy the archive to the server, then
   `scripts/deploy-prod.sh --marketing --image-archive <file> --expect-image <id> --expect-digest
<digest>` — SUCCESS only with valid HTTPS on both names. Rollback: `--marketing-rollback <revision12>-<image12>` (the release recorded as SUCCESS).
3. The content digest of a checkout: `sh apps/marketing/site-digest.sh apps/marketing/Caddyfile apps/marketing/site`.
