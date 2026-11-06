-- Return intake R1 (doc 047 §4; owner approved the model on 69d90c8, 2026-11-06, PR #126):
-- receipts, lines (one physical container each), issues, defective pump counts; the shipment
-- record is never rewritten — the crate scan completes its allocation, a bottle's identification
-- (SORTED) releases its assignment, Vyprázdněno closes the cycle; the next circulation of the same
-- crate is a new cycle.
-- CreateEnum
CREATE TYPE "ReturnReceiptState" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ReturnLineKind" AS ENUM ('CRATE', 'CONTAINER');

-- CreateEnum
CREATE TYPE "ReturnIssueKind" AS ENUM ('UNREADABLE', 'NOT_DELIVERED', 'NOT_IN_CIRCULATION', 'OTHER_SITE', 'COUNT_MISMATCH');

-- CreateEnum
CREATE TYPE "ReturnIssueResolution" AS ENUM ('IDENTIFIED', 'NOT_AYVO', 'WRITTEN_OFF');
-- AlterTable
ALTER TABLE "bottle_events" ADD COLUMN     "resolves_issue_id" UUID,
ADD COLUMN     "return_line_id" UUID;

-- AlterTable
ALTER TABLE "crate_assignments" ADD COLUMN     "released_event_id" UUID;

-- AlterTable
ALTER TABLE "order_crate_allocations" ADD COLUMN     "completed_at" TIMESTAMPTZ(3),
ADD COLUMN     "completed_by" UUID,
ADD COLUMN     "completed_line_id" UUID;

-- CreateTable
CREATE TABLE "return_receipts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "site_id" UUID NOT NULL,
    "hotel_id" UUID,
    "state" "ReturnReceiptState" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_by" UUID NOT NULL,
    "open_operation_id" UUID NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" UUID,
    "close_operation_id" UUID,

    CONSTRAINT "return_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_receipt_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "receipt_id" UUID NOT NULL,
    "kind" "ReturnLineKind" NOT NULL,
    "crate_id" UUID,
    "returned_cycle_id" UUID,
    "allocation_id" UUID,
    "scanned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scanned_by" UUID NOT NULL,
    "scan_operation_id" UUID NOT NULL,
    "emptied_at" TIMESTAMPTZ(3),
    "emptied_by" UUID,
    "empty_operation_id" UUID,
    "physical_count" INTEGER,

    CONSTRAINT "return_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_receipt_issues" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "receipt_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "kind" "ReturnIssueKind" NOT NULL,
    "bottle_id" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,
    "record_operation_id" UUID NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" UUID,
    "resolution" "ReturnIssueResolution",
    "resolution_reason" TEXT,
    "resolve_operation_id" UUID,
    "resolving_event_id" UUID,

    CONSTRAINT "return_receipt_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_pump_counts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "receipt_id" UUID NOT NULL,
    "defective" INTEGER NOT NULL,
    "reason" TEXT,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,
    "operation_id" UUID NOT NULL,

    CONSTRAINT "return_pump_counts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "return_receipts_serial_key" ON "return_receipts"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "return_receipts_code_key" ON "return_receipts"("code");

-- CreateIndex
CREATE INDEX "return_receipts_site_id_serial_idx" ON "return_receipts"("site_id", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "return_receipt_lines_returned_cycle_id_key" ON "return_receipt_lines"("returned_cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_receipt_lines_allocation_id_key" ON "return_receipt_lines"("allocation_id");

-- CreateIndex
CREATE INDEX "return_receipt_lines_receipt_id_idx" ON "return_receipt_lines"("receipt_id");

-- CreateIndex
CREATE INDEX "return_receipt_lines_crate_id_idx" ON "return_receipt_lines"("crate_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_receipt_issues_serial_key" ON "return_receipt_issues"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "return_receipt_issues_code_key" ON "return_receipt_issues"("code");

-- CreateIndex
CREATE UNIQUE INDEX "return_receipt_issues_resolving_event_id_key" ON "return_receipt_issues"("resolving_event_id");

-- CreateIndex
CREATE INDEX "return_receipt_issues_receipt_id_idx" ON "return_receipt_issues"("receipt_id");

-- CreateIndex
CREATE INDEX "return_receipt_issues_line_id_idx" ON "return_receipt_issues"("line_id");

-- CreateIndex
CREATE INDEX "return_receipt_issues_bottle_id_idx" ON "return_receipt_issues"("bottle_id");

-- CreateIndex
CREATE INDEX "return_pump_counts_receipt_id_idx" ON "return_pump_counts"("receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "bottle_events_resolves_issue_id_key" ON "bottle_events"("resolves_issue_id");

-- CreateIndex
CREATE UNIQUE INDEX "crate_assignments_released_event_id_key" ON "crate_assignments"("released_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_crate_allocations_completed_line_id_key" ON "order_crate_allocations"("completed_line_id");

-- AddForeignKey
ALTER TABLE "bottle_events" ADD CONSTRAINT "bottle_events_return_line_id_fkey" FOREIGN KEY ("return_line_id") REFERENCES "return_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_events" ADD CONSTRAINT "bottle_events_resolves_issue_id_fkey" FOREIGN KEY ("resolves_issue_id") REFERENCES "return_receipt_issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_assignments" ADD CONSTRAINT "crate_assignments_released_event_id_fkey" FOREIGN KEY ("released_event_id") REFERENCES "bottle_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_crate_allocations" ADD CONSTRAINT "order_crate_allocations_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_crate_allocations" ADD CONSTRAINT "order_crate_allocations_completed_line_id_fkey" FOREIGN KEY ("completed_line_id") REFERENCES "return_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipts" ADD CONSTRAINT "return_receipts_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipts" ADD CONSTRAINT "return_receipts_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipts" ADD CONSTRAINT "return_receipts_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipts" ADD CONSTRAINT "return_receipts_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipts" ADD CONSTRAINT "return_receipts_open_operation_id_fkey" FOREIGN KEY ("open_operation_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipts" ADD CONSTRAINT "return_receipts_close_operation_id_fkey" FOREIGN KEY ("close_operation_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "return_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_crate_id_fkey" FOREIGN KEY ("crate_id") REFERENCES "crates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_returned_cycle_id_fkey" FOREIGN KEY ("returned_cycle_id") REFERENCES "crate_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "order_crate_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_scanned_by_fkey" FOREIGN KEY ("scanned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_emptied_by_fkey" FOREIGN KEY ("emptied_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_scan_operation_id_fkey" FOREIGN KEY ("scan_operation_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_empty_operation_id_fkey" FOREIGN KEY ("empty_operation_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_issues" ADD CONSTRAINT "return_receipt_issues_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "return_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_issues" ADD CONSTRAINT "return_receipt_issues_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "return_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_issues" ADD CONSTRAINT "return_receipt_issues_bottle_id_fkey" FOREIGN KEY ("bottle_id") REFERENCES "bottles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_issues" ADD CONSTRAINT "return_receipt_issues_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_issues" ADD CONSTRAINT "return_receipt_issues_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_issues" ADD CONSTRAINT "return_receipt_issues_record_operation_id_fkey" FOREIGN KEY ("record_operation_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_issues" ADD CONSTRAINT "return_receipt_issues_resolve_operation_id_fkey" FOREIGN KEY ("resolve_operation_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipt_issues" ADD CONSTRAINT "return_receipt_issues_resolving_event_id_fkey" FOREIGN KEY ("resolving_event_id") REFERENCES "bottle_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_pump_counts" ADD CONSTRAINT "return_pump_counts_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "return_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_pump_counts" ADD CONSTRAINT "return_pump_counts_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_pump_counts" ADD CONSTRAINT "return_pump_counts_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================================
-- Codes and shapes
-- =============================================================================================

INSERT INTO "code_counters" ("name", "last_value") VALUES ('return_receipt', 0), ('return_issue', 0);

ALTER TABLE "return_receipts"
  ADD CONSTRAINT "return_receipts_code_check" CHECK ("code" = ayvo_format_code('RR-', "serial")),
  ADD CONSTRAINT "return_receipts_closed_check" CHECK (
    ("state" = 'OPEN') = ("closed_at" IS NULL)
    AND ("closed_at" IS NULL) = ("closed_by" IS NULL)
    AND ("closed_at" IS NULL) = ("close_operation_id" IS NULL));

ALTER TABLE "return_receipt_lines"
  ADD CONSTRAINT "return_receipt_lines_kind_check" CHECK (
    ("kind" = 'CRATE') = ("crate_id" IS NOT NULL)
    AND ("crate_id" IS NULL) = ("returned_cycle_id" IS NULL)
    AND ("crate_id" IS NULL) = ("allocation_id" IS NULL)),
  ADD CONSTRAINT "return_receipt_lines_emptied_check" CHECK (
    ("emptied_at" IS NULL) = ("emptied_by" IS NULL)
    AND ("emptied_at" IS NULL) = ("empty_operation_id" IS NULL)
    AND ("emptied_at" IS NULL) = ("physical_count" IS NULL)
    AND ("physical_count" IS NULL OR "physical_count" >= 0));

ALTER TABLE "return_receipt_issues"
  ADD CONSTRAINT "return_receipt_issues_code_check" CHECK ("code" = ayvo_format_code('RI-', "serial")),
  -- Only NOT_DELIVERED and NOT_IN_CIRCULATION name a bottle; OTHER_SITE never does (doc 047 §4.6).
  ADD CONSTRAINT "return_receipt_issues_bottle_check" CHECK (
    ("kind" IN ('NOT_DELIVERED', 'NOT_IN_CIRCULATION')) = ("bottle_id" IS NOT NULL)),
  ADD CONSTRAINT "return_receipt_issues_resolution_check" CHECK (
    ("resolved_at" IS NULL) = ("resolution" IS NULL)
    AND ("resolved_at" IS NULL) = ("resolved_by" IS NULL)
    AND ("resolved_at" IS NULL) = ("resolve_operation_id" IS NULL)
    AND coalesce("resolution" = 'IDENTIFIED', false) = ("resolving_event_id" IS NOT NULL)
    AND ("resolution" IS NULL OR "resolution" = 'IDENTIFIED' OR "resolution_reason" IS NOT NULL)
    AND ("kind" <> 'COUNT_MISMATCH' OR "resolved_at" IS NULL)
    AND ("kind" <> 'OTHER_SITE' OR "resolution" IS NULL OR "resolution" = 'WRITTEN_OFF'));

ALTER TABLE "return_pump_counts"
  ADD CONSTRAINT "return_pump_counts_defective_check" CHECK ("defective" <> 0 AND ("defective" > 0 OR "reason" IS NOT NULL));

-- A cycle is identified once per bottle; one open piece issue per bottle (doc 047 §4.2, §4.8a).
CREATE UNIQUE INDEX "bottle_events_one_sorted_per_cycle"
  ON "bottle_events" ("bottle_id", "crate_cycle_id") WHERE "type" = 'SORTED';
CREATE UNIQUE INDEX "return_receipt_issues_one_open_per_bottle"
  ON "return_receipt_issues" ("bottle_id") WHERE "resolved_at" IS NULL AND "bottle_id" IS NOT NULL;
CREATE INDEX "bottle_events_return_line_idx" ON "bottle_events" ("return_line_id") WHERE "return_line_id" IS NOT NULL;

-- =============================================================================================
-- Receipts, lines, issues, pump counts
-- =============================================================================================

CREATE FUNCTION return_receipts_guard() RETURNS trigger
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
  IF EXISTS (SELECT 1 FROM "return_receipt_lines" l WHERE l."receipt_id" = OLD."id" AND l."emptied_at" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: a return receipt closes only with every line emptied' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION return_receipt_lines_guard() RETURNS trigger
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
    -- A CRATE line: a crate of the receipt's site whose delivered cycle is held by this live
    -- allocation, its parcel delivered (doc 047 §4.3, §4.6).
    IF NEW."kind" = 'CRATE' AND NOT EXISTS (
         SELECT 1 FROM "crates" c
           JOIN "crate_cycles" cy ON cy."id" = NEW."returned_cycle_id" AND cy."crate_id" = c."id"
           JOIN "order_crate_allocations" oa ON oa."id" = NEW."allocation_id" AND oa."cycle_id" = cy."id"
                AND oa."crate_id" = c."id" AND oa."released_at" IS NULL AND oa."completed_at" IS NULL
           JOIN "shipment_parcels" p ON p."allocation_id" = oa."id"
           JOIN "shipments" s ON s."id" = p."shipment_id" AND s."status" <> 'CANCELLED'
           JOIN "shipment_parcel_progress" pp ON pp."parcel_id" = p."id" AND pp."delivered_at" IS NOT NULL
          WHERE c."id" = NEW."crate_id" AND c."site_id" = receipt."site_id" AND cy."status" = 'DELIVERED') THEN
      RAISE EXCEPTION 'AYVO: a crate line is a delivered crate of the receipt''s site, held by its delivered allocation'
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

-- At commit: a CRATE line ⇔ its cycle RETURNED or CLOSED; emptied ⇔ CLOSED (doc 047 §4.3 7).
CREATE FUNCTION return_receipt_lines_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  st "CrateCycleStatus";
BEGIN
  IF NEW."kind" = 'CRATE' THEN
    SELECT "status" INTO st FROM "crate_cycles" WHERE "id" = NEW."returned_cycle_id";
    IF st NOT IN ('RETURNED', 'CLOSED') OR (st = 'CLOSED') <> (NEW."emptied_at" IS NOT NULL) THEN
      RAISE EXCEPTION 'AYVO: a crate line''s cycle is RETURNED, and CLOSED exactly when the line is emptied (%)', st
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM ayvo_assert_crate_cycle(NEW."returned_cycle_id");
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "return_receipts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "return_receipts"
  FOR EACH ROW EXECUTE FUNCTION return_receipts_guard();
CREATE TRIGGER "return_receipts_no_truncate" BEFORE TRUNCATE ON "return_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "return_receipt_lines_guard" BEFORE INSERT OR UPDATE OR DELETE ON "return_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION return_receipt_lines_guard();
CREATE TRIGGER "return_receipt_lines_no_truncate" BEFORE TRUNCATE ON "return_receipt_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE CONSTRAINT TRIGGER "return_receipt_lines_consistent" AFTER INSERT OR UPDATE ON "return_receipt_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION return_receipt_lines_consistent();

CREATE FUNCTION return_receipt_issues_guard() RETURNS trigger
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

CREATE TRIGGER "return_receipt_issues_guard" BEFORE INSERT OR UPDATE OR DELETE ON "return_receipt_issues"
  FOR EACH ROW EXECUTE FUNCTION return_receipt_issues_guard();
CREATE TRIGGER "return_receipt_issues_no_truncate" BEFORE TRUNCATE ON "return_receipt_issues"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

CREATE FUNCTION return_pump_counts_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "return_receipts" r WHERE r."id" = NEW."receipt_id" AND r."state" = 'OPEN') THEN
    RAISE EXCEPTION 'AYVO: pumps are counted in an open receipt' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "return_pump_counts_insert_check" BEFORE INSERT ON "return_pump_counts"
  FOR EACH ROW EXECUTE FUNCTION return_pump_counts_insert_check();
CREATE TRIGGER "return_pump_counts_immutable" BEFORE UPDATE OR DELETE ON "return_pump_counts"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "return_pump_counts_no_truncate" BEFORE TRUNCATE ON "return_pump_counts"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- Bottle events of the return (doc 047 §4.5–§4.7)
-- =============================================================================================

CREATE FUNCTION bottle_events_return_rules() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  bottle record;
  line record;
  issue record;
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
    SELECT l.*, r."site_id", r."state" INTO line
      FROM "return_receipt_lines" l JOIN "return_receipts" r ON r."id" = l."receipt_id"
     WHERE l."id" = NEW."return_line_id";
    IF line."site_id" <> bottle."site_id" THEN
      RAISE EXCEPTION 'AYVO: a bottle is identified only in a receipt of its own site' USING ERRCODE = 'check_violation';
    END IF;
    -- The anchor: still an active member of that delivered cycle, assigned before the line existed,
    -- and one of the bottles its delivered allocation recorded (doc 047 §4.6, check 5).
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
    IF NEW."resolves_issue_id" IS NULL THEN
      IF line."state" <> 'OPEN' OR line."emptied_at" IS NOT NULL THEN
        RAISE EXCEPTION 'AYVO: a scan goes only into a not-emptied line of an open receipt' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT * INTO issue FROM "return_receipt_issues" WHERE "id" = NEW."resolves_issue_id";
      IF issue."line_id" <> NEW."return_line_id" OR issue."resolved_at" IS NOT NULL
         OR issue."kind" NOT IN ('UNREADABLE', 'NOT_DELIVERED', 'NOT_IN_CIRCULATION')
         OR (issue."bottle_id" IS NOT NULL AND issue."bottle_id" <> NEW."bottle_id") THEN
        RAISE EXCEPTION 'AYVO: SORTED resolves an open piece issue of its own line and bottle' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."type" = 'RETIRED' THEN
    IF bottle."status" NOT IN ('FILLED', 'RETURNED') OR coalesce(NEW."payload"->>'reason', '') = '' THEN
      RAISE EXCEPTION 'AYVO: a returned bottle is retired with a reason' USING ERRCODE = 'check_violation';
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

CREATE TRIGGER "bottle_events_return_rules" BEFORE INSERT ON "bottle_events"
  FOR EACH ROW EXECUTE FUNCTION bottle_events_return_rules();

-- At commit: every SORTED is a complete identification (doc 047 §4.5): it released exactly its
-- assignment of that cycle (RETURN_IDENTIFIED, released_event_id), the bottle is in its outcome
-- status (a defective one also RETIRED by the same operation), and a resolving SORTED is its
-- issue's resolving event (§4.8a).
CREATE FUNCTION bottle_events_sorted_complete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  outcome text;
  retired boolean;
BEGIN
  IF NEW."type" <> 'SORTED' THEN
    RETURN NULL;
  END IF;
  outcome := NEW."payload"->>'outcome';
  IF (SELECT count(*) FROM "crate_assignments" a
       WHERE a."released_event_id" = NEW."id" AND a."bottle_id" = NEW."bottle_id"
         AND a."cycle_id" = NEW."crate_cycle_id" AND a."release_reason" = 'RETURN_IDENTIFIED'
         AND a."released_at" IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION 'AYVO: a SORTED releases its assignment of that cycle' USING ERRCODE = 'check_violation';
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

CREATE CONSTRAINT TRIGGER "bottle_events_sorted_complete" AFTER INSERT ON "bottle_events"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bottle_events_sorted_complete();

-- Statuses: the existing path plus the return (doc 047 §4.7). DISPOSED never changes.
CREATE OR REPLACE FUNCTION bottles_status_transition() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'CREATED' AND NEW."status" = 'LABELED_EMPTY')
     AND NOT (OLD."status" = 'LABELED_EMPTY' AND NEW."status" = 'FILLED')
     AND NOT (OLD."status" = 'FILLED' AND NEW."status" IN ('RETURNED', 'RETIRED'))
     AND NOT (OLD."status" = 'RETURNED' AND NEW."status" = 'RETIRED')
     AND NOT (OLD."status" = 'RETIRED' AND NEW."status" IN ('DISPOSED', 'RETURNED')) THEN
    RAISE EXCEPTION 'AYVO: bottle status % → % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- At commit: every status is backed by its event; a returned, retired or disposed bottle is in no crate.
CREATE OR REPLACE FUNCTION bottles_labeled_has_event() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  member_cycle uuid;
  last_event record;
BEGIN
  IF NEW."status" = 'LABELED_EMPTY' AND NOT EXISTS (
       SELECT 1 FROM "bottle_events" WHERE "bottle_id" = NEW."id" AND "type" = 'LABEL_APPLIED') THEN
    RAISE EXCEPTION 'AYVO: a labelled bottle needs its LABEL_APPLIED event' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'FILLED' THEN
    IF NOT EXISTS (SELECT 1 FROM "bottle_events" WHERE "bottle_id" = NEW."id" AND "type" = 'FILLED') THEN
      RAISE EXCEPTION 'AYVO: a filled bottle needs its FILLED event' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "cycle_id" INTO member_cycle FROM "crate_assignments"
     WHERE "bottle_id" = NEW."id" AND "released_at" IS NULL;
    IF member_cycle IS NOT NULL THEN
      PERFORM ayvo_assert_crate_cycle(member_cycle);
    END IF;
  END IF;
  IF NEW."status" IN ('RETURNED', 'RETIRED', 'DISPOSED') THEN
    SELECT "type", "payload" INTO last_event FROM "bottle_events"
     WHERE "bottle_id" = NEW."id" AND "type" IN ('SORTED', 'RETIRED', 'DISPOSED', 'CORRECTION')
     ORDER BY "id" DESC LIMIT 1;
    IF NOT ((NEW."status" = 'RETURNED' AND (last_event."type" = 'CORRECTION'
               OR (last_event."type" = 'SORTED' AND last_event."payload"->>'outcome' = 'RETURNED')))
         OR (NEW."status" = 'RETIRED' AND last_event."type" = 'RETIRED')
         OR (NEW."status" = 'DISPOSED' AND last_event."type" = 'DISPOSED')) THEN
      RAISE EXCEPTION 'AYVO: bottle status % needs its event', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "crate_assignments" WHERE "bottle_id" = NEW."id" AND "released_at" IS NULL) THEN
      RAISE EXCEPTION 'AYVO: a % bottle is in no crate', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- =============================================================================================
-- Assignments: a shipped crate releases a bottle only by its identification (doc 047 §4.3 3)
-- =============================================================================================

CREATE OR REPLACE FUNCTION crate_assignments_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  release text[] := ARRAY['released_at','released_by','release_reason','release_operation_id','released_event_id'];
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
    IF NEW."release_reason" IS DISTINCT FROM 'RETURN_IDENTIFIED' OR NOT EXISTS (
         SELECT 1 FROM "bottle_events" e
          WHERE e."id" = NEW."released_event_id" AND e."type" = 'SORTED'
            AND e."bottle_id" = OLD."bottle_id" AND e."crate_cycle_id" = OLD."cycle_id") THEN
      RAISE EXCEPTION 'AYVO: a shipped crate releases a bottle only by its SORTED (RETURN_IDENTIFIED)'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."release_reason" = 'RETURN_IDENTIFIED' OR NEW."released_event_id" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: RETURN_IDENTIFIED releases only a member of a delivered crate' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =============================================================================================
-- Crate cycles: DELIVERED → RETURNED → CLOSED, the filling date and the counts kept (§4.3 7)
-- =============================================================================================

ALTER TABLE "crate_cycles" DROP CONSTRAINT "crate_cycles_filled_at_check";
ALTER TABLE "crate_cycles"
  ADD CONSTRAINT "crate_cycles_filled_at_check"
    CHECK (("status" IN ('FILLED', 'ALLOCATED', 'DISPATCHED', 'DELIVERED', 'RETURNED', 'CLOSED')) = ("filled_at" IS NOT NULL));

DROP INDEX "crate_cycles_one_open_per_crate";
CREATE UNIQUE INDEX "crate_cycles_one_open_per_crate"
  ON "crate_cycles" ("crate_id") WHERE "status" NOT IN ('ABORTED', 'CLOSED');

CREATE OR REPLACE FUNCTION crate_cycles_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  mutable text[] := ARRAY['status','member_count','filled_count','ready_to_fill_at','filled_at',
                          'aborted_at','aborted_by','abort_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: crate cycles are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'AYVO: a crate cycle snapshot is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'ABORTED' THEN
    RAISE EXCEPTION 'AYVO: an aborted crate cycle never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'AYVO: a closed crate cycle never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  -- After the delivery only the return moves a cycle, and only its status (doc 047 §4.3 7).
  IF OLD."status" IN ('DELIVERED', 'RETURNED') AND (
       NEW."status" <> CASE OLD."status" WHEN 'DELIVERED' THEN 'RETURNED'::"CrateCycleStatus" ELSE 'CLOSED'::"CrateCycleStatus" END
       OR (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')) THEN
    RAISE EXCEPTION 'AYVO: a delivered crate cycle changes only DELIVERED → RETURNED → CLOSED' USING ERRCODE = 'restrict_violation';
  END IF;
  -- A cycle with the carrier changes only by its delivery (nothing else of it, ever).
  IF OLD."status" = 'DISPATCHED' AND (NEW."status" <> 'DELIVERED'
       OR (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')) THEN
    RAISE EXCEPTION 'AYVO: a dispatched crate cycle changes only to delivered' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'OPEN_ASSEMBLY' AND NEW."status" IN ('READY_TO_FILL', 'FILLING', 'ABORTED'))
    OR (OLD."status" = 'READY_TO_FILL' AND NEW."status" IN ('OPEN_ASSEMBLY', 'FILLING', 'ABORTED'))
    OR (OLD."status" = 'FILLING' AND NEW."status" IN ('FILLED', 'ABORTED'))
    OR (OLD."status" = 'FILLED' AND NEW."status" IN ('FILLING', 'ALLOCATED'))
    OR (OLD."status" = 'ALLOCATED' AND NEW."status" IN ('FILLED', 'DISPATCHED', 'DELIVERED'))
    OR (OLD."status" = 'DISPATCHED' AND NEW."status" = 'DELIVERED')
    OR (OLD."status" = 'DELIVERED' AND NEW."status" = 'RETURNED')
    OR (OLD."status" = 'RETURNED' AND NEW."status" = 'CLOSED')) THEN
    RAISE EXCEPTION 'AYVO: crate cycle % → % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'FILLING' AND OLD."status" IN ('OPEN_ASSEMBLY', 'READY_TO_FILL') AND NEW."filled_count" < 1 THEN
    RAISE EXCEPTION 'AYVO: a crate enters FILLING only with a filled member' USING ERRCODE = 'check_violation';
  END IF;
  -- Allocation, its release, the dispatch, the delivery and the return keep the finished crate exactly as it was.
  IF (OLD."status" IN ('ALLOCATED', 'DISPATCHED', 'DELIVERED', 'RETURNED')
      OR NEW."status" IN ('ALLOCATED', 'DISPATCHED', 'DELIVERED', 'RETURNED', 'CLOSED'))
     AND (NEW."member_count" <> OLD."member_count" OR NEW."filled_count" <> OLD."filled_count"
          OR NEW."filled_at" IS DISTINCT FROM OLD."filled_at"
          OR NEW."ready_to_fill_at" IS DISTINCT FROM OLD."ready_to_fill_at") THEN
    RAISE EXCEPTION 'AYVO: an allocated crate keeps its members' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION ayvo_assert_crate_cycle(p_cycle_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  cycle record;
  active int;
  filled int;
  returned int;
  held_by text;
  completed record;
  progress record;
  expected text;
  line record;
BEGIN
  SELECT * INTO cycle FROM "crate_cycles" WHERE "id" = p_cycle_id;
  SELECT count(*) FILTER (WHERE a."released_at" IS NULL),
         count(*) FILTER (WHERE a."released_at" IS NULL AND b."status" = 'FILLED'),
         count(*) FILTER (WHERE a."release_reason" = 'RETURN_IDENTIFIED')
    INTO active, filled, returned
    FROM "crate_assignments" a JOIN "bottles" b ON b."id" = a."bottle_id"
   WHERE a."cycle_id" = p_cycle_id;
  IF cycle."status" IN ('DELIVERED', 'RETURNED', 'CLOSED') THEN
    -- After the delivery the counters stay frozen; only an identification at a return takes an
    -- active member away (doc 047 §4.3 2).
    IF cycle."member_count" <> cycle."capacity" OR cycle."filled_count" <> cycle."capacity"
       OR active + returned <> cycle."capacity" OR filled <> active THEN
      RAISE EXCEPTION 'AYVO: a delivered cycle keeps % = % active + % identified at a return, all filled',
        cycle."capacity", active, returned USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF returned <> 0 THEN
      RAISE EXCEPTION 'AYVO: only a delivered cycle has members identified at a return' USING ERRCODE = 'check_violation';
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
  -- ALLOCATED, DISPATCHED or DELIVERED ⇔ held by exactly one live order allocation (doc 028); a
  -- completed allocation no longer holds the crate (doc 047 §4.3 1).
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
  -- RETURNED / CLOSED: exactly through a real line of a receipt (doc 047 §4.3 7).
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
  END IF;
END
$$;

-- =============================================================================================
-- Order allocations: completed once by the crate scan, still the order's history (§4.3 1, 4, 5)
-- =============================================================================================

DROP INDEX "order_crate_allocations_one_active_per_cycle";
DROP INDEX "order_crate_allocations_one_active_per_crate";
CREATE UNIQUE INDEX "order_crate_allocations_one_active_per_cycle"
  ON "order_crate_allocations" ("cycle_id") WHERE "released_at" IS NULL AND "completed_at" IS NULL;
CREATE UNIQUE INDEX "order_crate_allocations_one_active_per_crate"
  ON "order_crate_allocations" ("crate_id") WHERE "released_at" IS NULL AND "completed_at" IS NULL;

ALTER TABLE "order_crate_allocations"
  ADD CONSTRAINT "order_crate_allocations_completed_check" CHECK (
    ("completed_at" IS NULL) = ("completed_by" IS NULL)
    AND ("completed_at" IS NULL) = ("completed_line_id" IS NULL)
    AND ("completed_at" IS NULL OR "released_at" IS NULL));

CREATE OR REPLACE FUNCTION order_crate_allocations_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  completion text[] := ARRAY['completed_at','completed_by','completed_line_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: allocations are released, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."released_at" IS NOT NULL OR OLD."completed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: an allocation changes only by its one release or completion' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."completed_at" IS NOT NULL THEN
    -- Completed only by the crate scan of a return: its parcel delivered, its own line (doc 047 §4.3 1).
    IF (to_jsonb(NEW) - completion) IS DISTINCT FROM (to_jsonb(OLD) - completion) THEN
      RAISE EXCEPTION 'AYVO: a completion changes nothing else of the allocation' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM "shipment_parcels" p
           JOIN "shipments" s ON s."id" = p."shipment_id" AND s."status" <> 'CANCELLED'
           JOIN "shipment_parcel_progress" pp ON pp."parcel_id" = p."id" AND pp."delivered_at" IS NOT NULL
          WHERE p."allocation_id" = OLD."id")
       OR NOT EXISTS (
         SELECT 1 FROM "return_receipt_lines" l
          WHERE l."id" = NEW."completed_line_id" AND l."kind" = 'CRATE' AND l."allocation_id" = OLD."id"
            AND l."returned_cycle_id" = OLD."cycle_id" AND l."crate_id" = OLD."crate_id") THEN
      RAISE EXCEPTION 'AYVO: only a delivered allocation is completed, by its own crate line' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['released_at','released_by','release_reason','release_operation_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['released_at','released_by','release_reason','release_operation_id']) THEN
    RAISE EXCEPTION 'AYVO: an allocation changes only by its one release' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Removed while the order is open, or released by its cancellation; never from a ready order.
  IF NOT EXISTS (SELECT 1 FROM "orders" o WHERE o."id" = OLD."order_id" AND o."status" IN ('OPEN', 'CANCELLED')) THEN
    RAISE EXCEPTION 'AYVO: a crate leaves only an open or cancelled order' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- "Records exactly the crate's active members" holds for a live allocation; a completed one is
-- its insert-only order_allocation_bottles (doc 047 §4.3 4).
CREATE OR REPLACE FUNCTION order_crate_allocations_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  capacity int;
BEGIN
  PERFORM ayvo_assert_crate_cycle(NEW."cycle_id");
  PERFORM ayvo_assert_order_line(NEW."line_id");
  PERFORM ayvo_assert_order(NEW."order_id");
  IF NEW."released_at" IS NULL THEN
    SELECT c."capacity" INTO capacity FROM "crate_cycles" c WHERE c."id" = NEW."cycle_id";
    IF (SELECT count(*) FROM "order_allocation_bottles" ob WHERE ob."allocation_id" = NEW."id") <> capacity
       OR (NEW."completed_at" IS NULL AND (
            SELECT count(*) FROM "order_allocation_bottles" ob JOIN "crate_assignments" a ON a."id" = ob."assignment_id"
             WHERE ob."allocation_id" = NEW."id" AND a."cycle_id" = NEW."cycle_id" AND a."released_at" IS NULL) <> capacity) THEN
      RAISE EXCEPTION 'AYVO: an allocation records exactly the crate''s active members' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- =============================================================================================
-- Permissions (ADMIN, explicitly)
-- =============================================================================================

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('returns:receive', 'Return intake of the active site: open and close receipts, scan returned crates and bottles, empty lines, resolve an issue by identification', false, false, true, 'WAREHOUSE'),
  ('returns:correct', 'Return intake of the active site: resolve an issue as not AYVO or written off, with a reason', false, false, true, 'WAREHOUSE');

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'returns:receive'),
  ('ADMIN', 'returns:correct');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
