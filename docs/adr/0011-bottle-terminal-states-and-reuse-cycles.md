# ADR 0011: Bottle terminal states and reuse cycles

- **Status:** Accepted — confirmed by owner 2026-10-10
- **Deciders:** AYVO owner, AYVO OS lead architect

## Context

The original brief stated that a retired bottle must never return to
circulation. In practice a bottle can be retired by mistake (wrong scan,
wrong inspection result), and AYVO needs a controlled way to undo that
without rewriting history (ADR 0006). At the same time, some bottles are
physically disposed of or destroyed; those can never come back.

The public bottle passport and ESG reporting will show the number of
completed reuse cycles, which needs an unambiguous definition.

## Decision

### RETIRED

- `RETIRED` is **operationally terminal**: no normal workflow (filling,
  crating, picking, sorting) may move a bottle out of it.
- A retirement may be **reversed only by an authorized, audited correction**:
  - The reversal is a **new** `CORRECTION` event referencing the `RETIRED`
    event; it records actor, reason and the authorization.
  - The original `RETIRED` event is **never altered or deleted**.
  - The current-state update and the correction event are written in the
    same transaction (ADR 0006).

### DISPOSED / DESTROYED

- `DISPOSED`/`DESTROYED` is a separate terminal state and is
  **irreversible**. No event of any kind — including a correction — may
  follow it.
- Enforced by the transition allow-list in the assets module **and** a
  database-level guard (e.g. trigger or check rejecting events for disposed
  bottles), so application bugs cannot bypass it.
- The bottle's identity and full history remain in the database forever
  (ADR 0005); its public QR URL stays stable.

### Completed reuse cycle

- A reuse cycle is **completed** when a bottle was **delivered to a hotel**
  and was **subsequently returned and individually identified** by AYVO.
- It is counted at the sorting identification event (`SORTED`) that
  follows a `DELIVERED_TO_HOTEL`. A returned crate whose bottles are not yet
  identified does not complete any cycle.
- The count is derived from lifecycle events; a cached counter on the
  bottle is allowed as current state (ADR 0006).

## Consequences

### Positive

- Mistaken retirements can be fixed without losing auditability.
- Physical disposal is final in data as well as in reality.
- Reuse-cycle numbers are defined from verifiable events, suitable for the
  public passport and ESG reports.

### Negative

- Correction authorization needs a permission model (identity-access
  module) before retirement reversal can be offered.
- Bottles that are lost at a hotel never complete their last cycle; this is
  intentional, but must be explained in reports.

## Alternatives considered

- **RETIRED strictly irreversible** — rejected by owner: makes operator
  mistakes permanent.
- **Editing or deleting the RETIRED event** — rejected: violates ADR 0006.
- **Counting a cycle at delivery or at crate-level return** — rejected:
  not verified at bottle level.

## Open questions

- Who is authorized to reverse a retirement, and is a second approval
  needed?
- Are DISPOSED and DESTROYED one state or two?
- Which state a bottle re-enters after a reversed retirement (e.g.
  `SORTED` or `QUARANTINED`).

  > _Editorial note (2026-10-11):_ quarantine is no longer a lifecycle state;
  > it is an active `bottle_holds` row (eligibility overlay) — see
  > [doc 020 §3.5](../020-production-core-v0.1.md). Read `QUARANTINED` above
  > as "re-enters with a quarantine hold".
