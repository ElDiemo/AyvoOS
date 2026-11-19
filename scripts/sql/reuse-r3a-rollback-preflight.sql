-- Read-only preflight before returning from R3-a to the previous (R2) image with the R3-a schema
-- kept (doc 058 §Rollback). Run inside BEGIN READ ONLY as the privileged migration role. One row:
--
--   verdict            ROLLBACK_ALLOWED                — doc 058 §2 may start
--                      FIX_FORWARD                     — R3-b wrote something (a REUSE member or a
--                                                        reused filling): never back (doc 048 §3.3c)
--                      STOP_ANCHORS                    — filled <> anchored: R3-a is not intact
--                      STOP_UNVERIFIED_MIGRATION       — a later migration nobody has checked against
--                                                        R3-a (unknown name, other checksum, failed,
--                                                        or applied after R3-a although named earlier)
--                      STOP_DEPENDENT_DEPLOYED         — R3-b and/or R1.1 is deployed (nothing
--                                                        written through R3-b): doc 059 / doc 070
--   later_migrations   every migration after R3-a as name=classification, for the release note
--
-- A later migration does not stop this rollback only when it is in the reviewed list below with
-- the same checksum (sha256 of its migration.sql, as Prisma records it) and classified INDEPENDENT:
-- its SQL names no R3-a object (bottle_fill_circulations, its triggers and functions) and needs no
-- migration that does. INDEPENDENT says nothing about rolling back that other change — its own
-- runbook decides that. Fail closed: everything not listed is STOP_UNVERIFIED_MIGRATION.
-- `::text` keeps the query valid before the R3-b enum value exists.
WITH r3a AS (
  SELECT finished_at FROM _prisma_migrations
   WHERE migration_name = '20261119090000_bottle_fill_circulations'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL
), reviewed (migration_name, checksum, classification) AS (VALUES
  -- R3-b (#154, doc 059): REUSE placement and reused fillings anchored in bottle_fill_circulations.
  ('20261119090100_reuse_placement_enum_values',
   '01682edff72538d76e9a0d02d6940f92bfc3a4618f7226998a2a4b002628bdc4', 'DEPENDS_R3B'),
  ('20261119090200_reuse_placement_filling',
   '956d1765074340a82f1be94e13c97a45d3093f5b987ed6c5d02142b2d12d7e87', 'DEPENDS_R3B'),
  -- R1.1 (#197, doc 070): needs R3-b (and reads bottle_fill_circulations).
  ('20261119090300_returns_r1_1_enum_values',
   '9ff745a49bdabe75d51d6e41354c346f3e57b300c5a7873283154650573dc901', 'DEPENDS_R1_1'),
  ('20261119090400_returns_r1_1',
   '98f3cc82e92d54ea57b25d263c1515a258b20b31d12e87f6ed008d38db0acd60', 'DEPENDS_R1_1'),
  -- R1.1 follow-up: an R1 NOT_DELIVERED resolvable after its crate was freed (R1.1's SORTED rule).
  ('20261119090500_returns_r1_issue_freed_crate',
   '7ec15ca044f79256594afe7dd249a470c86d4e8ce0fe0200e1a400fe42dd1e1c', 'DEPENDS_R1_1'),
  -- Commissions 2a (#196): a permission in the catalogue only, no bottle table.
  ('20261119180000_finance_commissions_permission',
   '356eea2b8c6d3c16cb73e44bcf1bd4391bd5fd92e34a24f9448437d323dc1997', 'INDEPENDENT')
), later AS (
  SELECT m.migration_name,
         CASE
           WHEN m.finished_at IS NULL OR m.rolled_back_at IS NOT NULL THEN 'UNVERIFIED'
           WHEN v.checksum IS DISTINCT FROM m.checksum THEN 'UNVERIFIED'
           WHEN m.migration_name < '20261119090000_bottle_fill_circulations' THEN 'UNVERIFIED'
           ELSE v.classification
         END AS classification
    FROM _prisma_migrations m
    LEFT JOIN reviewed v ON v.migration_name = m.migration_name
   WHERE m.migration_name > '20261119090000_bottle_fill_circulations'
      OR (m.migration_name < '20261119090000_bottle_fill_circulations'
          AND m.started_at > (SELECT finished_at FROM r3a))
), signals AS (
  SELECT (SELECT count(*) FROM crate_assignments WHERE source::text = 'REUSE')::int AS reuse_members,
         (SELECT count(*) FROM bottle_fill_circulations c
            JOIN bottle_events e ON e.id = c.circulation_event_id
           WHERE e.type::text = 'REUSE_READY')::int                                   AS reuse_anchored,
         (SELECT count(*) FROM bottle_events WHERE type::text = 'FILLED')::int          AS filled,
         (SELECT count(*) FROM bottle_fill_circulations)::int                           AS anchored
)
SELECT CASE
         WHEN NOT EXISTS (SELECT 1 FROM r3a)                         THEN 'STOP_UNVERIFIED_MIGRATION'
         WHEN s.reuse_members > 0 OR s.reuse_anchored > 0            THEN 'FIX_FORWARD'
         WHEN s.filled <> s.anchored                                 THEN 'STOP_ANCHORS'
         WHEN EXISTS (SELECT 1 FROM later WHERE classification = 'UNVERIFIED')
                                                                     THEN 'STOP_UNVERIFIED_MIGRATION'
         WHEN EXISTS (SELECT 1 FROM later WHERE classification LIKE 'DEPENDS_%')
                                                                     THEN 'STOP_DEPENDENT_DEPLOYED'
         ELSE 'ROLLBACK_ALLOWED'
       END AS verdict,
       coalesce((SELECT string_agg(migration_name || '=' || classification, ', '
                                   ORDER BY migration_name) FROM later), '') AS later_migrations,
       s.reuse_members, s.reuse_anchored, s.filled, s.anchored
  FROM signals s;
