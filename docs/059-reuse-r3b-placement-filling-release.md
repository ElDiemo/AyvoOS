# 059 — R3-b: a washed bottle back into production (release and rollback)

Status: **for review with the R3-b draft PR**, stacked on R3-a (doc 058, PR #152). It implements
doc 048 §3.0, §3.1 and §3.3 (PR #128).

The owner decided on 2026-11-09:

- A washed bottle is scanned and treated like a new one.
- New and washed bottles may share a crate.
- D2 = (b): a supervisor may release set-aside bottles of a revoked design. That is not part of
  this PR.

## What changes

**Migrations:**

- `20261115090000_reuse_placement_enum_values` adds `CrateAssignmentSource += REUSE`, in its own
  migration.
- `20261115090100_reuse_placement_filling` changes these rules:
  - **Placement:** a `REUSE` membership goes only into `OPEN_ASSEMBLY`. At commit, a `REUSE`
    member must be a `READY_FOR_REUSE` bottle placed after its latest `REUSE_READY`. Every other
    source still takes only `LABELED_EMPTY` or `FILLED` members.
  - **Consistency:**
    - a member always matches the cycle's product and label design (its binding);
    - the recipe check skips a `REUSE` member, because it is empty;
    - a later member of a reused bottle (`REPACKED`) carries the recipe of its `REUSE` cycle.
  - **Status:** `READY_FOR_REUSE → FILLED` is allowed. A `FILLED` status needs the `FILLED` of the
    bottle's **current** circulation, never an earlier one. A washed bottle may be in exactly its
    `REUSE` membership.
  - **Filling:** a washed bottle's filling consumes the FILL BOM **without its PUMP lines**, because
    the washed pump comes from the anonymous pool. A `PUMP` movement on it is refused. A new bottle
    still consumes the complete BOM, and a pump attachment is installed either way.

**API:**

- **The labelling station:**
  - a `READY_FOR_REUSE` bottle is only placed: outcome `PLACED`, an `ASSIGNED_TO_CRATE` event and
    a `REUSE` membership; nothing is consumed and there is no `LABEL_APPLIED`;
  - it is checked against the crate's product and design (`BINDING_MISMATCH`) and against an open
    approval (`DESIGN_NOT_APPROVED`);
  - a `RETURNED` bottle gets `NOT_WASHED`;
  - "Doplnit lahev" keeps refusing a washed bottle.
- **Filling:** a `READY_FOR_REUSE` member is accepted, and its consumption leaves out the pump. The
  duplicate-scan answer reads the latest `FILLED`.

**UI:**

- **The station:** "… po mytí vložena (n/kapacita) – etiketu už má, nic se neodepsalo".
- **New error texts:** `NOT_WASHED` and `BINDING_MISMATCH`.
- **Crate content:** the source "po mytí".

## Before and after deploying (read only, privileged migration role)

```sql
SELECT (SELECT count(*) FROM crate_assignments WHERE source = 'REUSE')        AS reuse_members,
       (SELECT count(*) FROM bottle_fill_circulations c
          JOIN bottle_events e ON e.id = c.circulation_event_id
         WHERE e.type = 'REUSE_READY')                                         AS reuse_fillings;
```

## Rollback

- **While both counts are 0:** the R3-a release runs on this schema. The new rules accept
  everything R3-a writes, and its fillings consume the complete BOM.
- **After the first `REUSE` member or reused filling:** fix forward only (doc 048 §3.3c).

## Tests (API e2e on a real DB, as the core runtime role, with commits)

**The second circulation** of one physical bottle, with the FAKE test carrier:

- delivered, returned and identified, "Po mytí";
- placed at the ordinary station next to a new bottle in one crate (`PLACED`, nothing consumed,
  never labelled again; a duplicate scan writes nothing);
- filled: liquid for both, a new pump only for the new bottle, a pump attachment for both;
- its second `FILLED` anchored to `REUSE_READY`;
- Hotovo, shipped and delivered again.

**Direct SQL that must fail:**

- a `PUMP` movement on the reused filling;
- a `REUSE` membership of a `LABELED_EMPTY` bottle or of a `RETURNED` bottle not yet washed;
- a bare `READY_FOR_REUSE → FILLED`.

**Compatibility:** R3-a, R2 "Po mytí" (its station test now expects `PLACED`), R1 returns,
labelling, filling, crates, cycle members, corrections, orders and shipments: 16 files, 129 tests.

Not covered: the staff web's labelling-station e2e was not run for the new message. The station
change is the text of one outcome.
