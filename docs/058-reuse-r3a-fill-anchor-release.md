# 058 — R3-a: one filling per circulation (release and rollback)

Status: **for review with the R3-a draft PR.** It implements doc 048 §3.3b–§3.3c and §8.2 step 1
(PR #128, technically approved on `3499c83`, review 5806877670).

The owner decided on 2026-11-09 (PR #128 comment 6744725588):

- R3 is approved. A washed bottle is scanned and treated like a new one.
- D3: new and washed bottles may share a crate.
- D2 is still open. It does not affect R3-a.

## What R3-a writes

One migration, `20261114090000_bottle_fill_circulations`, in one transaction:

1. `LOCK TABLE bottle_events IN SHARE ROW EXCLUSIVE MODE`, so no `FILLED` is written meanwhile.
2. It creates `bottle_fill_circulations (filled_event_id PK, circulation_event_id UNIQUE)`. Both
   columns are FKs to `bottle_events`. The table is insert-only, and its trigger refuses UPDATE,
   DELETE and a row that is not "a FILLED and the latest LABEL_APPLIED / REUSE_READY of the same
   bottle before it".
3. **Backfill by INSERT:** each existing `FILLED` gets its bottle's `LABEL_APPLIED`. No event row or
   payload is changed.
4. A trigger after each `FILLED` insert locks the bottle and derives the anchor:
   - from `LABELED_EMPTY`, the bottle's latest `LABEL_APPLIED`;
   - from `READY_FOR_REUSE`, its latest `REUSE_READY`;
   - in any other state, the insert is refused.

   The unique circulation refuses a second filling of the same circulation, whatever the crate or
   the path.

5. Only then it drops `bottle_events_one_filled_per_bottle`. The unique anchor is the stronger rule
   and already holds for every `FILLED`.

The API is unchanged and passes no anchor, so the R2 code keeps working on this schema. Placement
is unchanged: a `READY_FOR_REUSE` bottle still enters no crate. That is R3-b.

## Before and after deploying (read only, privileged migration role)

```sql
SELECT (SELECT count(*) FROM bottle_events WHERE type = 'FILLED')  AS filled,
       (SELECT count(*) FROM bottle_fill_circulations)              AS anchored,
       (SELECT count(*) FROM bottle_fill_circulations c
          JOIN bottle_events e ON e.id = c.circulation_event_id
         WHERE e.type = 'REUSE_READY')                              AS reuse_anchored;
```

After the migration, `filled = anchored`. `reuse_anchored` stays 0 until R3-b.

## Rollback: the previous image only, the schema stays

The only rollback of R3-a is to start the previous (R2) image again, **with the R3-a schema kept**.
Run the preflight first. It decides whether this runbook applies at all.

### 1. Preflight, before anything is started (read only, privileged migration role)

```sql
-- a) Migrations after R3-a. Any row: R3-b (or later) was deployed. Stop here.
SELECT migration_name, finished_at, rolled_back_at
  FROM _prisma_migrations
 WHERE migration_name > '20261114090000_bottle_fill_circulations'
 ORDER BY migration_name;

-- b) Both R3-b signals. Each must be 0. `::text` keeps the query valid before the R3-b enum
--    value exists.
SELECT (SELECT count(*) FROM crate_assignments WHERE source::text = 'REUSE') AS reuse_members,
       (SELECT count(*) FROM bottle_fill_circulations c
          JOIN bottle_events e ON e.id = c.circulation_event_id
         WHERE e.type = 'REUSE_READY')                                      AS reuse_anchored;

-- c) The anchors: filled = anchored.
SELECT (SELECT count(*) FROM bottle_events WHERE type = 'FILLED') AS filled,
       (SELECT count(*) FROM bottle_fill_circulations)            AS anchored;
```

The rollback to R2 may start only when all three hold:

- (a) returns no row;
- (b) gives `reuse_members = 0` and `reuse_anchored = 0`;
- (c) gives `filled = anchored`.

R3-b's first write can be a `REUSE` member alone, before any reused filling (review 5829606688). The
R2 code does not know that value and may fail to read the crate. That is why (b) checks members as
well as fillings. Checking only after the rollback would be too late.

If (a) returns a row, or (b) is not 0, this runbook does not apply:

- **R3-b is deployed, but nothing has been written through it** (both counts 0): follow doc 059.
  Go back to the R3-a image only, and run its checks.
- **Either count is above 0:** fix forward only (doc 048 §3.3c).

Going from R3-b straight back to R2 is not covered by any runbook.

### 2. Start the previous image (no migration)

- DEV: `scripts/deploy-dev.sh --rollback <previous-tag>`. The tag comes from the deployment log or
  `docker images 'ayvo-dev-preview/*'`.
- PROD: `scripts/deploy-prod.sh --rollback <release>`. `<release>` is the **12-character** commit
  ID of an earlier release that was deployed on that server. The script refuses any other form, and
  any release that was never exported there.

Neither runs a migration, so nothing in the database changes.

### 3. After the rollback

Repeat the preflight (a)–(c). Nothing may have changed: still no later migration,
`reuse_members = 0`, `reuse_anchored = 0` and `filled = anchored`. The trigger stays in force, so
each `FILLED` the R2 image writes from now on still gets its anchor.

### Why the schema is kept

The R2 code runs unchanged on this schema. R3-a changes no API, and the R2 suites pass on it (see
Tests). A later forward deploy finds a complete side table: Prisma has the migration recorded, and
nothing has to be backfilled again.

**Never take the schema back by hand.** Do not drop the trigger, do not remove the side table and
do not restore `bottle_events_one_filled_per_bottle` (review 5829368903):

- From then on, the R2 code would write fillings with no anchor.
- Prisma would still count R3-a as applied, so no later deploy would recreate the trigger or fill in
  the missing anchors.
- R3-b could then refuse ordinary operations on such a bottle.

Reversing the schema would need its own reviewed procedure. That procedure must include a tested
way forward again, with a backfill and the rules restored. This release does not provide one.

## Tests (API e2e on a real DB, as the core runtime role, with commits)

- **Anchors:** every `FILLED` of the API gets its bottle's `LABEL_APPLIED`, and database-wide
  `filled = anchored`.
- **The side table:**
  - UPDATE and DELETE are refused;
  - a second row for a filled circulation is refused;
  - a row naming another bottle's circulation, or a non-`FILLED` event, is refused.
- **A second `FILLED`** of a filled bottle by direct SQL is refused and nothing is written.
- **Two concurrent fill scans** of one bottle give one `FILLED` and one anchor.
- **Compatibility:** the existing labelling, filling, crates, orders, shipments, returns (R1) and
  "Po mytí" (R2) suites pass on this schema (13 files, 120 tests).
