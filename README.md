# AYVO OS

The central operating system for **AYVO** — a premium B2B circular hotel amenity service.
AYVO supplies hotels with reusable premium cosmetic bottles and manages the full loop: filling,
reusable crates, recurring service deliveries, returns, washing, inspection, refilling, hotel
contracts, monthly billing and sustainability reporting.

## Current project status

| Area             | Status                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| Foundation       | **Complete** — approved by owner 2026-10-10                                 |
| DEV preview      | **Deployed** at `dev.ayvo.co` — first deployment completed 2026-10-10       |
| Business modules | **Not implemented yet** (bottles, crates, hotels, deliveries, billing, ESG) |

## Environments

| Environment | Where                                 | Status                                                          |
| ----------- | ------------------------------------- | --------------------------------------------------------------- |
| Development | this server; preview at `dev.ayvo.co` | deployed (2026-10-10); DEV only — no production data or secrets |
| Production  | separate VPS                          | not yet created                                                 |

There is no staging environment yet ([ADR 0008](docs/adr/0008-dev-prod-separation.md)). The DEV
preview runs behind Caddy with HTTP Basic Auth; the API is same-origin at `/api/*`
([ADR 0013](docs/adr/0013-dev-preview-deployment.md)). Deployment is manual — see
[DEV preview deployment](docs/013-infrastructure.md#dev-preview-deployment-devayvoco).

## Documentation

| Doc                                                          | Topic                                              |
| ------------------------------------------------------------ | -------------------------------------------------- |
| [001 Vision](docs/001-vision.md)                             | What AYVO OS is for                                |
| [002 System principles](docs/002-system-principles.md)       | Non-negotiable engineering principles              |
| [003 Domain model](docs/003-domain-model.md)                 | Entities, glossary, module ownership               |
| [004 Bottle lifecycle](docs/004-bottle-lifecycle.md)         | Bottle identity, events, invariants                |
| [005 Crate lifecycle](docs/005-crate-lifecycle.md)           | Crates, temporary membership                       |
| [006 Warehouse workflows](docs/006-warehouse-workflows.md)   | Filling, picking, goods-in                         |
| [007 Hotels and contracts](docs/007-hotels-and-contracts.md) | Customer master data                               |
| [008 Service deliveries](docs/008-service-deliveries.md)     | Proposals, picking, shipments                      |
| [009 Returns](docs/009-returns.md)                           | Goods-in, sorting, re-identification               |
| [010 Billing](docs/010-billing.md)                           | Contract-based invoicing (separate from logistics) |
| [011 Sustainability](docs/011-sustainability.md)             | ESG data, public bottle passport                   |
| [012 Security](docs/012-security.md)                         | Tenant isolation, roles, secrets                   |
| [013 Infrastructure](docs/013-infrastructure.md)             | Dev setup, production principles                   |
| [014 Roadmap](docs/014-roadmap.md)                           | Proposed phases                                    |
| [ADRs](docs/adr/README.md)                                   | Architecture Decision Records                      |

## Architecture at a glance

- **Modular monolith** ([ADR 0001](docs/adr/0001-modular-monolith.md)) — one NestJS backend,
  one Next.js frontend, strict module boundaries. No microservices.
- **PostgreSQL is the source of truth** ([ADR 0002](docs/adr/0002-postgresql-source-of-truth.md)),
  accessed through Prisma ([ADR 0009](docs/adr/0009-prisma-orm.md)).
- **Auditable, append-only lifecycle history** with current-state tables for performance — not
  full event sourcing ([ADR 0006](docs/adr/0006-auditable-lifecycle-history.md)).
- **Redis is non-authoritative** — cache, queues, rate limiting only
  ([ADR 0010](docs/adr/0010-redis-non-authoritative.md)).

## Repository structure

```
apps/
  api/          NestJS 12 (ESM) backend — GET /api/health, Prisma + Redis wiring, Dockerfile
  web/          Next.js 16 frontend — placeholder page showing API/DB/Redis status, Dockerfile
packages/
  config/       Shared tsconfig + ESLint config
  types/        Shared API contracts (Zod schemas + inferred types)
  ui/           Shared React components (Tailwind, shadcn/ui-compatible `cn` helper)
docker/
  compose.yml   Local dev PostgreSQL 18 + Redis 8 (bound to 127.0.0.1)
deploy/dev/     DEV preview stack (dev.ayvo.co): Compose file + Caddyfile
scripts/
  deploy-dev.sh Manual DEV preview deployment (build, backup, migrate, start, verify)
docs/           Architecture docs and ADRs
```

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- pnpm 12 — via Corepack: `corepack enable pnpm` (version pinned in `package.json`)
- Docker with the Compose plugin (for PostgreSQL and Redis)

## Getting started

```bash
corepack enable pnpm
pnpm install
cp .env.example .env          # dev-only values; never commit .env
pnpm infra:up                 # start PostgreSQL + Redis (Docker)
pnpm dev                      # API on :4000, web on :3000
```

- Web: <http://localhost:3000> — shows API, PostgreSQL and Redis status
- API health: <http://localhost:4000/api/health> (every API route lives under `/api`)

The API starts even when PostgreSQL/Redis are down and reports `"status": "degraded"`.

## Commands

| Command                             | What it does                                           |
| ----------------------------------- | ------------------------------------------------------ |
| `pnpm dev`                          | Run all apps in watch mode                             |
| `pnpm build`                        | Build all workspaces                                   |
| `pnpm lint`                         | ESLint in every workspace                              |
| `pnpm typecheck`                    | TypeScript `--noEmit` in every workspace               |
| `pnpm test`                         | Vitest unit/integration tests                          |
| `pnpm test:e2e`                     | Playwright smoke tests (needs `pnpm build` + browsers) |
| `pnpm format` / `pnpm format:check` | Prettier                                               |
| `pnpm db:generate`                  | Generate the Prisma client                             |
| `pnpm db:migrate`                   | Create/apply a dev migration (`prisma migrate dev`)    |
| `pnpm infra:up` / `pnpm infra:down` | Start/stop dev PostgreSQL + Redis                      |
| `pnpm infra:config`                 | Validate `docker/compose.yml`                          |
| `pnpm deploy-dev:config`            | Validate `deploy/dev/compose.yml` (placeholder env)    |
| `scripts/deploy-dev.sh --check`     | Validate the server env file + DEV preview config      |
| `scripts/deploy-dev.sh`             | Deploy the DEV preview (on the DEV server only)        |

Playwright browsers: `pnpm --filter @ayvo/web exec playwright install --with-deps chromium`.

## Rules

- Never commit secrets. Only `.env.example` is tracked.
- DEV and PROD are strictly separated ([ADR 0008](docs/adr/0008-dev-prod-separation.md)).
- Lifecycle history is never silently rewritten; corrections are new events.
- [CLAUDE.md](CLAUDE.md) is the canonical contributor/AI-agent instruction file (Turborepo's
  generated `AGENTS.md` is disabled — [ADR 0012](docs/adr/0012-turborepo-agent-guidance-disabled.md)).
