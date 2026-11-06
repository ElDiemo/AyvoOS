# 048 — Returned bottle back into circulation: R2 (after washing), R3 (refilling), R1 order

Status: **draft for review** (issue #125, priority 1; doc 047 §5). Nothing here is implemented, and
nothing here is a migration.

- R2 and R3 are the second and third scan of the workflow the owner approved on 2026-11-05 (doc 047
  §3). This document proposes their concrete models. As for R1, the approved workflow does not
  approve these tables, enums or migrations; the owner approves each model.
- Documentation continuity: R1 is merged (#129), but its model doc 047 is still only in PR #126
  (`69d90c8`), which this PR is stacked on. Merging #126 is a separate documentation step, not
  done while the R1 DEV release is running; `main` is not changed from here.
- §6 is the implementation order of R1 once the owner approves the R1 model (doc 047 §4, technical
  APPROVE 5804146060 on `69d90c8`).

## 1. Dependencies and the release boundary

| Step | Needs, before its implementation starts                                                             |
| ---- | --------------------------------------------------------------------------------------------------- |
| R1   | done (#129, merged)                                                                                 |
| R2   | R1 on DEV (done, `e8e71d3`); the R1 fix below; this model — **decided on its own**                  |
| R3   | R2 released; this model; D1 (§4); §3.3c. It contains the placement into a crate **and** the filling |

**R2 and R3 are separate decisions.** R2 (§2) needs only the approval of its own small model and
can be released alone. Nothing in R3's open questions (D1, the compatible migration §3.3c, the
separate proposal §7) blocks R2.

**A prerequisite fix of R1, found while checking this (reproduced 2026-11-06 on `e8e71d3`, local
test database).** The supervised "Doplnit lahev" (`cycle-corrections.service.ts:127-143`) refuses
only `CREATED`. It put a `RETURNED` (unwashed) bottle into an assembling crate of the same
product, design and recipe, and the crate became `READY_TO_FILL`, which the filling never accepts
(it takes only `LABELED_EMPTY`): a stuck crate. A `RETIRED` bottle passes the same checks (only
a full crate refused it in the reproduction). The DB does not check the member's status either
(`crate_assignments_insert_check` checks the source against the cycle status only). Proposed as
its own small fix PR before R2: the API and the DB accept a new member only in `LABELED_EMPTY`
(labelling, `REPLACEMENT`) or `FILLED` (`REPACKED`), unchanged for today's walk; `RETURNED`,
`RETIRED`, `DISPOSED` → `BOTTLE_NOT_PLACEABLE`; test with a returned and a retired bottle.

**No crate that cannot be finished, between R2 and R3 (review 5806384095).** Today the filling
scan accepts only `LABELED_EMPTY` (`apps/api/src/production/filling.service.ts:250`). If R2 put a
washed bottle into an ordinary crate, that crate would reach `READY_TO_FILL` and could not be
filled until R3 — a stuck crate in the normal production. Therefore:

- **R2 releases only "Po mytí" on its own** (§2): `RETURNED → READY_FOR_REUSE`, no crate, no
  station change. A `READY_FOR_REUSE` bottle can enter no crate in R2. Today's memberships stay
  exactly as they are: labelling (`LABELING`) and `REPLACEMENT` of a `LABELED_EMPTY` bottle and
  the audited `REPACKED` of a `FILLED` one (`cycle-corrections.service.ts:121-232`) — R2 only
  adds `READY_FOR_REUSE` to the statuses that are refused (`NOT_PLACEABLE_YET`), at the station,
  in the corrections and in the DB.
- **R3 releases the placement into an ordinary crate (§3.0) together with its filling (§3.1)**
  in one migration and one deploy, so every crate that can take a washed bottle can also fill it.
- **Compatibility between releases** (as doc 049):
  - R2 on R1's data and R3 on R2's data add states only; the previous release runs on the new
    schema until the first new write. For R2 that is the first `REUSE_READY`; for R3 it is **any**
    of its new writes (§3.3c), not only the first `REUSE` assignment.
  - After that, the previous release cannot read the new status values (Prisma enum, P2023 —
    the R1 finding of doc 049 §3): fix forward only; the release notes record the first write.
  - Tests in each release: the unchanged walk of a new bottle (labelling → filling → Hotovo →
    picking → dispatch → delivery) green without changed expectations, while `READY_FOR_REUSE`
    bottles exist (R2) or while a crate holds new and washed bottles (R3).

Only R3 can deliver one bottle twice, so the tests "two deliveries of the same bottle" (doc 047
§4.10) and the end-to-end matrix (§5) run complete only from R3 on.

## 2. R2 — the second scan, after washing and inspection ("Po mytí" only)

### 2.1 What it does

- Sklad → "Po mytí": scan a `RETURNED` bottle of the active site → `RETURNED → READY_FOR_REUSE`
  ("Připravená k plnění · Po mytí"), with a new bottle event `REUSE_READY`. The operator scans
  only a bottle that was physically washed and inspected; there is no scan before washing (doc
  047 §3).
- The bottle keeps its **identity** (the same row, QR and code) and its **product binding**
  (`bottle_product_bindings` is written once and immutable,
  `migrations/20261014160100_labeling_into_crates/migration.sql:503-529`), so its category
  `HAND_SOAP`/`SHOWER_GEL` and its label design stay.
- **Nothing is consumed:** no `LABEL_APPLIED`, no `LABEL_APPLICATION` movement, no `NEW_BOTTLE`
  lot, no label media. The body and the label are physically the same.
- The bottle's open `PUMP` attachment (from its filling) is closed with the existing disposition
  `CLEANING_REQUIRED`: the pump left the bottle for washing and continues without identity (R3).
- `REUSE_READY` opens the bottle's **next circulation** (§3.3b): it is the event the next filling
  is bound to.
- **A withdrawn label design** (D2): when the bottle's design approval is revoked, "Po mytí"
  refuses (`DESIGN_WITHDRAWN`) and nothing is written; the bottle stays `RETURNED` and is listed
  under "Vyčleněno – odvolaná etiketa" for an explicit decision. No automatic retirement.

### 2.2 Data (for review)

```
BottleStatus           += READY_FOR_REUSE
BottleEventType        += REUSE_READY
status trigger           RETURNED → READY_FOR_REUSE only with a REUSE_READY in the transaction
commit check             READY_FOR_REUSE ⇔ the bottle's last return event is a REUSE_READY
                         younger than its last SORTED (positive match, as doc 049's R1 fix)
assignment insert check  unchanged sources; the member's status LABELED_EMPTY or FILLED (the
                         R1 fix above), never READY_FOR_REUSE in R2
inventory ledger         unchanged: no movement may reference REUSE_READY
```

### 2.3 Tests (API e2e on a real DB, committed)

- "Po mytí" of a `RETURNED` bottle: status, event, pump attachment closed; binding, label
  attachment and every balance unchanged; the ledger has no new row.
- Refusals with nothing written: `RETIRED`, `FILLED`, `LABELED_EMPTY`, another site, a revoked
  design (`DESIGN_WITHDRAWN`), a replay with another payload; a duplicate scan is the first result.
- **The boundary:** a `READY_FOR_REUSE` bottle at a labelling station → `NOT_PLACEABLE_YET`; a
  direct SQL `REUSE`/`LABELING` assignment of it fails; meanwhile a crate of new bottles is
  labelled, filled, Hotovo, picked and delivered unchanged.
- DB: `RETURNED → READY_FOR_REUSE` without `REUSE_READY` fails at commit; a loose `FILLED` bottle
  can never become `READY_FOR_REUSE`.
- Playwright: "Po mytí" at 390 px and 1440 px.

## 3. R3 — the third scan: refilling, and washed pumps

### 3.0 Placing a washed bottle into an ordinary crate (released with §3.1)

At the existing labelling station, crate loaded (the "direct placement" of the approved
workflow, doc 047 §3):

- The station's context is unchanged (product, label design, crate in `OPEN_ASSEMBLY`). The
  operator turns on the switch "Vrácené lahve po mytí"; it is part of each scan's payload
  (`afterWash: true`).
- One scan, one transaction: for a `RETURNED` bottle the writes of "Po mytí" **and**
  `ASSIGNED_TO_CRATE` into the loaded cycle; for a `READY_FOR_REUSE` bottle only
  `ASSIGNED_TO_CRATE`. Assignment source `REUSE`.
- The bottle is placed only where it physically belongs: product **and label design** equal to
  the cycle's (`crate_assignments_consistent`); otherwise `BINDING_MISMATCH`, nothing written.
- The cycle rules stay: only into `OPEN_ASSEMBLY`, ordinal ≤ capacity, the 40th eligible member
  makes it `READY_TO_FILL`; "eligible" becomes `LABELED_EMPTY` **or** `READY_FOR_REUSE`.
- **Which design and recipe the station's cycle has** (verified in the code, `main` `bcdd926`):
  - The station offers every design whose approval for the product is **open** (not revoked),
    oldest first (`apps/api/src/catalog/product-label-approvals.service.ts:156-166`); the context
    is accepted only for an open approval (`isOpen`, `:143-153`; `labeling.service.ts:155`), and
    every labelling scan checks it again (`labeling.service.ts:348`). A design version is approved
    for at most one product at a time (`:66-70`). An older design therefore stays selectable as
    long as its approval is open.
  - The context takes the product's **active** recipe (`labeling.service.ts:153`) and a
    `NEW_BOTTLE` lot (`:162-167`); for a reuse scan the lot is irrelevant (nothing is consumed)
    and is not required when the station works only with returned bottles.
  - **Recipe of a member.** Today `crate_assignments_consistent` takes the member's recipe from
    the cycle it was **labelled** in
    (`migrations/20261016090100_filling_and_crate_corrections/migration.sql:482-498`). An empty
    washed bottle has no recipe of its own, so a `READY_FOR_REUSE` member is compared on product
    and label design only; the target cycle's (active) recipe decides its filling.
- Lock order as labelling: operation request → session → crate → cycle → bottle.
- A new bottle at the same station is labelled exactly as today (`CREATED` only,
  `labeling.service.ts:303`).

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
bottle_fill_circulations new, insert-only: filled_event_id PK, circulation_event_id UNIQUE
                         (§3.3b, §3.3c); bottle_events keeps every row and payload unchanged
                         bottle_events_one_filled_per_bottle (UNIQUE (bottle) WHERE FILLED,
                         migrations/20261016090100_filling_and_crate_corrections/migration.sql:67)
                         is dropped at the end of the same migration, after the backfill (§3.3c)
commit checks            FILLED ⇔ a FILLED event of the bottle's current circulation (after its
                         last SORTED, or since labelling) with its open PUMP attachment; one open
                         PUMP attachment per bottle. NOT "of its active cycle": see §3.3a
crate_assignments_consistent
                         a FILLED member: product + label design + the recipe of the cycle of its
                         last FILLED event (not of its labelling cycle)
Permissions              inventory:washed_pumps_record (ADMIN, in the same migration)
```

### 3.3a A filled bottle in another crate (REPACKED) — no second filling, no write-off

Today (doc 025, `filling.e2e.test.ts` scenario 1) a supervisor takes filled bottles out of a
crate that is aborted or corrected; they stay `FILLED` without an active assignment, and
"Přeložit hotové lahve" puts them into another cycle (`REPACKED`,
`apps/api/src/production/cycle-corrections.service.ts:121-232`), which Hotovo finishes without any
new consumption. Their `FILLED` event and its `FILL` movements stay on the cycle they were filled
in. R3 must keep this:

- **The filling belongs to the bottle's circulation, not to its current crate.** A `FILLED`
  bottle is backed by exactly one `FILLED` event after its last `SORTED` (or since labelling, for
  a bottle never returned). The status machine guarantees "once": only `LABELED_EMPTY` or
  `READY_FOR_REUSE` is filled, and `FILLED` is never filled again. Its cycle may differ from the
  active assignment's cycle.
- **What a repacked filled bottle must match.** The target cycle's product and label design (its
  binding) and the recipe of the cycle **its last `FILLED` event** was written in. Today the code
  and the DB use the labelling cycle's recipe (`cycle-corrections.service.ts:168-178`, `:188-208`;
  the migration line above). That is the same for a never-returned bottle, so nothing changes for
  today's walk; for a reused bottle refilled under a newer recipe it is the right recipe.
- **Stock exactly once.** The `FILL` movements stay one per (`FILLED` event, BOM line)
  (existing unique index); a `REPACKED` assignment never posts a movement, never writes `FILLED`
  and never installs a pump. Hotovo of a cycle with repacked members needs no new filling (as
  today).
- **The audited path stays the only one:** `production:cycle_correct`, reason, `REPACKED` source,
  `ASSIGNED_TO_CRATE` event (unchanged).

### 3.3b One filling per circulation — also in the database (review 5806384095)

A unique `(bottle, crate_cycle)` protects one crate only: after `REPACKED` the second crate has
another id in the **same** circulation. And today's insert check of `FILLED` verifies the active
membership of a crate in filling (`bottle_events_cycle_rules`), not the bottle's state before the
filling. The circulation therefore gets an explicit identity:

- **The circulation is the event that made the bottle fillable:** its `LABEL_APPLIED` (first
  circulation) or a `REUSE_READY` (each later one, after a real return, §2.1).
- **Each `FILLED` is anchored to it** in an insert-only side table
  `bottle_fill_circulations (filled_event_id PK → bottle_events, circulation_event_id UNIQUE)`,
  written by the database (§3.3c says why not a column), at the insert of the `FILLED`, with the
  bottle row locked (`SELECT … FOR UPDATE` in the trigger, which also serialises a concurrent
  second filling):
  - the anchor is the bottle's **latest** `LABEL_APPLIED`/`REUSE_READY`;
  - the bottle is `LABELED_EMPTY` or `READY_FOR_REUSE` at that moment (never `FILLED`);
  - `circulation_event_id` is unique: one filling per circulation, whatever the crate, through the
    API, direct SQL or two concurrent requests.
- **One consumption per circulation follows:** `FILL` movements need their `FILLED` event and stay
  one per (event, BOM line) (existing unique index), so a second write-off of body, liquid or pump
  in the same circulation has nothing to attach to.
- A genuine next circulation (`SORTED` → `REUSE_READY`) gives a new event, so the next filling
  passes.

### 3.3c A migration that the R2 code survives (review 5806760233)

The deploy migrates **before** the API is switched, so for a while the R2 code writes on the R3
schema. The R2 filling knows no circulation anchor; R3 must not require one from it. And
`bottle_events` is append-only (`bottle_events_append_only`, no UPDATE): no backfill may rewrite an
event or its payload.

- **Why a side table, not a column:** a new column would need either the R2 code to fill it
  (it cannot) or an UPDATE of existing `FILLED` rows (refused by `bottle_events_append_only`). The
  side table is written by the database itself, so the R2 code's `FILLED` gets its anchor too.
- **One compatible migration, no transitional release needed:**
  - create `bottle_fill_circulations`; **backfill by INSERT**: each existing `FILLED` → its bottle's
    `LABEL_APPLIED` (today at most one `FILLED` per bottle, enforced by
    `bottle_events_one_filled_per_bottle`, so the backfill is unique by construction); no event row
    or payload is touched;
  - the insert trigger of `FILLED` derives the anchor from the locked bottle: `LABELED_EMPTY` →
    its `LABEL_APPLIED`, `READY_FOR_REUSE` → its latest `REUSE_READY` (which only R3's code fills);
    the API passes nothing, so the R2 code's fillings of new bottles get their anchor as well;
  - only then, in the same migration, `bottle_events_one_filled_per_bottle` is dropped: the side
    table's unique anchor is the stronger rule (one filling per circulation), and it already holds
    for every backfilled and every new `FILLED`.
- **If the review prefers the API to name the anchor explicitly** (as the earlier draft said): that
  needs a transitional release that derives it when absent, and a second migration that makes it
  required after R3 runs everywhere. The side table avoids both steps; it is the proposal.
- **Test plan before any R3 write** (as doc 049 §2, a throwaway worktree of the R2 release and the
  R3 migrations applied before each file): the R2 API tests of labelling, filling, Hotovo, picking,
  dispatch, delivery, the R1 intake and R2 "Po mytí" pass unchanged; each new `FILLED` of a new
  bottle gets its `LABEL_APPLIED` anchor; no `bottle_events` row changed (count and a hash of
  `payload` before/after).
- **Rollback after R3's first writes** — decided on **all** new writes, any of them non-zero
  means fix forward only:
  - `crate_assignments` with source `REUSE`;
  - `FILLED` anchored to a `REUSE_READY` (`bottle_fill_circulations` join `bottle_events`);
  - `washed_pump_entries` and the ledger types `WASHED_PUMP_ENTRY`/`WASHED_PUMP_CORRECTION`;
  - `FILL` movements of the washed pump item;
  - the read-only query and the preflight follow doc 049 §1 and §4, with these tables.

### 3.4 Tests (API e2e on a real DB, committed)

- **One filling per circulation (review 5806384095), commit tests by direct SQL:** a bottle filled
  in X, repacked into Y (`REPACKED`) → a second `FILLED` naming the same circulation for Y fails
  (side-table unique); a side row naming an older `LABEL_APPLIED`/`REUSE_READY` fails (trigger); a second
  `FILL` movement for the first `FILLED` fails (existing unique); a `FILLED` while the bottle is
  `FILLED` fails; two concurrent filling requests → one `FILLED`, one refusal. Positive: after a
  real return and `REUSE_READY` the next `FILLED` commits, with exactly one new set of `FILL`.
- **Repack without a second filling (review 5805919355):** a new bottle and a reused bottle are
  filled in crate X; X is taken apart (`remove-bottle` / abort); both are repacked into crate Y
  (one of them into an empty Y, which opens `FILLING` with the bottles' snapshot); Hotovo; picked,
  dispatched, delivered. Exactly one `FILLED` event and one set of `FILL` movements per bottle
  and circulation, none for the repack; washed and new pump balances changed once; both bottles
  reach the next return. Negative: repacking the reused bottle into a cycle of another recipe is
  refused (`SNAPSHOT_MISMATCH`, also by the DB).

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

For the owner (recommendations after review 5806384095):

- **D1 — Where washed pumps enter stock.** Recommended: **one entry per washing batch with the
  number of good washed pumps** (counted by hand at the washing place; a correction is a new
  entry with a reason). The alternative is no washed-pump stock, only the choice at filling; then
  nothing proves that a washed pump existed.
- **D2 — What a revoked label design means for returned bottles (a proposal, not a policy).**
  Revoking an approval and retiring a bottle are separate acts:
  - At the intake the bottle is identified as usual (`SORTED`, `RETURNED`). "Po mytí" refuses it
    (`DESIGN_WITHDRAWN`, §2.1): it stays `RETURNED`, listed as "Vyčleněno – odvolaná etiketa",
    blocked from any further use until someone decides.
  - **No automatic retirement and no second write-off.** The body and the label were consumed
    once, at the first labelling (`LABEL_APPLICATION`); a retirement writes no stock movement. An
    actual retirement is its own explicit, confirmed action (`RETURNED → RETIRED` with a reason).
  - Options for the owner:
    - **(a)** a revoked design means "do not send this label again": the separated bottles are
      retired by that explicit action, one by one or as a confirmed list;
    - **(b)** a revoked design means "no new labels": the separated bottles may be released to
      "Po mytí" again by a supervisor (a reuse context that accepts the revoked design, never
      labelling).
  - Whether a revocation must also stop **already prepared crates and shipments** is a separate
    change of today's dispatch, not part of R2 (§7).
- **D3 — New and reused bottles in one crate.** Recommended: **allowed when product, label design
  and recipe are the same** (the cycle's snapshot; the DB checks the binding, §3.0, §3.3a).
  Practical consequence today: an order line takes one product, and its first crate pins one
  recipe version and one label design for the whole line (`LINE_VERSION_MISMATCH`,
  `apps/api/src/orders/orders.service.ts:768-799`); one order holds each product once. So crates of
  an older, still approved design and crates of the new one cannot go into the same order for
  that product: the picker loads crates of one design per order.

Not the owner's, and not guessed: whether and how washed pumps are valued for accounting. That
is for the accountant. R3 records pieces only.

## 5. Test matrix: one physical bottle b, first delivery to second return

Crate K; stock columns: N = `NEW_BOTTLE`, P = new pump, W = washed pump. "—" = no change.

| #   | Step                                                               | b afterwards                           | Cycle                  | Reuse | N   | P   | W   |
| --- | ------------------------------------------------------------------ | -------------------------------------- | ---------------------- | ----- | --- | --- | --- |
| 1   | Labelled into K (existing walk)                                    | `LABELED_EMPTY`, binding               | K1 `OPEN_ASSEMBLY`     | 0     | −1  | —   | —   |
| 2   | Filled, Hotovo                                                     | `FILLED`, pump attached                | K1 `FILLED`            | 0     | —   | −1  | —   |
| 3   | Picked into O1, dispatched, delivered (existing walk)              | unchanged, no event                    | K1 `DELIVERED`         | 0     | —   | —   | —   |
| 4   | R1: crate scan of K, b scanned good on line A                      | `RETURNED`, `SORTED`                   | K1 `RETURNED`          | 1     | —   | —   | —   |
| 5   | Stale scan of b from line B, opened earlier                        | refused `ALREADY_RECEIVED_ELSEWHERE`   | —                      | 1     | —   | —   | —   |
| 6   | Defective pump −1 at intake; Vyprázdněno of K                      | —                                      | K1 `CLOSED`            | 1     | —   | —   | —   |
| 7   | Washing (no scan); D1 entry of washed pumps +n                     | —                                      | —                      | 1     | —   | —   | +n  |
| 8   | R2 "Po mytí"; then (R3) placed into K (a new cycle)                | `READY_FOR_REUSE`, then `REUSE` member | K2 `OPEN_ASSEMBLY`     | 1     | —   | —   | —   |
| 9   | R3 fill with `WASHED`, Hotovo                                      | `FILLED` (K2)                          | K2 `FILLED`            | 1     | —   | —   | −1  |
| 10  | Picked into O2, dispatched, delivered                              | unchanged                              | K2 `DELIVERED`         | 1     | —   | —   | —   |
| 11  | Second return: b on a new line C                                   | `RETURNED`, `SORTED` (K2)              | K2 `RETURNED` or mixed | 2     | —   | —   | —   |
| 12  | Throughout: O1 shows its contents, parcel and delivery, never K2's | —                                      | K1 history unchanged   | —     | —   | —   | —   |

Variants of the same walk: at step 8 one scan at the station (R3: "Po mytí" + placement); `NEW` at step 9 (P −1, W 0); b
defective at step 4 (`RETIRED`, reuse 1, never steps 8–11); **after step 9, K2 taken apart and b
repacked into crate M (`REPACKED`), Hotovo, O2 from M — no second `FILLED`, W stays −1 (§3.3a);
a second `FILLED` of b in M is refused by the DB (§3.3b).**

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

## 7. Separate proposal (not R2/R3): a revoked design and prepared dispatch

Today a revocation stops only **labelling**: the context and every labelling scan check
`isOpen` (`labeling.service.ts:155`, `:348`). Filling, Hotovo, picking (`addCrate` checks the
cycle's snapshot against the order line, `orders.service.ts:768-799`, not the approval) and the
shipment never look at it. If the owner wants "never send this label again" to hold everywhere,
it is its own change of dispatch, with its own model PR:

- server checks of the approval at: filling of a crate, Hotovo, loading a crate into an order,
  completing the order and preparing the shipment — each refusing `DESIGN_WITHDRAWN` for a crate
  whose cycle's design is revoked;
- an already open station context: the next scan is refused (as labelling does today);
- an already prepared or picked crate: it is held (refused at the next step), never silently
  removed; the operator removes it from the order with a reason;
- a shipment the carrier already has: no automatic action; a warning on the order;
- tests of each step, and that nothing changes while no approval is revoked.

Until then R2/R3 change nothing in dispatch.
