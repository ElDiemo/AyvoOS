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
                         scanned_at/by (the line's time anchor, §4.6); emptied_at/by;
                         physical_count (entered at Vyprázdněno / line close: pieces actually
                         taken out of THIS container)
                         UNIQUE (returned_cycle)        — a cycle is returned once
                         guard: never deleted; only emptied_at/by + physical_count, set once
return_receipt_issues    code RI-000001; receipt; line; kind UNREADABLE | NOT_DELIVERED |
                         NOT_IN_CIRCULATION | OTHER_SITE (no bottle link) | COUNT_MISMATCH; bottle (nullable); details;
                         recorded_at/by; resolved_at/by, resolution IDENTIFIED | NOT_AYVO |
                         WRITTEN_OFF, resolution_reason, resolving_event (once, UNIQUE)
                         UNIQUE (bottle) WHERE resolved_at IS NULL AND bottle IS NOT NULL
                         guard: never deleted; only the resolution fields, set once
return_pump_counts       receipt; defective n (signed; a correction is a new line); actor; reason
order_crate_allocations  + completed_at/by/line (set once, when its crate is scanned back):
                           the allocation stays the order's history but no longer reserves
                           the crate
crate_assignments        + released_event_id (FK bottle_events; only with the release)
BottleStatus            += RETURNED ("Vrácená, čeká na mytí"), RETIRED, DISPOSED
BottleEventType         += SORTED, RETIRED, DISPOSED, CORRECTION
bottle_events            SORTED carries crate_cycle_id = the bottle's delivered cycle, the
                         receipt line it was found in, and resolves_issue (nullable; the
                         piece issue of that same line it identifies, §4.8a)
                         UNIQUE (bottle_id, crate_cycle_id) WHERE type = 'SORTED'
                         UNIQUE (resolves_issue) WHERE resolves_issue IS NOT NULL
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
   - The crate scan sets `completed_at`/`completed_by`/`completed_line` (once; the allocation
     guard allows exactly these fields, and only for a delivered parcel) and the cycle →
     `RETURNED`, in one transaction.
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
7. **The cycle's own guards** (`crate_cycles_guard` and `crate_cycles_filled_at_check`,
   `migrations/20261021090100_order_tracking/migration.sql:355-406`). Today the guard refuses
   every change of a `DELIVERED` cycle ("does not change yet"), and the check requires
   `filled_at IS NULL` outside `FILLED`/`ALLOCATED`/`DISPATCHED`/`DELIVERED`. Both change:
   - **`crate_cycles_filled_at_check`** becomes
     `(status IN ('FILLED','ALLOCATED','DISPATCHED','DELIVERED','RETURNED','CLOSED')) = (filled_at IS NOT NULL)`.
     The date of filling stays on the cycle after the return.
   - **`crate_cycles_guard`**, the "does not change yet" refusal is replaced by:
     - `DELIVERED` changes only to `RETURNED`; `RETURNED` only to `CLOSED`; `CLOSED` never
       changes (like `ABORTED`).
     - In these steps only `status` changes. `member_count`, `filled_count`, `filled_at` and
       `ready_to_fill_at` stay as they were: the existing "an allocated crate keeps its members"
       clause is extended to `OLD.status IN ('DELIVERED','RETURNED')` and
       `NEW.status IN ('RETURNED','CLOSED')`. The snapshot columns stay immutable as today.
     - No other new transition. In particular `DELIVERED → CLOSED`, `RETURNED → DELIVERED` and
       anything out of `CLOSED` are refused.
   - **The proof of each step**, in `ayvo_assert_crate_cycle` (deferred, at commit):
     - `RETURNED` or `CLOSED` ⇒ exactly one `return_receipt_lines` row of kind `CRATE` with
       `returned_cycle` = this cycle and `crate` = the cycle's crate, a crate event `RETURNED`
       of this cycle, and the completed allocation of point 1 (completed by that line).
     - `CLOSED` ⇒ that line has `emptied_at` set, and a crate event `EMPTIED` of this cycle
       exists.
     - The other way round, in a new deferred check on the lines: a `CRATE` line whose
       `emptied_at` is set ⇒ its cycle is `CLOSED`; a `CRATE` line ⇒ its cycle is `RETURNED` or
       `CLOSED`.
   - So a cycle reaches `CLOSED` only through a real line, scanned and then emptied by the
     confirmed Vyprázdněno. An SQL `UPDATE` of the status alone fails, and while the cycle is
     `RETURNED` no new cycle of the crate can be opened (point 6), so the crate never returns to
     production without the emptying.

All of these are verified by tests that **commit** (deferred constraint triggers run at commit,
not at the statement), including the negative tests in §4.10.

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
| Bottle scan, good        | receipt OPEN; the context line not emptied; §4.6 checks, in their order                                            | `SORTED` (delivered cycle, found-in line, outcome `RETURNED`); status `FILLED → RETURNED`; the assignment released (`RETURN_IDENTIFIED`, `released_event_id`) |
| Bottle scan, defective   | same                                                                                                               | as above with outcome `RETIRED`, plus `RETIRED` (`DEFECTIVE_AT_RETURN`); status `FILLED → RETIRED`                                                            |
| Unreadable piece         | receipt OPEN; line not emptied                                                                                     | issue `UNREADABLE` for that line                                                                                                                              |
| Defective pump −1        | receipt OPEN                                                                                                       | pump-count line; **no inventory movement** (R3)                                                                                                               |
| Vyprázdněno (CRATE line) | receipt OPEN; line not emptied; `physical_count` entered                                                           | line `emptied_at`; cycle `RETURNED → CLOSED`; crate event `EMPTIED`; a `COUNT_MISMATCH` issue if §4.8 differs                                                 |
| Line done (CONTAINER)    | as Vyprázdněno, without the cycle                                                                                  | line `emptied_at`; §4.8                                                                                                                                       |
| Close receipt            | every line emptied                                                                                                 | receipt CLOSED                                                                                                                                                |
| Resolve an issue (§4.8a) | the issue open; receipt and line in **any** state; for `IDENTIFIED` the §4.6 checks against the issue's line       | issue resolved (once); for `IDENTIFIED` the bottle writes of a good/defective scan, the `SORTED` found in the issue's line with `resolves_issue`              |

### 4.6 History check, repeated and late scans, and the lock order

**Lock order.** It is the existing `crate → cycle → bottle` (`apps/api/src/production/filling.service.ts:216-233`,
`apps/api/src/crates/crate-cycles.service.ts:50`), with the receipt in front:

In every operation the `operation_requests` row comes first (the existing contract,
`apps/api/src/database/operation-requests.service.ts:29-61`), then:

- **Bottle scan, and resolving an issue as `IDENTIFIED`: one path, one order.**
  1. The receipt is locked `FOR SHARE`, so scans in one receipt run concurrently.
  2. The bottle's open assignment is read **without a lock**. It names its cycle X and crate X.
  3. Crate X → cycle X → bottle are locked `FOR UPDATE` (only the bottle when it has no open
     assignment).
  4. The assignment is checked again. If it changed meanwhile, the scan is refused with
     `CONCURRENT_CHANGE` and nothing is written.
  5. **Last**, the issue the scan would resolve is locked `FOR UPDATE`: for a resolution the named
     issue; for a rescan on L the open piece issue of this bottle on L, if any. Its state is read
     again after this lock: already resolved → the first result if it was resolved by the same
     bottle and outcome, else `ISSUE_RESOLVED`; nothing written.
  - The rescan of check 4 on L and the `IDENTIFIED` of §4.8a are therefore **the same code path**
    with the same order (receipt → crate → cycle → bottle → issue). Neither ever holds the issue
    while waiting for a crate, so they cannot deadlock; the one that commits second sees the
    resolved issue and the released assignment.
  - The context line (crate Y of the receipt) is never locked. It is protected by the receipt
    lock, so **one transaction never locks two crates**.
- **Crate scan and Vyprázdněno.** Receipt `FOR UPDATE` → crate → cycle.
- **Closing the receipt.** Receipt `FOR UPDATE`.
- So Vyprázdněno and closing wait for running scans, and a scan waits for them. A scan committed
  after Vyprázdněno of its context line is refused (`LINE_EMPTIED`), and a scan after the close
  is refused (`RECEIPT_CLOSED`). A late piece goes into a new receipt; an existing issue is
  resolved by its own operation (§4.8a).
- The pump counts and issue records lock only the receipt (`FOR SHARE`).
- **Resolving an issue as `NOT_AYVO` or `WRITTEN_OFF`.** Receipt `FOR SHARE` → the issue
  `FOR UPDATE`; no crate, cycle or bottle is locked, so nothing can wait in the other direction.

**The site boundary (R1).** Every receipt operation acts on the session's validated active site
(`@OperationalSite()`, doc 022), never on a site named in the request:

- The receipt, its lines, its issues and its pump counts belong to the receipt's site, which is
  the active site. A receipt, line or issue of another site answers **404**, as if it did not
  exist; this lookup is read-only and runs **before** the request row and any replay.
- The rows a scan changes must belong to that site: the crate (`crates.site_id`), its cycle
  (`crate_cycles.site_id`), the bottle (`bottles.site_id`) and the order of the delivered
  allocation. Otherwise → `CRATE_OF_ANOTHER_SITE` / `BOTTLE_OF_ANOTHER_SITE` (as picking does
  today, `apps/api/src/orders/orders.service.ts:681-688`), nothing changed on the foreign rows.
  For a bottle this is checked right after `classifyScannedQr`, before checks 1–8, and the line
  gets an issue `OTHER_SITE` **without** a link to the bottle, so the piece is counted (§4.8)
  without exposing anything of the other site. It is resolved only `WRITTEN_OFF` with a reason
  (a transfer between sites is not part of R1).
- **Error details** (`ALREADY_RECEIVED_ELSEWHERE`, `OPEN_ISSUE`, `ALREADY_RECEIVED`) name only
  receipts, lines and issues of the active site. Since a bottle is identified only in receipts of
  its own site, nothing of another site can be named; a refusal across sites carries no details.
- **Replay.** The payload under the `requestId` is the operation's kind plus `{ actorId, siteId,
receiptId, lineId | issueId, token, outcome }` (for a resolution also `resolution`). A stored
  response is returned only for the same id, kind and payload; the same id with another line,
  receipt, issue, outcome, site or kind → `IDEMPOTENCY_CONFLICT`, nothing written. Since the
  receipt is resolved within the active site first, a replay never returns a response of
  another site.

**The anchor of a scan.** A scan is always made **on one line L** (the context line, or the line
of the issue being resolved), and it identifies at most one concrete delivered cycle X. "The
bottle's last `SORTED`" or "its current assignment" alone is not enough: a stale request from a
line that stayed open could meet the bottle's _next_ delivery. The anchor is the line's
`scanned_at`, written by the database when the container was scanned in:

- a piece physically in L's container was delivered and assigned to its cycle **before** L
  existed, so a valid identification on L needs X's assignment `assigned_at < L.scanned_at`;
- a bottle identified anywhere **after** L existed cannot also be in L's container, since it would
  have to go back to a hotel and return in a container that was already at AYVO.

Between those events lie washing, filling, a dispatch and a delivery (hours to weeks), so the
comparison of database times is not a race; two scans of the same bottle are ordered by the
bottle lock.

**Checks, in this exact order** (after the locks; the first that applies decides, and nothing
after it runs):

0. **Same `requestId`** with the same kind and payload (including the receipt and the line or
   issue, see the site boundary) → the stored response (`OperationRequestsService`), before
   anything but the read-only lookup of the receipt in the active site; the same id with another
   kind or payload → `IDEMPOTENCY_CONFLICT`.
1. **Receipt or line closed.** Receipt CLOSED → `RECEIPT_CLOSED`; L emptied → `LINE_EMPTIED`.
   Nothing written. (Not for resolving an issue, which works on a closed line, §4.8a.)
2. **Already identified on this line.** The bottle has a `SORTED` found in **L**:
   - it is the bottle's last `SORTED` and the bottle has not moved on (still `RETURNED`, or
     `RETIRED` from it) and the outcome is the same → the **first result**: the same answer, no
     write, no counter change;
   - another outcome → `ALREADY_RECEIVED` (a change is a `CORRECTION`);
   - the bottle has moved on → `ALREADY_RECEIVED` with the reference.
3. **Identified elsewhere, and not in circulation again before L.** The bottle's last `SORTED`
   is in another line, and the bottle has no open assignment that is both younger than that
   `SORTED` and older than `L.scanned_at` → `ALREADY_RECEIVED_ELSEWHERE` with that line's receipt
   and code. It is a refusal for L, never a success: nothing written, nothing counted on L, and
   the UI shows it as "přijata jinde", not as a scanned piece. This covers the stale request of
   review 5803984774: the bottle accepted on A while B stayed open, then washed, filled and
   delivered a second time, then the old request of B arrives. Its open assignment (cycle 2) is
   younger than `B.scanned_at`, so it is refused here, before any use of the current assignment.
   The same holds while the bottle is still `RETURNED` or `READY_FOR_REUSE`.
4. **An open piece issue of this bottle on another line** → `OPEN_ISSUE` with its code; the issue
   is resolved by §4.8a, never by a second identification. (An open issue of this bottle on L
   itself is resolved by this scan: the `SORTED` gets `resolves_issue`.)
5. **The delivered cycle.** The bottle has an open assignment of cycle X with
   `assigned_at < L.scanned_at`, X has a delivered allocation (§4.1), and the bottle is in its
   `order_allocation_bottles` → the identification (`SORTED` for X, found in L).
   - X may be `DELIVERED` (crate X not back, a mixed return), `RETURNED` or `CLOSED`.
   - A genuine **second** return passes here: it is scanned on a line C opened after the second
     delivery, and the assignment of cycle 2 is younger than the first `SORTED` and older than
     `C.scanned_at`, so check 3 does not apply.
   - Deliveries from before R1 are covered: no backfill, and no new event at delivery.
6. **Not delivered yet.** The same assignment, X `ALLOCATED`/`DISPATCHED` → `NOT_DELIVERED`, plus
   an issue on L. After the tracking update it is resolved by a rescan on L (check 4) or by
   §4.8a.
7. **Assigned after L was opened.** An open assignment with `assigned_at ≥ L.scanned_at` →
   `NOT_IN_THIS_LINE`. Nothing written and no issue: the bottle cannot be in this container.
8. **Not in circulation.** No open assignment, or a status other than `FILLED` → `NOT_IN_CIRCULATION`,
   plus an issue.

A foreign or other-environment QR is refused before the checks (`classifyScannedQr`). Nothing is
written and no issue is recorded, because it is not an AYVO bottle.

**Two operators, one bottle.** The second waits on the bottle lock. After the first commits, the
second runs the checks again from 1: on the same line it gets the first result (2), on another
line `ALREADY_RECEIVED_ELSEWHERE` (3), or `CONCURRENT_CHANGE` when the assignment changed
between its read and its lock (then a rescan decides as above).

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
- **Recorded on the line** = this line's piece issues (`UNREADABLE`, `NOT_DELIVERED`,
  `NOT_IN_CIRCULATION`, `OTHER_SITE`), **resolved or not**, plus the `SORTED` events found in this line
  (good and defective) **without** `resolves_issue`.
- A piece is counted once: either as its issue or as its own `SORTED`. A `SORTED` that resolves an
  issue is the same piece and is not counted again. A later resolution therefore never changes
  the line's recorded count, and the `COUNT_MISMATCH` stated at Vyprázdněno stays true.
- Physical ≠ recorded → an issue `COUNT_MISMATCH` with both numbers. It never blocks the crate.

### 4.8a Resolving a concrete issue after the line or the receipt is closed

Typically the carrier's delivery confirmation, or a readable code, appears only after the line was
emptied or the receipt closed. Scans into a closed line stay refused (§4.6). The piece is resolved
by its own operation on the **concrete issue**, never by a scan into another receipt:

- **Who and where.** Sklad → "Příjem vratek" → open issues → the issue (code `RI-…`).
  `returns:receive` for `IDENTIFIED`; `returns:correct` for `NOT_AYVO` and `WRITTEN_OFF`, with a
  reason. Every resolution is audited and written once (the issue guard). Its receipt and line
  rows are not written, and a closed receipt stays closed.
- **`IDENTIFIED`.** The operator scans the bottle (and chooses good / defective). It runs the
  §4.6 checks **against the issue's line** (its `scanned_at` is the anchor; check 1 is skipped):
  - for a `NOT_DELIVERED` or `NOT_IN_CIRCULATION` issue, the scanned bottle must be the issue's
    bottle (else `WRONG_BOTTLE`);
  - the `SORTED` is found in the issue's line, with `resolves_issue` = the issue; the status and
    the release are those of a normal scan (§4.5);
  - when a check refuses (still not delivered, identified elsewhere), nothing is written and the
    issue stays open.
- **`NOT_AYVO`** (a foreign object was counted) and **`WRITTEN_OFF`** (the piece cannot be
  identified) write no bottle event.
- **Exactly once, also with two operators.**
  - The issue lock serializes two resolutions of the same issue. The second sees it resolved and
    gets the first result if it is the same bottle and outcome; otherwise `ISSUE_RESOLVED`.
  - A normal scan of the issue's bottle elsewhere is refused with `OPEN_ISSUE` (§4.6 check 4), and
    the index "one open issue per bottle" prevents two open issues for the same bottle.
  - In the DB: `resolving_event` and `resolves_issue` are unique, a resolving `SORTED` must have the
    issue's line as its found-in line, and `(bottle, cycle)` is identified at most once.
  - An `UNREADABLE` issue has no bottle, so nothing can stop a scan of that piece elsewhere. The
    piece is set aside with its issue code (doc 018 §16 quarantine). If it was still scanned on
    another line, its resolution answers `ALREADY_RECEIVED_ELSEWHERE`, and the issue is closed
    `WRITTEN_OFF` with that `SORTED` as its reference. The bottle's identification stays the one
    `SORTED`, and each line's count stays that of its own container.
- **Counts.** Unchanged for the line (§4.8). The reuse counter rises by one for a resolving
  `SORTED`, like any other identification.

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
- **The cycle guards (§4.3 point 7), as direct SQL that commits:**
  - `filled_at`, `member_count` and `filled_count` are unchanged after `RETURNED` and `CLOSED`;
    changing any of them in `DELIVERED`/`RETURNED`/`CLOSED` is refused;
  - `DELIVERED → CLOSED` directly is refused;
  - `DELIVERED → RETURNED` without a `CRATE` line of that cycle fails at commit;
  - `RETURNED → CLOSED` without the line's `emptied_at` and the `EMPTIED` event fails at commit;
  - setting a `CRATE` line's `emptied_at` without closing its cycle fails at commit;
  - while the cycle is `RETURNED`, opening a new cycle of the crate (labelling, or an `INSERT`) is
    refused, so the crate cannot go back to production without Vyprázdněno;
  - `CLOSED → anything` is refused;
  - the positive path on a real receipt line: crate scan → `RETURNED` → Vyprázdněno → `CLOSED`,
    with the line, both crate events and the original `filled_at`.
- **Every case of §4.5, §4.6 and §4.8:**
  - each check of §4.6 in its order, including that an earlier check wins (e.g. a closed line
    before `ALREADY_RECEIVED_ELSEWHERE`);
  - concurrency of two scans, and of a scan with Vyprázdněno or with the close;
  - repeated scans on the same line (first result), and on another line of the same and of
    another receipt (`ALREADY_RECEIVED_ELSEWHERE`, nothing counted on that line);
  - a stale scan on a line opened before the bottle's identification elsewhere;
  - a replay;
  - an old delivery;
  - the counts of a mixed return, including an unreadable piece identified later and counted
    once.
- **Resolution after the close (§4.8a):**
  - a `NOT_DELIVERED` piece: the receipt is closed, then the tracking update arrives, then the
    issue is resolved → one `SORTED` on the issue's line, reuse counter 1, the line's recorded
    count unchanged, the receipt still CLOSED;
  - an `UNREADABLE` piece resolved after the close in the same way;
  - two operators resolving the same issue at once → one `SORTED`, the other gets the first
    result or `ISSUE_RESOLVED`;
  - a resolution racing a normal scan of the same bottle elsewhere → one identification, the
    other `OPEN_ISSUE` or `CONCURRENT_CHANGE`;
  - an `UNREADABLE` piece scanned on another line first → its resolution answers
    `ALREADY_RECEIVED_ELSEWHERE`, closed `WRITTEN_OFF` with the reference, one `SORTED`;
  - `WRONG_BOTTLE`, and a resolution refused while still not delivered (the issue stays open);
  - **on the same line**: a rescan of the issue's bottle on L (check 4) and an `IDENTIFIED` of the
    same issue, started concurrently (both transactions held open until each has taken its first
    lock, then released) → both finish without a deadlock or a timeout, exactly one `SORTED` with
    `resolves_issue`, the other gets the first result or `ISSUE_RESOLVED`; repeated in both start
    orders. (The test with a scan on another line takes the `OPEN_ISSUE` branch and does not
    cover this.)
- **The site boundary (§4.6), with a second site and its own crate, cycle, bottle and receipt:**
  - a bottle scan of the other site's bottle on our line → `BOTTLE_OF_ANOTHER_SITE`, an
    `OTHER_SITE` issue without a bottle link, the foreign bottle, assignment, cycle and events
    unchanged;
  - a crate scan of the other site's delivered crate → `CRATE_OF_ANOTHER_SITE`, no line, the
    foreign allocation and cycle unchanged;
  - a scan, an issue record and Vyprázdněno on the other site's receipt or line, and a resolution
    of its issue → 404, nothing written, no detail in the answer;
  - error details of `ALREADY_RECEIVED_ELSEWHERE` / `OPEN_ISSUE` never name a receipt, line or
    issue of another site;
  - **replay**: the same `requestId` with another line, receipt, issue, outcome or kind →
    `IDEMPOTENCY_CONFLICT` and nothing written; the same `requestId` and payload with the session
    switched to the other site → 404 before the replay, the stored response not returned.
- **Two deliveries of the same bottle** (needs R2 and R3 to deliver a bottle twice, so it runs in
  R3's PR and in the acceptance; R1 covers the parts it can create):
  - bottle b is accepted on line A while line B of the same receipt stays open; b is washed,
    filled and delivered again; the stale request from B (new `requestId`) arrives →
    `ALREADY_RECEIVED_ELSEWHERE`, nothing written, reuse counter still 1;
  - the genuine second return of b on a new line C → `SORTED` for cycle 2, reuse counter 2.
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
  - recovery after an interrupted request;
  - an attempt to put crate K back into production before its Vyprázdněno is refused;
  - a piece whose delivery the carrier confirms only after the receipt is closed, resolved on its
    issue and counted once.
- **The same bottle twice.** The returned bottle, once delivered again (in O2 or another order),
  comes back a second time and is identified on a new line (reuse cycle 2). A stale scan of it
  from a line opened before its first identification is refused as "přijata jinde".

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
