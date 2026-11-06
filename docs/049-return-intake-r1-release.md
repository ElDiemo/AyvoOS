# 049 — Return intake R1: rolling back the release, before and after the first R1 write

Status: **for review with PR #129** (review 5805515412). It applies to DEV first and to every
later environment. It changes no deployment script; it is the decision point for the person who
runs `scripts/deploy-dev.sh --rollback` (or the PROD equivalent, doc 036 §7).

The R1 migrations (`20261109090000_return_receipts_enum_values`, `20261109090100_return_receipts`)
are never rolled back: a rollback starts the **previous images** on the **R1 schema** (doc 013).

## 1. Is there R1 data yet?

Read-only, as the privileged migration role:

```sql
SELECT (SELECT count(*) FROM return_receipts)                                        AS receipts,
       (SELECT count(*) FROM bottles WHERE status::text IN ('RETURNED','RETIRED','DISPOSED')) AS bottles,
       (SELECT count(*) FROM crate_cycles WHERE status::text IN ('RETURNED','CLOSED'))   AS cycles,
       (SELECT count(*) FROM order_crate_allocations WHERE completed_at IS NOT NULL)    AS allocations,
       (SELECT count(*) FROM bottle_events WHERE type::text IN ('SORTED','RETIRED','DISPOSED','CORRECTION')) AS events;
```

All five are 0 → §2. Any of them is not 0 → §3. The first write of R1 is the opening of a receipt
(`return_receipts`), so "receipts = 0" is the earliest signal.

## 2. Before the first R1 write: the previous images are safe

The previous release (`bcdd926`) runs unchanged on the R1 schema. Verified 2026-11-06 on a
throwaway worktree of `bcdd926` against a database migrated with the R1 migrations:

- `test/rollback-compat.e2e.test.ts` (`AYVO_NEWER_API_DIR` = R1): **18 passed** — sign-in,
  administration, inventory, catalogue, carriers, hotels, Finance read models with the old
  contracts.
- The old API tests of the whole production and dispatch walk, with the R1 migrations applied
  before each file (labelling, filling, orders, tracking to `DELIVERED`, shipments, crates,
  database invariants): **7 files, 97 passed**. The changed triggers (`ayvo_assert_crate_cycle`,
  `crate_cycles_guard`, `crate_assignments_guard`, the allocation guard and indexes, the bottle
  status checks) accept everything the old release writes.

So: `deploy-dev.sh --rollback <previous tag>`, no migration, nothing to clean up.

## 3. After the first R1 write: no rollback to a release before R1

Verified 2026-11-06: the previous release's own code on real R1 data (the e2e database after
`workflow-returns.spec.ts`: 3 receipts, 2 `RETURNED` and 2 `RETIRED` bottles, a `CLOSED` cycle):

- its `openCycle()` query (`status: { not: 'ABORTED' }`) on a crate with a `CLOSED` cycle fails:
  `P2023 Value 'CLOSED' not found in enum 'CrateCycleStatus'` — labelling, filling, picking and
  corrections of that crate break;
- reading a returned bottle fails the same way (`P2023`), so bottle lists and details break;
- its contracts reject `RETURNED`, `RETIRED` (bottle) and `RETURNED`, `CLOSED` (cycle), so its web
  pages of crates and bottles fail even where the API answered.

Decision point, for the owner, before any rollback in this state:

1. **Fix forward (default).** Keep the R1 images running and deploy a corrected R1 build. The
   intake can stay unused meanwhile; nothing else depends on it.
2. **Never delete or rewrite R1 rows to make an old image work.** Receipts, lines, issues,
   `SORTED`, completed allocations and the bottle statuses are the history of received returns
   (ADR 0006); the database refuses those changes anyway. A received return is never lost.
3. A rollback to an older image is possible only to a release that already contains R1 (its
   migrations and contracts), i.e. a later R1 build.

## 4. Release checks on DEV (after the owner approves the deploy)

- Before the deploy: §1 must be all 0 (no R1 data can exist without the R1 code).
- Right after the deploy, before the first receipt: the previous tag remains the rollback target.
- From the first receipt on, the rollback target is the R1 release; record that in the release
  note of the deployment.
