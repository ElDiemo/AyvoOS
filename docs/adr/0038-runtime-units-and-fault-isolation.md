# ADR 0038: Runtime units and fault isolation (transition from the modular monolith)

- **Status:** Proposed — for review. Nothing in this ADR is implemented, deployed or approved.
- **Date:** 2026-10-24
- **Deciders:** AYVO owner; AYVO OS lead architect; independent reviewer
- **Amends (when accepted):** [ADR 0001](0001-modular-monolith.md) — the modular monolith stays
  for what must be transactional; new and loosely coupled parts become separate runtime units.
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

| Unit                                                | Contains                                                                                                                                             | Why this boundary                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operations core** (stays one unit)                | inventory/stock ledger, procurement, catalog, labels, bottles, crates & cycles, workstations, production, orders, dispatch/carriers, printing, sites | Invariants are **one transaction** across these tables (label applied ⇄ stock consumed ⇄ crate cycle; allocation ⇄ order ⇄ shipment; constraint triggers). Splitting them would need distributed transactions — refused. Inside, the modular monolith rules of ADR 0001 stay. |
| **Operations workers**                              | print sweeper, carrier poller + tracking, supply-plan runner                                                                                         | Same code and image as the core, **separate process** (`--role=worker`), own DB pool. Isolates the request path from loop bugs and vice versa.                                                                                                                                |
| **Identity**                                        | users, sessions, roles/permissions catalogue, invitations, native auth, auth-mail outbox, audit of security events                                   | Everyone needs it; kept small. Phase 1: in the core process; later its own unit (§6 P5).                                                                                                                                                                                      |
| **Sales (Obchod)**                                  | prospects, contacts, activities, tasks, imports                                                                                                      | Own tables; only references `users`. First extraction candidate.                                                                                                                                                                                                              |
| **Public read**                                     | passport `/q`, cards `/id` (web routes + their read API)                                                                                             | Internet-facing; must survive internal load and vice versa.                                                                                                                                                                                                                   |
| **New: finance, hotel portal, marketing web/admin** | —                                                                                                                                                    | Built as separate units from the start (no new large module inside the core).                                                                                                                                                                                                 |

Not a goal: service-per-table, Kubernetes, a message broker, a new vendor.

## 4. Data ownership and contracts

- Each unit owns a **PostgreSQL schema** and a **database role** that may write only it; other
  units get no direct SQL access (role grants enforce this, not convention). Same cluster at
  first (shared failure domain, §2); a unit can later move to another cluster because nothing
  else reads its tables.
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

- Identity stays the only issuer of sessions (ADR 0037). Each unit authenticates a request by
  asking identity (`/internal/v1/session/introspect`, cached ≤ 30 s per session) or, while
  identity is in the core process, by the same in-process check. Identity down ⇒ no new
  sign-in and, after the cache, no authenticated requests — stated, not hidden.
- **Each unit enforces its own permissions server-side**; permissions stay in the one catalogue
  (migrations in identity), namespaced per unit (`sales:*`, `finance:*`, `portal:*`).
- **Module access** (owner: modules usable and permitted separately) = a per-unit gate
  permission (e.g. `module:sales`), granted through roles like any other permission. A unit
  refuses every route without it. Hiding a menu item is only convenience; feature visibility
  never replaces the server-side check or the runtime isolation.
- Hotel users (portal) get their own role set and tenant scope; the portal unit sees only
  what the core's portal contract returns for that tenant.

## 6. Transition — small steps, each with its own approval gate

| Step | Change                                                                                                                                        | Proves                                                                  | Cost / risk                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| P0   | Accept this ADR; rule: no new large module inside the core process                                                                            | —                                                                       | none                                              |
| P1   | **Workers** as a separate container from the same image; API runs no loops                                                                    | kill worker → API serves; kill API → loops continue; restart each alone | low; loops already idempotent/leased              |
| P2   | Per-unit DB roles + `CONNECTION LIMIT`, pool limits per process; schemas for new units                                                        | one unit cannot exhaust the cluster's connections                       | low–medium; migration of grants                   |
| P3   | **Sales** extracted: own process, own schema/role, ids instead of FKs to `users`, routes `/api/sales/*` via Caddy, identity check by contract | first real independent deploy/rollback/move                             | medium; data move in one migration, rollback plan |
| P4   | New finance / portal / marketing built as units on P1–P3 patterns                                                                             | —                                                                       | per feature                                       |
| P5   | Identity as its own unit (optional, after P3 experience)                                                                                      | identity restart without core restart                                   | medium–high; sign-in path                         |
| —    | Operations core stays one transactional unit                                                                                                  | —                                                                       | —                                                 |

Every step: same topology and contracts on DEV and PROD (Compose), standard deploy scripts,
tests that actually stop/kill/restart containers, no live infrastructure change without the
owner's separate approval.

## 7. Failure scenarios (target after P1–P3)

| Scenario                              | Keeps working                                                                                                    | Reports unavailability                                        | Recovery without duplicates                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| Sales process crashes                 | core, workers, public, sign-in                                                                                   | Obchod screens: "dočasně nedostupné"                          | restart; commands idempotent by request id                  |
| Workers crash or leak                 | all requests                                                                                                     | queues grow (print, tracking, plans)                          | leases expire; restart resumes; jobs idempotent             |
| Core crashes                          | sales (read/write own data), public pages (until they need core data), sign-in while identity is in core: **no** | warehouse/production/orders; sales features needing core data | restart; operation_requests replay safely                   |
| Dependency timeout (e.g. carrier API) | everything else                                                                                                  | that dispatch step, as today                                  | existing written/claimed carrier requests (no blind resend) |
| Memory/CPU exhaustion in one unit     | other units (container limits)                                                                                   | that unit                                                     | container restart                                           |
| DB connections exhausted by one unit  | other units (per-role limit)                                                                                     | that unit                                                     | pool drains; no shared starvation                           |
| PostgreSQL / host down                | nothing                                                                                                          | everything                                                    | backups/restore (doc 035); not solved by this ADR           |

## 8. Open decisions for the owner

1. Accept the unit list (§3), especially: operations core stays one transactional unit.
2. Order of steps; recommended P1 (workers) then P3 (sales) before any new finance/portal work.
3. Identity in its own unit now or later (P5)?
4. Same PostgreSQL cluster with per-unit schemas/roles for now (recommended), or separate
   clusters from the start (cost, backups ×N)?
5. Module access model (§5): per-unit gate permissions granted through roles.
