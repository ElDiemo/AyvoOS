# 058 — R3-a: one filling per circulation (release and rollback)

Status: **for review with the R3-a draft PR.** It implements doc 048 §3.3b–§3.3c and §8.2 step 1
(PR #128, technically approved on `3499c83`, review 5806877670).

The owner decided on 2026-11-09 (PR #128 comment 6744725588):

- R3 is approved. A washed bottle is scanned and treated like a new one.
- D3: new and washed bottles may share a crate.
- D2 is still open. It does not affect R3-a.

## What R3-a writes

One migration, `20261119090000_bottle_fill_circulations`, in one transaction:

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

`scripts/sql/reuse-r3a-rollback-preflight.sql`, inside `BEGIN READ ONLY`. It returns one row: a
`verdict`, every later migration with its classification (`later_migrations`, for the release
note), and the counts below.

It checks three things:

- **(a) Later migrations, by their real relation to R3-a.** A migration after R3-a stops the
  rollback unless the file's reviewed list names it **with the same checksum** (what Prisma
  records: sha256 of its `migration.sql`) as `INDEPENDENT`. `INDEPENDENT` means its SQL names no
  R3-a object (`bottle_fill_circulations`, its triggers and functions) and needs no migration that
  does. Example: commissions 2a (#196, `20261119180000_finance_commissions_permission`) has a later
  prefix but only adds a permission. It does not stop this rollback; its own rollback is decided by
  its own runbook. The same holds for the PPL pickup lookups (#212,
  `20261121090000_pickup_cancel_uncertain_lookups`, a check on `carrier_pickup_cancellations`
  only); on DEV both were applied before R3-a although named after it, and that order is allowed
  too. R3-b (#154) and R1.1 (#197) are `DEPENDS_*`.
  **Fail closed:** an unknown name, another checksum, a failed migration, or one named before R3-a
  but applied after it is `UNVERIFIED` and stops the rollback. Adding a migration to the list needs
  a review of its SQL; a test fails while a migration of the repo after R3-a is missing from it.
- **(b) Both R3-b signals** (`reuse_members`, `reuse_anchored`), each must be 0. R3-b's first write
  can be a `REUSE` member alone, before any reused filling (review 5829606688). The R2 code does
  not know that value and may fail to read the crate. That is why (b) checks members as well as
  fillings. Checking only after the rollback would be too late.
- **(c) The anchors:** `filled = anchored`.

| `verdict`                   | Meaning                                                         | What to do                                                                         |
| --------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ROLLBACK_ALLOWED`          | only R3-a and reviewed independent migrations, (b) 0, (c) holds | §2                                                                                 |
| `STOP_DEPENDENT_DEPLOYED`   | R3-b and/or R1.1 deployed, nothing written through R3-b         | doc 070 (R1.1) / doc 059 (R3-b): back to the R3-a image only, and run their checks |
| `FIX_FORWARD`               | a `REUSE` member or a reused filling exists                     | fix forward only (doc 048 §3.3c)                                                   |
| `STOP_UNVERIFIED_MIGRATION` | a later migration nobody has checked against R3-a               | stop; review its SQL and add it to the list in a PR first                          |
| `STOP_ANCHORS`              | `filled <> anchored`                                            | stop; R3-a is not intact                                                           |

Going from R3-b straight back to R2 is not covered by any runbook.

### 2. Start the previous image (no migration)

- DEV: `scripts/deploy-dev.sh --rollback <previous-tag>`. The tag comes from the deployment log or
  `docker images 'ayvo-dev-preview/*'`.
- PROD: `scripts/deploy-prod.sh --rollback <release>`. `<release>` is the **12-character** commit
  ID of an earlier release that was deployed on that server. The script refuses any other form, and
  any release that was never exported there.

Neither runs a migration, so nothing in the database changes.

### 3. After the rollback

Repeat the preflight. Nothing may have changed: still `ROLLBACK_ALLOWED` with the same
`later_migrations`. The trigger stays in force, so
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
- **The rollback preflight** (`reuse-r3a-rollback-preflight.e2e`, a throw-away database): only R3-a
  → allowed; a later independent migration (commissions 2a) → still allowed; the independent ones
  named after R3-a but applied before it (DEV's real order) → still allowed; the same name with
  another checksum, an unknown, a failed and a late-applied earlier migration → stop; R3-b recorded
  → `STOP_DEPENDENT_DEPLOYED`; a `FILLED` without its anchor → `STOP_ANCHORS`; the reviewed
  checksums are what Prisma records, and every later migration of the repo is in the list.
- **Compatibility:** the existing labelling, filling, crates, orders, shipments, returns (R1) and
  "Po mytí" (R2) suites pass on this schema (13 files, 120 tests).
