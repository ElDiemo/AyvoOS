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

## Release (DEV preview → PROD, the same artifact)

1. Merge → `scripts/deploy-dev.sh` (once: Caddy gets :8443 and the `marketing` network), then
   `scripts/deploy-marketing-dev.sh`: only the marketing container; preview at
   `https://<DEV_DOMAIN>:8443` (tailnet). It prints the content digest.
2. After acceptance on PROD (`MARKETING_DOMAIN` in prod.env, an OS release with
   `compose.marketing.yml` deployed): `scripts/deploy-prod.sh --marketing --release <commit>
--expect-digest <digest>`. Rollback: `--marketing-rollback <release>`.
3. The digest of a checkout: `sh apps/marketing/site-digest.sh apps/marketing/Caddyfile apps/marketing/site`.
