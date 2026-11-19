-- Return intake R1.1 follow-up (doc 047 §6.3 6, doc 070 §4.1): an R1 NOT_DELIVERED (no anchor,
-- on an R1 line of a receipt opened before R1.1) stays resolvable when a later R1.1 receipt freed
-- its crate first. Its circulation is the membership it was recorded in: the bottle's latest
-- assignment, made before the line, active when the issue was recorded and freed with its crate
-- (CRATE_RETURNED) only after it — delivered in that cycle's allocation. The SORTED names that
-- cycle on the issue's own line and resolves the issue; the membership needs no release (the
-- commit check already accepts a member freed with its crate). Once per circulation stays the
-- unique index bottle_events_one_sorted_per_cycle; one open issue per bottle stays as it is.
--
-- Only bottle_events_return_rules() changes: the same function as 20261119090400, with the R1
-- line branch widened for exactly that case. No table, row, index or trigger changes.

CREATE OR REPLACE FUNCTION bottle_events_return_rules() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  bottle record;
  line record;
  issue record;
  anchor_cycle uuid;
  anchor_allocation uuid;
  -- Set only when the SORTED resolves an unanchored NOT_DELIVERED (an R1 issue).
  r1_not_delivered_at timestamptz;
  latest record;
  last_retired record;
BEGIN
  SELECT * INTO bottle FROM "bottles" WHERE "id" = NEW."bottle_id";
  IF bottle."status" = 'DISPOSED' THEN
    RAISE EXCEPTION 'AYVO: a disposed bottle has no later event' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."type" = 'SORTED') <> (NEW."return_line_id" IS NOT NULL)
     OR (NEW."resolves_issue_id" IS NOT NULL AND NEW."type" <> 'SORTED') THEN
    RAISE EXCEPTION 'AYVO: exactly a SORTED event names its return line' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."type" IN ('SORTED', 'RETIRED', 'DISPOSED', 'CORRECTION')
     AND (NEW."operation_request_id" IS NULL OR NEW."actor_id" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: % names its operation and actor', NEW."type" USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."type" = 'SORTED' THEN
    IF NEW."crate_cycle_id" IS NULL OR NEW."payload"->>'outcome' IS NULL
       OR NEW."payload"->>'outcome' NOT IN ('RETURNED', 'RETIRED') THEN
      RAISE EXCEPTION 'AYVO: SORTED names its delivered cycle and its outcome' USING ERRCODE = 'check_violation';
    END IF;
    SELECT l.*, r."site_id", r."state", r."opened_at" AS "receipt_opened_at" INTO line
      FROM "return_receipt_lines" l JOIN "return_receipts" r ON r."id" = l."receipt_id"
     WHERE l."id" = NEW."return_line_id";
    IF line."site_id" <> bottle."site_id" THEN
      RAISE EXCEPTION 'AYVO: a bottle is identified only in a receipt of its own site' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."resolves_issue_id" IS NOT NULL THEN
      SELECT * INTO issue FROM "return_receipt_issues" WHERE "id" = NEW."resolves_issue_id";
      IF issue."line_id" <> NEW."return_line_id" OR issue."resolved_at" IS NOT NULL
         OR issue."kind" NOT IN ('UNREADABLE', 'NOT_DELIVERED', 'NOT_IN_CIRCULATION')
         OR (issue."bottle_id" IS NOT NULL AND issue."bottle_id" <> NEW."bottle_id") THEN
        RAISE EXCEPTION 'AYVO: SORTED resolves an open piece issue of its own line and bottle' USING ERRCODE = 'check_violation';
      END IF;
      anchor_cycle := issue."anchor_cycle_id";
      anchor_allocation := issue."anchor_allocation_id";
      IF issue."kind" = 'NOT_DELIVERED' AND issue."anchor_cycle_id" IS NULL THEN
        r1_not_delivered_at := issue."recorded_at";
      END IF;
    ELSIF line."state" <> 'OPEN' OR line."emptied_at" IS NOT NULL THEN
      RAISE EXCEPTION 'AYVO: a scan goes only into a not-emptied line of an open receipt' USING ERRCODE = 'check_violation';
    END IF;

    IF line."kind" = 'BOTTLES' THEN
      -- R1.1: the bottle's real latest circulation — its latest assignment, still active or freed
      -- with its crate (CRATE_RETURNED) — recorded in that cycle's delivered allocation.
      SELECT a.* INTO latest FROM "crate_assignments" a
       WHERE a."bottle_id" = NEW."bottle_id" ORDER BY a."assigned_at" DESC, a."id" DESC LIMIT 1;
      IF latest."cycle_id" IS DISTINCT FROM NEW."crate_cycle_id"
         OR NOT (latest."released_at" IS NULL OR latest."release_reason" = 'CRATE_RETURNED') THEN
        RAISE EXCEPTION 'AYVO: SORTED identifies the bottle''s latest circulation (its latest assignment, active or freed with its crate)'
          USING ERRCODE = 'check_violation';
      END IF;
      IF anchor_cycle IS NOT NULL THEN
        -- The one exception to the receipt anchor: an anchored NOT_DELIVERED identifies exactly
        -- its anchor, delivered by now (§6.3 4).
        IF NEW."crate_cycle_id" <> anchor_cycle OR NOT EXISTS (
             SELECT 1 FROM "order_allocation_bottles" ob
               JOIN "shipment_parcels" p ON p."allocation_id" = ob."allocation_id"
               JOIN "shipments" s ON s."id" = p."shipment_id" AND s."status" <> 'CANCELLED'
               JOIN "shipment_parcel_progress" pp ON pp."parcel_id" = p."id" AND pp."delivered_at" IS NOT NULL
              WHERE ob."allocation_id" = anchor_allocation AND ob."assignment_id" = latest."id"
                AND ob."bottle_id" = NEW."bottle_id") THEN
          RAISE EXCEPTION 'AYVO: an anchored issue identifies exactly its delivered anchor circulation'
            USING ERRCODE = 'check_violation';
        END IF;
      ELSIF NOT EXISTS (
           SELECT 1 FROM "order_allocation_bottles" ob
             JOIN "order_crate_allocations" oa ON oa."id" = ob."allocation_id" AND oa."cycle_id" = latest."cycle_id"
                  AND oa."released_at" IS NULL
             JOIN "shipment_parcels" p ON p."allocation_id" = oa."id"
             JOIN "shipments" s ON s."id" = p."shipment_id" AND s."status" <> 'CANCELLED'
             JOIN "shipment_parcel_progress" pp ON pp."parcel_id" = p."id"
                  AND pp."delivered_at" IS NOT NULL AND pp."delivered_at" < line."receipt_opened_at"
            WHERE ob."assignment_id" = latest."id" AND ob."bottle_id" = NEW."bottle_id") THEN
        RAISE EXCEPTION 'AYVO: SORTED identifies a circulation delivered before its receipt was opened'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      -- An R1 line (an R1 issue resolved later): R1's anchor — a member of that delivered cycle,
      -- assigned before the line existed, one of its allocation's bottles; still active, or (only
      -- for the unanchored NOT_DELIVERED it resolves) the bottle's latest membership, active when
      -- that issue was recorded and freed with its crate by a later receipt only after it.
      IF NOT EXISTS (
           SELECT 1 FROM "crate_assignments" a
             JOIN "order_allocation_bottles" ob ON ob."assignment_id" = a."id" AND ob."bottle_id" = a."bottle_id"
             JOIN "order_crate_allocations" oa ON oa."id" = ob."allocation_id" AND oa."cycle_id" = a."cycle_id"
                  AND oa."released_at" IS NULL
             JOIN "shipment_parcels" p ON p."allocation_id" = oa."id"
             JOIN "shipments" s ON s."id" = p."shipment_id" AND s."status" <> 'CANCELLED'
             JOIN "shipment_parcel_progress" pp ON pp."parcel_id" = p."id" AND pp."delivered_at" IS NOT NULL
            WHERE a."bottle_id" = NEW."bottle_id" AND a."cycle_id" = NEW."crate_cycle_id"
              AND a."assigned_at" < line."scanned_at"
              AND (a."released_at" IS NULL
                   OR (r1_not_delivered_at IS NOT NULL
                       AND a."release_reason" = 'CRATE_RETURNED'
                       AND a."assigned_at" <= r1_not_delivered_at AND a."released_at" > r1_not_delivered_at
                       AND NOT EXISTS (
                         SELECT 1 FROM "crate_assignments" later
                          WHERE later."bottle_id" = a."bottle_id" AND later."id" <> a."id"
                            AND (later."assigned_at", later."id") > (a."assigned_at", a."id"))))) THEN
        RAISE EXCEPTION 'AYVO: SORTED identifies a delivered member of the cycle, assigned before its line'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."type" = 'RETIRED' THEN
    IF bottle."status" NOT IN ('FILLED', 'RETURNED') OR coalesce(NEW."payload"->>'reason', '') = '' THEN
      RAISE EXCEPTION 'AYVO: a returned bottle is retired with a reason' USING ERRCODE = 'check_violation';
    END IF;
    IF bottle."status" = 'FILLED' AND NEW."payload"->>'reason' IS DISTINCT FROM 'DEFECTIVE_AT_RETURN' THEN
      RAISE EXCEPTION 'AYVO: a filled bottle is retired only at a return (DEFECTIVE_AT_RETURN with its SORTED)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."payload"->>'reason' = 'DEFECTIVE_AT_RETURN' AND NOT EXISTS (
         SELECT 1 FROM "bottle_events" e WHERE e."bottle_id" = NEW."bottle_id" AND e."type" = 'SORTED'
            AND e."payload"->>'outcome' = 'RETIRED' AND e."operation_request_id" = NEW."operation_request_id") THEN
      RAISE EXCEPTION 'AYVO: DEFECTIVE_AT_RETURN comes with its SORTED' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."type" = 'DISPOSED' THEN
    IF bottle."status" <> 'RETIRED' THEN
      RAISE EXCEPTION 'AYVO: only a retired bottle is disposed' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."type" = 'CORRECTION' THEN
    SELECT * INTO last_retired FROM "bottle_events"
     WHERE "bottle_id" = NEW."bottle_id" AND "type" = 'RETIRED' ORDER BY "id" DESC LIMIT 1;
    IF bottle."status" <> 'RETIRED' OR last_retired."payload"->>'reason' IS DISTINCT FROM 'DEFECTIVE_AT_RETURN'
       OR coalesce(NEW."payload"->>'reason', '') = '' THEN
      RAISE EXCEPTION 'AYVO: a CORRECTION reverses only a retirement documented at the return, with a reason'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
