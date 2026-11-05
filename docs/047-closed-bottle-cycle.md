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

### 4.1 What stays the record of the shipment (never rewritten)

After delivery, the shipped contents are read from records that R1 never changes:

- `order_allocation_bottles`: the bottles of the allocation, recorded at picking. It is
  insert-only (`apps/api/prisma/migrations/20261017090100_hotels_orders_picking/migration.sql:611-629`).
- `order_crate_allocations` of the order (allocation → order → hotel); the parcel
  (`shipment_parcels.allocation_id`); and its delivery `shipment_parcel_progress.delivered_at`.
- The delivery is confirmed per parcel by the carrier
  (`apps/api/src/orders/shipment-tracking.service.ts:252-293`).
- The cycle's `member_count`/`filled_count`, frozen since allocation ("an allocated crate keeps
  its members", `migrations/20261021090100_order_tracking/migration.sql:400-404`).

The **live** state changes at a return:

- the bottle's open `crate_assignments` row;
- the cycle status;
- whether the allocation still **reserves** the physical crate.

The shipment history is all of the above and stays readable from the order, the parcel and the
bottle. An order's allocations are never released by a return, so the order, its lines and
counters, and its `DELIVERED` stay as they are.

### 4.2 Data (new; for review)

```
return_receipts          RR-000001; site (@OperationalSite); hotel (nullable: unknown sender);
                         opened_at/by; closed_at/by; state OPEN → CLOSED
return_receipt_lines     receipt; kind CRATE | CONTAINER (a box without a crate QR);
                         crate (CRATE only); returned_cycle (CRATE only, its DELIVERED cycle);
                         scanned_at/by; emptied_at/by; physical_count (entered at Vyprázdněno /
                         line close: pieces actually taken out of THIS container)
                         UNIQUE (returned_cycle)        — a cycle is returned once
return_receipt_issues    receipt; line; kind UNREADABLE | NOT_DELIVERED | NOT_IN_CIRCULATION |
                         COUNT_MISMATCH; bottle (nullable); details; recorded_at/by;
                         resolved_at/by/resolution, resolving_event (once)
return_pump_counts       receipt; defective n (signed; a correction is a new line); actor; reason
order_crate_allocations  + completed_at/by/operation (set once, when its crate is scanned back):
                           the allocation stays the order's history but no longer reserves
                           the crate
crate_assignments        + released_event_id (FK bottle_events; only with the release)
BottleStatus            += RETURNED ("Vrácená, čeká na mytí"), RETIRED, DISPOSED
BottleEventType         += SORTED, RETIRED, DISPOSED, CORRECTION
bottle_events            SORTED carries crate_cycle_id = the bottle's delivered cycle and the
                         receipt line it was found in
                         UNIQUE (bottle_id, crate_cycle_id) WHERE type = 'SORTED'
CrateCycleStatus        += RETURNED → CLOSED
CrateEventType          += RETURNED, EMPTIED
Permissions              returns:receive, returns:correct (ADMIN, in the same migration)
```

- "Ke skartaci" is `RETIRED` with reason `DEFECTIVE_AT_RETURN` (ADR 0011: operationally
  terminal). The real shredding is the later, irreversible `DISPOSED`, with a DB guard.
- The receipt's hotel comes from the scanned crate's order, or is chosen. It is never inferred
  from bottles.

### 4.3 Database conditions after delivery — what changes, what keeps protecting

Today's commit-time checks would refuse a return: `ayvo_assert_crate_cycle` and
`crate_assignments_guard` (`migrations/20261021090100_order_tracking/migration.sql:408-487`), and
`order_crate_allocations_consistent` (`migrations/20261017090100_hotels_orders_picking/migration.sql:580-598`).

- A crate scan to `RETURNED` with a live allocation breaks "`ALLOCATED`/`DISPATCHED`/`DELIVERED`
  ⇔ held by an active allocation".
- Releasing a bottle of a still-`DELIVERED` cycle X (a mixed return) breaks "active = filled =
  capacity" and the guard "a bottle never leaves a crate allocated to an order".

Proposed changes, each limited to the post-delivery states:

1. **The live hold.**
   - "Held" is defined as an allocation with `released_at IS NULL AND completed_at IS NULL`.
   - The existing equivalences then hold unchanged for every pre-delivery state:
     - `ALLOCATED`/`DISPATCHED`/`DELIVERED` ⇔ live hold;
     - the parcel progress decides `ALLOCATED`/`DISPATCHED`/`DELIVERED`.
   - `RETURNED` and `CLOSED` require **no** live hold, and **exactly one completed** allocation
     whose parcel was delivered (`delivered_at IS NOT NULL`).
   - The crate scan sets `completed_at` (once; the allocation guard allows exactly this field,
     and only for a delivered parcel) and the cycle → `RETURNED`, in one transaction.
2. **Members after delivery.**
   - For `FILLED`/`ALLOCATED`/`DISPATCHED`, the rule stays "active = filled = capacity".
   - For `DELIVERED`, `RETURNED` and `CLOSED`:
     - `active + released_by_return = capacity`, where `released_by_return` counts the
       assignments released with `RETURN_IDENTIFIED`;
     - every active member is still `FILLED`;
     - the frozen `member_count = filled_count = capacity`;
     - the allocation's `order_allocation_bottles` still list exactly `capacity` bottles.
   - So the only way a delivered cycle loses an active member is an identification at a return.
3. **Releasing an assignment of a shipped cycle (`crate_assignments_guard`).**
   - It stays refused for `ALLOCATED`/`DISPATCHED`.
   - It is allowed for `DELIVERED`/`RETURNED`/`CLOSED` **only** with
     `release_reason = 'RETURN_IDENTIFIED'` and a `released_event_id` that is a `SORTED` of the
     same bottle and cycle, written in the same transaction.
   - Every other release stays refused.
4. **The allocation's consistency** (`order_crate_allocations_consistent`). "Records exactly the
   crate's active members" applies to a live allocation before delivery, as today. For a
   delivered or completed one, it is the insert-only `order_allocation_bottles`, unchanged.
5. **Reserving a crate.**
   - `order_crate_allocations_one_active_per_crate` and `…_one_active_per_cycle`
     (`migrations/20261017090100_hotels_orders_picking/migration.sql:526-530`) become partial on
     `released_at IS NULL AND completed_at IS NULL`.
   - A completed allocation stays the first order's history and no longer blocks picking of the
     same crate in its next cycle.
6. **One open cycle per crate.** `crate_cycles_one_open_per_crate`
   (`migrations/20261014160100_labeling_into_crates/migration.sql:292`) excludes `CLOSED` as well
   as `ABORTED`.

All of these are verified by tests that **commit** (deferred constraint triggers run at commit,
not at the statement).

### 4.4 The cycle in use: `openCycle()` and the next circulation

- **Selecting the cycle in use.** `CrateCyclesService.openCycle()` returns the crate's cycle that
  is not `ABORTED` (`apps/api/src/crates/crate-cycles.service.ts:55-69`). It is used by labelling,
  filling, picking, shipments and corrections. It changes to "not `ABORTED` and not `CLOSED`",
  the same set as the index, so there is at most one.
- **Each state then answers as today, or as below:**
  - `DELIVERED` or `RETURNED`: picking and the stations refuse with `CRATE_DELIVERED`
    (`apps/api/src/orders/orders.service.ts:721-726`). For `RETURNED`, the message says
    "vrácená, nejdřív Vyprázdněno".
  - `CLOSED`: `openCycle()` finds nothing. Labelling then opens a new `OPEN_ASSEMBLY` cycle
    exactly as for a crate that has never been used, with `CYCLE_OPENED` and new contents.
  - That cycle is filled, Hotovo, picked into a new order (a new live allocation), dispatched and
    delivered through the unchanged code.
- **History reads.** The bottle's and order's history reads take their cycles from the
  allocation, the parcel or the assignment, never from `openCycle()`. The first order keeps
  showing its original contents and delivery.

### 4.5 What each operation writes (one transaction each, idempotent per `requestId`)

| Operation                | Precondition (else refused, nothing written)                                                                       | Writes                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open receipt             | `returns:receive`, active site                                                                                     | receipt OPEN                                                                                                                                                  |
| Crate scan               | receipt OPEN; crate QR of this environment; its cycle `DELIVERED` with a live allocation whose parcel is delivered | line CRATE; allocation `completed_at`; cycle → `RETURNED`; crate event `RETURNED`. **No bottle row or event changes**                                         |
| Container without QR     | receipt OPEN                                                                                                       | line CONTAINER                                                                                                                                                |
| Bottle scan, good        | receipt OPEN; the context line not emptied; §4.6 check                                                             | `SORTED` (delivered cycle, found-in line, outcome `RETURNED`); status `FILLED → RETURNED`; the assignment released (`RETURN_IDENTIFIED`, `released_event_id`) |
| Bottle scan, defective   | same                                                                                                               | as above with outcome `RETIRED`, plus `RETIRED` (`DEFECTIVE_AT_RETURN`); status `FILLED → RETIRED`                                                            |
| Unreadable piece         | receipt OPEN; line not emptied                                                                                     | issue `UNREADABLE` for that line                                                                                                                              |
| Defective pump −1        | receipt OPEN                                                                                                       | pump-count line; **no inventory movement** (R3)                                                                                                               |
| Vyprázdněno (CRATE line) | receipt OPEN; line not emptied; `physical_count` entered                                                           | line `emptied_at`; cycle `RETURNED → CLOSED`; crate event `EMPTIED`; a `COUNT_MISMATCH` issue if §4.8 differs                                                 |
| Line done (CONTAINER)    | as Vyprázdněno, without the cycle                                                                                  | line `emptied_at`; §4.8                                                                                                                                       |
| Close receipt            | every line emptied                                                                                                 | receipt CLOSED                                                                                                                                                |

### 4.6 History check, repeated and late scans, and the lock order

**Lock order.** It is the existing `crate → cycle → bottle` (`apps/api/src/production/filling.service.ts:216-233`,
`apps/api/src/crates/crate-cycles.service.ts:50`), with the receipt in front:

- **Bottle scan.**
  1. The receipt is locked `FOR SHARE`, so scans in one receipt run concurrently.
  2. The bottle's open assignment is read **without a lock**. It names its cycle X and crate X.
  3. Crate X → cycle X → bottle are locked `FOR UPDATE`.
  4. The assignment is checked again. If it changed meanwhile, the scan is refused with
     `CONCURRENT_CHANGE` and nothing is written.
  - The context line (crate Y of the receipt) is never locked. It is protected by the receipt
    lock, so **one transaction never locks two crates**.
- **Crate scan and Vyprázdněno.** Receipt `FOR UPDATE` → crate → cycle.
- **Closing the receipt.** Receipt `FOR UPDATE`.
- So Vyprázdněno and closing wait for running scans, and a scan waits for them. A scan committed
  after Vyprázdněno of its context line is refused (`LINE_EMPTIED`), and a scan after the close
  is refused (`RECEIPT_CLOSED`). A late piece goes into a new receipt.
- The pump counts and issues lock only the receipt (`FOR SHARE`).

**Checks** (made after the locks):

- **Delivered.** The bottle has an open assignment of cycle X, X has a delivered allocation
  (§4.1), and the bottle is in its `order_allocation_bottles`.
  - The status of X may be `DELIVERED` (crate X not back, a mixed return), `RETURNED` or `CLOSED`.
  - Deliveries from before R1 are covered: no backfill, and no new event at delivery.
- **The first result of a repeated scan.** After a first success, the assignment no longer
  exists. The result is found by the unique `SORTED (bottle, X)` instead. The lookup follows the
  bottle's **last** `SORTED`:
  - Its receipt is OPEN, and the bottle has not moved on since (still `RETURNED`, or `RETIRED`
    from it) → the **first result** is returned: the same answer, no write, no counter change. A
    scan with the other outcome is refused (`ALREADY_RECEIVED`); a change is a `CORRECTION`.
  - Its receipt is CLOSED, or the bottle has moved on (`READY_FOR_REUSE`, a new cycle,
    dispatched again) → refused with `ALREADY_RECEIVED` and the reference. It is never a second
    `SORTED` for the old cycle (the unique index), and never a write into the closed receipt.
  - The same `requestId` returns the stored response (`OperationRequestsService`).
- **Two operators, one bottle.** The second waits on the bottle lock. After the first commits,
  the second either sees the `SORTED` (→ the first result) or a changed assignment
  (→ `CONCURRENT_CHANGE`, then a rescan gives the first result).
- **Not delivered yet.** X is `ALLOCATED`/`DISPATCHED`. Refused with `NOT_DELIVERED`, plus an
  issue on the line. It is resolved after the tracking update by a scan, which links the issue to
  the `SORTED`.
- **Not in circulation.** No open assignment, or a status other than `FILLED`. Refused with
  `NOT_IN_CIRCULATION`, plus an issue.
- **Foreign or other-environment QR.** Refused (`classifyScannedQr`). Nothing is written and no
  issue is recorded, because it is not an AYVO bottle.

### 4.7 Status transitions (DB allow-list)

| From → to            | Only by                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FILLED → RETURNED`  | intake scan (with `SORTED`)                                                                                                                                                                                                                      |
| `FILLED → RETIRED`   | intake scan, defective (with `SORTED` + `RETIRED`)                                                                                                                                                                                               |
| `RETURNED → RETIRED` | a defect found later (`RETIRED`, reason)                                                                                                                                                                                                         |
| `RETIRED → DISPOSED` | confirmed shredding (`DISPOSED`). Irreversible: no later event (DB guard)                                                                                                                                                                        |
| `RETIRED → RETURNED` | `CORRECTION` (`returns:correct`) **only for a retirement documented in the return process**: a `RETIRED` with `DEFECTIVE_AT_RETURN` linked to the bottle's `SORTED`; with a reason and audit. Any other retirement is not corrected by this path |

All existing transitions are unchanged.

### 4.8 Physical counts of a mixed return

Counted per receipt line (one physical container), never from the shipment:

- **Physical** = `physical_count`, entered when the line is emptied.
- **Recorded on the line** = `SORTED` events found in this line (good and defective), plus this
  line's issues that stand for a piece (`UNREADABLE`, `NOT_DELIVERED`, `NOT_IN_CIRCULATION`) and
  are **not resolved by a `SORTED`**.
- A piece is counted once. When an unreadable or undelivered piece is later identified, the
  resolving `SORTED` records the issue's line as its found-in line. The issue then stops counting,
  and the `SORTED` counts instead.
- Physical ≠ recorded → an issue `COUNT_MISMATCH` with both numbers. It never blocks the crate.

**Shown separately, as information only.** For a CRATE line, the cycle's history:

- shipped N (`order_allocation_bottles`);
- identified M (in any receipt);
- N − M labelled **"bez potvrzeného návratu"** (no confirmed return).

It is never compared with the physical count of the line.

### 4.9 R1 UI

Sklad → "Příjem vratek":

- open a receipt;
- scan a crate, or "krabice bez kódu";
- scan bottles, with the "Vadná → ke skartaci" switch;
- "Nečitelná lahev +1" and "Vadná pumpička −1";
- per line, the physical count and "Vyprázdněno";
- close the receipt.

Overview:

- the bottles "Vrácená, čeká na mytí" and since when;
- open issues.

The bottle detail shows the receipt. The hotel's view no longer counts an identified bottle as at
the hotel.

### 4.10 R1 tests (API e2e on a real DB; every case **committed**)

- **Transactions to commit:**
  - a crate scan to `RETURNED`, completing its allocation;
  - a mixed return, where a bottle of a still-`DELIVERED` cycle X is identified in crate Y's
    context;
  - Vyprázdněno → `CLOSED`;
  - the trigger refusals: a release without `SORTED`, a release for another reason, a release of
    an `ALLOCATED`/`DISPATCHED` cycle, a `completed_at` on an undelivered parcel, a second
    `SORTED` of a cycle, `DISPOSED → anything`.
- **Every case of §4.5, §4.6 and §4.8:**
  - concurrency of two scans, and of a scan with Vyprázdněno or with the close;
  - repeated scans in an open and in a closed receipt;
  - a replay;
  - an old delivery;
  - the counts of a mixed return, including an unreadable piece identified later and counted
    once.
- **The reuse counter:** 1 after a good or a defective return; unchanged by a crate,
  duplicate, foreign or late scan.
- **Playwright:** the intake at 390 px and 1440 px.

## 5. Connections and acceptance

| #   | Delivery                                                                                                                                                                                                                                                                       | Connects to                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| R1  | Intake (§4)                                                                                                                                                                                                                                                                    | —                                             |
| R2  | Second scan: `RETURNED → READY_FOR_REUSE` ("Připravená k plnění · Po mytí"). Optionally, in the same transaction, `ASSIGNED_TO_CRATE` into an `OPEN_ASSEMBLY` cycle of the bottle's bound category: no `LABEL_APPLIED`, no `NEW_BOTTLE` consumption, the cycle rules unchanged | R1's `RETURNED`; the existing assembly cycle  |
| R3  | Third scan, filling a `READY_FOR_REUSE` bottle: liquid as today, a washed pump from the counted pool (option A, a separate inventory item), a new pump only when stated; no body or label consumed. The defective pumps of R1 never touch the new-pump stock                   | R2's assignment; `filling.service.ts:254-305` |

Each of R2 and R3 gets its own model PR, as R1.

**Acceptance (issue #125)** on DEV, through the real UI, with one physical crate K:

- K's cycle 1 is delivered to hotel A (order O1).
- In a partial and mixed return:
  - K comes back with some of its bottles, plus one bottle of crate L, whose cycle is still
    `DELIVERED`;
  - the intake scans identify them, and they are no longer at the hotel (reuse cycle 1);
  - a defective neighbour goes "ke skartaci", and a defective pump −1;
  - an unreadable piece, later read by hand, is counted once;
  - the physical count of each line is entered;
  - Vyprázdněno.
- **The same crate K** is then assembled again (a new cycle 2), filled, Hotovo, picked into order
  O2, dispatched and delivered.
- Throughout, O1 still shows its original contents, its parcel and its delivery, and the bottles
  of O1 never identified are "bez potvrzeného návratu".
- For the returned bottle: washing without a scan, then the second scan (with direct placement
  into a prepared crate), then the third scan (filling with a washed pump), then dispatch.
- Along the way:
  - a duplicate scan, a late scan after the close, and a foreign scan;
  - two operators;
  - recovery after an interrupted request.

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
- the closed cycle's shipped membership, the first order's allocation and its parcel are
  unchanged after the crate's next cycle and its second dispatch.
