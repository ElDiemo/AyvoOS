# 037 — Public QR host (`https://qr.ayvo.co/<token>`)

Status: **prepared, not installed** (ADR 0035). Owner request 2026-10-23: anyone who scans an AYVO
QR code sees the public passport of that bottle from production data — without VPN and without
sign-in — while `os.ayvo.co` stays internal (tailnet + WorkOS, doc 036).

## 1. What is public

| Request                                              | Answer                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET`/`HEAD /<token>` (22 base64url characters)      | the existing passport page `/q/<token>` of the web application         |
| `GET`/`HEAD /_next/static/*`, `/icon.svg`            | the static files that page needs                                       |
| anything else (other paths, methods, the API, login) | plain `404 Not found` from the edge — the application is never reached |

The passport shows only the whitelisted public data (doc 011): bottle code and reuse cycles; a
crate token says "Returnable AYVO crate", a workstation token "Internal AYVO mark". No hotel,
contact, operational history or ESG figures. An unknown token (also a DEV token: DEV and
production share no data) is "Not found" — a public page without links into the application. A
lookup only reads: it never creates anything and never switches to another data source.

## 2. How (deploy/prod)

- **A separate edge**, `qr-edge` (Caddy, `deploy/prod/Caddyfile.qr`), published only on the
  server's public IPv4 `:443` (TCP; `PROD_PUBLIC_IPV4` from the default route). The internal edge
  (`caddy`) stays on the Tailscale address; the public :80 stays ACME-only for `os.ayvo.co`.
- The QR edge is on its own Docker network `public` together with `web` only: it cannot reach the
  API, PostgreSQL or Redis. The page reads the API server-side, as everywhere.
- Certificates: TLS-ALPN-01 on the public :443 (HTTP-01 belongs to the internal edge).
- `strict_sni_host`: a request for another host through the QR certificate gets 421; another
  TLS name gets no certificate. `os.ayvo.co` is never answered on the public address.
- Nothing from the internet passes to the application: cookies, `Authorization`, `Forwarded`,
  Next.js navigation/action headers (`RSC`, `Next-Action`, `Next-Router-*`) and AYVO headers are
  removed; `Set-Cookie` never comes back; the query string is dropped. An upstream failure is a
  calm `503` text without internals. Security headers: HSTS, CSP (`frame-ancestors 'none'`,
  `form-action 'none'`), `nosniff`, `no-referrer`.
- The QR host is taken from `PUBLIC_QR_BASE_URL` in `prod.env` (the API accepts only the
  production QR host there, ADR 0014) — never configured twice. Its DNS **A** record must point at
  the server (`--check` verifies it); no AAAA (IPv6 is not served).

## 3. Excessive traffic

1. **Host guard** (`ayvo-prod-docker-guard`): only the public address's TCP :443 passes; new
   connections above 20/s per source address (burst 60) are dropped (`hashlimit`).
2. **API** (`PublicRateLimitGuard`): at most `PUBLIC_RATE_LIMIT_MAX` (default 120) requests to
   `/api/public/*` per client IP and `PUBLIC_RATE_LIMIT_WINDOW_SECONDS` (60), in Redis → `429`
   with `Retry-After`; without Redis `503` (fail closed). One passport view is 1–3 such requests.
3. **Client address through Next.js:** the edge sets `X-Forwarded-For` to the visitor (any incoming
   value is replaced); the web server passes that header on in its server-side request; the API
   honours it only from `TRUSTED_PROXY_CIDRS` (the Docker networks). So visitors are counted one by
   one — never all as the web server's address — and nobody can choose their own address.
4. Caddy timeouts (header/body 10 s) and a 16 KB header limit.

## 4. Tests

- `apps/api/test/prod-qr-edge.test.ts` (containers, CI only): the real `Caddyfile.qr` in the real
  Caddy image (internal CA instead of ACME) before a stub web — rewrite, stripped headers, the
  visitor's address, 404 for every other path and method, 421 for a foreign Host, no handshake for a
  foreign name, masked upstream errors.
- `apps/api/test/deploy-prod.test.ts`: ports, networks, placeholders, host guard rules.
- `apps/api/test/passport.e2e.test.ts`: per-visitor limit behind a trusted proxy, ignored
  `X-Forwarded-For` from others, 503 without Redis, unknown tokens write nothing.
- Playwright `bottle-labels.spec.ts`: unknown and malformed tokens → public "Not found" without links.

## 5. External test (owner, after installation and every edge change)

From a machine **outside** the tailnet (mobile data):

```bash
curl -m 10 -s -o /dev/null -w '%{http_code}\n' https://qr.ayvo.co/AAAAAAAAAAAAAAAAAAAAAA   # 404 (unknown token)
curl -m 10 -s -o /dev/null -w '%{http_code}\n' https://qr.ayvo.co/login                   # 404
curl -m 10 -s -o /dev/null -w '%{http_code}\n' https://qr.ayvo.co/api/health              # 404
curl -m 10 -s -o /dev/null -w '%{http_code}\n' -H 'Host: os.ayvo.co' https://qr.ayvo.co/  # 421
curl -m 10 -v --resolve os.ayvo.co:443:2.29.17.36 https://os.ayvo.co/                     # TLS failure, never the app
nc -vz -w 5 2.29.17.36 5432; nc -vz -w 5 2.29.17.36 6379; nc -vz -w 5 2.29.17.36 4000; nc -vz -w 5 2.29.17.36 3000  # all refused
```

Then scan the QR of a real production bottle with a phone without VPN: its passport appears.
