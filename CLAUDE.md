# CLAUDE.md — working rules for AYVO OS

AYVO OS is the operating system for AYVO, a B2B circular hotel amenity service (reusable bottles,
crates, recurring service deliveries, returns, contract billing, ESG). Read `docs/` before
changing behaviour — especially 002 (principles), 003 (domain model) and the ADRs in `docs/adr/`.

## Hard rules

- **No deploys, no `git push`, no infrastructure changes outside this repo** without explicit
  owner approval.
- **Never invent business rules.** If the docs list something as an open question, ask. Do not
  hard-code assumptions (QR format, prorating, VAT, retirement criteria, partial crates, CO2e…).
- **Modular monolith** (ADR 0001). No microservices. Modules talk through exported services, never
  through another module's tables.
- **PostgreSQL is the source of truth** (ADR 0002). Redis is non-authoritative (ADR 0010).
- **History is append-only** (ADR 0006). Never UPDATE/DELETE lifecycle events; corrections are
  new compensating events. Current-state tables are allowed, but must change in the same
  transaction as the event that justifies them.
- **Multi-record business operations are transactional** (`prisma.$transaction`).
- **Invariants live in the database where possible** (unique / partial unique indexes, FKs,
  checks) — not only in application code. E.g. a bottle can never be in two active crates; a
  DISPOSED/DESTROYED bottle can never come back.
- **Billing is separate from logistics** (ADR 0007): base invoices derive from contracts
  (rooms × price/room/month), never from bottles shipped.
- **Tenant isolation:** hotel users must never see another hotel's data. Enforce server-side and
  test it.
- **No CO2e claims** without a documented methodology.
- **No secrets in git.** Only `.env.example` is committed.
- **Foundation phase:** do not add domain Prisma models (Bottle, Crate, Hotel, Delivery, Billing,
  ESG) until the owner approves the corresponding docs.

## Confirmed domain decisions (owner, 2026-10-10)

- Standard outbound crate capacity is **20**. A **READY** outbound crate contains **exactly 20
  bottles of the same product and size** (ADR 0004).
- Return crates may be partial, mixed, or contain not-yet-identified bottles (ADR 0004).
- Bottle **internal ID ≠ public QR identity**. The public QR identity is opaque, practically
  unguessable, and its URL stays stable for the bottle's physical lifetime (ADR 0005). The exact
  QR payload/URL format is still open.
- **RETIRED** is operationally terminal but may be reversed only by an authorized, audited
  correction event. **DISPOSED/DESTROYED** is irreversible (ADR 0011).
- A **completed reuse cycle** = delivered to a hotel, then returned and individually identified
  by AYVO (ADR 0011).
- AYVO admin users will require MFA (doc 012).

## Environment

- **This server is DEV only.** No production customer data and no production secrets here, ever.
- `dev.ayvo.co` is the development preview environment. Production will run later on a
  **separate VPS**. No staging environment yet — `APP_ENV` is `development | test | production`
  (ADR 0008).
- `docker/compose.yml` runs dev PostgreSQL 18 + Redis 8 on 127.0.0.1.
- DEV preview (ADR 0013): Caddy is the only public entry (80/443), HTTP Basic Auth on everything,
  `X-Robots-Tag: noindex, nofollow`. The API is **same-origin** at `/api/*` — NestJS owns the
  `/api` prefix (`API_BASE_PATH` in `@ayvo/types`); Caddy forwards the path unchanged. No API
  subdomain, no CORS, no IP allowlist, no CI/CD. Deploy only with `scripts/deploy-dev.sh`, and only
  when the owner asks; it must never remove volumes. Secrets live in
  `/opt/ayvo/secrets/dev-preview.env`, never in the repo.

## Stack

TypeScript 6 · pnpm 12 (Corepack) · Turborepo · Next.js 16 (`apps/web`) · NestJS 12 ESM
(`apps/api`) · Prisma 7 + `@prisma/adapter-pg` · PostgreSQL 18 · Redis 8 (ioredis) · Zod 4 ·
Tailwind 4 · Vitest · Playwright.

## Layout

- `apps/api` — NestJS. ESM: relative imports **must** use the `.js` extension. Prisma schema in
  `apps/api/prisma/schema.prisma`; generated client in `apps/api/src/generated/` (git-ignored,
  produced by `pnpm db:generate`). Env validated by Zod in `src/config/env.ts`.
- `apps/web` — Next.js App Router. Server-only env in `src/lib/env.ts`.
- `packages/types` — Zod schemas shared by API and web (API contracts). Built to `dist/`.
- `packages/ui` — shared React components; exported as TS source, transpiled by Next.
- `packages/config` — shared tsconfig and ESLint config.
- `docker/compose.yml` — dev PostgreSQL + Redis only.
- `deploy/dev/` — DEV preview Compose stack + Caddyfile; `apps/*/Dockerfile` — app images (build
  context = repo root, `.dockerignore` keeps `.env*` out); `scripts/deploy-dev.sh` — manual deploy.

## Conventions

- Nest DI: don't use `import type` for injected classes (decorator metadata needs the value
  import). Tests that bootstrap Nest rely on `unplugin-swc` for decorator metadata.
- New API contracts go into `packages/types` as Zod schemas; infer types with `z.infer`.
- New backend domain = new Nest module under `apps/api/src/<module>/` with its own tests.
- Architecture changes need an ADR (`docs/adr/`, next number; supersede, don't rewrite).
- **CLAUDE.md is the canonical AI instruction file.** Turborepo's auto-generated `AGENTS.md` is
  disabled (`"agentGuidance": false` in `turbo.json`, ADR 0012). Turborepo may differ from your
  training data: before changing `turbo.json` or turbo commands, read the installed version's docs
  in `node_modules/turbo/docs/`.

## Before finishing any change

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check
```

Check `git status` for accidentally added secrets or generated files. Don't push.
