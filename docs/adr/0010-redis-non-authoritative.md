# ADR 0010: Redis is never authoritative

- **Status:** Accepted — confirmed by owner 2026-10-10
- **Deciders:** AYVO OS lead architect

## Context

The stack includes Redis (version 8). Later features need caching,
background jobs (service planning proposals, carrier calls, invoice
generation, report exports), rate limiting (public bottle passport, login)
and short-lived locks. Redis data can be lost on restart or eviction.

## Decision

- Redis is used **only** for non-authoritative data:
  - caches (always rebuildable from PostgreSQL),
  - job queues and scheduling,
  - rate limiting,
  - ephemeral locks and short-lived session-like data.
- Anything business-relevant is **persisted in PostgreSQL first**. A job
  that performs a business action records its intent and outcome in
  PostgreSQL; jobs must be idempotent and safe to retry.
- Correctness never depends on a Redis lock alone; PostgreSQL constraints
  and transactions remain the final guard (ADR 0002).
- Losing all Redis data must not lose any business data; at worst it causes
  re-computation or re-queueing.

## Consequences

### Positive

- Simple recovery: Redis can be flushed without data loss.
- Clear rule for developers on where data belongs.

### Negative

- Some duplication (job state in both PostgreSQL and Redis queue).
- Jobs must be designed idempotent from the start.

## Alternatives considered

- **No Redis (PostgreSQL-based queue, e.g. SKIP LOCKED)** — viable and
  simpler; Redis kept per stack decision and for rate limiting/caching. May
  be revisited.
- **Redis as primary store for scanning sessions** — rejected: scan
  progress (e.g. 7/20 bottles in a crate) is business state and belongs in
  PostgreSQL.

## Open questions

- Job queue library choice (e.g. BullMQ) — decided when the first
  background job is implemented.
