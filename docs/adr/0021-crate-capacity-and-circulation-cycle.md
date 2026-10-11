# ADR 0021: Crate capacity 40 and the full-circulation crate cycle

- **Status:** Accepted — confirmed by owner 2026-10-11 (design; implementation per doc 020)
- **Date:** 2026-10-11
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Supersedes:** [ADR 0004](0004-crate-as-primary-logistics-unit.md) (crate as the primary
  logistics unit, 20-bottle outbound crate)

## Context

ADR 0004 (2026-10-10) recorded a standard outbound crate of 20 bottles, a READY rule of exactly 20
bottles of the same product and size, and a filling workflow in which bottles are filled first and
then scanned into a crate (docs 005, 006). Production Core (doc 020) is built on how AYVO actually
works, confirmed by the owner on 2026-10-11:

- one physical reusable crate holds **40** bottles and is the **same** crate for assembly, filling,
  shipment to the hotel and the return to AYVO — there is no separate 20-bottle outbound crate;
- empty, freshly labelled bottles are scanned into the crate **before** filling; the 40th eligible
  bottle makes the crate ready to fill;
- there are two crate types (hand soap, shower gel);
- a crate may stay partially assembled across production orders, but only bottles with identical
  product, product category, recipe version, label-template version and crate type may share it.

## Decision

1. **Capacity is data.** `crate_types.capacity` (40 for both current types) and a snapshot
   `crate_cycles.capacity`; no application constant. The database refuses an ordinal above the
   cycle's capacity.
2. **One crate cycle = one complete circulation** of a crate:
   `OPEN_ASSEMBLY → READY_TO_FILL → FILLING → FILLED (finished stock) → ALLOCATED → DISPATCHED →
AT_HOTEL → RETURNING → RECEIVED → CLOSED`, with `ABORTED` as the controlled exit from
   `OPEN_ASSEMBLY`. v0.1 implements `OPEN_ASSEMBLY`, `READY_TO_FILL` and `ABORTED`. A future return
   receipt links to the **same** cycle; there is no separate return cycle. At most one open
   (not `ABORTED`/`CLOSED`) cycle per crate.
3. **The 40th eligible bottle** moves the cycle to `READY_TO_FILL`; a 41st is impossible; a partial
   cycle is never made ready manually. Before filling starts, a `PRODUCTION_SUPERVISOR` may remove
   a damaged bottle (reason required), which returns the cycle to `OPEN_ASSEMBLY`.
4. **Snapshot compatibility:** a cycle carries an immutable snapshot of crate type, capacity,
   product, product category, recipe version and label-template version; every assignment must
   match all of them (database composite keys).
5. **Membership** (kept from ADR 0004): a bottle ↔ cycle assignment is a time-bounded historical
   record with an **ordinal** (1…capacity; not a physical slot — `slot_code` is reserved for a
   future grid). It is released, never deleted; a bottle has at most one active assignment
   (partial unique index). Membership is never a bottle status.
6. **Crate identity:** human-readable code (`AYV-C-000001`) and a separate opaque QR token under the
   ADR 0014 host policy; AYVO prints controlled crate labels. The public page of a crate token
   reveals only that it is an AYVO reusable crate and a safe contact/return instruction.
7. **Crate history** is append-only (`crate_events`), written in the same transaction as every
   cycle change; one operation id correlates bottle events, stock movements, assignments and crate
   events.
8. Kept from ADR 0004: the crate is the primary logistics unit (one crate operation implies its
   known bottles without rescanning; per-bottle history is still written); return crates may be
   partial, mixed or contain not-yet-identified bottles (confirmed 2026-10-10); bottle identity is
   re-established at sorting.

## Consequences

### Positive

- One model from assembly to return; filling, picking and returns extend the same cycle instead
  of introducing new crate concepts.
- Capacity changes need data, not code.
- Mixed recipe or label versions in one crate are impossible by construction.

### Negative

- Deliveries are whole crates: v0.1 customer order lines are expressed in crates of 40, so the
  dispatched quantity per standard product is a multiple of 40; smaller quantities need a separate
  crate type and commercial product (doc 008).
- Long-lived open assembly cycles are possible when production is slow (visible in the Bedny UI).

## Alternatives considered

- **Keep 20-bottle outbound crates and repack** — rejected by the owner: the same crate circulates.
- **A separate cycle per phase (production, return)** — rejected: splits one physical circulation
  and loses the link between delivered and returned contents.
- **Capacity as a constant** — rejected: crate types are data.

## Open questions

- Crate washing, damage and retirement criteria (doc 005).
