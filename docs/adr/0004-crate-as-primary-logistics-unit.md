# ADR 0004: Crate as the primary logistics unit

- **Status:** **Superseded** by [ADR 0021](0021-crate-capacity-and-circulation-cycle.md)
  (owner, 2026-10-11) — originally accepted, confirmed by owner 2026-10-10
- **Deciders:** AYVO OS lead architect

> **Superseded (2026-10-11).** The 20-bottle outbound crate, the READY rule of exactly 20 bottles
> and "fill, then scan into the crate" no longer apply: one reusable crate of capacity **40**
> (data, not a constant) serves assembly, filling, shipment and return, and one crate cycle is one
> complete circulation (ADR 0021, doc 020). Membership as a time-bounded record, at most one active
> membership per bottle, the crate as primary logistics unit and partial/mixed/unknown return
> crates are carried over into ADR 0021. The text below is kept unchanged as the historical
> decision.

## Context

Bottles are filled and scanned directly into reusable crates. A standard
outbound crate holds 20 bottles. Once a crate is complete and verified, the
warehouse should treat it as one unit: one crate scan stands for 20 known
bottle identities. Rescanning every bottle at every warehouse step would be
slow and error-prone. On the return path, bottles generally do not come back
in the crate they left in, so returned crate content may be unknown at
goods-in; bottles are identified individually during sorting.

## Decision

- The **crate** is the primary unit for outbound logistics: picking into
  deliveries, dispatch and shipment work at crate level.
- Every crate has a permanent internal ID and a permanent QR identity
  (same principles as ADR 0005).
- **Crate membership** (bottle ↔ crate) is a separate, time-bounded,
  historical record — not a mutable column on the bottle that gets
  overwritten. Each membership has a start and (when ended) an end, plus the
  event that caused each.
- A bottle can have **at most one active crate membership**, enforced in the
  database (e.g. partial unique index on active memberships).
- Crate capacity is configuration, not a hard-coded constant. The standard
  outbound capacity is **20** (confirmed).
- A **READY** outbound crate must contain **exactly 20 bottles of the same
  product and size** (confirmed). The transition to READY validates this in
  the same transaction, under a row lock on the crate; bottles of a
  different product or size are rejected while filling.
- A crate becomes usable as a logistics unit only after an explicit
  complete/verify step to READY. After that, crate-level operations imply
  the known bottle set without rescanning.
- Operations on a sealed crate's bottles are recorded per bottle in the
  lifecycle history (ADR 0006), derived from the crate operation in the same
  transaction.
- **Return crates may be partial, mixed, or initially contain unknown bottle
  identities** (confirmed). At goods-in only a physical quantity is
  recorded; bottle identity is established at sorting. The READY rule does
  not apply to return crates.

## Consequences

### Positive

- Fast warehouse operations: one scan per crate instead of 20.
- Full per-bottle traceability is still preserved.
- Model matches the physical process.

### Negative

- If a sealed crate is physically tampered with, the system may believe
  content that is no longer true; needs an explicit "open / re-verify" flow
  and discrepancy handling.
- Fan-out writes (one crate operation → 20 bottle events) must be done
  transactionally and efficiently.

## Alternatives considered

- **Bottle as primary unit everywhere** — rejected: too slow, conflicts with
  the stated warehouse workflow.
- **Crate-only tracking (no per-bottle history)** — rejected: breaks the
  permanent bottle identity and lifecycle requirements.

## Open questions

- Can anything other than a READY crate ever be dispatched (exception
  handling)? Can a READY crate mix fill batches? (Not defined — do not
  assume.)
- Exact rules for opening/breaking a completed crate and for discrepancies.
- Whether return crates are a different physical crate type.
