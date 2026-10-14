# ADR 0025: The same crate from labelling to dispatch, two bottle scans, explicit Hotovo

- **Status:** Proposed — the process and consumption moments are confirmed by the owner
  (2026-10-14, issue #19); the model below awaits approval with doc 025
- **Date:** 2026-10-14
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Supersedes / Superseded by:** amends [ADR 0021](0021-crate-capacity-and-circulation-cycle.md)
  (readiness and the filling part of the cycle); keeps everything else of ADR 0021

## Context

ADR 0021 fixed capacity as data, one cycle per circulation, assembly of labelled empty bottles
into the crate before filling (the 40th makes it `READY_TO_FILL`) and listed filling as a future
continuation. Issue #19 brought filling into stage A. The owner confirmed (2026-10-14): the same
physical crate is used from labelling through filling to dispatch; each bottle is scanned once
after its label is applied (into the crate) and once after it is filled and completed (in the
same crate), so the second worker catches bottles misplaced by the first; consumption happens
exactly at those two confirmations (body + label, then liquid + pump); a crate is ready only after
an explicit **Hotovo**. A short-lived alternative (revision 2 of doc 025: assign only finished
bottles) is withdrawn.

## Decision

1. Assembly stays as in ADR 0021: the labelling scan assigns the labelled empty bottle to the
   crate's open cycle; the 40th member makes it `READY_TO_FILL`; a partial crate is never made
   ready to fill manually.
2. The filling scan never assigns: it accepts only a bottle that is already an active, eligible
   member of **that** cycle and matches its snapshot, the station's category and the site; it
   records `FILLED` and consumes the `FILL` lines of the cycle's recipe version. A bottle of
   another crate or none is refused without any write; correcting membership is a separate,
   authorized, audited operation.
3. The cycle carries two separate figures: members and filled members. The first filled member
   moves it to `FILLING`, which it keeps whatever its counts until Hotovo or an abort; `FILLED` (ready finished stock) is reached **only** by Hotovo, and only
   when members = filled = capacity, all hold-free and compatible. Counts alone never make a
   crate ready.
4. Consumption moments: printing nothing; labelling scan −1 body (selected lot) + recipe label;
   filling scan −recipe liquid (current selected lot) + recipe pump; Hotovo, allocation and
   dispatch no component consumption. Each component exactly once per bottle; rejected or
   replayed scans consume nothing; historical deductions are never repeated.
5. Corrections (move, remove, refill a slot, reopen a ready crate before allocation, abort) and
   repacking of bottles outside a crate never reset a bottle's status and never consume again.

## Consequences

### Positive

- One physical carrier and one cycle history from labelling to return; dispatch later uses the
  stable content of a ready cycle.
- The second scan is a real comparison against recorded membership.
- Materials follow the physical steps exactly once.

### Negative

- Labelling and filling both need the crate at hand; a partial crate cannot go to filling.
- Corrections of membership are supervised operations (slower than a silent move, by design).

## Alternatives considered

- **Assign only finished bottles (doc 025 revision 2)** — withdrawn by the owner: no record of the
  handover and no check of the first worker's placement.
- **Readiness from counts (40/40)** — rejected: 40 labelled empties or 40 members with 26 filled
  are not finished stock; readiness is an explicit act.
