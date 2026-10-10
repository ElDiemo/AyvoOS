# 002 — System Principles

This document lists the engineering and domain principles every AYVO OS change must respect. When a design choice conflicts with a principle here, the principle wins unless an ADR explicitly changes it.

Status: Draft — foundation phase (2026-10-10)

## Confirmed requirements (from the brief)

1. **Modular monolith.** No microservices. ([ADR 0001](adr/0001-modular-monolith.md)) _(confirmed by owner 2026-10-10)_
2. **PostgreSQL is the source of truth.** ([ADR 0002](adr/0002-postgresql-source-of-truth.md)) _(confirmed by owner 2026-10-10)_
3. **Full auditability.** Lifecycle history is append-only and must never be silently overwritten. _(confirmed by owner 2026-10-10)_
4. **No full event sourcing.** Keep current state where useful for performance, plus immutable history. ([ADR 0006](adr/0006-auditable-lifecycle-history.md)) _(confirmed by owner 2026-10-10)_
5. **Transactions.** All important multi-record business operations are transactional.
6. **No secrets in the repository.**
7. **Simplicity.** Prefer simple, maintainable architecture over unnecessary complexity.
8. **Do not invent business rules.** Undefined rules are recorded as open questions, not implemented as guesses.
9. **Billing and logistics are separate domains.** ([ADR 0007](adr/0007-separate-billing-from-logistics.md)) _(confirmed by owner 2026-10-10)_
10. **Tenant isolation.** Hotel users never access other hotels' data.
11. **No unverified sustainability claims.** CO2e only with a documented methodology.
12. **Redis is never a source of truth.** ([ADR 0010](adr/0010-redis-non-authoritative.md)) _(confirmed by owner 2026-10-10)_
13. **Separate identities.** A bottle's internal ID and its public QR identity are separate; the public QR identity is opaque, practically unguessable and its public URL stays stable for the bottle's physical lifetime. ([ADR 0005](adr/0005-permanent-bottle-identity.md)) _(confirmed by owner 2026-10-10)_

## Proposed design (requires confirmation)

### Module boundaries

The API (`apps/api`) is split into modules (bounded contexts). Each module owns its tables and exposes an explicit service interface. Modules must not read or write another module's tables directly.

| Module           | Owns                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| identity-access  | Users, roles, sessions, hotel scoping                                    |
| catalog          | Products                                                                 |
| assets           | Bottles, crates, QR identities, crate assignments, lifecycle events      |
| production       | Fill batches, filling operations                                         |
| warehouse        | Stock locations, picking                                                 |
| customers        | Companies, hotels, locations, contacts, contracts, service configuration |
| service-planning | Delivery proposals                                                       |
| deliveries       | Service deliveries, shipments, carrier adapter                           |
| returns          | Return receipts (goods-in), sorting/processing records                   |
| billing          | Billing periods, invoices, invoice lines, payment status                 |
| sustainability   | Metrics, ESG export, passport data                                       |
| audit            | Generic administrative audit log                                         |

### History and state

- Current-state columns (e.g. a bottle's current status) are kept for query performance.
- Every state change also appends an immutable lifecycle event **in the same database transaction**.
- Corrections are new compensating events referencing the corrected event — never updates or deletes of history.
- Administrative changes (e.g. contract edits) are recorded in a generic audit log: actor, timestamp, entity, before/after.

### Invariants enforced in the database where possible

Business invariants are enforced by PostgreSQL constraints (unique / partial unique indexes, foreign keys, check constraints) in addition to application validation, so concurrent requests cannot violate them. Example: a partial unique index prevents a bottle from having two active crate assignments.

### Validation and types

- External input is validated with Zod at the API boundary.
- Shared DTO/contract types live in `packages/types`.

### Redis

Redis is non-authoritative (confirmed, principle 12): caching, queues, rate limiting only. Losing Redis must never lose business data. ([ADR 0010](adr/0010-redis-non-authoritative.md))

### Identifiers

- Internal primary keys are opaque (e.g. UUID) and never reused.
- Physical identities (bottle QR, crate QR) are permanent and never reassigned. ([ADR 0005](adr/0005-permanent-bottle-identity.md))
- Bottle internal ID and public QR identity are separate values (confirmed, principle 13).

### Time

- All timestamps stored as `timestamptz` in UTC; display localized.
- Events record both when they happened (occurred_at) and when they were recorded (recorded_at), since scanning may be offline/delayed.

### Testing

- Domain invariants and tenant isolation get automated tests.
- Vitest for unit/integration, Playwright for end-to-end.

## Open questions

- Must the warehouse UI work offline (delayed scan upload)? This affects occurred_at vs recorded_at handling.
- Data retention requirements for audit and personal data (GDPR)?
