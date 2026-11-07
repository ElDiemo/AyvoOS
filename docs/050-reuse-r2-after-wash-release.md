# 050 — R2 "Po mytí": release, rollback before/after the first R2 write, DEV acceptance

Status: **for review with the R2 draft PR**. It implements doc 048 §1–§2 as approved technically on
`3499c8312437fe48f3406cae9d473c3ee4b7fd51` (PR #128, review 5806877670); the owner asked for the
implementation on 2026-11-07. Like doc 049 for R1, it changes no deployment script.

**Documentation continuity.** The R1 model (doc 047, PR #126 at `69d90c8`) and the R2/R3 model (doc
048, PR #128 at `3499c83`) are still drafts, not in `main`. This document and the code cite them by
commit and do not restate or change them. Merging #126 and #128 stays a separate documentation step;
if either changes before it is merged, this R2 implementation is checked against the new text.

## 1. What R2 writes

- Two additive migrations: `20261111090000_reuse_ready_enum_values` (bottle `READY_FOR_REUSE`,
  event `REUSE_READY`, operation `REUSE_READY_SCAN`) and `20261111090100_reuse_ready` (triggers
  only; no table, no column, no permission, no existing row rewritten).
- Per scan, in one transaction: one `REUSE_READY` (operation, actor; no crate, station or lot),
  `RETURNED → READY_FOR_REUSE`, the bottle's open `PUMP` attachment closed (`CLEANING_REQUIRED`,
  `AFTER_WASH`, `removal_event_id` = the `REUSE_READY`). No stock movement, no label, no binding
  change.
- In R2 a `READY_FOR_REUSE` bottle enters no crate: the labelling station and "Doplnit lahev"
  answer `NOT_PLACEABLE_YET`; the database refuses any new membership (#131 trigger) and any
  `READY_FOR_REUSE` bottle with an active assignment.
- A revoked label design: the scan is refused (`DESIGN_WITHDRAWN`, nothing written); the queue
  lists the bottle under "Vyčleněno – odvolaná etiketa". Nothing is retired automatically.

**Not decided here, and not coded:** D2's options (a)/(b) for the set-aside bottles (doc 048 §4);
washed pumps and refilling (D1, R3); the dispatch check of a revoked design (doc 048 §7). R2 uses
the existing `returns:receive` (ADMIN only), as doc 048 §2.2 names no new permission; a separate
permission for washing staff would be a new owner decision.

## 2. Is there R2 data yet?

Read-only, as the privileged migration role:

```sql
SELECT (SELECT count(*) FROM bottles WHERE status::text = 'READY_FOR_REUSE') AS ready,
       (SELECT count(*) FROM bottle_events WHERE type::text = 'REUSE_READY')  AS events;
```

Both 0 → §3. Anything else → §4. The first R2 write is the first successful "Po mytí" scan.

## 3. Before the first R2 write: the previous images are safe

Verified 2026-11-07 on a throwaway worktree of the previous release `5f13568` (R1 + #131):

- `test/rollback-compat.e2e.test.ts` with `AYVO_NEWER_API_DIR` = R2: **17 passed**, 1 not
  applicable — its precondition "the newer database holds permissions this version does not know"
  is false by design (R2 adds no permission); every read model of the old release loads.
- The old release's own API tests of the production, dispatch and return walk, with the two R2
  migrations applied before each file (labelling, filling, crates, orders, order tracking,
  shipments, the R1 intake and its site boundary, the #131 member check): **9 files, 105 passed**.

So: `deploy-dev.sh --rollback <previous tag>`, no migration, nothing to clean up.

## 4. After the first R2 write: fix forward only

Verified 2026-11-07, read only: the previous release's Prisma client (`5f13568`) on the Playwright
database after R2's walk (one `READY_FOR_REUSE` bottle) — reading bottles fails with `P2023 Value
'READY_FOR_REUSE' not found in enum 'BottleStatus'`, reading bottle events with `P2023 Value
'REUSE_READY' not found in enum 'BottleEventType'` (bottle lists and details break, as doc 049 §3
for R1). Therefore, as in doc 049: fix forward with a corrected R2 build; never delete or rewrite `REUSE_READY` rows, the
closed pump attachments or the statuses (append-only history, ADR 0006; the database refuses it
anyway); a rollback only to a release that already contains R2.

## 5. DEV preflight (read-only; Codex, after the owner approves the DEV deploy)

As doc 049 §4, inside the DEV database container with its own user (no password typed or printed):

```bash
# 1. The running release = the rollback target before any R2 data.
docker inspect ayvo-dev-preview-api-1 --format '{{.Config.Image}}'
# 2. The last applied migration (expected: 20261110090000_crate_member_status).
docker exec ayvo-dev-preview-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1"'
# 3. Configuration and images valid; nothing changes.
scripts/deploy-dev.sh --check
```

Then the ordinary deploy (it dumps the database first). Right after it:

```bash
# 4. Both R2 migrations applied (expected 2), still no R2 data (expected 0|0).
docker exec ayvo-dev-preview-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "SELECT count(*) FROM _prisma_migrations WHERE migration_name LIKE '"'"'20261111%'"'"' AND finished_at IS NOT NULL"'
docker exec ayvo-dev-preview-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "SELECT (SELECT count(*) FROM bottles WHERE status::text = '"'"'READY_FOR_REUSE'"'"'), (SELECT count(*) FROM bottle_events WHERE type::text = '"'"'REUSE_READY'"'"')"'
```

Record in the release note: the tag from step 1, the dump path and the time of the first "Po mytí"
(the moment the rollback target becomes the R2 release).

## 6. DEV acceptance (short)

**Precondition — not met on DEV today:** "Po mytí" needs a `RETURNED` bottle, which only the R1
intake of a **delivered** crate produces. On DEV there is no supported way to a delivered crate
without the live carrier (`CARRIER_PROVIDER=test` only with `APP_ENV=test`; `DELIVERED` comes only
from carrier tracking). R2's DEV acceptance therefore waits for the owner's choice of the R1
acceptance path; nothing in R2 changes that.

Once a delivered crate has been received (R1) with at least one good and one defective bottle, at
390 px and at 1440 px, Sklad → **Po mytí**:

1. The good bottle is listed under "Vrácené, čekají na mytí". Scan it → "Připravená k plnění · Po
   mytí"; it moves to "Připravené k plnění". Its detail (Výroba → Lahve) shows the new status and
   the event "Po mytí – připravena k dalšímu plnění"; the reuse count is unchanged.
2. Scan it again → "už je po mytí (první výsledek …)"; §2's counts grow by one only.
3. Scan the defective (Ke skartaci) bottle → refused, nothing written.
4. At a labelling station of the same product, scan the washed bottle → refused (the bottle is
   not placed into the crate).
5. Warehouse stock (Stav skladu) and movements are unchanged by steps 1–4.

Not part of the DEV acceptance: revoking a real design approval (the API tests and Playwright
cover "Vyčleněno – odvolaná etiketa" on synthetic data), any carrier call, any change of DEV data
beyond the scans above.
