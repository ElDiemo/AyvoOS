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

Follow-up migration `20261119090500_returns_r1_issue_freed_crate` (§4.1): `bottle_events_return_rules`
replaced once more, only its R1-line branch widened. No table, row, index or trigger changes.

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

| Situation at the deploy                                                   | Under R1.1                                                                                                                        |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Closed R1 receipts, emptied lines, `COUNT_MISMATCH`, R1 `SORTED`          | Unchanged and readable; every new rule accepts them                                                                               |
| R1 `CLOSED` cycle with still active members                               | Kept active; a later bottle scan identifies them (latest assignment, delivered before receipt)                                    |
| Open R1 receipt with a not emptied `CRATE` (RETURNED) or `CONTAINER` line | That line keeps Vyprázdněno with its count; new scans go to the receipt's `BOTTLES` line                                          |
| Open R1 `NOT_DELIVERED` issue (no anchor) on an R1 line                   | Resolved under R1's rule (the line's `scanned_at`), never anchored afterwards — also after a later receipt freed its crate (§4.1) |

### 4.1 An R1 `NOT_DELIVERED` after a later receipt freed its crate

Found in the isolated trial (2026-11-19): an old receipt holds an unanchored `NOT_DELIVERED` of F1
on its container line (F was only picked up then); F is delivered, and a new receipt scans crate F
— F's cycle is `CLOSED`, F1's membership released `CRATE_RETURNED`. Before this follow-up F1 was
stuck: the new receipt refused it (`OPEN_ISSUE`), "Dořešit" on the old line answered
`NOT_IN_CIRCULATION` (R1's rule wanted a still active member), and only a close-out was left.

Expected behaviour (migration `20261119090500_returns_r1_issue_freed_crate`, a replaced
`bottle_events_return_rules` only):

1. **The new receipt** still refuses F1 with `OPEN_ISSUE` and names the old issue
   (`details.issue`); it writes nothing. The issue stays with the receipt where it was recorded.
2. **"Dořešit" of that issue** identifies F1 in exactly the circulation the issue was recorded
   in: the bottle's latest membership, made before the old line was opened, active when the issue
   was recorded and freed with its crate only after it — delivered in that cycle's allocation. The
   `SORTED` is on the old line, names F's cycle, resolves the issue; the membership keeps its
   `CRATE_RETURNED` release (no second release). The old container counts the piece once; it is
   emptied with its count and closed as before.
3. **Afterwards** the new receipt answers `ALREADY_RECEIVED_ELSEWHERE` with the old receipt; a
   replay or a rescan of "Dořešit" repeats the first result; another outcome is `ISSUE_RESOLVED`.
4. **Once per circulation:** "Dořešit" racing the new receipt's bottle scan, a second "Dořešit"
   or the crate scan itself (both orders) gives one `SORTED` — the same locks crate → cycle →
   bottle → issue, and the unique index `bottle_events_one_sorted_per_cycle` in the database.
5. **Everything else keeps R1's answer** (`NOT_IN_CIRCULATION`, nothing written): an issue
   recorded only after the crate was freed, any other kind (`NOT_IN_CIRCULATION`, `UNREADABLE`),
   another release than `CRATE_RETURNED`, or a later membership of the bottle. The database
   refuses the same by direct SQL.

The operating rule of the trial ("resolve a crate's old open issues before scanning that crate in
a new receipt") is no longer needed; the order no longer matters. Rollback (§5) is unchanged: the
migration only widens what an R1 line accepts, and the previous images never write such a
`SORTED`.

## 5. Rollback

- **Before the first R1.1 write** (a `BOTTLES` line, a `CRATE_RETURNED` release, or a `CRATE` line
  emptied without a count): the previous images run on the R1.1 schema — the new columns are
  nullable, the old code never writes them, and every replaced guard accepts what the old code
  writes. `deploy-dev.sh --rollback <previous tag>`, no migration.
- **After it:** fix forward only (as doc 049 §3): the old release cannot read `BOTTLES` (Prisma
  enum, `P2023`), and its guard would refuse a `CRATE_RETURNED` release it did not write. Never
  delete or rewrite R1.1 rows to make an old image work.
- The release note records the time of the first R1.1 write.

Verified on throwaway worktrees of `main` `09e82e7` (the release before R3 and R1.1), with all
five migrations of R3-a, R3-b and R1.1 applied (evidence harness outside the repository, listed
in the review package):

- **2026-11-18:** `test/rollback-compat.e2e.test.ts` with `AYVO_NEWER_API_DIR` = this branch —
  **17 passed**, 1 not applicable: its precondition "the newer database holds permissions this
  version does not know" is false by design (R1.1 adds no permission), as in doc 050 §3.
- **2026-11-19, the old release's own walk** (doc 049 §2), the migrations applied before each
  file: labelling, filling, orders, tracking, shipments, crates, dispatch printing, database
  invariants, returns, returns access, Po mytí, cycle member status, portal deliveries — **19 files,
  171 of 172 passed**. The one difference is by design of R3-b: R2's guard test expects
  `READY_FOR_REUSE → FILLED` by SQL alone to be refused as "not allowed"; R3 allows that step only
  with its FILLED event, so the same write is refused as "a filled bottle needs its FILLED event".
  The first run found two real gaps, fixed before this result: the database refused the old image's
  new `CONTAINER` line and its unanchored `NOT_DELIVERED` (both answered 500) — §6 2 and §6 4.
- **2026-11-19, real R1 data across the migrations:** the old release wrote, on its own schema,
  two closed R1 receipts (one with `COUNT_MISMATCH`, its unscanned bottle still an active member of
  the `CLOSED` cycle), an open receipt (a `RETURNED` crate line not emptied, an unreadable piece, a
  container with a bottle of a never scanned crate and an unanchored `NOT_DELIVERED` of a crate
  only picked up) and an open receipt with a container and an unreadable piece at **another site**.
  Preflight (§3) on it: 2 open receipts, 1 `RETURNED` cycle, 2 active members of returned/closed
  cycles, 1 open `NOT_DELIVERED`, 4 open issues, 2 sites. Two copies, both migrated:
  - **the old release continues** (rollback before the first R1.1 write) — 4/4: every receipt
    read with its own contracts; the open receipt finished (its bottle on its line, the late
    `NOT_DELIVERED` identified, Vyprázdněno with counts, closed); a new crate line and a new
    container line; the other site's receipt 404 at MAIN, written off, emptied and closed there.
  - **R1.1 takes over** — 5/5: every old receipt read with the new contracts, nothing rewritten
    (no `BOTTLES` line, no crate freed, counts and reuse counters as recorded); the open receipt
    continues (a new bottle scan on its `BOTTLES` line, the old `NOT_DELIVERED` resolved under R1's
    rule on its own line after the late delivery, the R1 lines emptied with counts, closed); the
    bottle still active in an R1 `CLOSED` cycle received on its own; the never scanned crate
    freed now, its last bottle traceable at the hotel and received weeks later, never twice; the
    other site's old receipt continued there, a MAIN bottle there only an `OTHER_SITE` piece.
  - **after the first R1.1 write** the old release fails reading the receipts (500) — as stated
    above: fix forward only.

## 6. Deviations from doc 047 §6.3 (for the review)

1. **`released_by_line_id` has a plain FK to the line, not the composite FK
   `(released_by_line_id, cycle_id)`.** Prisma cannot express an optional relation whose second
   column (`cycle_id`) is required, and the schema-drift test compares the database with
   `schema.prisma`. The same-cycle rule is enforced by `crate_assignments_guard` (the line's
   `returned_cycle_id` = the assignment's cycle) and re-checked at commit by
   `ayvo_assert_crate_cycle`; a line's `returned_cycle_id` never changes (line guard), so the
   result is the same.
2. **No new `CONTAINER` line from R1.1** (no route), as doc 047 §6.3 5 says "R1.1 makes no new
   ones". The database still accepts one: the previous image writes it after a rollback before the
   first R1.1 write (§5), and it stays an R1 line (Vyprázdněno with its count). An earlier draft
   refused it in the line guard; the rollback check found the previous image's "Krabice bez kódu"
   answering 500 on the R1.1 schema (review fix, 2026-11-19).
3. **"Bottle at the hotel" is enforced** (§2 read side, `BOTTLE_AT_HOTEL`): not spelled out in
   §6.3, but without it a bottle freed with its crate would look like a loose finished bottle and
   could be repacked without ever being returned.
4. **A `NOT_DELIVERED` without an anchor is still accepted on an R1 line** (`CRATE` or
   `CONTAINER`): the previous image writes it so after a rollback before the first R1.1 write; it
   is resolved under R1's rule on its own line. On the `BOTTLES` line it is always anchored (review
   fix, 2026-11-19).

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
