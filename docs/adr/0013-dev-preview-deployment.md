# ADR 0013: DEV preview deployment — Caddy, same-origin API, Basic Auth

- **Status:** Accepted — confirmed by owner 2026-10-10
- **Date:** 2026-10-10
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Supersedes / Superseded by:** — (fills the "hosting setup for `dev.ayvo.co`" open question of
  [ADR 0008](0008-dev-prod-separation.md))

## Context

`dev.ayvo.co` is the development preview environment and runs on the current DEV-only server
([ADR 0008](0008-dev-prod-separation.md)). The preview must be reachable from anywhere by people
with credentials, must not be indexed, and must not expose PostgreSQL, Redis or the API process
directly. The web app (Next.js) and the API (NestJS) are separate processes
([ADR 0003](0003-nextjs-and-nestjs.md)); browsers must be able to call the API without CORS.

## Decision

Owner decisions of 2026-10-10:

- **Caddy** is the reverse proxy and the **only** service binding public ports (80, 443). It
  obtains and renews the TLS certificate for `dev.ayvo.co` automatically (ACME).
- The entire preview is protected by **HTTP Basic Auth** for now. **No IP allowlist** — the
  preview must be reachable from anywhere with credentials. Credentials come from a server-only
  env file (bcrypt hash only); they are never committed.
- Every response carries **`X-Robots-Tag: noindex, nofollow`**, including the 401 challenge.
- **No separate public API subdomain.** The browser-facing API is **same-origin**:
  `https://dev.ayvo.co/api/*`. This avoids CORS entirely.
- **No staging** environment. **No CI/CD** yet: deployment is manual
  (`scripts/deploy-dev.sh`) until the first domain is stable.
- The `ayvo` user may use Docker on this DEV server.

Implementation:

- **Path ownership:** the API serves every route under the `/api` global prefix
  (`API_BASE_PATH` in `@ayvo/types`, applied by `configureApp` in `apps/api`). Caddy forwards
  `/api` and `/api/*` to the API **unchanged** — no `handle_path`, no rewrite — so the prefix
  is defined in exactly one place and cannot be stripped or duplicated. Local development uses
  the same paths (`http://localhost:4000/api/health`). Everything else goes to Next.js.
- Next.js server-side code reaches the API over the internal Docker network
  (`API_URL=http://api:4000`, an origin without a path).
- **Topology** (`deploy/dev/compose.yml`, Compose project `ayvo-dev-preview`):
  `caddy`, `web`, `api`, `postgres`, `redis`, plus a one-off `migrate` runner. Two networks:
  `edge` (caddy, web, api) and `backend` (api, migrate, postgres, redis), the latter
  `internal` (no egress). Only Caddy publishes host ports. Data lives in explicitly named
  volumes that no script removes.
- **Images:** multi-stage Dockerfiles per app (`turbo prune --docker`, pnpm, Node 24 Alpine),
  running as the unprivileged `node` user. The API image contains compiled `dist` plus
  production dependencies (`pnpm deploy --prod`); the web image uses Next.js `standalone`
  output. No secrets are used at build time.
- **Migrations:** `prisma migrate deploy` only, run by the deploy script in a separate
  `migrate` container after a `pg_dump` of the current database and before the new API
  starts ([ADR 0009](0009-prisma-orm.md)).
- This preview stack is separate from the local development infrastructure in
  `docker/compose.yml` (own containers, networks and volumes).

## Consequences

### Positive

- One origin: no CORS configuration, cookies can later be same-site, and the API path is
  identical at every hop (browser → Caddy → NestJS).
- PostgreSQL, Redis and the Node processes are not reachable from the internet.
- Automatic TLS with no manual certificate handling.
- Repeatable manual deployment with per-deploy image tags, a pre-migration backup and
  post-deploy verification; rollback to a previous image is a single command.

### Negative

- Basic Auth is a shared credential with no per-user audit; it is a stopgap until real
  authentication exists (doc 012).
- Images are built on the server; builds use server CPU and disk, and old image tags
  accumulate until pruned manually.
- Migrations are forward-only. Rolling back across a schema change needs a compensating
  migration or a restore from the pre-migration dump.
- Docker-published ports (80/443) bypass host `ufw` rules; this is intended for those two
  ports only and is why no other service publishes a port.

## Alternatives considered

- **nginx / Traefik** — Caddy chosen by owner; automatic HTTPS with minimal configuration.
- **IP allowlist** — rejected by owner: the preview must be reachable from anywhere.
- **Separate API subdomain (`api.dev.ayvo.co`)** — rejected by owner: needs CORS and a second
  certificate/origin.
- **Stripping `/api` in Caddy (`handle_path`)** — rejected: the API would believe it lives at
  `/`, links and future cookie paths would disagree between hops, and local development would
  differ from the preview.
- **Next.js rewrites as the API proxy** — rejected: puts the web process on every API call's
  path and couples API availability to the web app.

## Open questions

- Replacing Basic Auth with real authentication (doc 012) and whether the preview keeps an
  outer Basic Auth layer afterwards.
- Off-server copies and retention of DEV backups (dumps are kept on this server only).
- The production deployment (separate VPS) needs its own ADR.
