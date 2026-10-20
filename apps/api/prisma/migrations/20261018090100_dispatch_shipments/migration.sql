-- Dispatch to a carrier (doc 029, owner 2026-10-18): shipments derived from the completed picking,
-- one parcel per crate, optional actual weighings, carrier requests and stored labels; order
-- statuses READY_FOR_PICKUP / HANDED_TO_CARRIER; crate cycle DISPATCHED (ADR 0021). Additive:
-- new tables and triggers; existing functions are replaced with stricter versions only.

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('DRAFT', 'REQUESTING', 'LABELED', 'CANCELLING', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ParcelReferenceSource" AS ENUM ('HOTOVO_SNAPSHOT', 'REFERENCE_AT_SHIPMENT');

-- CreateEnum
CREATE TYPE "CarrierRequestStatus" AS ENUM ('PREPARED', 'SENT', 'ACCEPTED', 'CREATED', 'SUCCEEDED', 'REJECTED', 'NOT_CREATED', 'VOIDED');

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'DRAFT',
    "carrier_code" TEXT,
    "carrier_connection" TEXT,
    "carrier_environment" TEXT,
    "carrier_shipment_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "labeled_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" UUID,
    "cancel_reason" TEXT,
    "carrier_cancelled_at" TIMESTAMPTZ(3),
    "cancel_requested_at" TIMESTAMPTZ(3),
    "cancel_requested_by" UUID,
    "carrier_cancel_sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_parcels" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipment_id" UUID NOT NULL,
    "parcel_no" INTEGER NOT NULL,
    "allocation_id" UUID NOT NULL,
    "crate_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "reference_weight_g" DECIMAL(20,3),
    "reference_source" "ParcelReferenceSource",
    "weight_snapshot_id" UUID,
    "package_dimension_id" UUID,
    "carrier_parcel_number" TEXT,

    CONSTRAINT "shipment_parcels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_parcel_weighings" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "parcel_id" UUID NOT NULL,
    "mass_g" DECIMAL(12,3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "correction_of_id" UUID,
    "correction_reason" TEXT,

    CONSTRAINT "shipment_parcel_weighings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_carrier_requests" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipment_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "carrier_code" TEXT NOT NULL,
    "carrier_connection" TEXT NOT NULL,
    "carrier_environment" TEXT NOT NULL,
    "client_reference" TEXT NOT NULL,
    "status" "CarrierRequestStatus" NOT NULL DEFAULT 'PREPARED',
    "payload" JSONB NOT NULL,
    "carrier_ref" TEXT,
    "result" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "next_poll_at" TIMESTAMPTZ(3),
    "poll_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shipment_carrier_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_labels" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipment_id" UUID NOT NULL,
    "parcel_id" UUID,
    "request_id" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "dpi" INTEGER,
    "file_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipment_labels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_serial_key" ON "shipments"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_code_key" ON "shipments"("code");

-- CreateIndex
CREATE INDEX "shipments_order_id_idx" ON "shipments"("order_id");

-- CreateIndex
CREATE INDEX "shipment_parcels_crate_id_idx" ON "shipment_parcels"("crate_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_parcels_shipment_id_parcel_no_key" ON "shipment_parcels"("shipment_id", "parcel_no");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_parcels_shipment_id_allocation_id_key" ON "shipment_parcels"("shipment_id", "allocation_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_parcel_weighings_operation_request_id_key" ON "shipment_parcel_weighings"("operation_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_parcel_weighings_correction_of_id_key" ON "shipment_parcel_weighings"("correction_of_id");

-- CreateIndex
CREATE INDEX "shipment_parcel_weighings_parcel_id_recorded_at_idx" ON "shipment_parcel_weighings"("parcel_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_carrier_requests_client_reference_key" ON "shipment_carrier_requests"("client_reference");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_carrier_requests_operation_request_id_key" ON "shipment_carrier_requests"("operation_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_carrier_requests_shipment_id_attempt_no_key" ON "shipment_carrier_requests"("shipment_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_labels_file_key_key" ON "shipment_labels"("file_key");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_labels_shipment_id_parcel_id_key" ON "shipment_labels"("shipment_id", "parcel_id");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_cancel_requested_by_fkey" FOREIGN KEY ("cancel_requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_parcels" ADD CONSTRAINT "shipment_parcels_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_parcels" ADD CONSTRAINT "shipment_parcels_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "order_crate_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_parcels" ADD CONSTRAINT "shipment_parcels_crate_id_fkey" FOREIGN KEY ("crate_id") REFERENCES "crates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_parcels" ADD CONSTRAINT "shipment_parcels_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "crate_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_parcels" ADD CONSTRAINT "shipment_parcels_weight_snapshot_id_fkey" FOREIGN KEY ("weight_snapshot_id") REFERENCES "crate_cycle_weight_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_parcels" ADD CONSTRAINT "shipment_parcels_package_dimension_id_fkey" FOREIGN KEY ("package_dimension_id") REFERENCES "crate_type_dimensions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_parcel_weighings" ADD CONSTRAINT "shipment_parcel_weighings_parcel_id_fkey" FOREIGN KEY ("parcel_id") REFERENCES "shipment_parcels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_parcel_weighings" ADD CONSTRAINT "shipment_parcel_weighings_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_parcel_weighings" ADD CONSTRAINT "shipment_parcel_weighings_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_parcel_weighings" ADD CONSTRAINT "shipment_parcel_weighings_correction_of_id_fkey" FOREIGN KEY ("correction_of_id") REFERENCES "shipment_parcel_weighings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_carrier_requests" ADD CONSTRAINT "shipment_carrier_requests_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_carrier_requests" ADD CONSTRAINT "shipment_carrier_requests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_carrier_requests" ADD CONSTRAINT "shipment_carrier_requests_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_labels" ADD CONSTRAINT "shipment_labels_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_labels" ADD CONSTRAINT "shipment_labels_parcel_id_fkey" FOREIGN KEY ("parcel_id") REFERENCES "shipment_parcels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_labels" ADD CONSTRAINT "shipment_labels_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "shipment_carrier_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================================
-- Rules (doc 029 §3). Nothing is deleted; history is append-only (ADR 0006).
-- =============================================================================================

INSERT INTO "code_counters" ("name", "last_value") VALUES ('shipment', 0);

-- ---------------------------------------------------------------------------------------------
-- Orders: the dispatch statuses on one status (no second, contradicting status system).
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "orders" DROP CONSTRAINT "orders_status_completed_check";
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_status_completed_check" CHECK (
    ("status" NOT IN ('READY_TO_DISPATCH', 'READY_FOR_PICKUP', 'HANDED_TO_CARRIER') OR "completed_at" IS NOT NULL)
    AND ("status" <> 'OPEN' OR "completed_at" IS NULL));

CREATE OR REPLACE FUNCTION orders_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  mutable text[] := ARRAY['status','completed_at','completed_by','cancelled_at','cancelled_by','cancel_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: orders are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'AYVO: an order snapshot is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('CANCELLED', 'HANDED_TO_CARRIER') THEN
    RAISE EXCEPTION 'AYVO: a % order never changes', OLD."status" USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'OPEN' AND NEW."status" IN ('READY_TO_DISPATCH', 'CANCELLED'))
    OR (OLD."status" = 'READY_TO_DISPATCH' AND NEW."status" IN ('CANCELLED', 'READY_FOR_PICKUP'))
    OR (OLD."status" = 'READY_FOR_PICKUP' AND NEW."status" IN ('READY_TO_DISPATCH', 'HANDED_TO_CARRIER'))) THEN
    RAISE EXCEPTION 'AYVO: order % → % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."completed_at" IS NOT NULL AND (NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
                                         OR NEW."completed_by" IS DISTINCT FROM OLD."completed_by") THEN
    RAISE EXCEPTION 'AYVO: an order''s completion is recorded once' USING ERRCODE = 'restrict_violation';
  END IF;
  -- "Ready for pickup" is withdrawn only by starting the cancellation of its labels.
  IF OLD."status" = 'READY_FOR_PICKUP' AND NEW."status" = 'READY_TO_DISPATCH' AND NOT EXISTS (
       SELECT 1 FROM "shipments" s WHERE s."order_id" = NEW."id" AND s."status" = 'CANCELLING') THEN
    RAISE EXCEPTION 'AYVO: ready for pickup is withdrawn only by cancelling the labels' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- At commit: lines exist; from READY_TO_DISPATCH on every line exactly complete and exactly one
-- live (non-cancelled) shipment — LABELED from READY_FOR_PICKUP on; OPEN and CANCELLED hold no
-- live shipment; CANCELLED holds no crate.
CREATE OR REPLACE FUNCTION ayvo_assert_order(p_order_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  o record;
  live int;
  live_status "ShipmentStatus";
BEGIN
  SELECT * INTO o FROM "orders" WHERE "id" = p_order_id;
  IF NOT EXISTS (SELECT 1 FROM "order_lines" l WHERE l."order_id" = p_order_id) THEN
    RAISE EXCEPTION 'AYVO: an order has at least one line' USING ERRCODE = 'check_violation';
  END IF;
  IF o."status" IN ('READY_TO_DISPATCH', 'READY_FOR_PICKUP', 'HANDED_TO_CARRIER') AND EXISTS (
       SELECT 1 FROM "order_lines" l WHERE l."order_id" = p_order_id AND l."allocated_crates" <> l."crates") THEN
    RAISE EXCEPTION 'AYVO: % needs every line exactly complete', o."status" USING ERRCODE = 'check_violation';
  END IF;
  IF o."status" = 'CANCELLED' AND EXISTS (
       SELECT 1 FROM "order_crate_allocations" a WHERE a."order_id" = p_order_id AND a."released_at" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: a cancelled order holds no crate' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), min(s."status"::text)::"ShipmentStatus" INTO live, live_status
    FROM "shipments" s WHERE s."order_id" = p_order_id AND s."status" <> 'CANCELLED';
  IF o."status" IN ('OPEN', 'CANCELLED') AND live <> 0 THEN
    RAISE EXCEPTION 'AYVO: an % order has no live shipment', o."status" USING ERRCODE = 'check_violation';
  END IF;
  -- Orders completed before doc 029 have no shipment until their labels are requested.
  IF o."status" IN ('READY_FOR_PICKUP', 'HANDED_TO_CARRIER') AND (live <> 1 OR live_status <> 'LABELED') THEN
    RAISE EXCEPTION 'AYVO: % needs its labelled shipment', o."status" USING ERRCODE = 'check_violation';
  END IF;
  IF live > 1 THEN
    RAISE EXCEPTION 'AYVO: an order has at most one live shipment' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- A site holding orders not yet handed over stays active (doc 022 §7, doc 029).
CREATE OR REPLACE FUNCTION sites_deactivation_dependencies() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD."active" AND NOT NEW."active" AND (
       EXISTS (SELECT 1 FROM "hotels" h WHERE h."fulfillment_site_id" = NEW."id")
    OR EXISTS (SELECT 1 FROM "orders" o WHERE o."site_id" = NEW."id"
                                           AND o."status" IN ('OPEN', 'READY_TO_DISPATCH', 'READY_FOR_PICKUP'))) THEN
    RAISE EXCEPTION 'AYVO: a site serving hotels or holding unclosed orders stays active'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Crate cycles: ALLOCATED → DISPATCHED with the hand-over (ADR 0021); the members never change.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "crate_cycles" DROP CONSTRAINT "crate_cycles_filled_at_check";
ALTER TABLE "crate_cycles"
  ADD CONSTRAINT "crate_cycles_filled_at_check" CHECK (("status" IN ('FILLED', 'ALLOCATED', 'DISPATCHED')) = ("filled_at" IS NOT NULL));

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
  -- Delivery and returns do not exist yet: a dispatched cycle does not change.
  IF OLD."status" = 'DISPATCHED' THEN
    RAISE EXCEPTION 'AYVO: a dispatched crate cycle does not change yet' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'OPEN_ASSEMBLY' AND NEW."status" IN ('READY_TO_FILL', 'FILLING', 'ABORTED'))
    OR (OLD."status" = 'READY_TO_FILL' AND NEW."status" IN ('OPEN_ASSEMBLY', 'FILLING', 'ABORTED'))
    OR (OLD."status" = 'FILLING' AND NEW."status" IN ('FILLED', 'ABORTED'))
    OR (OLD."status" = 'FILLED' AND NEW."status" IN ('FILLING', 'ALLOCATED'))
    OR (OLD."status" = 'ALLOCATED' AND NEW."status" IN ('FILLED', 'DISPATCHED'))) THEN
    RAISE EXCEPTION 'AYVO: crate cycle % → % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'FILLING' AND OLD."status" IN ('OPEN_ASSEMBLY', 'READY_TO_FILL') AND NEW."filled_count" < 1 THEN
    RAISE EXCEPTION 'AYVO: a crate enters FILLING only with a filled member' USING ERRCODE = 'check_violation';
  END IF;
  -- Allocation, its release and the dispatch keep the finished crate exactly as it was.
  IF (OLD."status" = 'ALLOCATED' OR NEW."status" IN ('ALLOCATED', 'DISPATCHED'))
     AND (NEW."member_count" <> OLD."member_count" OR NEW."filled_count" <> OLD."filled_count"
          OR NEW."filled_at" IS DISTINCT FROM OLD."filled_at") THEN
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
  held_by text;
BEGIN
  SELECT * INTO cycle FROM "crate_cycles" WHERE "id" = p_cycle_id;
  SELECT count(*), count(*) FILTER (WHERE b."status" = 'FILLED') INTO active, filled
    FROM "crate_assignments" a JOIN "bottles" b ON b."id" = a."bottle_id"
   WHERE a."cycle_id" = p_cycle_id AND a."released_at" IS NULL;
  IF cycle."member_count" <> active OR cycle."filled_count" <> filled THEN
    RAISE EXCEPTION 'AYVO: cycle counters %/% differ from % active and % filled members',
      cycle."member_count", cycle."filled_count", active, filled USING ERRCODE = 'check_violation';
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
  IF cycle."status" IN ('FILLED', 'ALLOCATED', 'DISPATCHED') AND NOT EXISTS (
       SELECT 1 FROM "crate_events" e WHERE e."cycle_id" = p_cycle_id AND e."type" = 'CRATE_FILLED'
          AND e."occurred_at" = cycle."filled_at") THEN
    RAISE EXCEPTION 'AYVO: FILLED only by Hotovo (its CRATE_FILLED event)' USING ERRCODE = 'check_violation';
  END IF;
  IF cycle."status" = 'FILLING' AND NOT EXISTS (
       SELECT 1 FROM "crate_assignments" a JOIN "bottles" b ON b."id" = a."bottle_id"
        WHERE a."cycle_id" = p_cycle_id AND b."status" = 'FILLED') THEN
    RAISE EXCEPTION 'AYVO: a FILLING cycle has had a filled member' USING ERRCODE = 'check_violation';
  END IF;
  -- ALLOCATED or DISPATCHED ⇔ held by exactly one active order allocation (doc 028); DISPATCHED
  -- ⇔ that order was handed to the carrier (doc 029).
  SELECT o."status"::text INTO held_by
    FROM "order_crate_allocations" oa JOIN "orders" o ON o."id" = oa."order_id"
   WHERE oa."cycle_id" = p_cycle_id AND oa."released_at" IS NULL;
  IF (cycle."status" IN ('ALLOCATED', 'DISPATCHED')) <> (held_by IS NOT NULL) THEN
    RAISE EXCEPTION 'AYVO: a crate cycle is ALLOCATED exactly while an order holds it' USING ERRCODE = 'check_violation';
  END IF;
  IF (cycle."status" = 'DISPATCHED') <> (held_by IS NOT DISTINCT FROM 'HANDED_TO_CARRIER') THEN
    RAISE EXCEPTION 'AYVO: a crate cycle is DISPATCHED exactly when its order was handed to the carrier' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION crate_assignments_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: assignments are released, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."released_at" IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['released_at','released_by','release_reason','release_operation_id'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['released_at','released_by','release_reason','release_operation_id']) THEN
    RAISE EXCEPTION 'AYVO: an assignment changes only by its one release' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "crate_cycles" c WHERE c."id" = OLD."cycle_id" AND c."status" IN ('ALLOCATED', 'DISPATCHED')) THEN
    RAISE EXCEPTION 'AYVO: a bottle never leaves a crate allocated to an order' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- The order's hand-over checks its crates at commit too (DISPATCHED ⇔ HANDED_TO_CARRIER).
CREATE FUNCTION orders_crates_dispatched() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  c uuid;
BEGIN
  FOR c IN SELECT oa."cycle_id" FROM "order_crate_allocations" oa
            WHERE oa."order_id" = NEW."id" AND oa."released_at" IS NULL LOOP
    PERFORM ayvo_assert_crate_cycle(c);
  END LOOP;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "orders_crates_dispatched" AFTER UPDATE OF "status" ON "orders"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW."status" = 'HANDED_TO_CARRIER' OR OLD."status" = 'HANDED_TO_CARRIER')
  EXECUTE FUNCTION orders_crates_dispatched();

-- ---------------------------------------------------------------------------------------------
-- Shipments
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_code_check" CHECK ("code" = ayvo_format_code('SHP-', "serial")),
  ADD CONSTRAINT "shipments_cancelled_check" CHECK (
    ("cancelled_at" IS NULL) = ("cancelled_by" IS NULL)
    AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
    AND ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)
    AND ("cancel_reason" IS NULL OR btrim("cancel_reason") <> '')
    AND ("carrier_cancelled_at" IS NULL OR "cancelled_at" IS NOT NULL)),
  ADD CONSTRAINT "shipments_cancel_requested_check" CHECK (
    ("cancel_requested_at" IS NULL) = ("cancel_requested_by" IS NULL)
    AND ("status" <> 'CANCELLING' OR "cancel_requested_at" IS NOT NULL)
    AND ("carrier_cancelled_at" IS NULL OR "cancel_requested_at" IS NOT NULL)),
  ADD CONSTRAINT "shipments_labeled_check" CHECK (
    ("status" <> 'LABELED' OR ("labeled_at" IS NOT NULL AND "carrier_code" IS NOT NULL))
    AND ("status" NOT IN ('REQUESTING', 'CANCELLING') OR "carrier_code" IS NOT NULL)
    AND ("status" <> 'DRAFT' OR "labeled_at" IS NULL)),
  ADD CONSTRAINT "shipments_carrier_code_check" CHECK ("carrier_code" IS NULL OR "carrier_code" ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  ADD CONSTRAINT "shipments_carrier_snapshot_check" CHECK (
    ("carrier_code" IS NULL) = ("carrier_connection" IS NULL)
    AND ("carrier_code" IS NULL) = ("carrier_environment" IS NULL)
    AND ("carrier_environment" IS NULL OR "carrier_environment" IN ('TEST', 'PRODUCTION'))
    AND ("carrier_cancel_sent_at" IS NULL OR "cancel_requested_at" IS NOT NULL));

-- The whole order travels together: one live shipment per order.
CREATE UNIQUE INDEX "shipments_one_live_per_order" ON "shipments" ("order_id") WHERE "status" <> 'CANCELLED';

CREATE FUNCTION shipments_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" <> 'DRAFT' OR NEW."carrier_code" IS NOT NULL OR NEW."carrier_shipment_ref" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: a shipment starts as a DRAFT without carrier data' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "orders" o WHERE o."id" = NEW."order_id" AND o."site_id" = NEW."site_id"
                                            AND o."status" = 'READY_TO_DISPATCH') THEN
    RAISE EXCEPTION 'AYVO: a shipment belongs to a completed order of its site' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION shipments_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  mutable text[] := ARRAY['status','carrier_code','carrier_connection','carrier_environment',
                          'carrier_shipment_ref','labeled_at','cancelled_at','cancelled_by',
                          'cancel_reason','carrier_cancelled_at','cancel_requested_at',
                          'cancel_requested_by','carrier_cancel_sent_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: shipments are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'AYVO: a shipment''s identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'AYVO: a cancelled shipment never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  -- The carrier may change only while nothing is at a carrier (a draft after a refusal).
  IF (OLD."carrier_code" IS NOT NULL AND OLD."status" <> 'DRAFT'
      AND (NEW."carrier_code", NEW."carrier_connection", NEW."carrier_environment")
          IS DISTINCT FROM (OLD."carrier_code", OLD."carrier_connection", OLD."carrier_environment"))
     OR (OLD."cancel_requested_at" IS NOT NULL AND NEW."cancel_requested_at" IS DISTINCT FROM OLD."cancel_requested_at"
         AND NEW."status" <> 'CANCELLING')
     OR (OLD."carrier_shipment_ref" IS NOT NULL AND NEW."carrier_shipment_ref" IS DISTINCT FROM OLD."carrier_shipment_ref")
     OR (OLD."labeled_at" IS NOT NULL AND NEW."labeled_at" IS DISTINCT FROM OLD."labeled_at") THEN
    RAISE EXCEPTION 'AYVO: carrier data are recorded once' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('REQUESTING', 'CANCELLED'))
    OR (OLD."status" = 'REQUESTING' AND NEW."status" IN ('DRAFT', 'LABELED', 'CANCELLING'))
    OR (OLD."status" = 'LABELED' AND NEW."status" = 'CANCELLING')
    OR (OLD."status" = 'CANCELLING' AND NEW."status" IN ('LABELED', 'REQUESTING', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'AYVO: shipment % → % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  -- A shipment created at the carrier is cancelled only when the carrier confirmed it.
  IF OLD."status" = 'CANCELLING' AND NEW."status" = 'CANCELLED' AND NEW."carrier_cancelled_at" IS NULL THEN
    RAISE EXCEPTION 'AYVO: a labelled shipment is cancelled only through the carrier' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'CANCELLED' AND NEW."carrier_cancelled_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: a draft shipment was never at the carrier' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- At commit: parcels = the order's active allocations (one per crate); REQUESTING ⇔ exactly one
-- unresolved carrier request; LABELED ⇔ stored labels, a succeeded request and every parcel
-- numbered; the order's own rules (ayvo_assert_order) hold.
CREATE FUNCTION ayvo_assert_shipment(p_shipment_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  s record;
  unresolved int;
  labeled boolean;
BEGIN
  SELECT * INTO s FROM "shipments" WHERE "id" = p_shipment_id;
  IF s."status" <> 'CANCELLED' THEN
    IF (SELECT count(*) FROM "shipment_parcels" p WHERE p."shipment_id" = p_shipment_id)
       <> (SELECT count(*) FROM "order_crate_allocations" a WHERE a."order_id" = s."order_id" AND a."released_at" IS NULL)
       OR EXISTS (SELECT 1 FROM "shipment_parcels" p JOIN "order_crate_allocations" a ON a."id" = p."allocation_id"
                   WHERE p."shipment_id" = p_shipment_id AND (a."released_at" IS NOT NULL OR a."order_id" <> s."order_id")) THEN
      RAISE EXCEPTION 'AYVO: a shipment has exactly one parcel per crate of its order' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT count(*) INTO unresolved FROM "shipment_carrier_requests" r
   WHERE r."shipment_id" = p_shipment_id AND r."status" IN ('PREPARED', 'SENT', 'ACCEPTED', 'CREATED');
  -- Labelled: every parcel has its number and its own label file.
  labeled := NOT EXISTS (SELECT 1 FROM "shipment_parcels" p WHERE p."shipment_id" = p_shipment_id
                           AND NOT EXISTS (SELECT 1 FROM "shipment_labels" l WHERE l."parcel_id" = p."id"))
    AND EXISTS (SELECT 1 FROM "shipment_carrier_requests" r WHERE r."shipment_id" = p_shipment_id AND r."status" = 'SUCCEEDED')
    AND NOT EXISTS (SELECT 1 FROM "shipment_parcels" p WHERE p."shipment_id" = p_shipment_id AND p."carrier_parcel_number" IS NULL);
  IF unresolved > 1
     OR (s."status" = 'REQUESTING' AND unresolved <> 1)
     OR (s."status" IN ('DRAFT', 'LABELED', 'CANCELLED') AND unresolved <> 0) THEN
    RAISE EXCEPTION 'AYVO: a shipment is REQUESTING exactly while one carrier request is unresolved' USING ERRCODE = 'check_violation';
  END IF;
  IF s."status" = 'LABELED' AND NOT labeled THEN
    RAISE EXCEPTION 'AYVO: a LABELED shipment has its labels and every parcel number' USING ERRCODE = 'check_violation';
  END IF;
  -- Cancelling at the carrier: a labelled shipment, or one the carrier created (its request
  -- CREATED) whose labels never became usable.
  IF s."status" = 'CANCELLING' AND NOT (
       (unresolved = 0 AND labeled)
    OR (unresolved = 1 AND EXISTS (SELECT 1 FROM "shipment_carrier_requests" r
                                    WHERE r."shipment_id" = p_shipment_id AND r."status" = 'CREATED'))) THEN
    RAISE EXCEPTION 'AYVO: only a shipment the carrier created is cancelled at the carrier' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM ayvo_assert_order(s."order_id");
END
$$;

CREATE FUNCTION shipments_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM ayvo_assert_shipment(NEW."id");
  RETURN NULL;
END
$$;

CREATE TRIGGER "shipments_insert_check" BEFORE INSERT ON "shipments"
  FOR EACH ROW EXECUTE FUNCTION shipments_insert_check();
CREATE TRIGGER "shipments_guard" BEFORE UPDATE OR DELETE ON "shipments"
  FOR EACH ROW EXECUTE FUNCTION shipments_guard();
CREATE TRIGGER "shipments_no_truncate" BEFORE TRUNCATE ON "shipments"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE CONSTRAINT TRIGGER "shipments_consistent" AFTER INSERT OR UPDATE ON "shipments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shipments_consistent();

-- ---------------------------------------------------------------------------------------------
-- Parcels: one per crate; the reference is calculated (never an actual weighing).
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "shipment_parcels"
  ADD CONSTRAINT "shipment_parcels_no_check" CHECK ("parcel_no" >= 1),
  ADD CONSTRAINT "shipment_parcels_reference_check" CHECK (
    ("reference_weight_g" IS NULL) = ("reference_source" IS NULL)
    AND ("reference_weight_g" IS NULL OR "reference_weight_g" > 0)
    AND ("reference_source" IS DISTINCT FROM 'HOTOVO_SNAPSHOT' OR "weight_snapshot_id" IS NOT NULL)),
  ADD CONSTRAINT "shipment_parcels_number_check" CHECK ("carrier_parcel_number" IS NULL OR btrim("carrier_parcel_number") <> '');

CREATE FUNCTION shipment_parcels_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."carrier_parcel_number" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: a parcel is numbered only by the carrier' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "shipments" s JOIN "order_crate_allocations" a ON a."order_id" = s."order_id"
                  WHERE s."id" = NEW."shipment_id" AND s."status" = 'DRAFT' AND a."id" = NEW."allocation_id"
                    AND a."released_at" IS NULL AND a."crate_id" = NEW."crate_id" AND a."cycle_id" = NEW."cycle_id") THEN
    RAISE EXCEPTION 'AYVO: a parcel is a crate of its draft shipment''s order' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."weight_snapshot_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "crate_cycle_weight_snapshots" w WHERE w."id" = NEW."weight_snapshot_id" AND w."cycle_id" = NEW."cycle_id") THEN
    RAISE EXCEPTION 'AYVO: the weight snapshot belongs to the parcel''s crate cycle' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."package_dimension_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "crate_type_dimensions" d JOIN "crate_cycles" c ON c."crate_type_id" = d."crate_type_id"
        WHERE d."id" = NEW."package_dimension_id" AND d."subject" = 'SHIPPING_PACKAGE' AND c."id" = NEW."cycle_id") THEN
    RAISE EXCEPTION 'AYVO: the package dimensions are the shipping package of the crate''s type' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION shipment_parcels_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: parcels are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'carrier_parcel_number') IS DISTINCT FROM (to_jsonb(OLD) - 'carrier_parcel_number')
     OR OLD."carrier_parcel_number" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: a parcel changes only by its carrier number, once' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "shipments" s WHERE s."id" = NEW."shipment_id" AND s."status" = 'REQUESTING') THEN
    RAISE EXCEPTION 'AYVO: a parcel is numbered while its carrier request is resolved' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION shipment_children_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM ayvo_assert_shipment(NEW."shipment_id");
  RETURN NULL;
END
$$;

CREATE TRIGGER "shipment_parcels_insert_check" BEFORE INSERT ON "shipment_parcels"
  FOR EACH ROW EXECUTE FUNCTION shipment_parcels_insert_check();
CREATE TRIGGER "shipment_parcels_guard" BEFORE UPDATE OR DELETE ON "shipment_parcels"
  FOR EACH ROW EXECUTE FUNCTION shipment_parcels_guard();
CREATE TRIGGER "shipment_parcels_no_truncate" BEFORE TRUNCATE ON "shipment_parcels"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE CONSTRAINT TRIGGER "shipment_parcels_consistent" AFTER INSERT OR UPDATE ON "shipment_parcels"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shipment_children_consistent();

-- ---------------------------------------------------------------------------------------------
-- Actual weighings: optional, append-only, only before the carrier request.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "shipment_parcel_weighings"
  ADD CONSTRAINT "shipment_parcel_weighings_mass_check" CHECK ("mass_g" > 0),
  ADD CONSTRAINT "shipment_parcel_weighings_correction_check" CHECK (
    ("correction_of_id" IS NULL) = ("correction_reason" IS NULL)
    AND ("correction_reason" IS NULL OR length(btrim("correction_reason")) >= 3));

CREATE FUNCTION shipment_parcel_weighings_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "shipment_parcels" p JOIN "shipments" s ON s."id" = p."shipment_id"
                  WHERE p."id" = NEW."parcel_id" AND s."status" = 'DRAFT') THEN
    RAISE EXCEPTION 'AYVO: a parcel is weighed only before its labels are requested' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."correction_of_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "shipment_parcel_weighings" w WHERE w."id" = NEW."correction_of_id" AND w."parcel_id" = NEW."parcel_id") THEN
    RAISE EXCEPTION 'AYVO: a correction corrects a weighing of the same parcel' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "shipment_parcel_weighings_insert_check" BEFORE INSERT ON "shipment_parcel_weighings"
  FOR EACH ROW EXECUTE FUNCTION shipment_parcel_weighings_insert_check();
CREATE TRIGGER "shipment_parcel_weighings_immutable" BEFORE UPDATE OR DELETE ON "shipment_parcel_weighings"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "shipment_parcel_weighings_no_truncate" BEFORE TRUNCATE ON "shipment_parcel_weighings"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- ---------------------------------------------------------------------------------------------
-- Carrier requests: written before sending, claimed once, resolved forward only.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "shipment_carrier_requests"
  ADD CONSTRAINT "shipment_carrier_requests_attempt_check" CHECK ("attempt_no" >= 1),
  ADD CONSTRAINT "shipment_carrier_requests_reference_check" CHECK (btrim("client_reference") <> '' AND length("client_reference") <= 128),
  ADD CONSTRAINT "shipment_carrier_requests_carrier_check" CHECK ("carrier_code" ~ '^[A-Z][A-Z0-9_]{1,19}$'
    AND "carrier_environment" IN ('TEST', 'PRODUCTION') AND btrim("carrier_connection") <> ''),
  ADD CONSTRAINT "shipment_carrier_requests_polls_check" CHECK ("poll_count" >= 0),
  ADD CONSTRAINT "shipment_carrier_requests_times_check" CHECK (
    ("status" = 'PREPARED') = ("sent_at" IS NULL)
    AND ("status" IN ('SUCCEEDED', 'REJECTED', 'NOT_CREATED', 'VOIDED')) = ("resolved_at" IS NOT NULL));

CREATE UNIQUE INDEX "shipment_carrier_requests_one_unresolved" ON "shipment_carrier_requests" ("shipment_id")
  WHERE "status" IN ('PREPARED', 'SENT', 'ACCEPTED', 'CREATED');

CREATE FUNCTION shipment_carrier_requests_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" <> 'PREPARED' THEN
    RAISE EXCEPTION 'AYVO: a carrier request starts PREPARED' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "shipments" s WHERE s."id" = NEW."shipment_id" AND s."status" = 'REQUESTING'
                                               AND s."carrier_code" = NEW."carrier_code"
                                               AND s."carrier_connection" = NEW."carrier_connection"
                                               AND s."carrier_environment" = NEW."carrier_environment") THEN
    RAISE EXCEPTION 'AYVO: a carrier request belongs to a requesting shipment of the same carrier' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION shipment_carrier_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  mutable text[] := ARRAY['status','carrier_ref','result','error_code','error_message','sent_at','resolved_at',
                          'next_poll_at','poll_count'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: carrier requests are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'AYVO: what was sent to the carrier is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('SUCCEEDED', 'REJECTED', 'NOT_CREATED', 'VOIDED') THEN
    RAISE EXCEPTION 'AYVO: a resolved carrier request never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."carrier_ref" IS NOT NULL AND NEW."carrier_ref" IS DISTINCT FROM OLD."carrier_ref")
     OR (OLD."sent_at" IS NOT NULL AND NEW."sent_at" IS DISTINCT FROM OLD."sent_at") THEN
    RAISE EXCEPTION 'AYVO: the carrier reference and the sending are recorded once' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'PREPARED' AND NEW."status" = 'SENT')
    OR (OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'CREATED', 'SUCCEEDED', 'REJECTED', 'NOT_CREATED'))
    OR (OLD."status" = 'ACCEPTED' AND NEW."status" IN ('CREATED', 'SUCCEEDED', 'REJECTED', 'NOT_CREATED'))
    OR (OLD."status" = 'CREATED' AND NEW."status" IN ('SUCCEEDED', 'VOIDED'))) THEN
    RAISE EXCEPTION 'AYVO: carrier request % → % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "shipment_carrier_requests_insert_check" BEFORE INSERT ON "shipment_carrier_requests"
  FOR EACH ROW EXECUTE FUNCTION shipment_carrier_requests_insert_check();
CREATE TRIGGER "shipment_carrier_requests_guard" BEFORE UPDATE OR DELETE ON "shipment_carrier_requests"
  FOR EACH ROW EXECUTE FUNCTION shipment_carrier_requests_guard();
CREATE TRIGGER "shipment_carrier_requests_no_truncate" BEFORE TRUNCATE ON "shipment_carrier_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE CONSTRAINT TRIGGER "shipment_carrier_requests_consistent" AFTER INSERT OR UPDATE ON "shipment_carrier_requests"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shipment_children_consistent();

-- ---------------------------------------------------------------------------------------------
-- Labels: the carrier's document, stored once while its request is being resolved.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "shipment_labels"
  ADD CONSTRAINT "shipment_labels_format_check" CHECK ("format" IN ('PDF', 'ZPL')),
  ADD CONSTRAINT "shipment_labels_dpi_check" CHECK ("dpi" IS NULL OR "dpi" BETWEEN 100 AND 1200),
  ADD CONSTRAINT "shipment_labels_sha_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "shipment_labels_size_check" CHECK ("size_bytes" > 0);

-- One complete document per shipment (parcel null); one label per parcel (unique index).
CREATE UNIQUE INDEX "shipment_labels_one_complete" ON "shipment_labels" ("shipment_id") WHERE "parcel_id" IS NULL;

CREATE FUNCTION shipment_labels_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."parcel_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "shipment_parcels" p WHERE p."id" = NEW."parcel_id" AND p."shipment_id" = NEW."shipment_id") THEN
    RAISE EXCEPTION 'AYVO: a parcel label belongs to a parcel of its shipment' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "shipment_carrier_requests" r JOIN "shipments" s ON s."id" = r."shipment_id"
                  WHERE r."id" = NEW."request_id" AND r."shipment_id" = NEW."shipment_id"
                    AND r."status" IN ('SENT', 'ACCEPTED', 'CREATED') AND s."status" = 'REQUESTING') THEN
    RAISE EXCEPTION 'AYVO: labels come from the shipment''s unresolved carrier request' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "shipment_labels_insert_check" BEFORE INSERT ON "shipment_labels"
  FOR EACH ROW EXECUTE FUNCTION shipment_labels_insert_check();
CREATE TRIGGER "shipment_labels_immutable" BEFORE UPDATE OR DELETE ON "shipment_labels"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "shipment_labels_no_truncate" BEFORE TRUNCATE ON "shipment_labels"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- Permissions (doc 029 §6): at the active site with a warehouse, like orders. ADMIN only.
-- =============================================================================================

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('shipments:read', 'View the shipment of an order of the active site: parcels, weights, labels and carrier numbers', false, false, true, 'WAREHOUSE'),
  ('shipments:prepare', 'Prepare the shipment of an order: actual weighings, carrier labels, ready for pickup, cancel the preparation', false, false, true, 'WAREHOUSE'),
  ('shipments:handover', 'Confirm the physical hand-over of an order to the carrier', false, false, true, 'WAREHOUSE'),
  ('shipments:resolve_uncertain', 'Exceptionally confirm, after checking with the carrier, that an uncertain carrier request created nothing (risk of a duplicate shipment; audited with a reason)', false, false, true, 'WAREHOUSE');

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'shipments:read'),
  ('ADMIN', 'shipments:prepare'),
  ('ADMIN', 'shipments:handover'),
  ('ADMIN', 'shipments:resolve_uncertain');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
