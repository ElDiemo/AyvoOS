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

## 4. DEV preflight (read-only; Codex, after the owner approves the DEV deploy of #129)

Nothing below writes. `psql` runs inside the DEV database container with that container's own
user and database (no password is typed or printed). Stop at the first unexpected answer.

```bash
# 1. The running release = the rollback target before any R1 data.
docker inspect ayvo-dev-preview-api-1 --format '{{.Config.Image}}'
grep -E ' (SUCCESS|OK) ' /opt/ayvo/logs/deployments-dev-preview.log | tail -n 1

# 2. The database has no R1 migration yet (expected: the last one is 20261108090300_*).
docker exec ayvo-dev-preview-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1"'
docker exec ayvo-dev-preview-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "SELECT to_regclass('"'"'public.return_receipts'"'"') IS NULL"'          # expected: t

# 3. The configuration and images are valid; nothing changes.
scripts/deploy-dev.sh --check
```

Then the ordinary deploy (`scripts/deploy-dev.sh`), which dumps the database before it migrates
(`/opt/ayvo/backups/dev-preview/ayvo-dev-preview-<time>-<tag>.dump`). Right after it:

```bash
# 4. Both R1 migrations are applied and there is still no R1 data (expected: 2, then 0|0|0|0|0).
docker exec ayvo-dev-preview-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "SELECT count(*) FROM _prisma_migrations WHERE migration_name LIKE '"'"'20261109%'"'"' AND finished_at IS NOT NULL"'
docker exec ayvo-dev-preview-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "SELECT (SELECT count(*) FROM return_receipts), (SELECT count(*) FROM bottles WHERE status::text IN ('"'"'RETURNED'"'"','"'"'RETIRED'"'"','"'"'DISPOSED'"'"')), (SELECT count(*) FROM crate_cycles WHERE status::text IN ('"'"'RETURNED'"'"','"'"'CLOSED'"'"')), (SELECT count(*) FROM order_crate_allocations WHERE completed_at IS NOT NULL), (SELECT count(*) FROM bottle_events WHERE type::text IN ('"'"'SORTED'"'"','"'"'RETIRED'"'"','"'"'DISPOSED'"'"','"'"'CORRECTION'"'"'))"'
```

Decision before any later rollback: run the §1 query (step 4's second command).

- **All 0** → `scripts/deploy-dev.sh --rollback <tag from step 1>` is allowed (§2).
- **Anything else** → no rollback to the tag from step 1 (§3): fix forward with a corrected R1
  build. The R1 rows stay; the pre-migration dump is never restored over them (that would drop
  the received returns).
- Record in the release note: the tag from step 1, the dump path, the time of the first receipt
  (the moment the rollback target becomes the R1 release).
