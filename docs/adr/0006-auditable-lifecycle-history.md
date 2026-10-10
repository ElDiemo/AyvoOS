# ADR 0006: Immutable, auditable lifecycle history

- **Status:** Accepted — confirmed by owner 2026-10-10
- **Deciders:** AYVO OS lead architect

## Context

Bottles (and crates) move through a lifecycle such as CREATED, FILLED,
ASSIGNED_TO_CRATE, QUALITY_APPROVED, ALLOCATED_TO_DELIVERY, DISPATCHED,
DELIVERED_TO_HOTEL, AT_HOTEL, RETURNED, SORTED, WASHED, INSPECTED,
FILLED_AGAIN ... RETIRED. Historical events must never be silently
rewritten. At the same time, operational screens need fast answers to
"where is this bottle now?" and "what is in this crate?".

## Decision

We use **append-only lifecycle event tables plus current-state tables**.

- Each lifecycle-tracked aggregate (bottle, crate, later others) has an
  **append-only event table** recording: event type, timestamp
  (`occurred_at` and `recorded_at`), actor (user / system / integration),
  related entities (crate, delivery, hotel location, fill batch, ...),
  and a reason / payload where needed.
- The aggregate row keeps **current state** (status, current location,
  current crate, counters such as completed reuse cycles) for performance.
- Every state change writes the event **and** updates current state in the
  **same database transaction**. Never one without the other.
- Events are never updated or deleted by the application. Mistakes are
  corrected with an explicit **compensating/correction event** that
  references the original event and states the reason.
- State transitions are validated by an explicit transition table/state
  machine in the owning module (e.g. RETIRED is operationally terminal and
  DISPOSED/DESTROYED irreversible — see ADR 0011).
- A generic **audit log** records administrative changes (who changed
  which configuration, contract, price, permission; old and new values).
- **Database-level protection is considered**: the application DB role gets
  `INSERT`/`SELECT` but not `UPDATE`/`DELETE` on event and audit tables
  (via raw SQL migration, ADR 0009), and/or triggers that reject changes.
- Current state must always be reconstructable from events; a consistency
  check job can verify this.

## Consequences

### Positive

- Full history for traceability, investigations and ESG reporting.
- Fast operational queries via current state.
- Corrections are visible and explained, not hidden.

### Negative

- More writes and more tables than a plain CRUD model.
- Event tables grow continuously; partitioning or archiving may be needed
  later.
- Developers must use the module's lifecycle service; direct updates of
  status columns are forbidden by convention and review.

## Alternatives considered

- **Plain CRUD with mutable status** — rejected: loses history.
- **Full event sourcing** (state derived only by replaying events, CQRS
  projections) — rejected (confirmed by owner 2026-10-10): significantly more complexity
  (projections, versioning, replay, eventual consistency) without a
  concrete need; the hybrid keeps the auditability benefits while keeping
  reads simple and transactional.
- **Generic row-history triggers only** — rejected as the primary mechanism:
  captures data changes but not business meaning (why, which workflow).
  May still be used as an extra safety net.

## Open questions

- Full, authoritative list of lifecycle states and allowed transitions.
- Who is allowed to issue correction events, and is approval needed?
- Retention policy for event and audit data.
