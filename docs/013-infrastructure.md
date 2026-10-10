# 013 — Infrastructure

This document describes the current development infrastructure and the proposed principles for production infrastructure.

Status: Draft — foundation complete; DEV preview deployed (2026-10-10)

## Confirmed requirements

- Tech stack: TypeScript, pnpm, Turborepo, Next.js, NestJS, PostgreSQL, Prisma, Redis, Docker / Docker Compose, Tailwind, shadcn/ui, Zod, Vitest, Playwright.
- PostgreSQL is the source of truth ([ADR 0002](adr/0002-postgresql-source-of-truth.md)).
- DEV/PROD separation ([ADR 0008](adr/0008-dev-prod-separation.md)).
- This server is **DEV only**; no production customer data or production secrets belong here _(confirmed by owner 2026-10-10)_.
- `dev.ayvo.co` is the **development preview environment** _(confirmed by owner 2026-10-10)_, deployed as described in [ADR 0013](adr/0013-dev-preview-deployment.md) and [below](#dev-preview-deployment-devayvoco).
- Production will later run on a **separate VPS** _(confirmed by owner 2026-10-10)_.
- **No staging environment** for now _(confirmed by owner 2026-10-10)_.
- Domain database models are still not implemented _(confirmed by owner 2026-10-10)_.
- Caddy is the reverse proxy; the whole preview is behind HTTP Basic Auth, reachable from anywhere with credentials (no IP allowlist), and sends `X-Robots-Tag: noindex, nofollow` _(confirmed by owner 2026-10-10)_.
- No separate public API subdomain: the browser-facing API is same-origin at `https://dev.ayvo.co/api/*`, so no CORS _(confirmed by owner 2026-10-10)_.
- The `ayvo` user may use Docker on this DEV server _(confirmed by owner 2026-10-10)_.
- No CI/CD yet: deployment is manual until the first domain is stable _(confirmed by owner 2026-10-10)_.

## Current development setup

| Component            | How it runs                              | Port |
| -------------------- | ---------------------------------------- | ---- |
| PostgreSQL 18        | `docker/compose.yml`, bound to 127.0.0.1 | 5432 |
| Redis 8              | `docker/compose.yml`, bound to 127.0.0.1 | 6379 |
| API (NestJS 12, ESM) | on host via `pnpm dev`; routes at `/api` | 4000 |
| Web (Next.js 16)     | on host via `pnpm dev`                   | 3000 |

- Configuration: copy `.env.example` to `.env` and adjust. Real `.env` files are git-ignored.
- Prisma 7 with the Milestone 1 models (bottles, label templates, print jobs) and committed migrations; see [ADR 0009](adr/0009-prisma-orm.md) and the [data dictionary](015-data-dictionary.md).
- File storage (label artwork, print PDFs): `FILE_STORAGE_DIR`, default `var/storage` in the repository (git-ignored) — [ADR 0016](adr/0016-file-storage-abstraction.md).
- Further API settings (see `.env.example`): `PUBLIC_QR_BASE_URL` (local default `http://localhost:3000/q`), `LABEL_QR_MIN_SIZE_MM`, `LABEL_ARTWORK_MAX_BYTES`.
- Locally the web app forwards `/api/*` to `API_URL` (`apps/web/src/proxy.ts`), mirroring Caddy, so the browser always uses same-origin `/api`.
- Label review artifacts: `pnpm label-artifacts` writes the QR validation sheet, a calibration page, a DEV sample label and PNG previews to `artifacts/label-review/` (git-ignored) and decodes every QR (doc 016).
- Tests: `pnpm test` needs PostgreSQL (`pnpm infra:up`): API integration tests create, migrate and drop a temporary `ayvo_test_*` database per run. `pnpm test:e2e` (after `pnpm build`) recreates an `ayvo_e2e` database and runs the built API on port 4100 and the web app on 3100.
- Redis is non-authoritative ([ADR 0010](adr/0010-redis-non-authoritative.md)).
- Docker is installed on the development server; PostgreSQL 18 and Redis 8 run healthy via `docker/compose.yml` (verified 2026-10-10).

## DEV preview deployment (dev.ayvo.co)

> **⚠ Backups: the `pg_dump` taken by the deploy script is NOT a backup of the files volume.**
> Label artwork and print PDFs live in the Docker volume `ayvo-dev-preview-files-data`, which no
> script backs up. Losing it loses uploaded artwork. Local file storage is DEV-only; production
> needs object storage, off-site backups and a tested restore ([ADR 0016](adr/0016-file-storage-abstraction.md)).

Decision record: [ADR 0013](adr/0013-dev-preview-deployment.md). Files: `deploy/dev/compose.yml`,
`deploy/dev/Caddyfile`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `scripts/deploy-dev.sh`.

```
internet ──80/443──▶ caddy (TLS, Basic Auth, X-Robots-Tag)
                       ├─ /api, /api/* ──▶ api:4000  (path unchanged) ──▶ postgres:5432, redis:6379
                       └─ everything else ─▶ web:3000 ──(server-side, http://api:4000)──▶ api
networks: edge = caddy, web, api        backend (internal, no egress) = api, migrate, postgres, redis
```

| Service    | Image                          | Host ports         | Health check                                 |
| ---------- | ------------------------------ | ------------------ | -------------------------------------------- |
| `caddy`    | `caddy:2-alpine`               | 80, 443, 443/udp   | admin API on container localhost             |
| `web`      | `ayvo-dev-preview/web:<tag>`   | none               | `GET /` (Dockerfile `HEALTHCHECK`)           |
| `api`      | `ayvo-dev-preview/api:<tag>`   | none               | `GET /api/health` (Dockerfile `HEALTHCHECK`) |
| `postgres` | `postgres:18-alpine`           | none               | `pg_isready`                                 |
| `redis`    | `redis:8-alpine`               | none               | `redis-cli ping`                             |
| `migrate`  | `ayvo-dev-preview/api-migrate` | none (one-off run) | —                                            |

Data volumes are explicitly named (`ayvo-dev-preview-postgres-data`, `…-redis-data`,
`…-caddy-data`, `…-caddy-config`) and survive rebuilds; nothing in the repo removes them.

### Server-only configuration

Stored outside the repository in `/opt/ayvo/secrets/dev-preview.env` (mode 600, owned by `ayvo`;
path overridable with `AYVO_DEV_ENV_FILE`). Placeholders are documented in `.env.example`.

| Variable              | Value                                                          |
| --------------------- | -------------------------------------------------------------- |
| `APP_ENV`             | `development` (the script refuses anything else)               |
| `DEV_DOMAIN`          | `dev.ayvo.co`                                                  |
| `ACME_EMAIL`          | contact address for the Let's Encrypt account                  |
| `DEV_BASIC_AUTH_USER` | Basic Auth user name                                           |
| `DEV_BASIC_AUTH_HASH` | bcrypt hash from `caddy hash-password`, **in single quotes**   |
| `POSTGRES_USER`       | e.g. `ayvo`                                                    |
| `POSTGRES_DB`         | e.g. `ayvo_dev_preview`                                        |
| `POSTGRES_PASSWORD`   | 24+ characters of `[A-Za-z0-9_-]`, e.g. `openssl rand -hex 32` |

`DATABASE_URL`, `REDIS_URL` and `API_URL` are derived inside `deploy/dev/compose.yml`, as are
`PUBLIC_QR_BASE_URL` (`https://$DEV_DOMAIN/q`) and `FILE_STORAGE_DIR` (`/var/lib/ayvo/files`).

**Persistent files** (Milestone 1): the API mounts the named volume `ayvo-dev-preview-files-data`
at `/var/lib/ayvo/files` for label artwork and generated PDFs; its root filesystem stays
read-only. The volume is never removed by the scripts, but it is **not** included in the
pre-migration `pg_dump` backup (open question below). Labels printed from DEV encode
`https://dev.ayvo.co/q/<token>` and must never be used on real bottles.

### What `scripts/deploy-dev.sh` does

1. Validates prerequisites, the env file (location outside the repo, owner, mode 600, required
   variables, formats, no placeholders, `APP_ENV=development`) and the Compose config.
2. Takes a lock so two deployments cannot overlap.
3. Builds `api`, `web` and `api-migrate` images tagged `<git-sha>[-dirty]-<UTC timestamp>`.
4. Starts PostgreSQL and Redis and waits until healthy.
5. Writes a `pg_dump` of the current database to `/opt/ayvo/backups/dev-preview/` (database only — **not** the files volume).
6. Runs `prisma migrate deploy` in the one-off `migrate` container.
7. Starts the stack with the new images and waits until every service is healthy.
8. Verifies (all checks are mandatory; any failure fails the deployment):
   - API health is `ok` (PostgreSQL + Redis up); Caddy reaches `web:3000/` and `api:4000/api/health`;
   - unauthenticated `https://dev.ayvo.co/` and `/api/health` answer 401 (waits for the first
     certificate); `http://` redirects permanently to `https://dev.ayvo.co/`;
   - every HTTPS response checked carries `X-Robots-Tag` with `noindex` and `nofollow`;
   - authenticated `/` returns 200 with the AYVO OS HTML page; authenticated `/api/health` returns
     200 with `status=ok`, `environment=development`, `database=up`, `redis=up`; and
     `/api/api/health` returns 404 (prefix not duplicated).
9. Appends `SUCCESS` or `FAILED step=…` to `/opt/ayvo/logs/deployments-dev-preview.log`. On any
   failure it stops, prints container status and recent logs, and names the last good tag for
   rollback.

**Verification credentials.** The Basic Auth user is always `DEV_BASIC_AUTH_USER` from the
server env file; only the password is supplied, before anything changes: from
`AYVO_DEV_VERIFY_PASSWORD_FILE` (a mode-600 file outside the repo, e.g. temporary), from
`AYVO_DEV_VERIFY_PASSWORD`, or from a no-echo prompt on the terminal. The script removes these
variables from its environment, passes the password to curl on stdin only (never on the command
line) and never prints it. A rejected password is reported as such (401 for the configured user).

It never runs `docker compose down`, `down -v`, `volume rm` or prune commands.

### Deployment status

- **2026-10-10 — first DEV deployment completed.** Verified by the owner at runtime: web
  working, API `ok`, PostgreSQL up, Redis up, HTTPS working, Basic Auth working, environment
  `development`. The foundation milestone was approved the same day.

### First deployment

One-time prerequisites (owner, with sudo): Docker access for `ayvo`
(`sudo usermod -aG docker ayvo`, then log in again); DNS `dev.ayvo.co` → this server; inbound
TCP 80/443 (and UDP 443 for HTTP/3) reachable. Docker-published ports bypass `ufw`, so only
Caddy's ports are exposed — no other service publishes one.

```bash
# 1. Server-only env file (outside the repo)
install -d -m 700 /opt/ayvo/secrets
install -m 600 /dev/null /opt/ayvo/secrets/dev-preview.env
openssl rand -hex 32                                   # -> POSTGRES_PASSWORD
docker run --rm -it caddy:2-alpine caddy hash-password # -> DEV_BASIC_AUTH_HASH (single quotes!)
$EDITOR /opt/ayvo/secrets/dev-preview.env              # fill in the variables above

# 2. Validate (changes nothing)
scripts/deploy-dev.sh --check

# 3. Deploy and verify end to end (prompts for the Basic Auth password, without echo)
scripts/deploy-dev.sh
```

### Rollback

- **Application only** (no schema change since the target release):
  `scripts/deploy-dev.sh --rollback <tag>` — starts the previously built images without building
  or migrating, then runs the same verification. Tags: the deployment log or
  `docker images 'ayvo-dev-preview/*'`.
- **After a migration:** migrations are forward-only. **Rolling back the application does not
  reverse a schema migration** — the old images run against the new schema. Prefer forward
  recovery: fix the problem in a new migration and deploy normally. Milestone 1's migrations only
  add objects, so pre-Milestone-1 images ignore them. If the data must go back, restore the
  pre-migration dump (a deliberate, destructive step on the DEV database), mark a failed migration
  with `prisma migrate resolve --rolled-back <name>`, then roll back the images. **The files
  volume is not part of the dump** — restoring the database does not restore or remove files.

  ```bash
  C="docker compose -f deploy/dev/compose.yml --env-file /opt/ayvo/secrets/dev-preview.env"
  $C stop caddy web api
  $C exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
    < /opt/ayvo/backups/dev-preview/<dump-before-the-bad-release>.dump
  scripts/deploy-dev.sh --rollback <previous-tag>
  ```

- **Take the preview offline** without losing data: `$C stop` (never `down -v`).
- Old image tags and dumps accumulate; prune them manually when no longer needed.

## Proposed production principles (requires confirmation)

- Separate PROD (separate VPS, confirmed) and DEV environments: separate databases, Redis instances, credentials, domains. Staging is explicitly deferred.
- Never point a development machine at the production database.
- Database migrations applied explicitly as a release step (`prisma migrate deploy`), never `migrate dev` in production.
- Automated, encrypted, off-site PostgreSQL backups with tested restores; point-in-time recovery recommended because PostgreSQL holds the authoritative history.
- Container images built from the monorepo; API and web may be deployed as separate processes of the same monolith codebase.
- Structured logging, health checks (`/api/health`), uptime monitoring, error tracking.

## Open questions

- Production VPS provider and region (EU data residency?); self-managed vs managed PostgreSQL.
- Backup retention, RPO/RTO targets.
- Monitoring/logging/error-tracking stack.
- CI/CD platform (e.g. GitHub Actions) and release process — deferred by owner until the first domain is stable.
- Production domain and TLS setup (`dev.ayvo.co` is covered by ADR 0013).
- Off-server copies and retention of DEV preview backups.
- Backup of the DEV preview files volume (artwork, PDFs) together with the database dump.
- Milestone 1 production blockers (QR host routing, storage, backups, restore test, monitoring, secrets rotation, …): the consolidated list in [doc 016](016-bottles-and-labels.md#production-blockers).
