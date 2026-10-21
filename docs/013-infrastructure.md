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
- Caddy is the reverse proxy; the whole preview is behind HTTP Basic Auth and sends `X-Robots-Tag: noindex, nofollow` _(confirmed by owner 2026-10-10)_. Since 2026-10-17 it is reachable **only through our Tailscale tailnet** ([ADR 0026](adr/0026-dev-preview-tailnet-only.md)); the earlier "reachable from anywhere, no IP allowlist" is superseded.
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

Decision records: [ADR 0013](adr/0013-dev-preview-deployment.md),
[ADR 0026](adr/0026-dev-preview-tailnet-only.md) (tailnet only). Files: `deploy/dev/compose.yml`,
`deploy/dev/Caddyfile`, `deploy/dev/Corefile`, `deploy/dev/host/` (root-installed guard),
`apps/api/Dockerfile`, `apps/web/Dockerfile`, `scripts/deploy-dev.sh`, `scripts/verify-dev-acme.sh`.

```
tailnet ──443 (Tailscale IPv4 only)──▶ caddy (TLS, tailnet peer check, Basic Auth, X-Robots-Tag)
tailnet ──53 (Tailscale IPv4 only)───▶ dns (CoreDNS: dev.ayvo.co only, everything else REFUSED)
internet ──80 (IPv4)──▶ caddy: ACME HTTP-01 only; everything else aborted
                       ├─ /api, /api/* ──▶ api:4000  (path unchanged) ──▶ postgres:5432, redis:6379
                       └─ everything else ─▶ web:3000 ──(server-side, http://api:4000)──▶ api
networks: edge = caddy, web, api        backend (internal, no egress) = api, migrate, postgres, redis
```

| Service    | Image                          | Host ports         | Health check                                 |
| ---------- | ------------------------------ | ------------------ | -------------------------------------------- |
| `caddy`    | `caddy:2-alpine`               | ts:443 tcp/udp, 80 | admin API on container localhost             |
| `dns`      | `coredns/coredns:1.11.3`       | ts:53 tcp/udp      | — (checked by the deploy script)             |
| `web`      | `ayvo-dev-preview/web:<tag>`   | none               | `GET /` (Dockerfile `HEALTHCHECK`)           |
| `api`      | `ayvo-dev-preview/api:<tag>`   | none               | `GET /api/health` (Dockerfile `HEALTHCHECK`) |
| `postgres` | `postgres:18-alpine`           | none               | `pg_isready`                                 |
| `redis`    | `redis:8-alpine`               | none               | `redis-cli ping`                             |
| `migrate`  | `ayvo-dev-preview/api-migrate` | none (one-off run) | —                                            |

Data volumes are explicitly named (`ayvo-dev-preview-postgres-data`, `…-redis-data`,
`…-caddy-data`, `…-caddy-config`, `…-acme-webroot`) and survive rebuilds; nothing in the repo
removes them. `ts:` = the server's Tailscale IPv4 address, read by the deploy script from
`tailscale ip -4` on every run.

### Tailnet only (ADR 0026)

- **Owner, once (sudo), after an edge backup** (`scripts/dev-edge-backup.sh backup ayvo-dev-preview /opt/ayvo/backups/dev-preview /opt/ayvo/secrets/dev-preview.env`): `sudo bash deploy/dev/host/install.sh <that backup directory>` — verifies it, backs up the firewall state to
  `/var/backups/ayvo-dev-tailnet/<time>/`, installs the `DOCKER-USER` guard unit and the sysctl
  `net.ipv4.ip_nonlocal_bind=1`. The deploy script refuses to run without them.
- **Owner, Tailscale admin console:** DNS → add nameserver `<server Tailscale IPv4>`, _Restrict to
  domain_ `dev.ayvo.co` (split DNS); access policy: members → server tcp/udp 443, tcp 80,
  tcp/udp 53; admins → tcp 22. Save the previous policy first.
- `scripts/deploy-dev.sh --edge` recreates only Caddy and DNS with the running image tag.
- `scripts/verify-dev-acme.sh` proves certificate renewal (Let's Encrypt staging, HTTP-01 over the
  public IPv4 :80 exception; the test certificate is discarded).
- Still public: SSH 22 (until the owner closes it), Tailscale UDP 41641, IPv4 TCP 80 (ACME only).
- Rollback: [ADR 0026 § Backup and rollback](adr/0026-dev-preview-tailnet-only.md#backup-and-rollback-exact) (`scripts/dev-edge-backup.sh`).

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
(`sudo usermod -aG docker ayvo`, then log in again); DNS `dev.ayvo.co` → this server (public, for
ACME HTTP-01); inbound IPv4 TCP 80 reachable; Tailscale logged in; the host guard installed
(above). Docker-published ports bypass `ufw`: the guard and the tailnet binding handle them.

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
  reverse a schema migration** — the old images run against the new schema, which they may not
  fully support (e.g. permissions added by the migration, doc 033 §7). **Prefer forward recovery:**
  fix the problem in a new migration and deploy normally. Restoring the pre-migration dump is a
  last resort, below.

#### Restore a pre-migration dump (last resort, owner approval each time)

**Separate, explicit owner approval** before step 2, every time: it names the dump file and states
that **every write since that dump is lost** (records in old and new tables). The files volume is
not part of the dump: files stored since the dump stay, unreferenced (never deleted
automatically). Nothing below is done without that approval.

Never:

- `pg_restore --clean` into the running (newer) database — it does not remove tables, functions or
  triggers the newer release added, and fails on their dependencies (verified 2026-10-21: 23
  errors, the newer tables remained while `_prisma_migrations` already looked like the old one);
- `prisma migrate resolve --rolled-back` for migrations that **succeeded** — that command only
  marks a **failed** migration; a restored database simply carries the dump's own history;
- dropping the current database: it is renamed and kept until the owner decides.

Steps (`DB` = `POSTGRES_DB` of the server env file; `R` = `${DB}_restore_<UTC time>`):

```bash
C="docker compose -f deploy/dev/compose.yml --env-file /opt/ayvo/secrets/dev-preview.env"
DUMP=/opt/ayvo/backups/dev-preview/<dump-before-the-bad-release>.dump
# 1. the dump is readable — otherwise stop here
$C exec -T postgres pg_restore --list < "$DUMP" > /dev/null
# 2. (after the approval) no more writes
$C stop caddy web api
# 3. restore into a NEW, empty database: one transaction, stop at the first error
$C exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" '"$R"
$C exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d '"$R"' --exit-on-error --single-transaction' < "$DUMP"
```

If step 3 fails, **stop**: the current database is untouched; keep `$R` for diagnosis and start
the current release again (`scripts/deploy-dev.sh --rollback <current-tag>`).

4. Check `$R` (read-only); any difference → stop as above:
   - **history:** `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
AND rolled_back_at IS NULL ORDER BY 1` equals the migration directories of the previous
     release (`git ls-tree --name-only <previous-commit> apps/api/prisma/migrations/`, without
     `migration_lock.toml`); no row with `finished_at IS NULL` or `rolled_back_at IS NOT NULL`;
   - **schema:** the previous release's migrate image reports it up to date — only `status`, never
     `deploy`: `POSTGRES_DB=$R AYVO_IMAGE_TAG=<previous-tag> $C --profile tools run --rm --no-deps
migrate node_modules/.bin/prisma migrate status` → "Database schema is up to date!";
   - **data:** the per-table fingerprint (count + md5 of every table, read-only transaction) equals
     the one taken before the deploy; `SELECT count(*) FROM ayvo_inventory_drift()` is 0.
5. Switch (connected to the `postgres` database; api and web are stopped):
   `ALTER DATABASE "$DB" RENAME TO "${DB}_superseded_<UTC time>"; ALTER DATABASE "$R" RENAME TO "$DB";`
6. `scripts/deploy-dev.sh --rollback <previous-tag>` (previous images, no migration, the same
   verification), then the QR passport and ledger checks of the deploy procedure.

Verified in isolation (2026-10-21, SUP42-R3, local dev PostgreSQL, scratch databases): dump of
release 9a6231f → this PR's migrations and writes → restore into a new database: fingerprint
identical (95 tables), history exactly the 36 migrations of 9a6231f, `migrate status` up to date,
`migrate diff` against its schema empty, ledger drift 0; the API of 9a6231f on the restored
database signed in, read and created a supplier, read receipts and stock. A second restore into
the non-empty database ended with exit 1 and changed nothing.

- **Take the preview offline** without losing data: `$C stop` (never `down -v`).
- Old image tags and dumps accumulate; prune them manually when no longer needed.

## GitHub automation

Pull requests are created and maintained from this server by the **AYVO Automation** GitHub App
(installed on the AyvoOS repository only) through `/opt/ayvo/bin/ayvo-gh`; merges need an explicit,
per-PR owner authorization. Git pushes keep using the SSH remote. Setup, threat model, rotation,
revocation and removal: [doc 017](017-github-automation.md), [ADR 0018](adr/0018-github-app-automation.md).

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
