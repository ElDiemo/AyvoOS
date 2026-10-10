# ADR 0002: PostgreSQL as the source of truth

- **Status:** Accepted — confirmed by owner 2026-10-10
- **Deciders:** AYVO OS lead architect

## Context

AYVO OS must preserve the full lifecycle of every bottle and crate, keep
hotel contracts and billing data correct, and enforce physical invariants
such as "a bottle never belongs to two active crates" and "a disposed
bottle never returns to circulation" (ADR 0011). These need strong consistency, relational
integrity and transactions spanning several records.

## Decision

We will use **PostgreSQL (version 18)** as the single source of truth for
all business data.

- All business state and history live in PostgreSQL. Other stores (Redis,
  object storage, carrier systems) are secondary or derived.
- Invariants are enforced in the database wherever practical, not only in
  application code: foreign keys, `NOT NULL`, `CHECK` constraints, unique
  and partial unique indexes (e.g. one active crate membership per bottle),
  and exclusion constraints where useful.
- Important multi-record business operations run in a single transaction.
- Use appropriate isolation / row locking (`SELECT ... FOR UPDATE`) for
  concurrent scanning workflows (e.g. two operators scanning the same crate).
- Timestamps are stored as `timestamptz` in UTC.
- Money is stored as exact decimals or integer minor units, never floats.

## Consequences

### Positive

- Mature, well-understood, ACID-compliant, excellent tooling.
- Constraints catch bugs that application code would miss.
- Rich querying for lifecycle reconstruction and reporting (window
  functions, JSONB, CTEs).
- Easy to run locally (Docker) and in production.

### Negative

- Single primary database is a scaling and availability concern; mitigated
  by backups, point-in-time recovery and, later, replicas.
- Some constraints must be written as raw SQL migrations (see ADR 0009).

## Alternatives considered

- **MySQL / MariaDB** — weaker support for partial indexes, exclusion
  constraints and transactional DDL.
- **Document database (MongoDB etc.)** — poor fit for relational,
  transactional data with strong invariants.
- **Event store as primary store** — see ADR 0006 for why full event
  sourcing was not chosen.

## Open questions

- Backup, retention and recovery targets (RPO/RTO) for production.
- Hosting choice for the production database (self-managed vs managed).
