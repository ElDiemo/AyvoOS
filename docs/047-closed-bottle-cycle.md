# 047 — Closed bottle cycle: inventory on main and proposed model (issue #125, part 1)

Status: **inventory and model proposal for review** (owner priority 2026-11-05, issue #125; §3–§5
revised for the owner's physical process in the issue comment of 2026-11-05). No
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
  - A bottle whose identity cannot be read is never matched by guessing; it is quarantined (doc
    018 §16).
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

## 3. The owner's physical process (issue #125 comment, 2026-11-05)

This replaces the earlier working idea that every dirty bottle is scanned before washing.

1. **Intake.** The returned crate (or box) is scanned. This records **the crate's return only**.
   It never confirms the identities, or the return, of the bottles originally shipped in it.
2. **Unpacking.** The bottles are taken out and the pumps unscrewed.
   - Pumps are **washed and reused**.
   - Pumps have no individual codes, and no lasting link of one pump to one bottle is claimed.
3. **Defective bottles.** A defective or cracked bottle is scanned at intake into **"ke
   skartaci"** (for shredding).
   - It can then never be washed or filled as a good bottle.
   - This is not yet the irreversible disposal: confirming `DISPOSED` stays a separate step under
     ADR 0011.
4. **Defective pumps.** They are counted ("Vadná pumpička −1"), never scanned. Audit and
   corrections keep the physical truth.
5. **Good bottles are not scanned before washing.** The reader has no place in the dirty, wet
   area. After washing and inspection, the bottles ready for the next filling are scanned one by
   one. Their identity and history continue.
6. **No blanket batch approval.** Washing without scans is not a blanket approval of every piece
   in a batch. Intake, washing without a scan, and individual identification afterwards are
   separate steps.

Still open from the accepted docs, not decided here:

- How returns are collected (doc 009:64).
- Whether `DISPOSED` and `DESTROYED` are one state or two, and who may reverse a retirement (ADR
  0011).

## 4. Proposed model (for review — not implemented)

**Boundary (owner 2026-11-05, issue #125 and #126):** a crate with unknown contents exists **only
in the return intake**. Everything up to delivery keeps its current meaning and is not changed by
this proposal:

- assembly, filling, picking, dispatch and delivery;
- the concrete cycle with its concrete verified bottles;
- product, recipe and label;
- capacity and the "full" rule;
- the transactional consumption.

A finished crate is still scanned and handled whole with known contents. There are **no new
mandatory per-bottle scans at dispatch**. At a return, the original membership or count is never
assumed. The historical shipped assignments are never rewritten. The next circulation of the same
physical crate is a **new cycle** with the newly and actually found contents (assembly scans as
today).

Two operator situations: **intake** (the dirty side) and **ready for filling** (the clean side,
after washing).

### 4.1 Intake: the crate's return, defective bottles, defective pumps

```
return_receipts           RR-000001; site; hotel (nullable: unknown sender); opened_at/by;
                          state OPEN → CLOSED
return_receipt_crates     receipt, crate (by its QR), the DELIVERED cycle it returns,
                          returned_at/by, emptied_at/by ("Vyprázdněno")
return_pump_counts        receipt, +n removed / −n defective, actor, reason (append-only lines;
                          a correction is a new line)
CrateCycleStatus         += RETURNED (crate scanned back) → CLOSED (emptied; the crate is free)
crate_cycles_one_open_per_crate   excludes CLOSED as well as ABORTED (the crate circulates again)
```

- **Crate scan.**
  - It is accepted only for a crate whose cycle is `DELIVERED`. Anything else is refused with
    the reason.
  - A second scan answers with the existing line.
  - It writes the crate event `RETURNED` and moves the cycle to `RETURNED`.
  - **No bottle event is written. Nothing changes for any bottle.**
- **"Ke skartaci" scan** of a defective bottle:
  - The event `SORTED` is written with outcome `SCRAP`, and the bottle gets an active hold of
    kind `SCRAP` (doc 020's approved hold overlay, of a new kind). The hold refuses washing,
    readiness, assembly and filling.
  - Disposal is confirmed later as `DISPOSED` (irreversible, ADR 0011). Releasing a mistaken
    hold is an audited correction.
  - The bottle must have a `DELIVERED_TO_HOTEL` after its last filling (§4.3). If not, the scan
    is refused with the reason, never guessed.
  - **For review:** under ADR 0011 this individual identification after a return completes the
    cycle. The alternative is to count only bottles that become ready again. The owner decides.
- **Pumps.**
  - The intake records the counted pumps removed and the counted defective pumps (−1 button).
  - They are a counted pool with no identity, no lot and no supplier lot, and **never a movement
    of the new-pump stock item** (§4.4).
- **"Vyprázdněno" — releasing the emptied crate (proposed, not yet approved by the owner).**
  - It is one confirmation per crate after its intake, by the operator who emptied it, with no
    scan of good bottles. In one transaction:
    - the returned cycle → `CLOSED`;
    - the crate is free for a **new** cycle.
  - **The shipped assignments are not touched.**
    - The membership of the closed cycle stays as it was shipped: the historical fact, not a claim
      that those bottles came back.
    - A bottle's open assignment ends only at its own individual scan (§4.2), additively
      (`released_at/by/reason` set once; the original fields never change).
    - The unique "one active assignment per bottle" index
      (`migrations/20261014160100_labeling_into_crates/migration.sql:424`) therefore still
      protects the bottle until it is identified.
  - The bottles' status does not change. Which of them really came back is not known yet.
  - **It is safe even if a bottle stayed in the crate:** the next assembly accepts only a bottle
    that is `READY_FOR_REUSE` (§4.4), so an unwashed bottle is refused at its scan.
- The receipt closes when all its crates are emptied.

### 4.2 Clean side: individual scan of a bottle ready for filling

- The scan comes after washing and inspection (neither is controlled by the system: no washer
  control, no hygiene parameters).
- One transaction:
  - the event `SORTED` with outcome `READY`; this is the reuse-cycle moment (ADR 0011);
  - the status → `READY_FOR_REUSE` (new: empty, label on, washed and inspected, eligible);
  - the bottle's open assignment to its delivered cycle ends, additively, with reason
    `IDENTIFIED_AFTER_RETURN`. Its crate may be returned, emptied, or not back yet (a mixed
    return).
  - Today's guard forbids that release while the cycle is `DELIVERED`
    (`migrations/20261021090100_order_tracking/migration.sql:484`). It would allow exactly this
    one reason, from the return-identification path only. For review.
- **Checked against the bottle's history, regardless of the crate it came back in:**
  - a `DELIVERED_TO_HOTEL` after its last filling, and no `SORTED` since; otherwise the scan is
    refused with the reason (not delivered yet, already sorted, on a hold, retired, disposed);
  - a duplicate scan answers with the first result;
  - a QR of another environment or a foreign QR is refused (`classifyScannedQr`).
- A bottle found defective here goes to "ke skartaci", as at intake.
- **Discrepancies are resolved, never silently merged.** Example: a bottle whose last cycle was
  not delivered. The bottle gets an active hold with the reason and the scan details. An
  authorized user resolves it by an audited correction. History is never rewritten.
- A delivered bottle that is never scanned stays "delivered, not returned" and completes no
  cycle (ADR 0011: intentional).

### 4.3 Delivery writes the bottle history

- In the same transaction as cycle `DELIVERED`, write one `DELIVERED_TO_HOTEL` bottle event per
  bottle of the cycle, with source CARRIER (doc 031).
- This is the historical fact "shipped to this hotel". It is distinct from the real returned
  pieces, which are known only from the scans of §4.1–4.2.

### 4.4 Into the next production cycle: no repeated consumption

- **Assembly.** The labelling station accepts a `READY_FOR_REUSE` bottle as an assembly scan.
  - It writes only `ASSIGNED_TO_CRATE`, with no `LABEL_APPLIED` and no `NEW_BOTTLE` consumption.
  - The cycle rules (category, label version, recipe version, crate type) apply against the
    bottle's bound category.
- **Today's filling.** It always consumes the recipe's FILL BOM, including the `PUMP` line
  (`apps/api/src/production/filling.service.ts:254-305`). It requires a PUMP line
  (`:461-464`) and opens a PUMP attachment (`apps/api/src/assets/bottles.service.ts:418-452`).
  Stock issues allow only `CONSUMABLE` items
  (`apps/api/src/inventory/stock-issues.service.ts:36`).
- **Proposed for review:**
  - the filling of a reused bottle consumes the liquid as today;
  - its pump comes from the counted pool of washed pumps, not from the new-pump stock;
  - it consumes a new pump only when the operator states that a new one was really used.
  - Two options for the pool:
    - **A** — a separate inventory item "washed returned pump", with its own ledger movements:
      intake + / defective − / refill −. It never shares a balance with new pumps. A defective
      returned pump never decreases the new-pump stock, which was already consumed at the first
      fitting.
    - **B** — a counter outside the inventory ledger.
  - A is recommended: one ledger, negative balances refused, and the existing audit.
  - The PUMP attachment of a refill records "reused pump (no identity)", or the new item.
- The status trigger gains exactly `FILLED → READY_FOR_REUSE` (only through §4.2) and
  `READY_FOR_REUSE → FILLED` (only through a cycle), and nothing else.

### 4.5 Permissions (ADMIN, by migration)

- `returns:receive` — intake: crate, scrap scan, pump counts, Vyprázdněno.
- `returns:ready` — the clean-side scan.
- `returns:correct` — releasing a hold, corrections of counts, `DISPOSED`.
- Site-scoped like production; every operation is idempotent per `requestId`.

## 5. Deliveries (each its own PR; the model PR first)

| #   | Delivery                                                                                              | Usable result                                                                |
| --- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| R0  | This document (model for approval)                                                                    | —                                                                            |
| R1  | Intake: crate return, "ke skartaci", pump counts, "Vyprázdněno"; `DELIVERED_TO_HOTEL` at delivery     | Sklad → "Příjem vratek"; the crate is free again                             |
| R2  | Clean-side scan → `READY_FOR_REUSE`; history check, discrepancy holds; reuse counter from real events | Station mode "Připraveno k plnění"                                           |
| R3  | Reuse in assembly and filling; pump pool (A)                                                          | The existing station accepts the bottle; no new body, label or pump consumed |

**Acceptance (issue #125).** The flow counts as done only when a **specific returned bottle**
passes, on DEV and through the real UI:

- delivery;
- a partial and mixed return: the crate scan, one defective bottle "ke skartaci", one defective
  pump −1, and "Vyprázdněno";
- washing without a scan;
- the individual scan on the clean side;
- assembly into a new cycle, refilling with a reused pump, and dispatch.

It must then show reuse cycle 1 in its history and on the passport. Required along the way:

- the counter is not raised by a crate scan, a duplicate scan, a wrong or other-environment QR,
  or an unreadable bottle;
- no new body, label or pump is consumed;
- two operators work concurrently;
- recovery after an interrupted request;
- every count, event and movement is transactional and audited.

**Regression acceptance — the existing production and dispatch walk, unchanged.** The same
existing API e2e and Playwright tests stay green without changed expectations:

- labelling into a crate, filling, Hotovo;
- picking whole crates, the shipment, labels, handover;
- carrier tracking to `DELIVERED`.

In particular:

- a finished crate is picked and dispatched by its crate scan with its known contents;
- no per-bottle scan is added at picking or dispatch;
- capacity, the category/recipe/label rules and the FILL consumption of a **new** bottle are as
  today;
- the refusals already tested stay refusals: `CRATE_DELIVERED` for a delivered crate's cycle, and
  labelling only `CREATED`, filling only `LABELED_EMPTY` for a new bottle.

A new test adds the next circulation of one physical crate: a new cycle with new contents, while
the closed cycle's shipped membership is unchanged.

Single screens of R1–R2 are intermediate states, not a finished cycle.
