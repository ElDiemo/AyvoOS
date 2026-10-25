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
- **The running core is not the DB superuser** (ADR 0041, in review): `api` connects as `ayvo_core`
  (rows of `public` only — no TRUNCATE, DDL, trigger switching or other schemas); migrations, role
  setups and backups keep the privileged account. Tests run the app as such a role; fixtures that
  need more use `withPrivileged` — never broaden the runtime role.
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
- **Domain models need owner approval.** Approved and implemented (Milestone 1, doc 016): Bottle,
  BottleEvent, BottleCreationBatch, LabelTemplate(+Version/Element), LabelArtwork, LabelPrintJob.
  Milestone 2A (doc 018): inventory units/items/settings/locations/lots, the stock ledger and
  balances, BOM versions/lines, suppliers, supplier documents, goods receipts (+lines, document
  links, corrections), bottle component attachments, operation requests. Milestone 2C (doc 021):
  users, user identities, roles (system + custom, ADR 0024), permissions, user roles, user scopes
  (site + warehouse), user sessions (with the active site), login states, identity bootstrap,
  audit events, **sites** (doc 022, ADR 0023), user invitations (doc 021 §7b). Catalogue core
  (requested by the owner 2026-10-13, doc 023; table design subject to the owner's PR review):
  product categories, catalogue components, crate types (+ categories), products, recipe
  versions / revisions / revision BOMs. Physical crates (doc 020 §3.4, issue #19 PR A1, doc 025):
  QR identity registry, crate registrations, crates, crate label print jobs, crate events.
  Workstations and work sessions (doc 026, A2, model approved 2026-10-14): workstations,
  workstation events, workstation sessions (one active per station and per user), session events.
  Labelling into crates (doc 025 A3, owner B1–B4 2026-10-14): product label approvals, crate
  cycles, crate assignments, bottle product bindings, the labelling context on sessions; a new
  LABEL_APPLIED only into a crate cycle (the standalone label application answers 410).
  Filling (doc 025 A4, schema approved 2026-10-16): bottle status/event FILLED with its one liquid
  lot, PUMP attachments, FILL movements, cycle counters (Obsah/Naplněno), Hotovo (FILLED) and
  supervised corrections (`production:cycle_correct`) — no holds/quarantine yet.
  Hotels, manual orders and picking (doc 028, owner 2026-10-17): hotels (one delivery address,
  contact, explicit fulfilment site), orders (site + address snapshot), order lines in whole
  crates (capacity from the crate type), order crate allocations (+ their bottles), order events;
  crate cycle `ALLOCATED`; permissions `hotels:*` / `orders:*` for ADMIN only. Ends at
  "Připraveno k expedici" — no carrier, dispatch, delivery, contracts or hotel users.
  Dispatch to a carrier (doc 029, owner 2026-10-18): shipments (one live per order, whole order
  together), parcels (1 crate = 1 parcel = 1 label, from the allocation), optional actual
  weighings, carrier requests (written, claimed once, never re-sent blindly), stored labels;
  order `READY_FOR_PICKUP` / `HANDED_TO_CARRIER`, cycle `DISPATCHED` (not delivered);
  `shipments:read|prepare|handover` for ADMIN only. Carrier behind `carriers/carrier.ts`;
  `CARRIER_PROVIDER=test` only with `APP_ENV=test`. No delivery, returns or pickup ordering.
  Site carrier settings (doc 029 §9, owner 2026-10-19): `site_carrier_settings` (PPL only,
  `sites:carrier_manage`, ADMIN), a server-side connection by code (only `PPL_TEST`, URL fixed in
  code, no production connection), credentials only on the server — never in plaintext in the DB,
  never in the browser, logs, audit or git; each request snapshots settings + connection + environment +
  account. Credentials may also be entered in Správa systému → Dopravci (ADR 0027,
  `carriers:connections_manage`): AES-256-GCM in `carrier_connections`, key `CARRIER_CREDENTIALS_KEY`
  only in the server env, secret write-only; another account never takes over existing shipments.
  Weights and dimensions (doc 025 §10, W1, owner 2026-10-17): append-only measured references of
  components and packaging (per unit; a liquid as a weighed sample), the finished bottle per
  recipe version, crate tare and crate /
  shipping-package dimensions (g / mm), Hotovo weight snapshots; `catalog:weights_record`.
  Unknown is never 0; one shipped crate = one parcel = one label; no carrier limit hard-coded.
  Order states and carrier tracking (doc 031, ADR 0029, owner 2026-10-20): order `DELIVERED`,
  crate cycle `DELIVERED`, `shipment_tracking` (schedule), `shipment_tracking_events`
  (append-only, the carrier's own code and times), `shipment_parcel_progress` (forward only);
  order and crate events with `source` USER | CARRIER (actor NULL only for CARRIER). Only the
  carrier's documented codes change states (PPL 150/151 pickup, 450–453 delivery); handed over /
  delivered only when every parcel is; a delivery never completes a bottle's reuse cycle.
  Owner 2026-10-21: a parcel picked up and not delivered keeps the site active
  (`PARCELS_IN_TRANSIT`, also DB); return / loss / failed attempt / pick-up point is never a
  delivery — a warning on that parcel, nothing cancelled, released or returned automatically.
  Hotel supply plans (doc 032, owner 2026-10-20): one plan per hotel (validity, INACTIVE →
  ACTIVE ⇄ PAUSED, rules of product × whole crates × days 1–31), occurrences unique per plan and
  local ship day (DB), orders with `origin` MANUAL | SUPPLY_PLAN pointing to their occurrence,
  optional hotel receiving details; `orders:plan_manage` (ADMIN only). Plans only create ordinary
  orders (never a carrier shipment, pickup, label print or dispatch); horizon 14 days, never a
  past day; a cancelled or moved order is never created again. No hotel portal, no forecasting.
  Dispatch and direct printing (doc 029, doc 030, owner 2026-10-18/-20; PR #36, #37, PR C for review):
  shipments, parcels, carrier requests, labels in several formats (PDF preview + ZPL for printing,
  never our own conversion), per-site carrier settings and encrypted carrier connections (ADR 0027),
  printers and print agents per site (a machine principal with its own token — ADR 0028), the durable
  print queue (jobs + append-only events; SENT ≠ printed; UNCERTAIN never retried automatically).
  Obchod — hotel acquisition (doc 034, ADR 0031, requested by the owner 2026-10-21; table design
  subject to the owner's PR review): sales prospects, contacts, append-only activities (corrected
  by new versions), tasks and append-only sales events; `sales:work` (SALES, own prospects) and
  `sales:manage` (ADMIN, everything, assignment). Not site-scoped; prospects are not hotels and
  nothing outside Obchod is created. SALES is assignable, FINANCE and HOTEL_USER stay planned.
  Archiving a prospect (owner 2026-10-22, doc 034 §3a): archived at / by / reason on the prospect,
  not a stage, never with open tasks, read-only until restored (also DB); task edits in the UI.
  CSV import / export of prospects (owner 2026-10-22, doc 034 §13): append-only `sales_imports`
  (result only — the file is never stored), `import_id` / `import_row` on prospects; preview
  writes nothing, confirmation re-checks everything in one transaction; export in the list's
  scope with CSV-injection protection.
  Finance — received documents (night package N1, started by the owner 2026-10-24, doc 039; table
  design subject to review). **Its own runtime unit (owner 2026-10-25, ADR 0039 limited variant
  A):** container `finance` (`node dist/finance/main.js`), schema `finance` with its own Prisma
  schema/migrations (`apps/api/prisma-finance`), roles `ayvo_finance_owner` (migrations) and
  `ayvo_finance` (runtime: SELECT/INSERT/UPDATE on Finance tables only), no FKs to the core; it
  never imports core modules or reads core tables. Suppliers, supplier documents and the current
  user come only from the core contract `/api/internal/v1/finance/*` (service token + forwarded
  session, evaluated per request; Caddy aborts /api/internal/*); core down = Finance 503, never
  access. Documents: own PDF or a referenced supplier document (no copy), drafts "k doplnění",
  handover month, versioned metadata, voided never deleted; `finance:documents_read|manage` for
  ADMIN only. Export for the accountant (N2, doc 039 §7): one handover month, FULL/SUPPLEMENT, the
  confirmation bound to the preview fingerprint (else PREVIEW_STALE), incomplete documents block it,
  built outside DB transactions within fixed bounds, one build per process; append-only exports,
  items (version + file hash) and events GENERATED / DOWNLOADED / HANDED_OVER (manual, once);
  `finance:exports_manage` for ADMIN only. Deployed only by `scripts/deploy-finance-dev.sh`. No
  VAT logic, posting, payments or automatic sending to the accountant.
  Hotel billing settings (N3A-1, owner 2026-10-25, doc 040; in review, not merged): customers (the
  billed company ≠ hotel) with versions, one billing agreement per hotel with append-only bitemporal
  versions (the only place of billed rooms / own price; effective from the 1st of a month), the
  default price list per currency; exact decimals, an explicit 0.00 ≠ missing; hotels only via the
  core contract; `finance:billing_read|manage` (ADMIN). No amounts, VAT, numbering or invoices yet;
  live invoicing stays blocked until the owner approves the accounting rules.
  Employee public business cards (owner 2026-10-23; ADR 0036, docs/employee-business-cards.md;
  implementation/model pending PR review): one optional card per existing user, explicit public
  fields, stable slug, separate versioned draft/publication and private normalized photos;
  `identity:users_manage` only. Deactivation hides atomically; reactivation never republishes.
  This feature does not authorize public-host cutover, real-profile imports or DNS changes.
  **Approved design, not
  implemented** (Production Core v0.1, doc 020): product-label approvals, crates, crate
  cycles/assignments/events, production orders and series, work sessions, inventory reservations,
  bottle category bindings, holds and identity voids — implement only PR by PR as the owner
  authorizes (doc 020 §14). Do not add other domain models (FillBatch, Hotel, Delivery, Billing,
  ESG, purchase orders, commissions) until the owner approves the corresponding docs.

## Confirmed domain decisions (owner, 2026-10-10)

- **Crates (owner 2026-10-11, ADR 0021 — supersedes the 20-bottle crate of ADR 0004):** capacity
  **40**, as data on the crate type and a snapshot on the cycle — never a constant. The same crate
  serves assembly, filling, shipment and return; **one crate cycle = one complete circulation**
  (`OPEN_ASSEMBLY → READY_TO_FILL → …→ CLOSED`). Bottles are scanned into the crate **before**
  filling; the 40th eligible bottle makes it `READY_TO_FILL`, a partial cycle is never made ready
  manually, and a cycle never mixes product, category, recipe version, label version or crate
  type. Membership is an assignment (ordinal 1…capacity), never a bottle status.
- Return crates may be partial, mixed, or contain not-yet-identified bottles (owner 2026-10-10);
  a return links to the same circulation cycle.
- **Production (owner 2026-10-11, doc 020):** product ≠ label template; a production order fixes
  product, recipe version, label version and planned quantity (= currently eligible bottles). The
  first physically confirmed label permanently binds the bottle's product category
  (`HAND_SOAP`/`SHOWER_GEL`). Quarantine is an active `bottle_hold` (eligibility overlay), not a
  status. A completed order is never reopened. The stock ledger follows physical truth; reservation
  coverage is derived (priority → `ready_at` → order code, whole reservations only). No activation
  outside a production order once the production scan exists. v0.1 deliveries are whole crates of
  40 (doc 008).
- **Authentication (owner 2026-10-11, ADR 0022, doc 021 — Milestone 2C):** external OIDC (WorkOS
  AuthKit) behind the provider boundary in `apps/api/src/identity`; users, roles, permissions,
  scopes, sessions and audit are authoritative in PostgreSQL and evaluated on every request;
  identity only from the `ayvo_session` cookie, never from headers or unverified claims.
  **Every API route must declare `@Public()`, `@Authenticated()` or `@RequirePermission(...)`** —
  the global guard denies everything else, and `test/identity.e2e.test.ts` fails on an undeclared
  route. New permissions are added to the catalogue by migration (and to `packages/types`) and
  granted to `ADMIN` explicitly in the same migration (ADMIN = whole system, never a code bypass;
  the role-matrix test fails otherwise). Purchase prices and supplier documents need
  `procurement:cost_read` / `procurement:documents_read` and are omitted server-side otherwise;
  recording prices needs `procurement:cost_write` (refused otherwise, also on replay). Production
  series, bottles, print jobs and supplier documents belong to a site (`@OperationalSite()`);
  label templates are company-wide (`production:templates_manage`, ADMIN by default). The sign-in
  rate limiter fails closed (503) without Redis.
  `SALES`, `FINANCE` and `HOTEL_USER` are planned templates (doc 021 §4c): not assignable
  (`isPlannedRole`, refused by the API), records and permissions unchanged.
  Users are onboarded only by AYVO invitations (provider API, server-side): an identity is linked
  at first sign-in only if the provider reports the user's invitation accepted by exactly that
  identity (the bootstrap ADMIN excepted). Session defaults: 120 min idle, 12 h absolute.
  WorkOS tokens: exact `WORKOS_JWT_ISSUER` (required), `client_id`, `sid`, RS256 only (doc 021 §5a).
  The permission catalogue and system roles change only inside a migration that switches
  `ayvo.catalogue_migration` on (and off at the end); custom roles never hold security
  administration. Sign-in routes are rate limited in Redis (doc 021 §5b).
- **Sites (owner 2026-10-12, ADR 0023, doc 022):** a site is a physical facility (not a country, not
  a legal entity) and the operational boundary. Warehouses belong to exactly one site; roles say
  what, site scopes say where (warehouse scopes only narrow an accessible site); ADMIN's global
  access is the permission `sites:all_access`. Warehouse-scoped routes act on the session's
  validated active site (`@OperationalWarehouse()`), never on a site named in the request. New
  operational records belong to a site; codes stay globally unique; timestamps UTC, shown in the
  site's time zone. Hotel fulfilment site and per-site carriers: rules in doc 022 §7–§8 (not
  implemented).
  **Native authentication (owner 2026-10-23/24, ADR 0037, doc 038 — in review, replaces the
  WorkOS provider only):** e-mail + password (Argon2id) then TOTP, always both; invitations and
  resets by one-time e-mailed links; recovery codes; `AUTH_ENCRYPTION_KEY` per environment, never
  copied; mail only through an explicitly chosen transport (`google-relay` = the approved Google
  Workspace IPv4 relay without credentials, or `smtp` with user + password; `memory` tests only).
  `AUTH_PROVIDER=test` exists only with `APP_ENV=test`; never add another bypass. The first
  ADMIN is bootstrapped once (`node dist/identity/bootstrap-admin.js`).
- Bottle **internal ID ≠ public QR identity**. The public QR identity is opaque, practically
  unguessable, and its URL stays stable for the bottle's physical lifetime (ADR 0005). Production
  QR URL `https://qr.ayvo.co/<token>`, DEV `https://dev.ayvo.co/q/<token>`; token = 128 random
  bits, 22 base64url chars (ADR 0014, accepted). The QR encodes only that URL. Hard DEV/production
  separation: production encodes only `https://qr.ayvo.co`, nothing else ever does; DEV labels
  carry `DEV - NOT FOR PRODUCTION`. QR size/error correction are **provisional** until the
  physical test — never hardcode them.
- Milestone 1 (doc 016): bottle codes `AYV-B-000001`, creation batches `BC-000001` (not fill
  batches), print jobs `PJ-000001`; registration of 1–1000 bottles is all-or-nothing with one
  `CREATED` event per bottle; label templates are not products and their versions are immutable
  (ADR 0015); new batches use only the latest version of an active (non-archived) template;
  templates are never deleted; one label per PDF page at the exact size, no bleed/crop marks, 100 %
  scale; no A4 imposition yet. Timestamps UTC, displayed in Europe/Prague.
- **Milestone 1 is a DEV implementation only.** The single consolidated production-blocker list is
  in doc 016 ("Production blockers"); never mark QR size, printer output, storage, authentication
  or production readiness as approved. DEV Basic Auth was removed by the owner (ADR 0030).
- `https://qr.ayvo.co` may appear only in `apps/api/src/common/qr-policy.ts`, the matching DB
  CHECK, their tests and docs — never as a default, preview or UI value (ADR 0014).
- Label engine vs. bottles: `labels` must not import bottle code (doc 016 "Module structure");
  registration is idempotent per client `requestId`; template renaming is disabled (prerequisites
  in doc 016).
- **Inventory (owner 2026-10-11, doc 018, ADR 0019):** quantities are exact (`NUMERIC(19,3)`,
  decimal strings, pieces whole, no implicit unit conversion); stock changes only through the
  append-only ledger (balances are written by the database trigger, never negative); every
  mutating operation is idempotent per request id (`OperationRequestsService`). A bottle identity
  is physical only after `LABEL_APPLIED` (status `LABELED_EMPTY`, Czech "Etiketa nalepena – prázdná
  lahev"), which consumes exactly one `NEW_BOTTLE` from the lot the operator selected — never
  FIFO, never a silent lot switch. Creating identities or printing consumes no bottle stock. The
  bottle body owns the identity; labels/pumps/liquid are components with installation history.
  Receipts need an invoice or delivery note (no invoice ⇒ "invoice pending"). Never hard-code the
  fill quantity (330 ml is recipe data, 2B). The internal application is Czech
  (`apps/web/src/i18n/cs`, doc 019); the public passport stays English.
- **RETIRED** is operationally terminal but may be reversed only by an authorized, audited
  correction event. **DISPOSED/DESTROYED** is irreversible (ADR 0011).
- A **completed reuse cycle** = delivered to a hotel, then returned and individually identified
  by AYVO (ADR 0011).
- AYVO admin users will require MFA (doc 012), provided through the identity provider (ADR 0022).

## Environment

- **This server is DEV only.** No production customer data and no production secrets here, ever.
- `dev.ayvo.co` is the development preview environment. Production will run later on a
  **separate VPS**. No staging environment yet — `APP_ENV` is `development | test | production`
  (ADR 0008).
- `docker/compose.yml` runs dev PostgreSQL 18 + Redis 8 on 127.0.0.1.
- DEV preview (ADR 0013, **tailnet only — ADR 0026**): Caddy publishes 443 only on the server's
  Tailscale IPv4 address (from `tailscale ip -4`, never `0.0.0.0`/IPv6) and aborts every peer
  outside the tailnet; the only public port is IPv4 :80 for ACME HTTP-01 (everything else
  aborted); private DNS (`dns`, CoreDNS) answers only `dev.ayvo.co` via Tailscale split DNS; the
  root-installed host guard (`deploy/dev/host/`) is required. No HTTP Basic Auth (ADR 0030):
  WorkOS application sessions and print-agent tokens remain mandatory on protected routes.
  `X-Robots-Tag: noindex, nofollow`. The API is **same-origin** at `/api/*` — NestJS owns the
  `/api` prefix (`API_BASE_PATH` in `@ayvo/types`); Caddy forwards the path unchanged. No API
  subdomain, no CORS, no CI/CD. `--edge` recreates only Caddy + DNS. Deploy only with `scripts/deploy-dev.sh`, and only
  when the owner asks; it must never remove volumes. Secrets live in
  `/opt/ayvo/secrets/dev-preview.env`, never in the repo.

## Stack

TypeScript 6 · pnpm 12 (Corepack) · Turborepo · Next.js 16 (`apps/web`) · NestJS 12 ESM
(`apps/api`) · Prisma 7 + `@prisma/adapter-pg` · PostgreSQL 18 · Redis 8 (ioredis) · Zod 4 ·
Tailwind 4 · Vitest · Playwright.

## Layout

- `apps/api` — NestJS. ESM: relative imports **must** use the `.js` extension. Prisma schema in
  `apps/api/prisma/schema.prisma`; generated client in `apps/api/src/generated/` (git-ignored,
  produced by `pnpm db:generate`). Env validated by Zod in `src/config/env.ts`. Domain modules:
  `labels` ← `assets` ← `label-production` (doc 016); `inventory` ← `procurement`; `warehouse`
  composes assets, label-production, inventory and procurement (doc 018); `sites` (facilities,
  doc 022) ← `identity` (users, roles, scopes, sessions, global access guard — doc 021); `audit`
  (shared security audit); `storage` = FileStorage abstraction; `catalog` (components, products,
  recipes, material calculation — doc 023) uses `inventory` (items, BOM tables) and `crates`
  (crate types).
  Routes: `/api/admin/*` (staff) and `/api/public/*` (anonymous passport only).
- `apps/web` — Next.js App Router. Server-only env in `src/lib/env.ts`. Admin pages in
  `src/app/(admin)`, public passport in `src/app/q/[token]`. The internal app is organized by
  company functions (doc 019, ADR 0020) — **Sklad** and **Výroba**, defined in
  `src/lib/navigation.ts`; never add entity-level top-level navigation or placeholder modules.
  Internal UI copy is Czech (`src/i18n/cs/`). Server components read the API via
  `lib/api.ts` (API_URL); client components call same-origin `/api` (`lib/client-api.ts`; locally
  forwarded by `src/proxy.ts`).
- `packages/types` — Zod schemas shared by API and web (API contracts). Built to `dist/`.
- `packages/ui` — shared React components; exported as TS source, transpiled by Next.
- `packages/config` — shared tsconfig and ESLint config.
- `docker/compose.yml` — dev PostgreSQL + Redis only.
- `ops/night-shift` — the night-shift controller (doc 024; Python standard library, tests run by
  `pnpm test`). The live copy in `/opt/ayvo/night-shift` changes only by the owner's installation.
- `ops/prod-backup` — production database backups to S3 and their restore check (doc 035; Python
  standard library). Installed and its timers enabled only on AyvoOS-PROD by the owner.
- `apps/marketing` — the public marketing site ayvo.co (ADR 0040, proposed): static EN/CZ/DE HTML
  in Git, its own Caddy image (no DB/Redis/API/secrets, read-only, unprivileged). No CMS: content
  changes are HTML edits through a PR; no inline styles/scripts (strict CSP), no tracking or
  external fonts — `pnpm --filter @ayvo/marketing test` enforces it. Edge: PROD qr-edge and the
  internal Caddy only get mounted site files (`deploy/prod/sites/`, `acme.d/`) via
  `compose.marketing.yml` (MARKETING_DOMAIN); DEV preview `https://<DEV_DOMAIN>:8443` (tailnet).
  Deployed on its own: DEV builds and tests the image (pinned base) and saves it as an archive;
  PROD loads exactly that image ID (`deploy-prod.sh --marketing --image-archive … --expect-image …`),
  never builds it, and records SUCCESS only with valid HTTPS on apex and www; the OS deployment
  never builds, starts or stops it (it only prepares the edge).
- `deploy/dev/` — DEV preview Compose stack + Caddyfile; `apps/*/Dockerfile` — app images (build
  context = repo root, `.dockerignore` keeps `.env*` out); `scripts/deploy-dev.sh` — manual deploy.
- `deploy/prod/` + `scripts/deploy-prod.sh` — the separate PRODUCTION installation on AyvoOS-PROD
  (doc 036, ADR 0033): the same release code, its own project, secrets, database and host guard.
  Run only there, only by the owner, only an approved commit on origin/main.

## Conventions

- Nest DI: don't use `import type` for injected classes (decorator metadata needs the value
  import). Tests that bootstrap Nest rely on `unplugin-swc` for decorator metadata.
- New API contracts go into `packages/types` as Zod schemas; infer types with `z.infer`.
- New backend domain = new Nest module under `apps/api/src/<module>/` with its own tests.
- API integration tests (`apps/api/test/*.e2e.test.ts`) run against a real, per-run PostgreSQL
  database (created, migrated and dropped by `test/support/global-setup.ts`; needs
  `pnpm infra:up`). Never mock the database for invariants, transactions or concurrency.
  `createTestApp()` runs as a test superuser (resolver replaced in the test module only; the guard
  still enforces each route's rule; global site access, active site = the site of `MAIN`); use
  `createTestApp({}, {}, { auth: 'real' })` for authentication tests (`test/support/sign-in.ts`)
  and `{ redis: 'real' }` where Redis matters (rate limits). Test files share one database and run
  one at a time in no fixed order: never assume the number of sites, warehouses or admins.
- Playwright (`pnpm test:e2e`, needs `pnpm build`) starts the built API on a fresh `ayvo_e2e`
  database (port 4100, fake identity provider, bootstrapped `e2e-admin@ayvo.test`) and the web app
  on port 3100; it also adds a fictional second site with a warehouse (`E2E-DE`). `e2e/auth.setup.ts`
  signs in, sets the admin session's active site and stores the sessions used by the specs.
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
