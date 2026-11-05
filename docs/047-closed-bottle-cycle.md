# 047 — Closed bottle cycle: inventory on main and proposed model (issue #125, part 1)

Status: **inventory and model proposal for review** (owner priority 2026-11-05, issue #125). No
table, enum or migration in this document is approved or implemented. Each delivery below needs
the owner's approval of its model in a PR before any migration is written.

## 1. Inventory against main `bcdd926` (verified 2026-11-05)

Legend: **UI** = a usable page; **API** = routes only; **–** = nothing.

| Step                                          | DB      | API                | UI                          | Tests            | Docs                                                        |
| --------------------------------------------- | ------- | ------------------ | --------------------------- | ---------------- | ----------------------------------------------------------- |
| Labelling into a crate (new bottle)           | ✓       | ✓                  | ✓ `/production/station`     | API + Playwright | doc 025 A3                                                  |
| Filling, Hotovo                               | ✓       | ✓                  | ✓ station                   | API + Playwright | doc 025 A4                                                  |
| Order, picking, dispatch, carrier             | ✓       | ✓                  | ✓ `/dispatch/orders/[code]` | API + Playwright | doc 028, 029                                                |
| Delivered (order + crate cycle `DELIVERED`)   | ✓       | ✓ carrier tracking | ✓ order detail              | API + Playwright | doc 031                                                     |
| Return from the hotel (pickup, return crates) | –       | –                  | –                           | –                | doc 009 draft; doc 029/031 out of scope                     |
| Receipt at the site, counts                   | –       | –                  | –                           | –                | doc 009 draft, doc 005 "future"                             |
| Per-bottle identification after return        | –       | –                  | –                           | –                | ADR 0011 (rule), doc 018 §16 (unidentified → quarantine)    |
| Sorting, retirement, disposal, holds          | –       | –                  | –                           | –                | ADR 0011 accepted; doc 020 approved design, not implemented |
| Washing and inspection                        | –       | –                  | –                           | –                | doc 004 draft only                                          |
| Eligible again, refilled, dispatched          | blocked | refused            | –                           | refusals tested  | doc 025:102 "later approved flow"                           |

Evidence (all on main):

- **Bottle states and events.**
  - `BottleStatus` = `CREATED | LABELED_EMPTY | FILLED` (`apps/api/prisma/schema.prisma:149`).
  - `BottleEventType` = `CREATED | LABEL_APPLIED | ASSIGNED_TO_CRATE | FILLED | REMOVED_FROM_CRATE`
    (`:158`).
  - The status trigger allows only `CREATED → LABELED_EMPTY → FILLED`
    (`migrations/20261016090100_filling_and_crate_corrections/migration.sql:27`).
- **Crate cycle.**
  - `CrateCycleStatus` ends at `DELIVERED`, "terminal until returns exist" (`schema.prisma:2213`).
  - `crate_cycles_one_open_per_crate` excludes only `ABORTED`
    (`migrations/20261014160100_labeling_into_crates/migration.sql:292`), so a crate whose cycle
    was delivered can never open another one.
  - A delivered crate is refused for another order with `CRATE_DELIVERED`
    (`apps/api/src/orders/orders.service.ts:721`).
- **Bottles in a delivered crate.** They stay `FILLED` and keep their assignment. The release is
  refused while the cycle is `ALLOCATED`/`DISPATCHED`/`DELIVERED`
  (`migrations/20261021090100_order_tracking/migration.sql:484`).
- **No path back for a returned bottle.**
  - Labelling accepts only `CREATED` (`apps/api/src/production/labeling.service.ts:302`).
  - Filling accepts only `LABELED_EMPTY` (`apps/api/src/production/filling.service.ts:237`).
  - So a returned bottle cannot re-enter today.
- **Reuse counter.**
  - `countCompletedReuseCycles` (`apps/api/src/assets/reuse-cycles.ts:7`) counts `SORTED` after
    `DELIVERED_TO_HOTEL`. Neither event exists, and delivery writes no bottle event. The passport
    and the bottle detail therefore always show 0.
  - That 0 is correct today, but it is not yet backed by any event.
- **Carrier returns.** A carrier-reported return (PPL 336/480/718) is only a warning on the parcel
  (doc 031 §6); nothing is released.
- **Unused enums.** `ComponentDisposition` (`schema.prisma:399`, including `CLEANING_REQUIRED`)
  and `CrateStatus.RETIRED` exist but are unused.

Conclusion: delivery is the current end. The pages that exist cover the path **up to delivery
only**. None of them is a returned or completed cycle.

## 2. Rules already decided (not reopened)

- **Returns.** Return crates may be partial, mixed, or contain unidentified bottles, and a return
  links to the same circulation cycle (CLAUDE.md, owner 2026-10-10).
- **Reuse cycle.**
  - A cycle completes only at the individual identification (`SORTED`) of a bottle that was
    delivered (ADR 0011). A crate-level return completes nothing.
  - A bottle that is not identified is quarantined and never matched by guessing (doc 018 §16).
- **Terminal states.**
  - `RETIRED` is operationally terminal and reversible only by an audited `CORRECTION`.
  - `DISPOSED`/`DESTROYED` are irreversible, guarded in the DB (ADR 0011).
  - Quarantine is an active `bottle_hold`, an overlay, not a status (doc 020).
- **Identity.**
  - One crate cycle is one complete circulation. A cycle never mixes product, category, recipe
    version, label version or crate type (ADR 0021).
  - The first confirmed label binds the product category permanently (doc 020).
- **Stock.** It follows physical truth through the append-only ledger. The bottle body and a label
  that are not physically replaced are never consumed again (issue #125).

## 3. Owner decisions pending (asked 2026-11-05)

1. **Pump:** washed and reused, or always a new one? This decides the material at refilling (a
   `PUMP` attachment removed with a disposition, and a new one consumed or not).
2. **Washing and inspection:** per batch of specific bottles, or bottle by bottle?

The model below works for both answers. A per-bottle event always exists, and a batch is only an
optional grouping. Until the owner answers, nothing is implemented for washing or the pump.

Other open points from accepted docs stay open and are not decided here:

- How returns are collected (doc 009:64).
- Whether `DISPOSED` and `DESTROYED` are one state or two, and who may reverse a retirement (ADR
  0011).

## 4. Proposed model (for review — not implemented)

### 4.1 Crate return and receipt

```
return_receipts           RR-000001; site; hotel (nullable: unknown sender); received_at/by;
                          note; state OPEN → CLOSED (closing needs every crate settled)
return_receipt_crates     receipt, crate (by its QR), the crate cycle it closes,
                          counted bottles (as found, also 0), unidentified count
CrateCycleStatus         += RETURNED (receipt recorded) → CLOSED (all bottles settled)
crate_cycles_one_open_per_crate   excludes CLOSED as well as ABORTED (the crate may circulate again)
```

- A crate is received against its `DELIVERED` cycle. A crate without a `DELIVERED` cycle is
  refused, and the screen says why.
- A crate scanned twice in one receipt answers with the existing line and never duplicates.

### 4.2 Delivery and identification of bottles

- **At delivery**, in the same transaction as cycle `DELIVERED`:
  - one `DELIVERED_TO_HOTEL` bottle event per bottle of the cycle (ADR 0011);
  - `source` = CARRIER, as for orders (doc 031).
- **At identification**, the individual scan of a bottle from a received crate:
  - writes the event `SORTED` with the receipt line, the crate it was found in and its outcome;
  - ends the bottle's assignment to the delivered cycle;
  - this is the moment the reuse counter counts.
  - A bottle of cycle X found in crate Y is recorded as found (a mixed return). Its identity
    decides, never the crate.
  - A duplicate scan answers with the first result. A QR of another environment or a foreign QR
    is refused, using `classifyScannedQr`.
  - An unreadable bottle only increments the line's unidentified count. It is never matched.
- **Outcome** of the identification, in one transaction with the event:
  - `RETURNED` (a new status: identified, dirty, waiting for washing);
  - or `RETIRED` (with a reason; reversible by `CORRECTION`, ADR 0011);
  - or `DISPOSED` (irreversible, DB guard);
  - or `RETURNED` plus an active `bottle_hold` (doc 020's approved quarantine) when in doubt.

### 4.3 Washing, inspection, eligibility

- The event `WASHED` (per bottle, optionally with `wash_batch`, depending on the owner's answer
  in §3). It is followed by the event `INSPECTED` with the result:
  - `READY_FOR_REUSE` (a new status: empty, label on, clean, eligible);
  - or `RETIRED`/`DISPOSED` with a reason.
- An active hold blocks every step until it is released (audited).

### 4.4 Into the next production cycle

- The labelling station accepts a `READY_FOR_REUSE` bottle as an assembly scan:
  - it writes only `ASSIGNED_TO_CRATE`, with no `LABEL_APPLIED` and no `NEW_BOTTLE` consumption;
  - the cycle rules (one product category, label version, recipe version, crate type) apply
    unchanged, against the bottle's bound category.
- Filling of a reused bottle:
  - the liquid is consumed as today (FILL movement from its one lot);
  - the pump follows the owner's answer in §3;
  - the status trigger gains exactly `READY_FOR_REUSE → … → FILLED` through the cycle, and
    nothing else.
- Dispatch and delivery are unchanged.

### 4.5 Permissions (ADMIN, by migration)

- `returns:receive` — receipts and crates.
- `returns:sort` — identification and its outcome.
- `returns:wash` — washing and inspection.
- `returns:correct` — hold release and `CORRECTION` of a retirement.
- Site-scoped like production; every operation is idempotent per `requestId`.

## 5. Deliveries (each its own PR; the model PR first)

| #   | Delivery                                                                       | Usable result                                                             |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| R0  | This document (model for approval)                                             | —                                                                         |
| R1  | Receipt of returned crates; cycle `RETURNED`; `DELIVERED_TO_HOTEL` at delivery | Sklad → "Příjem vratek": receive crates of a delivered order, counts      |
| R2  | Per-bottle identification and outcome; reuse counter fed by real events        | Station mode "Třídění": scan, outcome, unidentified count; cycle `CLOSED` |
| R3  | Washing and inspection → `READY_FOR_REUSE` (after the owner's §3 answers)      | "Mytí a kontrola"                                                         |
| R4  | Reuse in assembly and filling, pump material per §3                            | The existing station accepts the bottle                                   |

**Acceptance (issue #125).** The flow counts as done only when a **specific returned bottle**
passes, on DEV and through the real UI:

- delivery;
- a partial and mixed return;
- individual identification;
- controlled washing and inspection;
- assembly into a new cycle, refilling and dispatch.

It must then show reuse cycle 1 in its history and on the passport. Required along the way:

- a duplicate scan, a wrong or other-environment QR, and an unreadable bottle;
- two operators working concurrently;
- recovery after an interrupted request (idempotency);
- events, assignments, counts and stock movements transactional and audited.

Single screens of R1–R3 are intermediate states, not a finished cycle.
