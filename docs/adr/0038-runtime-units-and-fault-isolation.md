# ADR 0038: Runtime units and fault isolation (transition from the modular monolith)

- **Status:** Proposed — for review. Nothing in this ADR is implemented, deployed or approved.
- **Date:** 2026-10-24
- **Deciders:** AYVO owner; AYVO OS lead architect; independent reviewer
- **Amends (when accepted):** [ADR 0001](0001-modular-monolith.md) — the modular monolith stays
  for what must be transactional; new and loosely coupled parts become separate runtime units.
- **Business view:** the draft module map
  [`docs/architecture/module-map-2026-10-24.md`](../architecture/module-map-2026-10-24.md)
  (PR #64, branch `codex/architecture-module-map-20261024`) describes the business modules and
  their links; this ADR proposes the **runtime granularity** only. Neither starts a refactor.
- **Source:** owner decision 2026-10-24 (`OWNER-FAULT-ISOLATION-20261024.md`): separately running,
  deployable and movable modules talking through contracts, no cascade when one fails, modules
  usable and permitted separately; no "hydra".

## 1. Where we are today (db8206d) — honestly

| Part            | Runtime                                                                                                   | Shared with                                             |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| API (NestJS)    | **one process**, 25 module directories                                                                    | every module; one heap, one event loop, one Prisma pool |
| Background work | **inside the API process**: print sweeper, carrier poller, tracking, supply-plan runner, auth-mail outbox | the API request path                                    |
| Web (Next.js)   | one process                                                                                               | all internal UI, public passport and card pages         |
| PostgreSQL      | one database, 106 tables, 11 cross-domain constraint triggers                                             | everything                                              |
| Redis           | one instance (rate limits; non-authoritative, ADR 0010)                                                   | sign-in, public reads                                   |
| Edges           | Caddy (tailnet), qr-edge (public)                                                                         | the host                                                |
| Host            | one VPS per environment                                                                                   | all of the above                                        |

Today's failure domains: an unhandled crash, memory leak, CPU-bound loop or event-loop block in
**any** module takes down or slows the whole API (sign-in, warehouse, production, Obchod,
dispatch, public reads) and all background loops. One slow query or exhausted Prisma pool
starves every module. A web crash takes down internal UI and public pages together. The owner's
requirement is **not met** by db8206d; module folders are not runtime isolation.

## 2. What isolation can and cannot give

- **Can:** a crash, leak, deadlock or overload of one unit does not stop the others; each unit
  restarts alone; each unit can be built, deployed, rolled back and moved to another host alone;
  callers time out and report "temporarily unavailable" instead of hanging.
- **Cannot (shared failure domains that remain until separately decided):** the host/VPS
  (process isolation is not host HA); the PostgreSQL cluster while units share it (separate
  schemas and roles limit blast radius, not a server outage); the edge/gateway; identity (no
  new sign-in without it); the network between units. These are named, not hidden.

## 3. Target runtime units

A unit = its own process/container, own image entry point, own health check, own resource
limits (memory, CPU, DB connections), own deploy/rollback, own data it alone writes.

| Unit                                                                             | Contains                                                                                                                                             | Why this boundary                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operations core** (stays one unit — an **exception** to the requirement, §8.1) | inventory/stock ledger, procurement, catalog, labels, bottles, crates & cycles, workstations, production, orders, dispatch/carriers, printing, sites | Invariants are **one transaction** across these tables (label applied ⇄ stock consumed ⇄ crate cycle; allocation ⇄ order ⇄ shipment; constraint triggers). Splitting them would need distributed transactions — refused. Inside, the modular monolith rules of ADR 0001 stay. |
| **Operations workers**                                                           | print sweeper, carrier poller + tracking, supply-plan runner                                                                                         | Same code and image as the core, **separate process** (`--role=worker`), own DB pool. Isolates the request path from loop bugs and vice versa.                                                                                                                                |
| **Identity**                                                                     | users, sessions, roles/permissions catalogue, invitations, native auth, auth-mail outbox, audit of security events                                   | Everyone needs it; kept small. Phase 1: in the core process; later its own unit (§6 P5).                                                                                                                                                                                      |
| **Sales (Obchod)**                                                               | prospects, contacts, activities, tasks, imports                                                                                                      | Own tables; only references `users`. First extraction candidate.                                                                                                                                                                                                              |
| **Public read**                                                                  | passport `/q`, cards `/id` (web routes + their read API)                                                                                             | Internet-facing; must survive internal load and vice versa.                                                                                                                                                                                                                   |
| **New: finance, hotel portal, marketing web/admin**                              | —                                                                                                                                                    | Built as separate units from the start (no new large module inside the core). Finance here = invoicing, documents, payments and management overviews; the accounting stays in UOL — no general ledger or payroll is implied.                                                  |

Not a goal: service-per-table, Kubernetes, a message broker, a new vendor.

## 4. Data ownership and contracts

- Each unit owns a **PostgreSQL schema** and a **database role** that may write only it; other
  units get no direct SQL access (role grants enforce this, not convention). Same cluster at
  first (shared failure domain, §2); a unit can later move to another cluster because nothing
  else reads its tables.
- **Connection budget, not just limits:** a per-role `CONNECTION LIMIT` alone does not keep
  connections free for others. The sum of all unit pools must stay below `max_connections`
  minus a fixed reserve for administration, backup and restore (e.g. 100 = 15 reserve +
  core 30 + workers 10 + identity 15 + sales 10 + public read 10 + spare 10). Even then the
  cluster's CPU, I/O and locks remain one shared failure domain.
- Cross-unit references are plain ids (no foreign keys across schemas); the owner of the id
  answers questions about it through its API.
- **Synchronous contract:** versioned HTTP/JSON (`/internal/v1/...`), schemas in `packages/types`
  (Zod, as today), timeouts (default 2–5 s), at most 2 retries with backoff, and only for
  idempotent calls. Every command carries an idempotency key (the existing
  `operation_requests` pattern). Errors are typed; "unavailable" is a first-class answer.
- **Asynchronous contract:** a **transactional outbox** table in the producing unit (written in
  the same transaction as the business change) and a polling consumer in the receiving unit,
  which records processed event ids (exactly-once effect, at-least-once delivery). No broker.
- Durable evidence for money and stock: finance never derives anything from a retry or a
  missing answer; it consumes recorded events (e.g. `order.delivered`, contract changes) and
  writes idempotent documents.

## 5. Authentication, permissions and module access

- Identity stays the only issuer of sessions (ADR 0037). Two questions are kept apart:
  - **Authentication** — is this session valid (not expired, not revoked, user active)?
  - **Authorization** — what may this user do right now (roles, permissions, site/hotel scope)?
- **Today's semantics are kept:** both are evaluated against identity's authoritative data on
  **every request**; a revoked session, a removed role, a deactivation or a removed hotel scope
  takes effect on the next request. A unit therefore asks identity per request
  (`/internal/v1/session/introspect` → principal with its current permissions and scopes), or
  does the same check in-process while identity lives in the core process.
- **No cache window is proposed as decided.** Caching introspection would trade revocation delay
  for availability; if ever wanted, it is a separate owner decision (§8.6) with a stated maximum
  delay, and it may cover authentication only — never permissions, scopes or deactivation.
- Consequence, stated plainly: identity is a **per-request dependency** of every authenticated
  unit. Identity down ⇒ no sign-in and no authenticated request anywhere (fail closed).
- Test for every unit: warm up a session, then remove a role / deactivate the user / remove a
  hotel scope / revoke the session — the very next request is refused.
- **Each unit enforces its own permissions server-side**; permissions stay in the one catalogue
  (migrations in identity), namespaced per unit (`sales:*`, `finance:*`, `portal:*`).
- **Module access** (owner: modules usable and permitted separately) = a per-unit gate
  permission (e.g. `module:sales`), granted through roles like any other permission. A unit
  refuses every route without it. Hiding a menu item is only convenience; feature visibility
  never replaces the server-side check or the runtime isolation.
- Hotel users (portal) get their own role set and tenant scope; the portal unit sees only
  what the core's portal contract returns for that tenant.

## 6. Transition — small steps, each with its own approval gate

| Step | Change                                                                                                                                        | Proves                                                                                                        | Cost / risk                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| P0   | Accept this ADR; rule: no new large module inside the core process                                                                            | —                                                                                                             | none                                              |
| P1   | **Workers** as a separate container from the same image; API runs no loops                                                                    | kill worker → API serves; kill API → loops continue; restart each alone                                       | low; loops already idempotent/leased              |
| P2   | Per-unit DB roles + `CONNECTION LIMIT` and pool sizes within the connection budget (§4); schemas for new units                                | one unit cannot take the connections reserved for the others or for admin/restore (CPU/I/O/locks stay shared) | low–medium; migration of grants                   |
| P3   | **Sales** extracted: own process, own schema/role, ids instead of FKs to `users`, routes `/api/sales/*` via Caddy, identity check by contract | first real independent deploy/rollback/move                                                                   | medium; data move in one migration, rollback plan |
| P4   | New finance / portal / marketing built as units on P1–P3 patterns                                                                             | —                                                                                                             | per feature                                       |
| P5   | Identity as its own unit (optional, after P3 experience)                                                                                      | identity restart without core restart                                                                         | medium–high; sign-in path                         |
| —    | Operations core stays one transactional unit                                                                                                  | —                                                                                                             | —                                                 |

Every step: same topology and contracts on DEV and PROD (Compose), standard deploy scripts,
tests that actually stop/kill/restart containers, no live infrastructure change without the
owner's separate approval.

## 7. Failure scenarios

Terms: **alive** = the process runs; **usable** = a signed-in user can do the work;
**degraded** = alive, but answers "dočasně nedostupné" for what needs the failed part.

### 7a. After P1–P3 (identity still inside the core process)

| Failure                           | Sales                                                                | Core functions                   | Workers                                    | Public card/passport               | Recovery                                             |
| --------------------------------- | -------------------------------------------------------------------- | -------------------------------- | ------------------------------------------ | ---------------------------------- | ---------------------------------------------------- |
| Sales crashes                     | **down**, restarts alone                                             | usable                           | alive                                      | usable                             | restart; commands idempotent by request id           |
| Workers crash/leak                | usable                                                               | usable                           | **down** — print, tracking, plans queue up | usable                             | leases expire; restart resumes; jobs idempotent      |
| Core crashes                      | **alive, not usable** (no identity ⇒ authenticated requests refused) | down                             | alive; loops needing core wait             | down while its read API is in core | restart; `operation_requests` replay safely          |
| Carrier/API timeout               | usable                                                               | usable except that dispatch step | that loop backs off                        | usable                             | claimed carrier requests, no blind resend (as today) |
| Memory/CPU exhaustion in one unit | others keep their container limits                                   |                                  |                                            |                                    | container restart                                    |
| One unit exhausts its DB pool     | others keep their budget (§4)                                        |                                  |                                            |                                    | pool drains                                          |
| PostgreSQL or host down           | down                                                                 | down                             | down                                       | down                               | backups/restore (doc 035) — not solved here          |

Before P5, a separate Sales process proves independent **deployment and crash containment**, not
that Obchod stays usable during a core outage.

### 7b. After P5 (identity its own unit)

| Failure          | Sales                                                            | Core           | Identity | Notes                           |
| ---------------- | ---------------------------------------------------------------- | -------------- | -------- | ------------------------------- |
| Core crashes     | **usable** for its own data; features needing core data degraded | down           | alive    | sign-in works                   |
| Identity crashes | **down for users** (fail closed, §5)                             | down for users | down     | the shared, accepted dependency |
| Sales crashes    | down                                                             | usable         | alive    |                                 |

## 8. Open decisions for the owner

1. **Operations core stays one transactional unit** — warehouse, production, labels, crates,
   orders and dispatch are then not separately deployable. This is an explicit exception to the
   requirement, justified by their shared invariants; it needs the owner's explicit acceptance,
   not an inference from general agreement with modularity.
2. The unit list (§3) and the order of steps; recommended P1 (workers), P2, then P3 (sales)
   before new finance/portal work.
3. Identity in its own unit now or later (P5) — only P5 makes Sales usable during a core outage.
4. Same PostgreSQL cluster with per-unit schemas/roles and a connection budget for now
   (recommended), or separate clusters (cost, backups ×N).
5. Module access (§5): per-unit gate permissions granted through roles.
6. Whether any introspection cache is acceptable at all; if yes, its maximum delay, and that it
   never covers permissions, scopes or deactivation (§5).
