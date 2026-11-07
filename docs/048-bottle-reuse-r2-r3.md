# 048 — Returned bottle back into circulation: R2 (after washing), R3 (refilling), R1 order

Status: **draft for review** (issue #125, priority 1; doc 047 §5). State on `main` `5650409`
(2026-11-07): R1 is merged and on DEV (#129, with the fixes #131, #133); **R2 (§2) is implemented**
(#132, doc 050) and on DEV with no R2 data yet. **R3 (§3) is not implemented**; §8 is its concrete
delivery plan for the owner's decision.

**Owner's clarification 2026-11-07 (review 5814083818), applied below:**

- "Po mytí" keeps the same QR and "K plnění", and the next production goes the same way as for
  a new bottle;
- the combined scan of washing and placement is withdrawn;
- pumps are written off as one count X at the intake (doc 047 §6.2), with no washed-pump stock and
  no `WASHED`/`NEW` choice;
- the crate and bottle changes of the intake are doc 047 §6 (R1.1). They do not touch the crate's
  content in production and dispatch.

- R2 and R3 are the second and third scan of the workflow the owner approved on 2026-11-05 (doc 047
  §3). This document proposes their concrete models. As for R1, the approved workflow does not
  approve these tables, enums or migrations; the owner approves each model.
- Documentation continuity: R1 is merged (#129), but its model doc 047 is still only in PR #126
  (`69d90c8`), which this PR is stacked on. Merging #126 is a separate documentation step, not
  done while the R1 DEV release is running; `main` is not changed from here.
- §6 is the implementation order of R1 once the owner approves the R1 model (doc 047 §4, technical
  APPROVE 5804146060 on `69d90c8`).

## 1. Dependencies and the release boundary

| Step | Needs, before its implementation starts                                                            |
| ---- | -------------------------------------------------------------------------------------------------- |
| R1   | done (#129, merged; on DEV)                                                                        |
| R2   | done: #132 (`main` `5650409`, doc 050), on DEV since 2026-11-07, no R2 write yet                   |
| R1.1 | doc 047 §6 (owner 2026-11-07): step P (pumps X, UI only), then the crate/bottle model — for review |
| R3   | R2 released; this model; D3 (§4). R3-a (fill anchor only) first; placement **with** filling (§8.2) |

**R2 and R3 are separate decisions.** R2 (§2) needs only the approval of its own small model and
can be released alone. Nothing in R3's open questions (D3, the compatible migration §3.3c, the
separate proposal §7) blocks R2. The order of the separate steps is P → R1.1 → R3-a → R3-b/c
(doc 047 §6.4).

**A prerequisite fix of R1, found while checking this (reproduced 2026-11-06 on `e8e71d3`, local
test database) — done in #131 (`crate_assignments_member_placeable`).** The supervised "Doplnit
lahev" (`cycle-corrections.service.ts:127-143`) refused only `CREATED`. It put a `RETURNED`
(unwashed) bottle into an assembling crate of the same product, design and recipe, and the crate
became `READY_TO_FILL`, which the filling never accepts (it takes only `LABELED_EMPTY`): a stuck
crate. A `RETIRED` bottle passes the same checks (only a full crate refused it in the reproduction).
The DB does not check the member's status either (`crate_assignments_insert_check` checks the source
against the cycle status only). Proposed as its own small fix PR before R2: the API and the DB
accept a new member only in `LABELED_EMPTY` (labelling, `REPLACEMENT`) or `FILLED` (`REPACKED`),
unchanged for today's walk; `RETURNED`, `RETIRED`, `DISPOSED` → `BOTTLE_NOT_PLACEABLE`; test with a
returned and a retired bottle.

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
  (R3-b and R3-c, one release), so every crate that can take a washed bottle can also fill it.
  The `REUSE` membership is allowed in the database only in that release. The fill anchor
  (R3-a, §8.2) may come first: it keeps R2's guard that a `READY_FOR_REUSE` bottle is in no
  crate, so the R2 release stays complete on its schema (review 5814000174).
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

Implemented as below in #132 (`main` `5650409`); the release, rollback and DEV acceptance are in
doc 050. The owner's clarification of 2026-11-07 changes only its shown text: "K plnění" instead of
"Připravená k plnění · Po mytí" (the same QR, no data change; doc 047 §6.3, point 7). Codes as
built: `NOT_RETURNED` (any status but `RETURNED`), `DESIGN_WITHDRAWN`,
`NOT_PLACEABLE_YET` (station and "Doplnit lahev"); permission `returns:receive` (no new one).

### 2.1 What it does

- Sklad → "Po mytí": scan a `RETURNED` bottle of the active site → `RETURNED → READY_FOR_REUSE`
  ("Připravená k plnění · Po mytí"), with a new bottle event `REUSE_READY`. The operator scans
  only a bottle that was physically washed and inspected; between the intake scan (`SORTED`, R1)
  and the washing there is no scan (doc 047 §3).
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

## 3. R3 — back into production: placement and refilling

### 3.0 Placing a washed bottle into an ordinary crate (released with §3.1)

At the existing labelling station, crate loaded (the "direct placement" of the approved
workflow, doc 047 §3):

- **The same path as a new bottle** (owner 2026-11-07). The existing station with its context
  (product, label design, crate in `OPEN_ASSEMBLY`) has no switch. The station recognises the
  bottle by its QR:
  - `CREATED`: labelled as today (`LABEL_APPLIED`, consumption of body and label);
  - `READY_FOR_REUSE` ("K plnění", after "Po mytí"): only `ASSIGNED_TO_CRATE` with source
    `REUSE`. Nothing is consumed and there is no `LABEL_APPLIED`; the label is physically there.
  - `RETURNED` (not yet "Po mytí"): refused `NOT_WASHED`, nothing written. Washing is confirmed
    only by the standalone "Po mytí" (§2), never at the station.
- **The combined scan of washing and placement is withdrawn** (it was in the draft of
  2026-11-07). Each scan writes exactly one operation.
- **A refusal writes nothing.** This covers `BINDING_MISMATCH`, `DESIGN_WITHDRAWN`, a full or not
  assembling crate, another site, and a database refusal at commit.
- The bottle is placed only where it physically belongs: product **and label design** equal to
  the cycle's (`crate_assignments_consistent`).
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

### 3.0a The operating view: readiness, crate and location apart (review 5814000174)

The owner confirmed the operating direction on 2026-11-07. Overviews and the bottle detail show
three things apart, each **derived** from existing records. There are no new combined statuses
and nothing is stored for them.

1. **Physical readiness** (the bottle's status):
   - `CREATED` after its label is printed: "Kód čekající na nalepení";
   - `LABELED_EMPTY` and `READY_FOR_REUSE`: the common next step **"K plnění"**. The source
     "Nová" (the circulation began with `LABEL_APPLIED`) or "Po mytí" (with `REUSE_READY`) stays
     visible as history; it decides the consumption of the filling (§3.1).
   - `FILLED`, `RETURNED` ("Vrácená, čeká na mytí"), `RETIRED`, `DISPOSED` as today.
2. **Current crate binding:** the active assignment (crate code and cycle status), or "bez
   bedny". It is independent of the readiness.
3. **Location derived from dispatch:**
   - "—" for `CREATED`: a printed code is not yet a physical bottle, so printed codes never look
     like physical stock;
   - "na provozovně" from the first label application on, while no shipped cycle is open;
   - "u dopravce" (its cycle `DISPATCHED`);
   - "u hotelu": the bottle's **last delivered allocation** (`order_allocation_bottles`, parcel
     delivered) has no `SORTED` of the bottle yet. The source is shown with it: order, hotel and
     delivery time. This stays true after its crate was scanned back and the crate binding
     ended (R1.1, doc 047 §6.3), because it never depends on the crate binding.
   - back "na provozovně" from its own `SORTED`. The return from the hotel is derived from the
     bottle's own scan, never from the crate scan.
   - The delivery history (order, parcel, delivery) is kept and shown as it is.

This is a read-side change of the bottle overview and detail (R3-c; it can also go ahead as its own
read-only PR). The full eligible return and the measurement per hotel and product are a follow-up
proposal outside R3.

### 3.1 Filling a reused bottle

- The existing filling scan, at the same station, with the same crate and liquid lot
  (`apps/api/src/production/filling.service.ts:200-305`). It accepts a member in
  `READY_FOR_REUSE` as well as `LABELED_EMPTY` (`:250`).
- `READY_FOR_REUSE → FILLED`, a new `FILLED` event for **this** cycle, the liquid lot as today.
- **No pump choice and no washed-pump stock** (owner 2026-11-07). The pump put on a reused
  bottle is a washed one from the anonymous pool, which has no stock record. So the filling of a
  bottle whose circulation began with `REUSE_READY` consumes the recipe's FILL BOM **without its
  `PUMP` lines**: the liquid from the chosen lot, nothing for the pump. That is the physical
  truth with no fictitious consumption.
- A **new** bottle is filled exactly as today: the complete FILL BOM, its pump from new stock.
- A new `PUMP` attachment is installed as today.

### 3.2 Pumps: written off at the intake, no washed stock (owner 2026-11-07)

- Pumps are washed and reused anonymously. **There is no washed-pump item, entry or batch
  record**, and R3 needs none.
- Used pumps found unusable are written off at the intake as one count X ("Odepsat pumpičky",
  doc 047 §6.2, the existing `RETURN_PUMP_COUNT`). They are counted apart from new stock, and that
  never writes a ledger movement.
- New pumps leave stock only by the filling of a **new** bottle (`FILL`, as today) and by
  receipts and their corrections. A reused bottle's filling never touches them (§3.1).
- **R3 assumes a really washed pump** on every reused bottle. That is why its filling writes no
  pump movement.
- **Adding new pumps to the reused pool is a separate stock proposal**, not part of R3 and not
  decided (review 5814140177):
  - **Today it cannot be recorded:** the manual stock issue (doc 018 §5a) accepts only
    `CONSUMABLE` items and refuses a `PUMP` with `NOT_CONSUMABLE` (`stock-issues.service.ts:39`).
  - **The proposal:** one quantity action "Nové pumpičky do oběhu: N" (`inventory` permission,
    active site, idempotent per `requestId`). It writes a real ledger write-off of N pieces of the
    **new** pump item: a new movement type with exactly one source row, a reason, and a balance
    that is never negative.
  - It has no link to a bottle, a crate or a filling scan, and there is no choice at any scan.
  - The pool itself still has no stock record. This only records that new pumps left stock
    into it.
  - Its own model PR for the owner.
- Quantities only: no price and no valuation.

### 3.3 Data (for review)

```
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
fill check               ayvo_assert_fill_complete: a FILLED anchored on a REUSE_READY consumes
                         exactly the FILL BOM without its PUMP lines; anchored on a LABEL_APPLIED,
                         the complete FILL BOM (unchanged). The PUMP attachment is installed in both
                         cases
CrateAssignmentSource   += REUSE (R3-b, §8.2)
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
  and circulation, none for the repack; the new pump balance changed once (for the new bottle); both
  bottles reach the next return. Negative: repacking the reused bottle into a cycle of another
  recipe is refused (`SNAPSHOT_MISMATCH`, also by the DB).

- A reused bottle: liquid −1 portion; new pump, body and label 0; a `PUMP` attachment installed.
- A new bottle: the complete FILL BOM, unchanged (new pump −1).
- DB:
  - a reused bottle's `FILLED` with a `PUMP` movement fails;
  - a new bottle's `FILLED` without its `PUMP` movement fails;
  - a second `FILLED` of the same circulation fails.
- Pumps written off at the intake (X): no ledger row and the new pump balance unchanged (doc 047
  §6.2).
- Hotovo, picking, dispatch and delivery of a cycle with reused bottles through the unchanged
  code.

## 4. Decisions needed

**Already decided — not reopened** (owner 2026-11-05, issue #125 comment 6665848743): pumps are
washed and reused, without individual codes; a defective pump is counted, never scanned. A good
bottle is scanned individually at the intake (`SORTED`, R1), then washed and inspected with no
scan in between, and scanned a second time after that (`REUSE_READY`, R2). The bottle keeps its
identity, body and label are not consumed again; a refilling consumes new
material only for what was really replaced. The reuse counter counts `SORTED` (R1).

**Decided 2026-11-07** (owner review 5814083818, doc 047 §6):

- the crate scan frees the crate on its own, and the bottle's own scan confirms its return;
- "Po mytí" keeps the same QR and "K plnění", then the next production goes as for a new bottle;
- pumps are one write-off count X at the intake, with no washed-pump stock and no
  `WASHED`/`NEW` choice. This settles D1.

Still open, with their effect on R3 in §8.4: D2 (what a revoked design means), D3 (new and washed
bottles in one crate).

For the owner (recommendations after review 5806384095):

- **D1 — settled by the owner on 2026-11-07:** no washed-pump stock and no choice at filling. Used
  pumps found unusable are written off as X at the intake (doc 047 §6.2). A reused bottle's
  filling consumes no pump (§3.1).
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

Not the owner's, and not guessed: whether and how written-off or reused pumps are valued for
accounting. That is for the accountant. R3 records pieces only.

## 5. Test matrix: one physical bottle b, first delivery to second return

Crate K; stock columns: N = `NEW_BOTTLE`, P = new pump, X = used pumps written off at the intake
(`return_pump_counts`, never stock). "—" = no change. The intake follows R1.1 (doc 047 §6.3).

Operating view of b (§3.0a):

- before step 1: "Kód čekající na nalepení", location "—";
- steps 1–2: "K plnění · Nová", then the filling;
- step 3: "u dopravce", then "u hotelu";
- step 4: still "u hotelu" (the crate scan says nothing about b);
- step 5: back "na provozovně" (from b's own `SORTED`);
- step 8: "K plnění · Po mytí", "bez bedny";
- step 8b: the same, crate K2.

| #   | Step                                                               | b afterwards                               | Cycle                | Reuse | N   | P   | X   |
| --- | ------------------------------------------------------------------ | ------------------------------------------ | -------------------- | ----- | --- | --- | --- |
| 1   | Labelled into K (existing walk)                                    | `LABELED_EMPTY`, binding                   | K1 `OPEN_ASSEMBLY`   | 0     | −1  | —   | —   |
| 2   | Filled, Hotovo                                                     | `FILLED`, pump attached                    | K1 `FILLED`          | 0     | —   | −1  | —   |
| 3   | Picked into O1, dispatched, delivered (existing walk)              | unchanged, no event                        | K1 `DELIVERED`       | 0     | —   | —   | —   |
| 4   | R1.1: crate scan of K (frees K; b's membership `CRATE_RETURNED`)   | still `FILLED`, no event, "bez bedny"      | K1 `CLOSED`          | 0     | —   | —   | —   |
| 5   | R1.1: b scanned good in the receipt (no crate chosen)              | `RETURNED`, `SORTED` (K1)                  | —                    | 1     | —   | —   | —   |
| 6   | The same b scanned again; and in another receipt                   | first result; `ALREADY_RECEIVED_ELSEWHERE` | —                    | 1     | —   | —   | —   |
| 7   | "Odepsat pumpičky" X = 3 at the intake; washing (no scan)          | —                                          | —                    | 1     | —   | —   | +3  |
| 8   | R2 "Po mytí" (the same QR → "K plnění")                            | `READY_FOR_REUSE`, pump closed             | —                    | 1     | —   | —   | —   |
| 8b  | R3-b: scanned at the station like a new bottle, into K (new cycle) | `REUSE` member, nothing consumed           | K2 `OPEN_ASSEMBLY`   | 1     | —   | —   | —   |
| 9   | R3: filled (FILL BOM without the pump), Hotovo                     | `FILLED` (K2), pump attached               | K2 `FILLED`          | 1     | —   | —   | —   |
| 10  | Picked into O2, dispatched, delivered                              | unchanged                                  | K2 `DELIVERED`       | 1     | —   | —   | —   |
| 11  | Second return: crate scan of K, then b scanned                     | `RETURNED`, `SORTED` (K2)                  | K2 `CLOSED`          | 2     | —   | —   | —   |
| 12  | Throughout: O1 shows its contents, parcel and delivery, never K2's | —                                          | K1 history unchanged | —     | —   | —   | —   |

Variants of the same walk:

- **b scanned before its crate:** step 5 before 4. `SORTED` releases b's still active
  membership, and the crate scan then releases only the rest.
- **An empty return:** step 4 without step 5. K is free, b stays `FILLED`, "u hotelu", with
  reuse 0.
- **A mixed return:** a bottle of crate L, whose crate never came back, is identified for L1.
- **b `RETURNED` at the station** (before "Po mytí"): `NOT_WASHED`, nothing written. **On the
  R3-a schema only:** any membership of a `READY_FOR_REUSE` b is refused at commit, as in R2.
- **b defective at step 5:** `RETIRED`, reuse 1, never steps 8–11.
- **After step 9, K2 taken apart** and b repacked into crate M (`REPACKED`), Hotovo, O2 from M:
  no second `FILLED`, no movement (§3.3a). A second `FILLED` of b in M is refused by the DB
  (§3.3b).

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

## 8. R3 — concrete delivery plan (2026-11-07, on `main` `5650409`; for the owner's decision)

Nothing of R3 is implemented; no step below is covered by an approval yet (the R3 model has the
technical APPROVE 5806877670 on `3499c83`; the owner's approval and D3 are open, D1 is settled).
The plan
names what each step needs.

### 8.1 What `main` has today (verified)

- Placement: `crate_assignments_member_placeable` (#131) admits only `LABELED_EMPTY`/`FILLED`
  members; R2's `bottles_labeled_has_event` requires a `READY_FOR_REUSE` bottle to be in no
  crate; the station and "Doplnit lahev" answer `NOT_PLACEABLE_YET`. Sources are `LABELING`,
  `REPACKED`, `REPLACEMENT` (no `REUSE`).
- Filling: only `LABELED_EMPTY` (`filling.service.ts:250`); one `FILLED` per bottle
  (`bottle_events_one_filled_per_bottle`, `20261016090100`); `ayvo_assert_fill_complete` requires
  the complete FILL BOM of the cycle's recipe, pump line included, and a new `PUMP` attachment.
- **To be fixed with R3 (found 2026-11-07):** `BottlesService.filledLot` reads the bottle's
  `FILLED` event with `findFirst` and no order. With one `FILLED` per bottle that is exact today.
  After a second filling its one caller, the filling's duplicate scan (`ALREADY_FILLED`,
  `filling.service.ts:239`), may show the first circulation's liquid lot. R3-b reads the
  `FILLED` of the bottle's current circulation (`bottle_fill_circulations`) and tests a
  duplicate scan after the second filling.
- The second return already works: R1's identification accepts a bottle that is in circulation
  again after its last `SORTED` (`return-receipts.service.ts:779`), `SORTED` is unique per
  (bottle, cycle), and the reuse counter is the number of `SORTED`.

### 8.2 The smallest safe order (each its own PR; release of 2–3 together)

1. **R3-a — the fill anchor only (DB; D3-independent; deployable alone).**
   - One migration, in one transaction, first takes
     `LOCK TABLE bottle_events IN SHARE ROW EXCLUSIVE MODE`, so that no `FILLED` is written
     during it (the APPROVE condition "atomic backfill and switch"):
     - `bottle_fill_circulations` (§3.3b): insert-only, its own trigger refusing UPDATE, DELETE and
       a row whose events are of another bottle or of the wrong type;
     - backfill by INSERT (each `FILLED` → its bottle's `LABEL_APPLIED`), and the FILLED insert
       trigger deriving the anchor;
     - then drop `bottle_events_one_filled_per_bottle`.
   - **No placement change** (review 5814000174). `CrateAssignmentSource` stays without `REUSE`,
     `crate_assignments_member_placeable` (#131) is unchanged, and R2's "a `READY_FOR_REUSE`
     bottle is in no crate" is unchanged. The R2 release is therefore complete on this schema: a
     washed bottle can reach no crate, so none can be stuck unfillable.
   - Tests:
     - DB tests that commit, as `ayvo_core`: the §3.4 circulation cases;
     - **negative:** a complete, otherwise consistent membership (`LABELING`, `REPACKED`,
       `REPLACEMENT`) of a `READY_FOR_REUSE` bottle on the R3-a schema fails at commit;
     - the doc 049/050 compatibility runs: the R2 release's API tests on the R3-a schema;
     - a `FILLED` of the R2 API written while the migration runs: it waits for the lock and
       then gets its anchor.
2. **R3-b — the `REUSE` membership with the filling (DB + API; needs D3).**
   - **Migrations:** the enum value first, in its own migration (`CrateAssignmentSource +=
REUSE`). Then the rules:
     - a `READY_FOR_REUSE` member is allowed only with source `REUSE` into `OPEN_ASSEMBLY`;
     - R2's "in no crate" becomes "in no crate, or in exactly its `REUSE` assignment made after
       its `REUSE_READY`";
     - the fill check of §3.3: the FILL BOM without its `PUMP` lines for a reused circulation,
       complete for a new one;
     - every other rule is unchanged.
   - **DB tests that commit:**
     - positive: the `REUSE` membership, and a reused filling without a pump movement;
     - negative: `REUSE` of a `RETURNED` or `LABELED_EMPTY` bottle, a pump movement on a reused
       filling, a missing one on a new filling.
   - **The station (§3.0):** a `READY_FOR_REUSE` bottle takes the same path as a new one, with no
     switch and only the assignment. `RETURNED` gives `NOT_WASHED`. The station's
     `NOT_PLACEABLE_YET` becomes this placement; "Doplnit lahev" keeps refusing.
   - **The filling (§3.1):** `READY_FOR_REUSE` is accepted with no pump choice and no pump
     movement. `filledLot` reads the current circulation's `FILLED` (§8.1).
3. **R3-c — UI.** No new control at the station or the filling, which recognise the bottle from its
   QR. The station shows "Po mytí" as the source of a placed bottle, and the operating view
   (§3.0a) applies. Tested at 390 px and 1440 px.

R3-b and R3-c are released together: a crate that can take a washed bottle can also fill it
(§1). D3 is decided apart from this order (§8.4); D1 is settled.

Rollback:

- R3-a: before its first `FILLED` anchored to a `REUSE_READY`, which only R3-b can write, the R2
  release runs on it. Its own rows (anchors of new bottles) are read by nobody else.
- R3-b/c: fix forward only after the first write of the §3.3c list.

### 8.3 The test of a second circulation (API e2e, existing fixtures)

`crateFactory(t, { capacity: 2 })`, `shipCrates`, `deliver` (FAKE carrier, `RETURN_ENV`),
`returnsApi`, the R2 scan `POST /api/admin/returns/after-wash`, `factory.openStation()`, and
the filling fixtures (`fillingSession`, `fillLoadCrate`, `chooseLiquidLot`, `fillScan`,
`finishCrate`).

1. **First circulation.**
   - Crates K (b1, b2), L (b3, b4) and M (b7, b8) of design V are made and Hotovo, shipped in O1
     and delivered.
   - Crate J (b5, b6) carries another approved design V′ (`factory.refill()`). It goes in its own
     order O1′, because an order line pins one design (§4 D3), and is delivered too.
2. **The intake (R1.1, doc 047 §6.3): mixed return, double scans.**
   - Receipt R: crate scans of K, J and M free them. L's crate never comes back.
   - Bottle scans in R, with no crate chosen: b1 GOOD; b3 GOOD (from L — the mixed case, for
     L1); b2 DEFECTIVE; b5, b7, b8 GOOD.
   - b1 scanned again: `repeated`, still one `SORTED`.
   - "Odepsat pumpičky" X = 2: one `return_pump_counts` row, no ledger row.
   - b4 is never scanned and stays "u hotelu".
3. **After washing.** "Po mytí" b1, b3, b5 and b7, then b1 again (`repeated`, one
   `REUSE_READY`). b8 stays `RETURNED`.
4. **Placement (R3-b).**
   - The station opens P and design V with crate K: K2, a new cycle (K1 is `CLOSED`).
   - b1 ("K plnění") is scanned like a new bottle: the assignment only. K2 has 1 of 2 places
     taken.
   - **Refusals while K2 still has a free place**, so a refusal is never mistaken for a full
     crate:
     - b5 ("K plnění", design V′): `BINDING_MISMATCH`;
     - b8 (`RETURNED`, not "Po mytí"): `NOT_WASHED`.
   - b3 ("K plnění") is scanned the same way, and K2 becomes `READY_TO_FILL`.
   - b1 scanned again at that station: the existing `ALREADY_APPLIED`.
   - b2 (`RETIRED`): refused.
   - **The full crate, separately:** at K2 (`READY_TO_FILL`, 2 of 2), b7 ("K plnění") gets the
     existing full-crate refusal.
   - **Zero writes for every refusal in this step,** checked against a snapshot taken before each
     scan:
     - b5 and b7 stay `READY_FOR_REUSE` in no crate;
     - b8 stays `RETURNED` with the pump attached;
     - no event, assignment, crate counter, attachment or stock movement is added.
5. **Filling.**
   - b1 and b3 are filled (liquid only, no pump movement, a `PUMP` attachment installed), then
     Hotovo.
   - A second `fillScan` of b1: `ALREADY_FILLED` with circulation 2's liquid lot (§8.1).
   - Two concurrent fills of b3 from two requests: one `FILLED`.
6. **Second circulation.** K2 is shipped in O2 and delivered. Receipt R′: crate scan of K
   (frees K2), then b1 GOOD (`SORTED` for K2, not K1).
7. **Asserted throughout:**
   - **Identity:** b1's code and `public_token` (the same QR URL) never change. Its events, in
     order:
     - `CREATED`, `LABEL_APPLIED`, `ASSIGNED_TO_CRATE`, `FILLED`, `SORTED`;
     - `REUSE_READY`, `ASSIGNED_TO_CRATE` (source `REUSE`), `FILLED`, `SORTED`;
     - exactly one `LABEL_APPLIED`.
   - **Anchors:** `bottle_fill_circulations` holds two rows for b1, anchored on its
     `LABEL_APPLIED` and on its `REUSE_READY`.
   - **Stock in circulation 2:** `NEW_BOTTLE`, label and new pump unchanged, liquid −1 portion
     per bottle, and no movement for any repeat or refusal.
   - **Reuse counter:** b1 = 2 (detail and passport).
   - **Order history:** O1 still lists b1, b2, b3, b4, b7, b8 and its parcels and delivery, and the
     crate scans never changed it; O2 lists b1 and b3.
   - **Operating view (§3.0a)** of b1 at each step as in the §5 note: readiness, crate and
     location apart, the location "u hotelu" until b1's own `SORTED`, also after K's crate scan.
8. **On the R3-a schema alone** (before R3-b): the same walk up to step 3, then a direct
   membership of the `READY_FOR_REUSE` b1 by SQL, committed as `ayvo_core`, fails. The R2 API
   tests pass unchanged.

### 8.4 Open decisions and their effect

- **D1:** settled by the owner on 2026-11-07. There is no washed-pump stock and no choice; a
  reused filling consumes no pump (§3.1, §3.2). R3 needs nothing more from it.
- **D3** (open):
  - "allowed" (recommended) is §3.0 as written, with a new and a "Po mytí" bottle in one crate;
  - "not allowed" adds one rule to the placement: a cycle takes `REUSE` members only when it
    has no `LABELING` member, and the reverse;
  - it changes R3-b only.
- **D2** (open):
  - no effect on R3: a set-aside bottle never becomes `READY_FOR_REUSE`, so it never reaches
    placement or filling;
  - (a) or (b) is its own small change on the "Po mytí" side.

### 8.5 Operational acceptance without a carrier and without DEV writes

- **Available today, no new infrastructure:**
  - the Playwright walk on the isolated `ayvo_e2e` database, with SIMULATED carrier events (PPL
    code 450) written only into that database (`workflow-returns.spec.ts` already does it for R1
    and R2);
  - screenshots at 390 px and 1440 px for the owner to look at (as the R1 visual proof of
    2026-11-07);
  - for R3, the same spec gets the §8.3 walk: placement, filling, Hotovo, picking, a second
    delivery and a second return. No carrier is called and DEV is not written.
- **A real DEV acceptance** still needs a delivered crate on DEV. That needs the owner's choice of
  the R1 acceptance path (a live test carrier, or a documented manual delivery decision); R3 adds
  nothing to that choice. Until then DEV checks stay read-only: the pages render and the counts
  are 0 (as the R2 release on 2026-11-07).
