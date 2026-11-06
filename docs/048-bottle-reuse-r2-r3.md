# 048 — Returned bottle back into circulation: R2 (after washing), R3 (refilling), R1 order

Status: **draft for review** (issue #125, priority 1; doc 047 §5). Nothing here is implemented, and
nothing here is a migration.

- R2 and R3 are the second and third scan of the workflow the owner approved on 2026-11-05 (doc 047
  §3). This document proposes their concrete models. As for R1, the approved workflow does not
  approve these tables, enums or migrations; the owner approves each model.
- §6 is the implementation order of R1 once the owner approves the R1 model (doc 047 §4, technical
  APPROVE 5804146060 on `69d90c8`).

## 1. Dependencies

| Step | Needs, before its implementation starts                                                        |
| ---- | ---------------------------------------------------------------------------------------------- |
| R1   | the owner's approval of the R1 model (doc 047 §4)                                              |
| R2   | R1 implemented (status `RETURNED`, `SORTED`, released assignments, cycle `CLOSED`); this model |
| R3   | R2 implemented (status `READY_FOR_REUSE`, the bottle's new assignment); this model; §4 D1      |

Only R3 can deliver one bottle twice, so the tests "two deliveries of the same bottle" (doc 047
§4.10) and the end-to-end matrix (§5) run complete only from R3 on.

## 2. R2 — the second scan, after washing and inspection

### 2.1 What it does

- `RETURNED → READY_FOR_REUSE` ("Připravená k plnění · Po mytí"), with a new bottle event
  `REUSE_READY`. The operator scans only a bottle that was physically washed and inspected; there
  is no scan before washing (doc 047 §3).
- The bottle keeps its **identity** (the same row, QR and code) and its **product binding**
  (`bottle_product_bindings` is written once and immutable,
  `migrations/20261014160100_labeling_into_crates/migration.sql:503-529`), so its category
  `HAND_SOAP`/`SHOWER_GEL` and its label design stay.
- **Nothing is consumed:** no `LABEL_APPLIED`, no `LABEL_APPLICATION` movement, no `NEW_BOTTLE`
  lot, no label media. The body and the label are physically the same.
- The bottle's open `PUMP` attachment (from its first filling) is closed with the existing
  disposition `CLEANING_REQUIRED`: the pump left the bottle for washing and continues without
  identity (R3).

### 2.2 Two paths, both tested

**A — on its own** (Sklad → "Po mytí"):

- Scan a `RETURNED` bottle of the active site → `REUSE_READY`, status `READY_FOR_REUSE`, the pump
  attachment closed. No crate.
- The bottle is put into a crate later, by path B's scan of a `READY_FOR_REUSE` bottle, which
  then writes only `ASSIGNED_TO_CRATE`.

**B — the real direct placement** (the existing labelling station, crate loaded):

- The station's context is unchanged (product, label design, crate in `OPEN_ASSEMBLY`). The
  operator turns on the switch "Vrácené lahve po mytí"; it is part of each scan's payload
  (`afterWash: true`), so a `RETURNED` bottle is never accepted at the station without it
  (`AFTER_WASH_NOT_CONFIRMED`).
- One scan, one transaction: path A's writes **and** `ASSIGNED_TO_CRATE` into the loaded cycle,
  assignment source `REUSE`.
- The bottle is placed only where it physically belongs: the existing commit check requires the
  member's binding to equal the cycle's product **and label design**
  (`crate_assignments_consistent`, `migrations/20261014160100_labeling_into_crates/migration.sql:477-490`).
  Otherwise `BINDING_MISMATCH`, naming the bottle's product and label design, nothing written.
- The cycle rules stay: inserted only into `OPEN_ASSEMBLY`, ordinal ≤ capacity, the 40th
  eligible member makes it `READY_TO_FILL`. "Eligible" becomes `LABELED_EMPTY` **or**
  `READY_FOR_REUSE`.
- Lock order as labelling: operation request → session → crate → cycle → bottle.

A new bottle at the same station is labelled exactly as today (`CREATED` only,
`apps/api/src/production/labeling.service.ts:303`).

### 2.3 Data (for review)

```
BottleStatus           += READY_FOR_REUSE
BottleEventType        += REUSE_READY   (path STANDALONE | INTO_CRATE; the cycle for INTO_CRATE)
CrateAssignmentSource  += REUSE
status trigger           RETURNED → READY_FOR_REUSE only with a REUSE_READY in the transaction;
                         READY_FOR_REUSE → FILLED only by R3
commit check             READY_FOR_REUSE ⇔ a REUSE_READY younger than the bottle's last SORTED
assignment insert check  accepts LABELED_EMPTY (LABELING) or READY_FOR_REUSE (REUSE)
inventory ledger         unchanged: no movement may reference REUSE_READY or a REUSE assignment
```

The existing supervised corrections of a cycle (`production:cycle_correct`) apply unchanged.

### 2.4 Tests (API e2e on a real DB, committed)

- Path A, then placement by path B; path B in one scan. Both leave the binding, the label
  attachment and every stock balance unchanged, and the ledger has no new row.
- Refusals with nothing written: not `RETURNED`/`READY_FOR_REUSE` (`RETIRED`, `FILLED`, a new
  bottle without the switch), another site, `BINDING_MISMATCH`, a crate not `OPEN_ASSEMBLY`, a
  full crate.
- The 40th member made of new and reused bottles → `READY_TO_FILL`.
- Replay, a duplicate scan, two stations scanning the same bottle.
- DB: `RETURNED → READY_FOR_REUSE` without `REUSE_READY` fails at commit; a `REUSE` assignment
  of a `RETURNED` bottle fails.
- Playwright: "Po mytí" and the station switch at 390 px and 1440 px.

## 3. R3 — the third scan: refilling, and washed pumps

### 3.1 Filling a reused bottle

- The existing filling scan, at the same station, with the same crate and liquid lot
  (`apps/api/src/production/filling.service.ts:200-305`). It accepts a member in
  `READY_FOR_REUSE` as well as `LABELED_EMPTY` (`:250`).
- `READY_FOR_REUSE → FILLED`, a new `FILLED` event for **this** cycle, the liquid lot as today.
- **The pump really installed is stated on each scan of a reused bottle:** `pump: 'WASHED' |
'NEW'`, required, with no default. The UI keeps the last choice visible as a switch; the value
  is part of the payload.
  - `WASHED` → one piece of the washed pump item.
  - `NEW` → the recipe's pump, exactly as today.
- A **new** bottle is filled exactly as today: always the recipe's pump; a `pump` value on it is
  refused.
- A new `PUMP` attachment is installed as today.

### 3.2 The smallest stock record (existing inventory logic, no new supplier)

- **A separate item** "Pumpička umytá" (kind `PUMP`, unit piece, no lots), with one new column
  `reuse_of_item_id` naming the new pump item it is the washed form of (doc 047 §5, option A).
  The new pump keeps its own item and balance.
- **Inflow.** Only what was really washed and found good is entered:
  - `washed_pump_entries`: site, location, item, quantity (whole pieces, ≠ 0; negative = a
    correction with a reason), actor, time, `requestId`;
  - ledger movement `WASHED_PUMP_ENTRY` (+) or `WASHED_PUMP_CORRECTION` (−), one per entry;
    "type ⇔ sign ⇔ exactly one source" as for `RECEIPT`/`RECEIPT_CORRECTION`;
  - the balance is written by the existing trigger and is never negative.
- **Consumption.** The `FILL` movement of the recipe's `PUMP` BOM line with item = the washed item.
  The ledger check "item equal to the source" is extended by exactly one case: the washed item
  whose `reuse_of_item_id` is the BOM line's item, only for the `FILLED` event of a bottle that
  was `READY_FOR_REUSE`. One movement per (bottle event, BOM line), unchanged.
- **A defective pump at the intake never touches stock.** R1's `return_pump_counts` (doc 047 §4.2)
  writes no movement. A defective pump never entered any stock, so it can never write off a new
  pump; the new pump balance changes only by `RECEIPT`, `RECEIPT_CORRECTION` and `FILL`, as today.
  A pump found defective during washing is simply not entered.
- **Quantities only.** No price, no valuation, nothing in Finance (see D3).

### 3.3 Data (for review)

```
inventory_items          + reuse_of_item_id (only kind PUMP, → a PUMP item without it)
washed_pump_entries      new, append-only (above)
InventoryMovementType   += WASHED_PUMP_ENTRY, WASHED_PUMP_CORRECTION
bottle_events            bottle_events_one_filled_per_bottle → UNIQUE (bottle, crate_cycle)
                         WHERE type = 'FILLED'
                         (migrations/20261016090100_filling_and_crate_corrections/migration.sql:67)
commit checks            FILLED ⇔ the bottle's last FILLED event, of its active cycle, with its
                         open PUMP attachment; one open PUMP attachment per bottle
Permissions              inventory:washed_pumps_record (ADMIN, in the same migration)
```

### 3.4 Tests (API e2e on a real DB, committed)

- A reused bottle with `WASHED`: liquid −1 portion, washed pump −1, new pump 0, body and label 0.
- With `NEW`: new pump −1, washed pump 0.
- Without `pump`, or no washed pump in stock (`INSUFFICIENT_STOCK`), → refused, nothing written.
- A new bottle: unchanged consumption; `pump` refused.
- A washed pump entry and its correction; a negative balance refused.
- R1 defective pump −1 → no ledger row, the new pump balance unchanged.
- DB: a washed-item `FILL` for a new bottle fails; a second `FILLED` of the same cycle fails.
- Hotovo, picking, dispatch and delivery of a cycle with reused bottles through the unchanged
  code.

## 4. Decisions needed

For the owner:

- **D1 — Where washed pumps enter stock.** Proposed: one entry per washing round at the washing
  place, counted by hand. The alternative is no washed-pump stock at all, only the choice at
  filling; then there is no check that a washed pump really existed.
- **D2 — A changed label design.** A reused bottle keeps its physical label, so it can only go into
  a cycle of its own product and label design (the DB rule today). When a product's design
  changes, do returned bottles keep running with their old design (proposed: yes, while its
  approval for that product is valid), or are they taken out?
- **D3 — New and reused bottles in one crate.** The existing rules allow it, since they have the
  same product and label design. Proposed: allowed. Say so if they must be kept apart.

Not the owner's, and not guessed: whether and how washed pumps are valued for accounting. That
is for the accountant. R3 records pieces only.

## 5. Test matrix: one physical bottle b, first delivery to second return

Crate K; stock columns: N = `NEW_BOTTLE`, P = new pump, W = washed pump. "—" = no change.

| #   | Step                                                               | b afterwards                                    | Cycle                  | Reuse | N   | P   | W   |
| --- | ------------------------------------------------------------------ | ----------------------------------------------- | ---------------------- | ----- | --- | --- | --- |
| 1   | Labelled into K (existing walk)                                    | `LABELED_EMPTY`, binding                        | K1 `OPEN_ASSEMBLY`     | 0     | −1  | —   | —   |
| 2   | Filled, Hotovo                                                     | `FILLED`, pump attached                         | K1 `FILLED`            | 0     | —   | −1  | —   |
| 3   | Picked into O1, dispatched, delivered (existing walk)              | unchanged, no event                             | K1 `DELIVERED`         | 0     | —   | —   | —   |
| 4   | R1: crate scan of K, b scanned good on line A                      | `RETURNED`, `SORTED`                            | K1 `RETURNED`          | 1     | —   | —   | —   |
| 5   | Stale scan of b from line B, opened earlier                        | refused `ALREADY_RECEIVED_ELSEWHERE`            | —                      | 1     | —   | —   | —   |
| 6   | Defective pump −1 at intake; Vyprázdněno of K                      | —                                               | K1 `CLOSED`            | 1     | —   | —   | —   |
| 7   | Washing (no scan); D1 entry of washed pumps +n                     | —                                               | —                      | 1     | —   | —   | +n  |
| 8   | R2 path B into K (a new cycle)                                     | `READY_FOR_REUSE`, `REUSE` member, pump removed | K2 `OPEN_ASSEMBLY`     | 1     | —   | —   | —   |
| 9   | R3 fill with `WASHED`, Hotovo                                      | `FILLED` (K2)                                   | K2 `FILLED`            | 1     | —   | —   | −1  |
| 10  | Picked into O2, dispatched, delivered                              | unchanged                                       | K2 `DELIVERED`         | 1     | —   | —   | —   |
| 11  | Second return: b on a new line C                                   | `RETURNED`, `SORTED` (K2)                       | K2 `RETURNED` or mixed | 2     | —   | —   | —   |
| 12  | Throughout: O1 shows its contents, parcel and delivery, never K2's | —                                               | K1 history unchanged   | —     | —   | —   | —   |

Variants of the same walk: path A at step 8 then placement; `NEW` at step 9 (P −1, W 0); b
defective at step 4 (`RETIRED`, reuse 1, never steps 8–11).

**The existing dispatch walk, unchanged:** a new bottle b′ in a new crate, and a new bottle b″
next to b in K2: labelled only from `CREATED`, filled only from `LABELED_EMPTY` with the recipe's
pump (P −1), whole crates picked by their crate scan, no per-bottle scan at picking or dispatch,
nothing new at delivery, `CRATE_DELIVERED` for a crate not yet returned. The existing API e2e and
Playwright tests stay green without changed expectations.

## 6. R1 implementation order (after the owner approves the R1 model)

Each step is its own PR, reviewed and merged before the next. API and DB tests come before any UI.

1. **R1-a — database.** One migration: the doc 047 §4.2 tables and enums, the permissions with
   their ADMIN grant, and the §4.3 changes (live hold, members after delivery, the release, the
   allocation consistency, the partial indexes, one open cycle, the cycle guards). DB tests that
   **commit**, running as `ayvo_core`: every positive transition and every negative of doc 047
   §4.10, including the direct SQL ones. The whole existing suite stays green unchanged. No
   service or route yet.
2. **R1-b — API.** The receipt services and routes (`returns:receive`, `returns:correct`,
   `@OperationalSite()`), the §4.6 checks in their order, the one lock order, the site boundary
   and the replay payload, and §4.8a. API e2e on a real DB: all of doc 047 §4.10 except Playwright,
   including the same-line concurrency of a rescan and `IDENTIFIED`.
3. **R1-c — UI.** Sklad → "Příjem vratek" (doc 047 §4.9), Playwright at 390 px and 1440 px.
4. **DEV acceptance** only after the owner approves that deployment.

From the APPROVE (5804146060), binding for R1-b:

- **A refusal that records an issue commits.** `NOT_DELIVERED`, `NOT_IN_CIRCULATION` and
  `OTHER_SITE` do not throw inside `OperationRequestsService.run`: a throw rolls back everything,
  the issue included (`apps/api/src/database/operation-requests.service.ts:29-61`). They return a
  stored outcome `{ outcome: 'ISSUE_RECORDED', code, issue }`, committed with the issue. A replay
  of the same request returns that outcome and adds **no second piece**. Refusals that write
  nothing keep throwing.
- **Concurrency on the same line:** verified on the real DB. The one that loses may return the
  result already written only if it is for the same issue, bottle and outcome, and never writes a
  second event.
