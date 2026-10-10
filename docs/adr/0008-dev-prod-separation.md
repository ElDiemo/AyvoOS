# ADR 0008: DEV / PROD separation

- **Status:** Accepted — confirmed by owner 2026-10-10
- **Deciders:** AYVO OS lead architect

## Context

AYVO OS will hold customer, contract, billing and operational data. Mistakes
in development (test data, destructive migrations, leaked credentials) must
never affect production. No deployment pipeline exists yet.

## Decision

- **Separate environments** with no shared stateful resources:
  separate PostgreSQL databases, separate Redis instances, separate
  credentials, separate API keys for external services (e.g. carrier
  sandbox vs production).
- An explicit `APP_ENV` variable (`development`, `test`, `production`) is
  required and validated at startup; dangerous operations
  (seeding, database reset, test fixtures) refuse to run in `production`.
- Configuration comes from environment variables, validated with Zod at
  startup. `.env.example` documents every variable with safe placeholder
  values; real `.env*` files are git-ignored.
- **Production secrets are never committed** to the repository and never
  placed in development machines' env files.
- **No production data in development** unless anonymised by a defined,
  reviewed procedure.
- **The current server is DEV only** (confirmed). No production customer
  data and no production secrets belong on it.
- **`dev.ayvo.co`** is the development preview environment (confirmed).
- **Production will later run on a separate VPS** (confirmed).
- **No staging environment** is created for now (confirmed); staging is
  explicitly deferred and would need a new decision.
- **No deployment from this repository yet.** Deployment and server
  infrastructure will be defined in a later ADR.
- Database migrations are committed to the repo and applied to production
  only through a reviewed, explicit process (`prisma migrate deploy`), never
  `migrate dev` or `db push` against production.
- Local development uses Docker Compose for PostgreSQL and Redis, bound to
  localhost.

## Consequences

### Positive

- Development cannot damage production data or send real shipments/
  invoices by accident.
- Clear, validated configuration; misconfiguration fails fast.

### Negative

- More infrastructure to maintain (at least two environments).
- Realistic test data must be generated rather than copied.

## Alternatives considered

- **Shared database with schemas/prefixes per environment** — rejected:
  too easy to cross boundaries.
- **Secrets in repo (encrypted)** — not adopted now; a secret manager
  decision is deferred.

## Open questions

- Provider and region for the production VPS; secret management tool.
- ~~Hosting setup for `dev.ayvo.co`~~ — resolved by
  [ADR 0013](0013-dev-preview-deployment.md) (2026-10-10).
- CI/CD pipeline and approval process for production deploys.
