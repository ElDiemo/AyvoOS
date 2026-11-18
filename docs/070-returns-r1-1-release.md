# 070 — Return intake R1.1: the crate scan frees the crate, the bottle scan stands on its own

Status: **draft for review with its PR** (stacked on R3-b, #154). It implements doc 047 §6.3 as
written on `f2d2656` (PR #126). The owner asked for the implementation on 2026-11-18. Like doc 049
for R1 and doc 050 for R2, it changes no deployment script.

**Documentation continuity.** Doc 047 (#126) and doc 048 (#128) are still drafts, not on `main`.
This document cites them by commit and does not restate or change them. Deviations from the text
are listed in §6.

## 1. What changes for the operator

| Before (R1)                                                            | R1.1                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Crate scan → `RETURNED`; the crate waits for "Vyprázdněno" + count     | Crate scan → the crate is **freed at once** (`CLOSED`), no count, usable immediately   |
| Unscanned bottles stay active members of the crate                     | The scan ends every remaining member's binding (`CRATE_RETURNED`); **no bottle event** |
| A bottle scan needs a line (a crate or "Krabice bez kódu")             | A bottle scan needs **no crate**: the receipt's one `BOTTLES` line                     |
| `SORTED` from the bottle's **active** assignment, made before the line | `SORTED` of the bottle's **latest** circulation, delivered before the receipt opened   |
| The receipt closes after every container was emptied                   | The receipt closes at once (only an older R1 line still waits for its Vyprázdněno)     |

The reuse counter is unchanged: one `SORTED` per (bottle, cycle), so each really returned bottle
counts exactly once per circulation; the crate scan never counts.

## 2. What R1.1 writes

Two migrations: `20261119090300_returns_r1_1_enum_values` (`ReturnLineKind += BOTTLES`) and
`20261119090400_returns_r1_1`:

- **Columns:** `crate_assignments.released_by_line_id` (→ the CRATE line), `return_receipt_issues.
anchor_cycle_id` + `anchor_allocation_id` (a composite FK to `order_crate_allocations (id,
cycle_id)`, new unique key). No existing row is rewritten.
- **Checks:** `CRATE_RETURNED` ⇔ its line, never with a bottle event; the anchor both or neither,
  only on `NOT_DELIVERED`; lines by kind (a count only with the emptying, required on an R1
  `CONTAINER`, never on `BOTTLES`); one `BOTTLES` line per receipt.
- **Guards (functions replaced):** `return_receipts_guard`, `return_receipt_lines_guard`,
  `return_receipt_lines_consistent`, `return_receipt_issues_guard`, `bottle_events_return_rules`,
  `bottle_events_sorted_complete`, `bottles_labeled_has_event`, `crate_assignments_guard`,
  `crate_assignments_member_placeable`, `ayvo_assert_crate_cycle`. Each keeps its R1/R2/R3
  behaviour for old rows (§4).
- **API:** `POST …/receipts/:code/bottles` and `…/unreadable` (no line); the crate scan answers
  `freed`; the detail has `counts` and `freedWithCrate`. Removed: `…/containers`,
  `…/lines/:lineId/bottles`, `…/lines/:lineId/unreadable`. `…/lines/:lineId/empty` stays for R1
  lines only.
- **Read side:** "Lahve mimo bednu → Hotové" no longer lists a bottle that is at the hotel by the
  records (freed with its crate, not scanned back); "Doplnit lahev" refuses it (`BOTTLE_AT_HOTEL`,
  also refused by the database).

New refusals (nothing written): `CRATE_DELIVERED_AFTER_RECEIPT`, `DELIVERED_AFTER_RECEIPT`,
`CIRCULATION_CHANGED`, `LINE_NOT_EMPTIABLE`, `BOTTLE_AT_HOTEL`.

## 3. Preflight before the deploy (read only, as doc 049 §4)

```sql
SELECT (SELECT count(*) FROM return_receipts WHERE closed_at IS NULL)                     AS open_receipts,
       (SELECT count(*) FROM crate_cycles WHERE status::text = 'RETURNED')                 AS returned_cycles,
       (SELECT count(*) FROM crate_assignments a JOIN crate_cycles c ON c.id = a.cycle_id
         WHERE a.released_at IS NULL AND c.status::text IN ('RETURNED','CLOSED'))          AS active_members_of_returned,
       (SELECT count(*) FROM return_receipt_issues
         WHERE kind::text = 'NOT_DELIVERED' AND resolved_at IS NULL)                       AS open_not_delivered;
```

**DEV, read 2026-11-18 (api `4fcddf1`):** 1 open receipt **without any line**; 0 `RETURNED` cycles; 0
active members of returned/closed cycles; 0 open issues; 0 `SORTED`; 0 `REUSE_READY`; no R3
migration yet. The open receipt simply gets its `BOTTLES` line with its first scan. Any other value
on another environment goes to the owner before the deploy.

## 4. Old data (doc 047 §6.3 6)

| Situation at the deploy                                                   | Under R1.1                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Closed R1 receipts, emptied lines, `COUNT_MISMATCH`, R1 `SORTED`          | Unchanged and readable; every new rule accepts them                                            |
| R1 `CLOSED` cycle with still active members                               | Kept active; a later bottle scan identifies them (latest assignment, delivered before receipt) |
| Open R1 receipt with a not emptied `CRATE` (RETURNED) or `CONTAINER` line | That line keeps Vyprázdněno with its count; new scans go to the receipt's `BOTTLES` line       |
| Open R1 `NOT_DELIVERED` issue (no anchor) on an R1 line                   | Resolved under R1's rule (the line's `scanned_at`), never anchored afterwards                  |

## 5. Rollback

- **Before the first R1.1 write** (a `BOTTLES` line, a `CRATE_RETURNED` release, or a `CRATE` line
  emptied without a count): the previous images run on the R1.1 schema — the new columns are
  nullable, the old code never writes them, and every replaced guard accepts what the old code
  writes. `deploy-dev.sh --rollback <previous tag>`, no migration.
- **After it:** fix forward only (as doc 049 §3): the old release cannot read `BOTTLES` (Prisma
  enum, `P2023`), and its guard would refuse a `CRATE_RETURNED` release it did not write. Never
  delete or rewrite R1.1 rows to make an old image work.
- The release note records the time of the first R1.1 write.

Not yet verified for this PR: the old release's own API tests on the R1.1 schema (doc 049 §2
style). To do before the DEV deploy.

## 6. Deviations from doc 047 §6.3 (for the review)

1. **`released_by_line_id` has a plain FK to the line, not the composite FK
   `(released_by_line_id, cycle_id)`.** Prisma cannot express an optional relation whose second
   column (`cycle_id`) is required, and the schema-drift test compares the database with
   `schema.prisma`. The same-cycle rule is enforced by `crate_assignments_guard` (the line's
   `returned_cycle_id` = the assignment's cycle) and re-checked at commit by
   `ayvo_assert_crate_cycle`; a line's `returned_cycle_id` never changes (line guard), so the
   result is the same.
2. **No new `CONTAINER` line** in R1.1 (refused by the database), as doc 047 §6.3 5 says "R1.1
   makes no new ones".
3. **"Bottle at the hotel" is enforced** (§2 read side, `BOTTLE_AT_HOTEL`): not spelled out in
   §6.3, but without it a bottle freed with its crate would look like a loose finished bottle and
   could be repacked without ever being returned.

## 7. Tests (API e2e on a real database, guards committed as `ayvo_core`; Playwright isolated)

- `returns.e2e.test.ts` (R1.1, rewritten): the crate scan frees the crate and confirms nothing;
  **10 shipped / 8 returned** (3 before the crate, 5 after, 1 defective; 2 stay at the hotel; the
  9th weeks later after the crate's reuse); bottle before its crate, a never-scanned crate (mixed),
  another receipt after the crate's reuse; late scans (`…_AFTER_RECEIPT`, also with a new
  requestId); `NOT_DELIVERED` anchored and resolved after the late delivery and the close;
  `CIRCULATION_CHANGED`; duplicates and replays; concurrency (one crate in two receipts; crate +
  its bottle at once, both orders; one bottle in two receipts; first scans of one receipt; a crate
  scan racing a station load); database guards by direct SQL.
- `reuse-second-circulation.e2e.test.ts`: **the same crate K and the same bottle through two
  circulations — reuse 0 → 1 → 2**, placing and filling the ordinary way (liquid consumed per real
  filling, no new pump); **stock availability**: two refills at once with liquid for one bottle —
  one filled, the other `LOT_EXHAUSTED`, the balance never negative.
- R2 (`after-wash*`), R3 (`reuse-*`), #131 (`cycle-member-status`), `returns-access` (real sign-in,
  site isolation) and the migrations/drift test pass on the new schema.
- Playwright `workflow-returns.spec.ts` (390 and 1440 px, screenshots `intake-r11-*.png`) and
  `workstation-reuse.spec.ts` on an isolated database.

The FAKE test carrier only; synthetic data only; no live carrier call.
