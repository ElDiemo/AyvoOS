# ADR 0035: A separate public edge serves only the QR passport

- **Status:** Proposed — owner request 2026-10-23, awaiting review in the PR
- **Date:** 2026-10-23
- **Related:** ADR 0014 (public QR identity and URL), ADR 0026 / ADR 0033 (tailnet-only edges),
  doc 011 (public passport), doc 037

## Context

Printed QR codes encode `https://qr.ayvo.co/<token>` (ADR 0014). Anyone must be able to open that
passport without VPN or sign-in, from production data. The production installation (ADR 0033)
publishes HTTPS only on the tailnet, and its host guard drops public :443 — DNS alone cannot
change that, and opening the internal edge to the internet would expose the whole application.

## Decision

1. A **second, separate edge** (`qr-edge`, Caddy) on the public IPv4 :443 only. It answers
   exactly `GET|HEAD /<22 base64url characters>` (rewritten to the existing `/q/<token>` page) and
   the page's static files; every other request is a 404 from the edge itself. No API route, no
   sign-in, no catch-all into the application.
2. The edge shares a Docker network **only with `web`**: it can never reach the API or the
   databases directly. The page reads the API server-side, exactly as on DEV and `os.ayvo.co`.
3. Nothing chosen by the visitor reaches the application (cookies, credentials, Next.js
   navigation/action headers, query string, forwarded headers); the visitor's real address goes on
   as `X-Forwarded-For`, so the API rate limit counts visitors, not the web server.
4. Excessive traffic is limited twice: new connections per source in the host guard, requests per
   visitor on `/api/public/*` in the API (Redis; fail closed).
5. Same application code everywhere (no CRM-only or QR-only build); `os.ayvo.co` stays internal.

## Consequences

- One more public port (IPv4 TCP :443 of the public address); IPv6 stays closed (no AAAA).
- The QR host's certificate uses TLS-ALPN-01; the internal edge keeps HTTP-01 on :80.
- The owner's external test (doc 037 §5) is required after installation and every edge change.
