-- Return intake R1.1 (doc 047 §6.3; owner 2026-11-18: "the scan of a delivered returnable crate at
-- the right site frees it at once and detaches its active contents in one transaction; no
-- mandatory Vyprázdnit or physical count; the scan of each really returned bottle by its QR,
-- independent of any crate, counts a completed circulation exactly once").
--
-- 1. The crate scan frees the crate: its CRATE line, the delivered allocation completed, the cycle
--    DELIVERED → RETURNED → CLOSED and the line emptied without a count — and every still active
--    member released CRATE_RETURNED by that line. No bottle row or event is written.
-- 2. The bottle scan needs no crate: it goes to the receipt's one BOTTLES line and identifies the
--    bottle's real latest circulation (its latest assignment, active or freed with its crate),
--    delivered before the receipt was opened. A NOT_DELIVERED issue stores the circulation known
--    at its first scan (anchor_cycle_id, anchor_allocation_id); only its resolution may identify
--    that circulation after the receipt was opened.
-- 3. A bottle freed with its crate stays "at the hotel" until its own scan: it never joins a crate.
--
-- Existing rows are never rewritten. R1 receipts, emptied lines, counts and SORTED keep their
-- rules; an open R1 line keeps Vyprázdněno with its count; an R1 issue on an R1 line keeps its
-- line anchor (doc 047 §6.3 6).

-- =============================================================================================
-- Columns, keys and shapes
-- =============================================================================================

ALTER TABLE "crate_assignments" ADD COLUMN "released_by_line_id" UUID;
ALTER TABLE "return_receipt_issues" ADD COLUMN "anchor_cycle_id" UUID,
ADD COLUMN "anchor_allocation_id" UUID;

-- CreateIndex
CREATE INDEX "crate_assignments_released_by_line_id_idx" ON "crate_assignments"("released_by_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_crate_allocations_id_cycle_id_key" ON "order_crate_allocations"("id", "cycle_id");

-- CreateIndex
CREATE INDEX "return_receipt_issues_anchor_allocation_id_anchor_cycle_id_idx" ON "return_receipt_issues"("anchor_allocation_id", "anchor_cycle_id");

-- AddForeignKey
ALTER TABLE "crate_assignments" ADD CONSTRAINT "crate_assignments_released_by_line_id_fkey" FOREIGN KEY ("released_by_line_id") REFERENCES "return_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: the anchor is an allocation of exactly that cycle.
ALTER TABLE "return_receipt_issues" ADD CONSTRAINT "return_receipt_issues_anchor_allocation_id_anchor_cycle_id_fkey" FOREIGN KEY ("anchor_allocation_id", "anchor_cycle_id") REFERENCES "order_crate_allocations"("id", "cycle_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one reason per release: CRATE_RETURNED ⇔ its line, never with a bottle event.
ALTER TABLE "crate_assignments"
  ADD CONSTRAINT "crate_assignments_crate_return_check" CHECK (
    coalesce("release_reason" = 'CRATE_RETURNED', false) = ("released_by_line_id" IS NOT NULL)
    AND ("released_by_line_id" IS NULL OR "released_event_id" IS NULL));

-- The anchor: both or neither, and only on NOT_DELIVERED.
ALTER TABLE "return_receipt_issues"
  ADD CONSTRAINT "return_receipt_issues_anchor_check" CHECK (
    ("anchor_cycle_id" IS NULL) = ("anchor_allocation_id" IS NULL)
    AND ("anchor_cycle_id" IS NULL OR "kind" = 'NOT_DELIVERED'));

-- Lines by kind (§6.3 5): the emptying fields all or none; a count only with the emptying,
-- required for a CONTAINER, never on BOTTLES; BOTTLES is never emptied. An R1.1 CRATE line is
-- emptied at its scan without a count; an R1 CRATE line kept its count.
ALTER TABLE "return_receipt_lines" DROP CONSTRAINT "return_receipt_lines_emptied_check";
ALTER TABLE "return_receipt_lines"
  ADD CONSTRAINT "return_receipt_lines_emptied_check" CHECK (
    ("emptied_at" IS NULL) = ("emptied_by" IS NULL)
    AND ("emptied_at" IS NULL) = ("empty_operation_id" IS NULL)
    AND ("physical_count" IS NULL OR ("emptied_at" IS NOT NULL AND "physical_count" >= 0))
    AND ("kind" <> 'CONTAINER' OR ("emptied_at" IS NULL) = ("physical_count" IS NULL))
    AND ("kind" <> 'BOTTLES' OR ("emptied_at" IS NULL AND "physical_count" IS NULL)));

CREATE UNIQUE INDEX "return_receipt_lines_one_bottles_line"
  ON "return_receipt_lines" ("receipt_id") WHERE "kind" = 'BOTTLES';

-- =============================================================================================
-- Receipts and lines
-- =============================================================================================

-- A receipt closes when every CRATE and CONTAINER line is emptied; its BOTTLES line is exempt.
CREATE OR REPLACE FUNCTION return_receipts_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: return receipts are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'OPEN' THEN
      RAISE EXCEPTION 'AYVO: a return receipt opens OPEN' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."hotel_id" IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM "hotels" h WHERE h."id" = NEW."hotel_id" AND h."fulfillment_site_id" = NEW."site_id") THEN
      RAISE EXCEPTION 'AYVO: the receipt''s hotel is served by its site' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."state" <> 'OPEN' OR NEW."state" <> 'CLOSED'
     OR (to_jsonb(NEW) - ARRAY['state','closed_at','closed_by','close_operation_id'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','closed_at','closed_by','close_operation_id']) THEN
    RAISE EXCEPTION 'AYVO: a return receipt changes only by its one closing' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "return_receipt_lines" l
              WHERE l."receipt_id" = OLD."id" AND l."kind" <> 'BOTTLES' AND l."emptied_at" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: a return receipt closes only with every crate and container line emptied'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- A new CRATE line: a crate of the receipt's site whose DELIVERED cycle is held by this live
-- allocation, its parcel delivered BEFORE the receipt was opened (the receipt anchor, §6.3 1). R1.1
-- itself records no new CONTAINER line (no route), but the database still accepts one: the previous
-- image writes it after a rollback before the first R1.1 write (doc 070 §5), and it stays an R1
-- line (Vyprázdněno with a count). A BOTTLES line has no crate (kind check).
CREATE OR REPLACE FUNCTION return_receipt_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  receipt record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: return receipt lines are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO receipt FROM "return_receipts" WHERE "id" = NEW."receipt_id";
  IF receipt."state" <> 'OPEN' THEN
    RAISE EXCEPTION 'AYVO: a closed return receipt takes no line change' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."emptied_at" IS NOT NULL THEN
      RAISE EXCEPTION 'AYVO: a return line starts not emptied' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'CRATE' AND NOT EXISTS (
         SELECT 1 FROM "crates" c
           JOIN "crate_cycles" cy ON cy."id" = NEW."returned_cycle_id" AND cy."crate_id" = c."id"
           JOIN "order_crate_allocations" oa ON oa."id" = NEW."allocation_id" AND oa."cycle_id" = cy."id"
                AND oa."crate_id" = c."id" AND oa."released_at" IS NULL AND oa."completed_at" IS NULL
           JOIN "shipment_parcels" p ON p."allocation_id" = oa."id"
           JOIN "shipments" s ON s."id" = p."shipment_id" AND s."status" <> 'CANCELLED'
           JOIN "shipment_parcel_progress" pp ON pp."parcel_id" = p."id"
                AND pp."delivered_at" IS NOT NULL AND pp."delivered_at" < receipt."opened_at"
          WHERE c."id" = NEW."crate_id" AND c."site_id" = receipt."site_id" AND cy."status" = 'DELIVERED') THEN
      RAISE EXCEPTION 'AYVO: a crate line is a crate of the receipt''s site, delivered before the receipt was opened and held by its delivered allocation'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."emptied_at" IS NOT NULL OR NEW."emptied_at" IS NULL
     OR (to_jsonb(NEW) - ARRAY['emptied_at','emptied_by','empty_operation_id','physical_count'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['emptied_at','emptied_by','empty_operation_id','physical_count']) THEN
    RAISE EXCEPTION 'AYVO: a return line changes only by its one emptying' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- At commit: a CRATE line ⇔ its cycle RETURNED or CLOSED; emptied ⇔ CLOSED. Read from the line's
-- current row: an R1.1 crate line is inserted and emptied in one transaction, and the deferred
-- check of its INSERT would otherwise see the row as inserted (not yet emptied).
CREATE OR REPLACE FUNCTION return_receipt_lines_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  st "CrateCycleStatus";
  cur record;
BEGIN
  SELECT * INTO cur FROM "return_receipt_lines" WHERE "id" = NEW."id";
  IF cur."kind" = 'CRATE' THEN
    SELECT "status" INTO st FROM "crate_cycles" WHERE "id" = cur."returned_cycle_id";
    IF st NOT IN ('RETURNED', 'CLOSED') OR (st = 'CLOSED') <> (cur."emptied_at" IS NOT NULL) THEN
      RAISE EXCEPTION 'AYVO: a crate line''s cycle is RETURNED, and CLOSED exactly when the line is emptied (%)', st
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM ayvo_assert_crate_cycle(cur."returned_cycle_id");
  END IF;
  RETURN NULL;
END
$$;

-- Issues: as R1; a new NOT_DELIVERED names the circulation known at its scan — the bottle's latest
-- assignment's cycle, held by that live, not yet delivered allocation (§6.3 2).
CREATE OR REPLACE FUNCTION return_receipt_issues_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: return issues are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."resolved_at" IS NOT NULL THEN
      RAISE EXCEPTION 'AYVO: a return issue starts open' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "return_receipt_lines" l JOIN "return_receipts" r ON r."id" = l."receipt_id"
                    WHERE l."id" = NEW."line_id" AND r."id" = NEW."receipt_id" AND r."state" = 'OPEN'
                      AND l."emptied_at" IS NULL) THEN
      RAISE EXCEPTION 'AYVO: an issue is recorded on a not-emptied line of an open receipt' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."bottle_id" IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM "bottles" b JOIN "return_receipts" r ON r."id" = NEW."receipt_id"
          WHERE b."id" = NEW."bottle_id" AND b."site_id" = r."site_id") THEN
      RAISE EXCEPTION 'AYVO: an issue names only a bottle of the receipt''s site' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'NOT_DELIVERED' AND (
         NEW."anchor_cycle_id" IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM "order_crate_allocations" oa JOIN "crate_cycles" c ON c."id" = oa."cycle_id"
            WHERE oa."id" = NEW."anchor_allocation_id" AND oa."cycle_id" = NEW."anchor_cycle_id"
              AND oa."released_at" IS NULL AND oa."completed_at" IS NULL
              AND c."status" IN ('ALLOCATED', 'DISPATCHED'))
         OR (SELECT a."cycle_id" FROM "crate_assignments" a WHERE a."bottle_id" = NEW."bottle_id"
              ORDER BY a."assigned_at" DESC, a."id" DESC LIMIT 1) IS DISTINCT FROM NEW."anchor_cycle_id") THEN
      RAISE EXCEPTION 'AYVO: a NOT_DELIVERED issue names the bottle''s current, not yet delivered circulation'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- The resolution only, once; a closed line or receipt stays as it is (doc 047 §4.8a).
  IF OLD."resolved_at" IS NOT NULL OR NEW."resolved_at" IS NULL
     OR (to_jsonb(NEW) - ARRAY['resolved_at','resolved_by','resolution','resolution_reason','resolve_operation_id','resolving_event_id'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['resolved_at','resolved_by','resolution','resolution_reason','resolve_operation_id','resolving_event_id']) THEN
    RAISE EXCEPTION 'AYVO: a return issue changes only by its one resolution' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."resolution" = 'IDENTIFIED' AND NOT EXISTS (
       SELECT 1 FROM "bottle_events" e
        WHERE e."id" = NEW."resolving_event_id" AND e."type" = 'SORTED' AND e."resolves_issue_id" = OLD."id"
          AND e."return_line_id" = OLD."line_id" AND (OLD."bottle_id" IS NULL OR e."bottle_id" = OLD."bottle_id")) THEN
    RAISE EXCEPTION 'AYVO: an issue is identified by the SORTED that resolves it, on its own line' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =============================================================================================
-- The identification (SORTED)
-- =============================================================================================

CREATE OR REPLACE FUNCTION bottle_events_return_rules() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  bottle record;
  line record;
  issue record;
  anchor_cycle uuid;
  anchor_allocation uuid;
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
      -- An R1 line (an R1 issue resolved later): R1's anchor — still an active member of that
      -- delivered cycle, assigned before the line existed, one of its allocation's bottles.
      IF NOT EXISTS (
           SELECT 1 FROM "crate_assignments" a
             JOIN "order_allocation_bottles" ob ON ob."assignment_id" = a."id" AND ob."bottle_id" = a."bottle_id"
             JOIN "order_crate_allocations" oa ON oa."id" = ob."allocation_id" AND oa."cycle_id" = a."cycle_id"
                  AND oa."released_at" IS NULL
             JOIN "shipment_parcels" p ON p."allocation_id" = oa."id"
             JOIN "shipments" s ON s."id" = p."shipment_id" AND s."status" <> 'CANCELLED'
             JOIN "shipment_parcel_progress" pp ON pp."parcel_id" = p."id" AND pp."delivered_at" IS NOT NULL
            WHERE a."bottle_id" = NEW."bottle_id" AND a."cycle_id" = NEW."crate_cycle_id"
              AND a."released_at" IS NULL AND a."assigned_at" < line."scanned_at") THEN
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

-- At commit: every SORTED is a complete identification — it released exactly its active
-- assignment of that cycle (RETURN_IDENTIFIED), or that assignment was already freed with its crate
-- (CRATE_RETURNED); no active membership of that cycle is left; the bottle is in its outcome status
-- (a defective one also RETIRED by the same operation); a resolving SORTED resolves its issue.
CREATE OR REPLACE FUNCTION bottle_events_sorted_complete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  outcome text;
  retired boolean;
  released_here int;
BEGIN
  IF NEW."type" <> 'SORTED' THEN
    RETURN NULL;
  END IF;
  outcome := NEW."payload"->>'outcome';
  SELECT count(*) INTO released_here FROM "crate_assignments" a
   WHERE a."released_event_id" = NEW."id" AND a."bottle_id" = NEW."bottle_id"
     AND a."cycle_id" = NEW."crate_cycle_id" AND a."release_reason" = 'RETURN_IDENTIFIED'
     AND a."released_at" IS NOT NULL;
  IF NOT (released_here = 1 OR (released_here = 0 AND EXISTS (
            SELECT 1 FROM "crate_assignments" a
             WHERE a."bottle_id" = NEW."bottle_id" AND a."cycle_id" = NEW."crate_cycle_id"
               AND a."release_reason" = 'CRATE_RETURNED')))
     OR EXISTS (SELECT 1 FROM "crate_assignments" a
                 WHERE a."bottle_id" = NEW."bottle_id" AND a."cycle_id" = NEW."crate_cycle_id"
                   AND a."released_at" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: a SORTED releases its assignment of that cycle, or names one freed with its crate'
      USING ERRCODE = 'check_violation';
  END IF;
  retired := EXISTS (SELECT 1 FROM "bottle_events" e
                      WHERE e."bottle_id" = NEW."bottle_id" AND e."type" = 'RETIRED'
                        AND e."operation_request_id" = NEW."operation_request_id"
                        AND e."payload"->>'reason' = 'DEFECTIVE_AT_RETURN');
  IF (outcome = 'RETIRED') <> retired
     OR (SELECT "status"::text FROM "bottles" WHERE "id" = NEW."bottle_id") <> outcome THEN
    RAISE EXCEPTION 'AYVO: a SORTED leaves the bottle % (a defective one RETIRED by the same operation)', outcome
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."resolves_issue_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "return_receipt_issues" i
        WHERE i."id" = NEW."resolves_issue_id" AND i."resolving_event_id" = NEW."id") THEN
    RAISE EXCEPTION 'AYVO: a resolving SORTED resolves its issue' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

-- At commit: as R3-b, except that "came back by an identification" reads the latest membership's
-- cycle: its SORTED exists and the membership ended by it — or was freed with its crate before it
-- (§6.3 4).
CREATE OR REPLACE FUNCTION bottles_labeled_has_event() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  member_cycle uuid;
  last_event record;
  last_sorted uuid;
  backed boolean;
  last_ready uuid;
  latest record;
BEGIN
  IF NEW."status" = 'LABELED_EMPTY' AND NOT EXISTS (
       SELECT 1 FROM "bottle_events" WHERE "bottle_id" = NEW."id" AND "type" = 'LABEL_APPLIED') THEN
    RAISE EXCEPTION 'AYVO: a labelled bottle needs its LABEL_APPLIED event' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'FILLED' THEN
    IF NOT EXISTS (SELECT 1 FROM "bottle_fill_circulations" fc
                    WHERE fc."circulation_event_id" = (
                      SELECT "id" FROM "bottle_events" WHERE "bottle_id" = NEW."id"
                         AND "type" IN ('LABEL_APPLIED', 'REUSE_READY') ORDER BY "id" DESC LIMIT 1)) THEN
      RAISE EXCEPTION 'AYVO: a filled bottle needs its FILLED event' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "cycle_id" INTO member_cycle FROM "crate_assignments"
     WHERE "bottle_id" = NEW."id" AND "released_at" IS NULL;
    IF member_cycle IS NOT NULL THEN
      PERFORM ayvo_assert_crate_cycle(member_cycle);
    END IF;
  END IF;
  IF NEW."status" IN ('RETURNED', 'RETIRED', 'DISPOSED', 'READY_FOR_REUSE') THEN
    SELECT "type", "payload" INTO last_event FROM "bottle_events"
     WHERE "bottle_id" = NEW."id" AND "type" IN ('SORTED', 'RETIRED', 'DISPOSED', 'CORRECTION', 'REUSE_READY')
     ORDER BY "id" DESC LIMIT 1;
    backed := coalesce(
         (NEW."status" = 'RETURNED' AND (last_event."type" = 'CORRECTION'
            OR (last_event."type" = 'SORTED' AND last_event."payload"->>'outcome' = 'RETURNED')))
      OR (NEW."status" = 'RETIRED' AND last_event."type" = 'RETIRED')
      OR (NEW."status" = 'DISPOSED' AND last_event."type" = 'DISPOSED')
      OR (NEW."status" = 'READY_FOR_REUSE' AND last_event."type" = 'REUSE_READY'), false);
    IF NOT backed THEN
      RAISE EXCEPTION 'AYVO: bottle status % needs its event', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'READY_FOR_REUSE' THEN
      SELECT "id" INTO last_sorted FROM "bottle_events"
       WHERE "bottle_id" = NEW."id" AND "type" = 'SORTED' ORDER BY "id" DESC LIMIT 1;
      IF last_sorted IS NULL OR (SELECT count(*) FROM "bottle_events"
            WHERE "bottle_id" = NEW."id" AND "type" = 'REUSE_READY' AND "id" > last_sorted) <> 1 THEN
        RAISE EXCEPTION 'AYVO: a bottle is ready for reuse by exactly one REUSE_READY after its return'
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "bottle_component_attachments"
                  WHERE "bottle_id" = NEW."id" AND "component_type" = 'PUMP' AND "removed_at" IS NULL) THEN
        RAISE EXCEPTION 'AYVO: a bottle ready for reuse has no pump attached (closed for cleaning)'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    SELECT "id" INTO last_ready FROM "bottle_events"
     WHERE "bottle_id" = NEW."id" AND "type" = 'REUSE_READY' ORDER BY "id" DESC LIMIT 1;
    IF NEW."status" <> 'READY_FOR_REUSE' THEN
      last_ready := NULL;
    END IF;
    SELECT a.* INTO latest FROM "crate_assignments" a
     WHERE a."bottle_id" = NEW."id" AND (last_ready IS NULL OR a."assigned_event_id" < last_ready)
     ORDER BY a."assigned_at" DESC, a."id" DESC LIMIT 1;
    IF latest."id" IS NULL OR latest."released_at" IS NULL OR NOT EXISTS (
         SELECT 1 FROM "bottle_events" e
          WHERE e."bottle_id" = NEW."id" AND e."type" = 'SORTED' AND e."crate_cycle_id" = latest."cycle_id"
            AND (latest."released_event_id" = e."id" OR latest."release_reason" = 'CRATE_RETURNED')) THEN
      RAISE EXCEPTION 'AYVO: a % bottle was identified at a return from its latest crate', NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "crate_assignments" WHERE "bottle_id" = NEW."id" AND "released_at" IS NULL
                AND NOT (last_ready IS NOT NULL AND "source" = 'REUSE' AND "assigned_event_id" > last_ready)) THEN
      RAISE EXCEPTION 'AYVO: a % bottle is in no crate', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- =============================================================================================
-- Assignments: released by the bottle's SORTED or by its crate's line; a bottle freed with its
-- crate joins no crate before its own scan
-- =============================================================================================

CREATE OR REPLACE FUNCTION crate_assignments_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  release text[] := ARRAY['released_at','released_by','release_reason','release_operation_id',
                          'released_event_id','released_by_line_id'];
  st "CrateCycleStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: assignments are released, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."released_at" IS NOT NULL OR (to_jsonb(NEW) - release) IS DISTINCT FROM (to_jsonb(OLD) - release) THEN
    RAISE EXCEPTION 'AYVO: an assignment changes only by its one release' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT c."status" INTO st FROM "crate_cycles" c WHERE c."id" = OLD."cycle_id";
  IF st IN ('ALLOCATED', 'DISPATCHED') THEN
    RAISE EXCEPTION 'AYVO: a bottle never leaves a crate allocated to an order' USING ERRCODE = 'check_violation';
  END IF;
  IF st IN ('DELIVERED', 'RETURNED', 'CLOSED') THEN
    IF NOT (
         (NEW."release_reason" = 'RETURN_IDENTIFIED' AND NEW."released_by_line_id" IS NULL AND EXISTS (
            SELECT 1 FROM "bottle_events" e
             WHERE e."id" = NEW."released_event_id" AND e."type" = 'SORTED'
               AND e."bottle_id" = OLD."bottle_id" AND e."crate_cycle_id" = OLD."cycle_id"))
      OR (NEW."release_reason" = 'CRATE_RETURNED' AND NEW."released_event_id" IS NULL AND EXISTS (
            SELECT 1 FROM "return_receipt_lines" l
             WHERE l."id" = NEW."released_by_line_id" AND l."kind" = 'CRATE'
               AND l."returned_cycle_id" = OLD."cycle_id"))) THEN
      RAISE EXCEPTION 'AYVO: a shipped crate releases a bottle only by its SORTED (RETURN_IDENTIFIED) or by its own crate line (CRATE_RETURNED)'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."release_reason" IN ('RETURN_IDENTIFIED', 'CRATE_RETURNED')
        OR NEW."released_event_id" IS NOT NULL OR NEW."released_by_line_id" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: % releases only a member of a delivered crate', NEW."release_reason"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- At commit: as R3-b; and a bottle whose latest membership was freed with its returned crate is
-- still at the hotel by the records — it joins no crate until its own return scan (SORTED).
CREATE OR REPLACE FUNCTION crate_assignments_member_placeable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  st "BottleStatus";
  last_ready uuid;
  prev record;
BEGIN
  SELECT b."status" INTO st FROM "crate_assignments" a JOIN "bottles" b ON b."id" = a."bottle_id"
   WHERE a."id" = NEW."id" AND a."released_at" IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NEW."source" = 'REUSE' THEN
    SELECT "id" INTO last_ready FROM "bottle_events"
     WHERE "bottle_id" = NEW."bottle_id" AND "type" = 'REUSE_READY' ORDER BY "id" DESC LIMIT 1;
    IF st IS DISTINCT FROM 'READY_FOR_REUSE' OR last_ready IS NULL OR NEW."assigned_event_id" < last_ready THEN
      RAISE EXCEPTION 'AYVO: a REUSE member is a washed bottle placed after its REUSE_READY'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF st NOT IN ('LABELED_EMPTY', 'FILLED') THEN
    RAISE EXCEPTION 'AYVO: a crate takes a new member only in LABELED_EMPTY or FILLED'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT a.* INTO prev FROM "crate_assignments" a
   WHERE a."bottle_id" = NEW."bottle_id" AND a."id" <> NEW."id"
   ORDER BY a."assigned_at" DESC, a."id" DESC LIMIT 1;
  IF prev."release_reason" = 'CRATE_RETURNED' AND NOT EXISTS (
       SELECT 1 FROM "bottle_events" e
        WHERE e."bottle_id" = NEW."bottle_id" AND e."type" = 'SORTED' AND e."crate_cycle_id" = prev."cycle_id") THEN
    RAISE EXCEPTION 'AYVO: a bottle freed with its returned crate joins no crate before its own return scan'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

-- =============================================================================================
-- Cycles: the balance of a shipped cycle (§6.3 3)
-- =============================================================================================

CREATE OR REPLACE FUNCTION ayvo_assert_crate_cycle(p_cycle_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  cycle record;
  active int;
  filled int;
  returned int;
  freed int;
  held_by text;
  completed record;
  progress record;
  expected text;
  line record;
BEGIN
  SELECT * INTO cycle FROM "crate_cycles" WHERE "id" = p_cycle_id;
  SELECT count(*) FILTER (WHERE a."released_at" IS NULL),
         count(*) FILTER (WHERE a."released_at" IS NULL AND b."status" = 'FILLED'),
         count(*) FILTER (WHERE a."release_reason" = 'RETURN_IDENTIFIED'),
         count(*) FILTER (WHERE a."release_reason" = 'CRATE_RETURNED')
    INTO active, filled, returned, freed
    FROM "crate_assignments" a JOIN "bottles" b ON b."id" = a."bottle_id"
   WHERE a."cycle_id" = p_cycle_id;
  IF cycle."status" IN ('DELIVERED', 'RETURNED', 'CLOSED') THEN
    -- After the delivery the counters stay frozen; only an identification at a return or the
    -- crate's own return scan takes an active member away (doc 047 §4.3 2, §6.3 3).
    IF cycle."member_count" <> cycle."capacity" OR cycle."filled_count" <> cycle."capacity"
       OR active + returned + freed <> cycle."capacity" OR filled <> active THEN
      RAISE EXCEPTION 'AYVO: a delivered cycle keeps % = % active + % identified at a return + % freed with the crate, all filled',
        cycle."capacity", active, returned, freed USING ERRCODE = 'check_violation';
    END IF;
    IF freed <> 0 AND cycle."status" <> 'CLOSED' THEN
      RAISE EXCEPTION 'AYVO: members are freed with the crate only as it closes' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF returned <> 0 OR freed <> 0 THEN
      RAISE EXCEPTION 'AYVO: only a delivered cycle has members released by a return' USING ERRCODE = 'check_violation';
    END IF;
    IF cycle."member_count" <> active OR cycle."filled_count" <> filled THEN
      RAISE EXCEPTION 'AYVO: cycle counters %/% differ from % active and % filled members',
        cycle."member_count", cycle."filled_count", active, filled USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (cycle."status" = 'OPEN_ASSEMBLY' AND (active >= cycle."capacity" OR filled <> 0))
     OR (cycle."status" = 'READY_TO_FILL' AND (active <> cycle."capacity" OR filled <> 0))
     OR (cycle."status" IN ('FILLED', 'ALLOCATED', 'DISPATCHED') AND (active <> cycle."capacity" OR filled <> cycle."capacity"))
     OR (cycle."status" = 'ABORTED' AND active <> 0) THEN
    RAISE EXCEPTION 'AYVO: cycle status % does not match % members / % filled of %',
      cycle."status", active, filled, cycle."capacity" USING ERRCODE = 'check_violation';
  END IF;
  IF cycle."status" = 'READY_TO_FILL' AND (cycle."ready_to_fill_at" IS NULL OR NOT EXISTS (
       SELECT 1 FROM "crate_events" e WHERE e."cycle_id" = p_cycle_id AND e."type" = 'READY_TO_FILL')) THEN
    RAISE EXCEPTION 'AYVO: READY_TO_FILL without its event' USING ERRCODE = 'check_violation';
  END IF;
  IF cycle."status" IN ('FILLED', 'ALLOCATED', 'DISPATCHED', 'DELIVERED', 'RETURNED', 'CLOSED') AND NOT EXISTS (
       SELECT 1 FROM "crate_events" e WHERE e."cycle_id" = p_cycle_id AND e."type" = 'CRATE_FILLED'
          AND e."occurred_at" = cycle."filled_at") THEN
    RAISE EXCEPTION 'AYVO: FILLED only by Hotovo (its CRATE_FILLED event)' USING ERRCODE = 'check_violation';
  END IF;
  IF cycle."status" = 'FILLING' AND NOT EXISTS (
       SELECT 1 FROM "crate_assignments" a JOIN "bottles" b ON b."id" = a."bottle_id"
        WHERE a."cycle_id" = p_cycle_id AND b."status" = 'FILLED') THEN
    RAISE EXCEPTION 'AYVO: a FILLING cycle has had a filled member' USING ERRCODE = 'check_violation';
  END IF;
  SELECT o."status"::text INTO held_by
    FROM "order_crate_allocations" oa JOIN "orders" o ON o."id" = oa."order_id"
   WHERE oa."cycle_id" = p_cycle_id AND oa."released_at" IS NULL AND oa."completed_at" IS NULL;
  IF (cycle."status" IN ('ALLOCATED', 'DISPATCHED', 'DELIVERED')) <> (held_by IS NOT NULL) THEN
    RAISE EXCEPTION 'AYVO: a crate cycle is ALLOCATED exactly while an order holds it' USING ERRCODE = 'check_violation';
  END IF;
  IF held_by IS NOT NULL THEN
    SELECT pp."picked_up_source", pp."delivered_at" INTO progress
      FROM "shipment_parcels" p JOIN "shipments" s ON s."id" = p."shipment_id" AND s."status" <> 'CANCELLED'
      LEFT JOIN "shipment_parcel_progress" pp ON pp."parcel_id" = p."id"
     WHERE p."cycle_id" = p_cycle_id;
    expected := CASE WHEN progress."delivered_at" IS NOT NULL THEN 'DELIVERED'
                     WHEN progress."picked_up_source" IS NOT NULL THEN 'DISPATCHED'
                     ELSE 'ALLOCATED' END;
    IF cycle."status"::text <> expected THEN
      RAISE EXCEPTION 'AYVO: a crate cycle is % while its parcel says %', cycle."status", expected
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT oa.* INTO completed FROM "order_crate_allocations" oa
   WHERE oa."cycle_id" = p_cycle_id AND oa."released_at" IS NULL AND oa."completed_at" IS NOT NULL;
  IF (cycle."status" IN ('RETURNED', 'CLOSED')) <> (completed."id" IS NOT NULL) THEN
    RAISE EXCEPTION 'AYVO: a crate cycle is RETURNED or CLOSED exactly when its allocation is completed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF cycle."status" IN ('RETURNED', 'CLOSED') THEN
    SELECT l.* INTO line FROM "return_receipt_lines" l
     WHERE l."returned_cycle_id" = p_cycle_id AND l."kind" = 'CRATE' AND l."crate_id" = cycle."crate_id"
       AND l."allocation_id" = completed."id" AND l."id" = completed."completed_line_id";
    IF line."id" IS NULL OR NOT EXISTS (
         SELECT 1 FROM "crate_events" e WHERE e."cycle_id" = p_cycle_id AND e."type" = 'RETURNED') THEN
      RAISE EXCEPTION 'AYVO: a RETURNED cycle needs its crate line, its completed allocation and its RETURNED event'
        USING ERRCODE = 'check_violation';
    END IF;
    IF cycle."status" = 'CLOSED' AND (line."emptied_at" IS NULL OR NOT EXISTS (
         SELECT 1 FROM "crate_events" e WHERE e."cycle_id" = p_cycle_id AND e."type" = 'EMPTIED')) THEN
      RAISE EXCEPTION 'AYVO: a CLOSED cycle needs its emptied line and its EMPTIED event'
        USING ERRCODE = 'check_violation';
    END IF;
    -- R1.1: a crate line emptied at its scan (no count) freed the crate — no active member left.
    -- An R1 line (emptied with its count) keeps its never-identified members active (§6.3 6).
    IF cycle."status" = 'CLOSED' AND line."physical_count" IS NULL AND active <> 0 THEN
      RAISE EXCEPTION 'AYVO: a crate freed by its return scan has no active member left (% active)', active
        USING ERRCODE = 'check_violation';
    END IF;
    IF freed <> 0 AND (line."physical_count" IS NOT NULL OR EXISTS (
         SELECT 1 FROM "crate_assignments" a
          WHERE a."cycle_id" = p_cycle_id AND a."release_reason" = 'CRATE_RETURNED'
            AND a."released_by_line_id" IS DISTINCT FROM line."id")) THEN
      RAISE EXCEPTION 'AYVO: members are freed only by their own cycle''s crate line' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END
$$;
