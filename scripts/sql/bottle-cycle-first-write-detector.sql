-- DEV trial runbook (read only, privileged migration role or the DB container's own user).
-- "Has the bottle-cycle chain (R3-b, R1.1) written anything the previous release (main 09e82e7)
-- cannot read?"  Every column 0 (and first_new_write_at NULL) = the rollback to the previous images
-- is still allowed (doc 070 §5, doc 059). Any value > 0 = fix forward only.
-- r3a_unanchored_fillings must also be 0 (doc 058 §1 c: the R3-a trigger anchors every filling).
-- Valid only after the five migrations 20261119090000…090400 (it names their columns).
SELECT
  (SELECT count(*) FROM return_receipt_lines WHERE kind::text = 'BOTTLES')                   AS r11_bottles_lines,
  (SELECT count(*) FROM crate_assignments WHERE release_reason::text = 'CRATE_RETURNED')     AS r11_crate_returned,
  (SELECT count(*) FROM return_receipt_lines
     WHERE kind::text = 'CRATE' AND emptied_at IS NOT NULL AND physical_count IS NULL)      AS r11_crates_freed,
  (SELECT count(*) FROM return_receipt_issues WHERE anchor_cycle_id IS NOT NULL)             AS r11_anchored_issues,
  (SELECT count(*) FROM crate_assignments WHERE source::text = 'REUSE')                      AS r3b_reuse_members,
  (SELECT count(*) FROM bottle_fill_circulations c
     JOIN bottle_events e ON e.id = c.circulation_event_id WHERE e.type::text = 'REUSE_READY') AS r3b_reuse_fillings,
  (SELECT count(*) FROM bottle_events WHERE type::text = 'FILLED')
    - (SELECT count(*) FROM bottle_fill_circulations)                                        AS r3a_unanchored_fillings,
  least(
    (SELECT min(scanned_at) FROM return_receipt_lines WHERE kind::text = 'BOTTLES'),
    (SELECT min(scanned_at) FROM return_receipt_lines
       WHERE kind::text = 'CRATE' AND emptied_at IS NOT NULL AND physical_count IS NULL),
    (SELECT min(released_at) FROM crate_assignments WHERE release_reason::text = 'CRATE_RETURNED'),
    (SELECT min(assigned_at) FROM crate_assignments WHERE source::text = 'REUSE')
  )                                                                                          AS first_new_write_at;
