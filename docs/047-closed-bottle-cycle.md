# 047 — Closed bottle cycle: inventory on main and proposed model (issue #125, part 1)

Status: **approved workflow + R1 model for review** (owner priority 2026-11-05, issue #125).

- §3 is the **workflow the owner approved** on 2026-11-05 ("no to by melo jit tak sup jedem").
- §4 is the **concrete R1 model, for review**. Per CLAUDE.md, a new domain model needs the owner's
  approval of that model; the approved workflow does not approve these tables, enums or
  migrations.
- §5 marks how R2 and R3 connect.
- Nothing here is implemented.

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

## 3. Approved workflow (owner 2026-11-05)

Three individual scans of the bottle, never fewer:

1. **Intake, on the dry workplace.**
   - The scan of the returned crate (or box) opens the **intake context only**. Its original
     contents are never assumed.
   - **Every returned bottle is scanned individually.**
     - A good bottle → "Vrácená, čeká na mytí".
     - A defective one → "Ke skartaci".
   - From that moment the intake shows that this concrete bottle is no longer at the hotel.
   - The first verified return after a delivery closes the reuse cycle **once** (ADR 0011). This
     includes a defective bottle.
   - Pumps are washed and reused, counted without identity. Defective pumps are counted (−1).
2. **After washing and inspection.** The second scan → "Připravená k plnění · Po mytí". If the
   operator directly places the bottle into a prepared crate, the same scan also assigns it to
   that new crate.
3. **Filling.** The confirmation of filling is the third scan (the existing filling scan).

Unchanged and outside the return:

- **The boundary (§4.0).** A crate of unknown contents exists only in the return intake. Picking
  and dispatch use the whole verified contents of a crate, as today.

Still open from the accepted docs, not decided here:

- How returns are collected (doc 009:64).
- Whether `DISPOSED` and `DESTROYED` are one state or two, and who may reverse a retirement (ADR
  0011).

## 4. R1 — the intake: concrete model for review (not implemented)

### 4.0 Boundary (owner 2026-11-05, issue #125 and #126)

Up to delivery, nothing changes:

- assembly, filling, picking, dispatch and delivery;
- the concrete cycle with its concrete verified bottles;
- product, recipe and label snapshots;
- capacity and the "full" rule;
- the transactional consumption.

A finished crate is still handled whole with known contents. **No new per-bottle scan at
dispatch, and no new write in the delivery transaction.** At a return, the original membership or
count is never assumed. The shipped assignments and snapshots are never rewritten; a release only
adds its own fields. The next circulation of the same physical crate is a **new cycle** with its
own verified contents.

### 4.1 Data

```
return_receipts          RR-000001; site (@OperationalSite); hotel (nullable: unknown sender);
                         opened_at/by; closed_at/by; state OPEN → CLOSED
return_receipt_crates    receipt; crate (by its QR); returned_cycle (its DELIVERED cycle);
                         scanned_at/by; emptied_at/by (§4.4)
                         UNIQUE (returned_cycle) — a cycle is returned once
return_receipt_issues    receipt; kind UNREADABLE | NOT_DELIVERED | NOT_IN_CIRCULATION |
                         COUNT_MISMATCH; bottle (nullable); details; recorded_at/by;
                         resolved_at/by/resolution (once)   — append-only except the resolution
return_pump_counts       receipt; defective n > 0; actor; reason; a correction is a new line
                         with its own sign — append-only
BottleStatus            += RETURNED ("Vrácená, čeká na mytí"), RETIRED, DISPOSED
                           (READY_FOR_REUSE comes in R2)
BottleEventType         += SORTED, RETIRED, DISPOSED, CORRECTION
CrateCycleStatus        += RETURNED → CLOSED
CrateEventType          += RETURNED, EMPTIED
crate_assignments        + released_event_id (FK bottle_events), set only together with the
                           release
Permissions              returns:receive, returns:correct (ADMIN, granted in the same migration)
```

- "Ke skartaci" is `RETIRED` with reason `DEFECTIVE_AT_RETURN`.
  - It is the approved, operationally terminal state of ADR 0011, reversible only by an audited
    `CORRECTION`.
  - The real shredding is the later, irreversible `DISPOSED`, with a DB guard.
- Hotel in the receipt: it is taken from the scanned crate's order, or chosen. It is never
  inferred from bottles.

### 4.2 What each operation writes (each one transaction, idempotent per `requestId`)

| Operation              | Precondition (else refused, nothing written)        | Writes                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open receipt           | `returns:receive`, active site                      | `return_receipts` OPEN                                                                                                                                                                                                            |
| Crate scan             | crate QR of this environment; its cycle `DELIVERED` | receipt crate line; cycle → `RETURNED`; crate event `RETURNED`. **No bottle row or event changes.**                                                                                                                               |
| Bottle scan, good      | §4.3 history check passes                           | `SORTED` (cycle = the delivered cycle, receipt, crate line if any, outcome `RETURNED`); status `FILLED → RETURNED`; the bottle's open assignment to that cycle released (`RETURN_IDENTIFIED`, `released_event_id` = the `SORTED`) |
| Bottle scan, defective | same                                                | as above with outcome `RETIRED`; plus a `RETIRED` event, reason `DEFECTIVE_AT_RETURN`; status `FILLED → RETIRED`                                                                                                                  |
| Unreadable bottle      | —                                                   | issue `UNREADABLE` (count 1, note). No bottle touched                                                                                                                                                                             |
| Defective pump −1      | receipt OPEN                                        | `return_pump_counts` line. **No inventory movement** (see R3)                                                                                                                                                                     |
| Vyprázdněno            | crate line of this receipt                          | §4.4                                                                                                                                                                                                                              |
| Close receipt          | every crate line emptied                            | state CLOSED                                                                                                                                                                                                                      |

**Reuse cycle (ADR 0011).**

- It is counted from `SORTED` events that name a **delivered cycle**.
- `UNIQUE (bottle_id, crate_cycle_id) WHERE type = 'SORTED'` makes it exactly once per delivery,
  for good and defective bottles alike.
- A crate scan, a duplicate scan, a foreign QR or an unreadable bottle never counts.
- `countCompletedReuseCycles` (`apps/api/src/assets/reuse-cycles.ts:7`) changes to count these
  `SORTED` events.
- **For review:** ADR 0011 names `SORTED` after `DELIVERED_TO_HOTEL`. R1 takes the delivery from
  the delivered cycle the `SORTED` names instead of a new bottle event. The rule is the same, the
  delivery transaction stays untouched (§4.0), and old deliveries are covered. ADR 0011 then gets
  an addendum, not a rewrite.
- The passport and the bottle detail show the result at once.

### 4.3 History check of a bottle scan — and the edge cases

The check is made under `SELECT … FOR UPDATE` of the bottle row, then of its open assignment and
cycle, always in that lock order.

- **Delivered.** The bottle has an open assignment whose cycle is `DELIVERED`, `RETURNED` or
  `CLOSED`. That is the verified delivery fact recorded by the carrier (doc 031).
- **Old deliveries.** Deliveries from before R1 are covered by the same check, with no backfill
  and no new event at delivery. No `DELIVERED_TO_HOTEL` event is introduced; the cycle is the
  record.
- **Mixed return.** A bottle scanned in the context of crate Y whose delivered cycle belongs to
  crate X is accepted. Its own cycle decides. The receipt records the crate it was found in.
- **Concurrency.** Two operators scan the same bottle. The row lock makes the second wait; it
  then sees the `SORTED` and gets the **first result** (the same answer, no second event, no
  error).
  - A different `requestId` with the same bottle and cycle → the existing result.
  - The same `requestId` → the stored response (`OperationRequestsService`).
- **Repeated scan.** It answers with the first result. A scan with the other outcome
  (good ↔ defective) is refused with `ALREADY_RECEIVED`. A change is an audited `CORRECTION`, not
  a rescan.
- **Not delivered yet.** The cycle is `DISPATCHED`/`ALLOCATED`/… (for example, the carrier has not
  reported it).
  - Refused with `NOT_DELIVERED`, plus an issue `NOT_DELIVERED` with the bottle.
  - It is resolved after the tracking update by scanning again, or by an authorized decision.
- **Not in circulation.** The bottle has no open assignment, or its status is not `FILLED`.
  - Refused with `NOT_IN_CIRCULATION`, plus an issue with the bottle and its current state.
  - This covers `CREATED`, `LABELED_EMPTY`, already `RETURNED`, `RETIRED` and `DISPOSED`.
- **Foreign or other-environment QR.** Refused (`classifyScannedQr`). Nothing is written.
- **Unreadable code.** Only an issue `UNREADABLE`.
  - The piece is set aside and never matched by guessing (doc 018 §16).
  - Resolution: the bottle code read by hand → an ordinary bottle scan, then the issue is
    resolved with a reference to it. Otherwise the issue is resolved as "nelze identifikovat",
    with a note.
- **Count mismatch.** The confirmation "Vyprázdněno" shows:
  - shipped in that cycle: N;
  - identified from it, in any receipt: M;
  - still at the hotel by the records: N − M.
  - If the operator states that more pieces came out than were identified, an issue
    `COUNT_MISMATCH` records the numbers.
  - Nothing is inferred and nothing blocks the crate.

### 4.4 Releasing the historical assignment and the crate

- **The bottle's assignment ends at its own intake scan.**
  - `released_at/by`, `release_reason = 'RETURN_IDENTIFIED'` and `released_event_id` are set once.
    The original fields never change.
  - Today's guard forbids a release while the cycle is `DELIVERED`
    (`apps/api/prisma/migrations/20261021090100_order_tracking/migration.sql:484`).
    - R1 adds one exception: reason `RETURN_IDENTIFIED` with a `SORTED` event of the same bottle
      and cycle in the same transaction, checked by the trigger.
    - Every other release of a shipped cycle stays refused.
  - The unique "one active assignment per bottle" index
    (`apps/api/prisma/migrations/20261014160100_labeling_into_crates/migration.sql:424`) thus
    protects a bottle until it is identified.
  - The shipped membership stays readable as history (`assigned_*`, the cycle, the order
    allocation).
- **"Vyprázdněno"** is one confirmation per crate line, after the crate is really empty.
  - Cycle `RETURNED → CLOSED`; crate event `EMPTIED`, with the N / M / N − M numbers in its data.
  - The cycle's remaining open assignments stay open. Those bottles are still "at the hotel" by
    the records until they are identified, possibly later and in another crate. The guard allows
    their identification release also for `CLOSED`.
- **A new cycle of the crate.**
  - `crate_cycles_one_open_per_crate`
    (`apps/api/prisma/migrations/20261014160100_labeling_into_crates/migration.sql:292`)
    excludes `CLOSED` as well as `ABORTED`.
  - The crate then opens a new `OPEN_ASSEMBLY` cycle through the existing assembly, with newly
    scanned contents.
  - A crate whose cycle is `DELIVERED` or `RETURNED` still cannot open a cycle or be picked
    (`CRATE_DELIVERED`, unchanged).

### 4.5 Status transitions (DB allow-list)

| From → to            | Only by                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `FILLED → RETURNED`  | intake scan (with `SORTED`)                                               |
| `FILLED → RETIRED`   | intake scan, defective (with `SORTED` + `RETIRED`)                        |
| `RETURNED → RETIRED` | a defect found later (`RETIRED`, reason)                                  |
| `RETIRED → DISPOSED` | confirmed shredding (`DISPOSED`). Irreversible: no later event (DB guard) |
| `RETIRED → RETURNED` | `CORRECTION` (`returns:correct`)                                          |

All existing transitions are unchanged. Where a corrected retirement returns to (ADR 0011 open
question) is proposed as `RETURNED`.

### 4.6 R1 UI

Sklad → "Příjem vratek":

- open a receipt;
- scan a crate;
- scan bottles, with a "Vadná → ke skartaci" switch for the next scan;
- "Nečitelná lahev +1" and "Vadná pumpička −1";
- "Vyprázdněno" per crate, with N / M / N − M;
- close the receipt.

Overview:

- bottles "Vrácená, čeká na mytí" and since when, for each site;
- open issues.

The bottle detail shows the receipt. The hotel's delivery view no longer counts identified bottles
as at the hotel.

### 4.7 R1 tests

- **API e2e, real DB:**
  - every row of §4.2 and every case of §4.3;
  - two concurrent scans of one bottle (one `SORTED`);
  - a replay of a lost response;
  - a mixed return;
  - a delivery from before R1;
  - the trigger refusals: release without `SORTED`, release of a shipped cycle for another reason,
    `DISPOSED → anything`, a second `SORTED` of the same cycle;
  - the reuse counter is 1 after a good or a defective return and unchanged by crate, duplicate
    or foreign scans.
- **Playwright:** the intake at 390 px and 1440 px, including Vyprázdněno and a new cycle of the
  crate.
- **Regression:** see §5.

## 5. Connections and acceptance

| #   | Delivery                                                                                                                                                                                                                                                                       | Connects to                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| R1  | Intake (§4)                                                                                                                                                                                                                                                                    | —                                             |
| R2  | Second scan: `RETURNED → READY_FOR_REUSE` ("Připravená k plnění · Po mytí"). Optionally, in the same transaction, `ASSIGNED_TO_CRATE` into an `OPEN_ASSEMBLY` cycle of the bottle's bound category: no `LABEL_APPLIED`, no `NEW_BOTTLE` consumption, the cycle rules unchanged | R1's `RETURNED`; the existing assembly cycle  |
| R3  | Third scan, filling a `READY_FOR_REUSE` bottle: liquid as today, a washed pump from the counted pool (option A, a separate inventory item), a new pump only when stated; no body or label consumed. The defective pumps of R1 never touch the new-pump stock                   | R2's assignment; `filling.service.ts:254-305` |

Each of R2 and R3 gets its own model PR, as R1.

**Acceptance (issue #125)** on DEV, through the real UI:

- a specific bottle is delivered, then returned in a partial and mixed return;
- intake scan: it is no longer at the hotel, and reuse cycle 1;
- a defective neighbour goes "ke skartaci" and a defective pump −1;
- Vyprázdněno, and the crate opens a new cycle;
- washing without a scan, then the second scan (with direct placement);
- the third scan (filling with a washed pump), then dispatch;
- along the way: an unreadable bottle, a duplicate and a foreign scan, two operators, recovery
  after an interrupted request.

The single screens of R1 and R2 are intermediate states, not a finished cycle.

**Regression acceptance — the existing production and dispatch walk, unchanged.** The existing
API e2e and Playwright tests stay green without changed expectations:

- labelling, filling, Hotovo;
- picking whole crates, the shipment, labels, handover;
- tracking to `DELIVERED`.

In particular:

- a finished crate is picked and dispatched by its crate scan with its known contents;
- no per-bottle scan is added at picking or dispatch;
- delivery writes nothing new;
- capacity, the category/recipe/label rules and the FILL consumption of a **new** bottle are as
  today;
- `CRATE_DELIVERED`, labelling only `CREATED` and filling only `LABELED_EMPTY` stay refusals for a
  new bottle;
- the closed cycle's shipped membership is unchanged after the crate's next cycle.
