-- Hotels, manual orders and picking of finished crates (doc 028, owner 2026-10-17). No stock
-- movement, no bottle status change; nothing existing is rewritten.

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'READY_TO_DISPATCH', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderEventType" AS ENUM ('CREATED', 'CRATE_ADDED', 'CRATE_REMOVED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "hotels" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address_line1" TEXT NOT NULL,
    "address_line2" TEXT,
    "postal_code" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "contact_name" TEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "fulfillment_site_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,

    CONSTRAINT "hotels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "hotel_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "requested_ship_date" DATE NOT NULL,
    "hotel_name" TEXT NOT NULL,
    "address_line1" TEXT NOT NULL,
    "address_line2" TEXT,
    "postal_code" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "contact_name" TEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "completed_by" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" UUID,
    "cancel_reason" TEXT,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "crate_type_id" UUID NOT NULL,
    "capacity" INTEGER NOT NULL,
    "crates" INTEGER NOT NULL,
    "bottles" INTEGER NOT NULL,
    "allocated_crates" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_crate_allocations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "crate_id" UUID NOT NULL,
    "allocated_at" TIMESTAMPTZ(3) NOT NULL,
    "allocated_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "released_at" TIMESTAMPTZ(3),
    "released_by" UUID,
    "release_reason" TEXT,
    "release_operation_id" UUID,

    CONSTRAINT "order_crate_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_allocation_bottles" (
    "allocation_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "bottle_id" UUID NOT NULL,

    CONSTRAINT "order_allocation_bottles_pkey" PRIMARY KEY ("allocation_id","assignment_id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "type" "OrderEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "actor_id" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hotels_serial_key" ON "hotels"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "hotels_code_key" ON "hotels"("code");

-- CreateIndex
CREATE UNIQUE INDEX "hotels_operation_request_id_key" ON "hotels"("operation_request_id");

-- CreateIndex
CREATE INDEX "hotels_fulfillment_site_id_idx" ON "hotels"("fulfillment_site_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_serial_key" ON "orders"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "orders_code_key" ON "orders"("code");

-- CreateIndex
CREATE UNIQUE INDEX "orders_operation_request_id_key" ON "orders"("operation_request_id");

-- CreateIndex
CREATE INDEX "orders_site_id_requested_ship_date_idx" ON "orders"("site_id", "requested_ship_date");

-- CreateIndex
CREATE INDEX "orders_hotel_id_idx" ON "orders"("hotel_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_lines_order_id_line_no_key" ON "order_lines"("order_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "order_lines_order_id_product_id_key" ON "order_lines"("order_id", "product_id");

-- CreateIndex
CREATE INDEX "order_crate_allocations_order_id_idx" ON "order_crate_allocations"("order_id");

-- CreateIndex
CREATE INDEX "order_crate_allocations_cycle_id_idx" ON "order_crate_allocations"("cycle_id");

-- CreateIndex
CREATE INDEX "order_crate_allocations_crate_id_idx" ON "order_crate_allocations"("crate_id");

-- CreateIndex
CREATE INDEX "order_allocation_bottles_bottle_id_idx" ON "order_allocation_bottles"("bottle_id");

-- CreateIndex
CREATE INDEX "order_events_order_id_occurred_at_idx" ON "order_events"("order_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "hotels" ADD CONSTRAINT "hotels_fulfillment_site_id_fkey" FOREIGN KEY ("fulfillment_site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hotels" ADD CONSTRAINT "hotels_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hotels" ADD CONSTRAINT "hotels_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_crate_type_id_fkey" FOREIGN KEY ("crate_type_id") REFERENCES "crate_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_crate_allocations" ADD CONSTRAINT "order_crate_allocations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_crate_allocations" ADD CONSTRAINT "order_crate_allocations_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_crate_allocations" ADD CONSTRAINT "order_crate_allocations_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "crate_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_crate_allocations" ADD CONSTRAINT "order_crate_allocations_crate_id_fkey" FOREIGN KEY ("crate_id") REFERENCES "crates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_crate_allocations" ADD CONSTRAINT "order_crate_allocations_allocated_by_fkey" FOREIGN KEY ("allocated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_crate_allocations" ADD CONSTRAINT "order_crate_allocations_released_by_fkey" FOREIGN KEY ("released_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_crate_allocations" ADD CONSTRAINT "order_crate_allocations_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_crate_allocations" ADD CONSTRAINT "order_crate_allocations_release_operation_id_fkey" FOREIGN KEY ("release_operation_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_allocation_bottles" ADD CONSTRAINT "order_allocation_bottles_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "order_crate_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_allocation_bottles" ADD CONSTRAINT "order_allocation_bottles_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "crate_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_allocation_bottles" ADD CONSTRAINT "order_allocation_bottles_bottle_id_fkey" FOREIGN KEY ("bottle_id") REFERENCES "bottles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================================
-- Codes (global, gapless like GR-/CR-) — the format is provisional (doc 028 §6)
-- =============================================================================================

INSERT INTO "code_counters" ("name", "last_value") VALUES ('hotel', 0), ('order', 0);

-- =============================================================================================
-- Hotels: explicit, active fulfilment site with a warehouse; code and site immutable
-- =============================================================================================

ALTER TABLE "hotels"
  ADD CONSTRAINT "hotels_serial_check" CHECK ("serial" >= 1),
  ADD CONSTRAINT "hotels_code_check" CHECK ("code" = ayvo_format_code('HT-', "serial")),
  ADD CONSTRAINT "hotels_country_code_check" CHECK ("country_code" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "hotels_text_check" CHECK (
    btrim("name") <> '' AND btrim("address_line1") <> '' AND btrim("postal_code") <> ''
    AND btrim("city") <> '' AND btrim("contact_name") <> '' AND btrim("contact_phone") <> ''
    AND btrim("contact_email") <> '');

CREATE FUNCTION hotels_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "sites" s WHERE s."id" = NEW."fulfillment_site_id" AND s."active"
                    AND 'WAREHOUSE' = ANY (s."capabilities")) THEN
    RAISE EXCEPTION 'AYVO: a hotel is served by an active site with a warehouse' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION hotels_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: hotels are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  -- A fulfilment site reassignment (reason + audit, new orders only) is a later operation.
  IF NEW."id" <> OLD."id" OR NEW."serial" <> OLD."serial" OR NEW."code" <> OLD."code"
     OR NEW."fulfillment_site_id" <> OLD."fulfillment_site_id" OR NEW."created_at" <> OLD."created_at"
     OR NEW."created_by" <> OLD."created_by" OR NEW."operation_request_id" <> OLD."operation_request_id" THEN
    RAISE EXCEPTION 'AYVO: a hotel''s code and fulfilment site are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "hotels_insert_check" BEFORE INSERT ON "hotels"
  FOR EACH ROW EXECUTE FUNCTION hotels_insert_check();
CREATE TRIGGER "hotels_guard" BEFORE UPDATE OR DELETE ON "hotels"
  FOR EACH ROW EXECUTE FUNCTION hotels_guard();
CREATE TRIGGER "hotels_no_truncate" BEFORE TRUNCATE ON "hotels"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- Orders: the hotel's fulfilment site as an immutable snapshot; status transitions
-- =============================================================================================

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_serial_check" CHECK ("serial" >= 1),
  ADD CONSTRAINT "orders_code_check" CHECK ("code" = ayvo_format_code('OR-', "serial")),
  ADD CONSTRAINT "orders_country_code_check" CHECK ("country_code" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "orders_completed_check" CHECK (("completed_at" IS NULL) = ("completed_by" IS NULL)),
  ADD CONSTRAINT "orders_cancelled_check" CHECK (
    ("cancelled_at" IS NULL) = ("cancelled_by" IS NULL)
    AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
    AND ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)
    AND ("cancel_reason" IS NULL OR btrim("cancel_reason") <> '')),
  ADD CONSTRAINT "orders_status_completed_check" CHECK (
    ("status" <> 'READY_TO_DISPATCH' OR "completed_at" IS NOT NULL)
    AND ("status" <> 'OPEN' OR "completed_at" IS NULL));

CREATE FUNCTION orders_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'AYVO: an order starts OPEN' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "hotels" h JOIN "sites" s ON s."id" = h."fulfillment_site_id"
                  WHERE h."id" = NEW."hotel_id" AND h."fulfillment_site_id" = NEW."site_id"
                    AND s."active" AND 'WAREHOUSE' = ANY (s."capabilities")) THEN
    RAISE EXCEPTION 'AYVO: an order belongs to the hotel''s active fulfilment site' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION orders_guard() RETURNS trigger
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
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'AYVO: a cancelled order never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'OPEN' AND NEW."status" IN ('READY_TO_DISPATCH', 'CANCELLED'))
    OR (OLD."status" = 'READY_TO_DISPATCH' AND NEW."status" = 'CANCELLED')) THEN
    RAISE EXCEPTION 'AYVO: order % → % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."completed_at" IS NOT NULL AND (NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
                                         OR NEW."completed_by" IS DISTINCT FROM OLD."completed_by") THEN
    RAISE EXCEPTION 'AYVO: an order''s completion is recorded once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- At commit: an order has lines; READY_TO_DISPATCH only with every line exactly complete;
-- CANCELLED holds no crate.
CREATE FUNCTION ayvo_assert_order(p_order_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  o record;
BEGIN
  SELECT * INTO o FROM "orders" WHERE "id" = p_order_id;
  IF NOT EXISTS (SELECT 1 FROM "order_lines" l WHERE l."order_id" = p_order_id) THEN
    RAISE EXCEPTION 'AYVO: an order has at least one line' USING ERRCODE = 'check_violation';
  END IF;
  IF o."status" = 'READY_TO_DISPATCH' AND EXISTS (
       SELECT 1 FROM "order_lines" l WHERE l."order_id" = p_order_id AND l."allocated_crates" <> l."crates") THEN
    RAISE EXCEPTION 'AYVO: READY_TO_DISPATCH needs every line exactly complete' USING ERRCODE = 'check_violation';
  END IF;
  IF o."status" = 'CANCELLED' AND EXISTS (
       SELECT 1 FROM "order_crate_allocations" a WHERE a."order_id" = p_order_id AND a."released_at" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: a cancelled order holds no crate' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION orders_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM ayvo_assert_order(NEW."id");
  RETURN NULL;
END
$$;

CREATE TRIGGER "orders_insert_check" BEFORE INSERT ON "orders"
  FOR EACH ROW EXECUTE FUNCTION orders_insert_check();
CREATE TRIGGER "orders_guard" BEFORE UPDATE OR DELETE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION orders_guard();
CREATE TRIGGER "orders_no_truncate" BEFORE TRUNCATE ON "orders"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE CONSTRAINT TRIGGER "orders_consistent" AFTER INSERT OR UPDATE ON "orders"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orders_consistent();

-- =============================================================================================
-- Order lines: whole crates; capacity = the crate type's; bottles derived; only the counter moves
-- =============================================================================================

ALTER TABLE "order_lines"
  ADD CONSTRAINT "order_lines_line_no_check" CHECK ("line_no" >= 1),
  ADD CONSTRAINT "order_lines_crates_check" CHECK ("crates" >= 1 AND "capacity" >= 1),
  ADD CONSTRAINT "order_lines_bottles_check" CHECK ("bottles" = "crates" * "capacity"),
  ADD CONSTRAINT "order_lines_allocated_check" CHECK ("allocated_crates" BETWEEN 0 AND "crates");

CREATE FUNCTION order_lines_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."allocated_crates" <> 0 OR NOT EXISTS (
       SELECT 1 FROM "orders" o WHERE o."id" = NEW."order_id" AND o."status" = 'OPEN') THEN
    RAISE EXCEPTION 'AYVO: a line is added to an open order, empty' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "crate_types" ct JOIN "crate_type_categories" x ON x."crate_type_id" = ct."id"
                  JOIN "products" p ON p."category_code" = x."category_code"
                  WHERE ct."id" = NEW."crate_type_id" AND ct."capacity" = NEW."capacity"
                    AND p."id" = NEW."product_id") THEN
    RAISE EXCEPTION 'AYVO: the line''s crate type and capacity do not fit the product' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION order_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: order lines are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'allocated_crates') IS DISTINCT FROM (to_jsonb(OLD) - 'allocated_crates') THEN
    RAISE EXCEPTION 'AYVO: an order line changes only by its picked crates' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- At commit: the counter equals the line's active allocations.
CREATE FUNCTION ayvo_assert_order_line(p_line_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (SELECT "allocated_crates" FROM "order_lines" WHERE "id" = p_line_id) <> (
       SELECT count(*) FROM "order_crate_allocations" a WHERE a."line_id" = p_line_id AND a."released_at" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: an order line''s picked crates differ from its active allocations' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION order_lines_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM ayvo_assert_order_line(NEW."id");
  PERFORM ayvo_assert_order(NEW."order_id");
  RETURN NULL;
END
$$;

CREATE TRIGGER "order_lines_insert_check" BEFORE INSERT ON "order_lines"
  FOR EACH ROW EXECUTE FUNCTION order_lines_insert_check();
CREATE TRIGGER "order_lines_guard" BEFORE UPDATE OR DELETE ON "order_lines"
  FOR EACH ROW EXECUTE FUNCTION order_lines_guard();
CREATE TRIGGER "order_lines_no_truncate" BEFORE TRUNCATE ON "order_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE CONSTRAINT TRIGGER "order_lines_consistent" AFTER INSERT OR UPDATE ON "order_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_lines_consistent();

-- =============================================================================================
-- Crate allocations: one active per cycle (a crate is never in two orders); only a finished
-- crate of the line's product, crate type and site; released once, never deleted
-- =============================================================================================

CREATE UNIQUE INDEX "order_crate_allocations_one_active_per_cycle"
  ON "order_crate_allocations" ("cycle_id") WHERE "released_at" IS NULL;
CREATE UNIQUE INDEX "order_crate_allocations_one_active_per_crate"
  ON "order_crate_allocations" ("crate_id") WHERE "released_at" IS NULL;

ALTER TABLE "order_crate_allocations"
  ADD CONSTRAINT "order_crate_allocations_release_check" CHECK (
    ("released_at" IS NULL AND "released_by" IS NULL AND "release_reason" IS NULL AND "release_operation_id" IS NULL)
    OR ("released_at" IS NOT NULL AND "released_by" IS NOT NULL AND "release_operation_id" IS NOT NULL));

CREATE FUNCTION order_crate_allocations_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."released_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: an allocation starts active' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "orders" o JOIN "order_lines" l ON l."order_id" = o."id"
                  JOIN "crate_cycles" c ON c."id" = NEW."cycle_id"
                  WHERE o."id" = NEW."order_id" AND l."id" = NEW."line_id" AND o."status" = 'OPEN'
                    AND c."crate_id" = NEW."crate_id" AND c."status" = 'ALLOCATED'
                    AND c."site_id" = o."site_id" AND c."product_id" = l."product_id"
                    AND c."crate_type_id" = l."crate_type_id" AND c."capacity" = l."capacity") THEN
    RAISE EXCEPTION 'AYVO: only a finished crate of the line''s product, crate type and site joins an open order'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION order_crate_allocations_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: allocations are released, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."released_at" IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['released_at','released_by','release_reason','release_operation_id'])
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

-- At commit: the cycle matches (ALLOCATED ⇔ active allocation), the line counter matches, and an
-- active allocation records exactly the cycle's active members.
CREATE FUNCTION order_crate_allocations_consistent() RETURNS trigger
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
       OR (SELECT count(*) FROM "order_allocation_bottles" ob JOIN "crate_assignments" a ON a."id" = ob."assignment_id"
            WHERE ob."allocation_id" = NEW."id" AND a."cycle_id" = NEW."cycle_id" AND a."released_at" IS NULL) <> capacity THEN
      RAISE EXCEPTION 'AYVO: an allocation records exactly the crate''s active members' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "order_crate_allocations_insert_check" BEFORE INSERT ON "order_crate_allocations"
  FOR EACH ROW EXECUTE FUNCTION order_crate_allocations_insert_check();
CREATE TRIGGER "order_crate_allocations_guard" BEFORE UPDATE OR DELETE ON "order_crate_allocations"
  FOR EACH ROW EXECUTE FUNCTION order_crate_allocations_guard();
CREATE TRIGGER "order_crate_allocations_no_truncate" BEFORE TRUNCATE ON "order_crate_allocations"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE CONSTRAINT TRIGGER "order_crate_allocations_consistent" AFTER INSERT OR UPDATE ON "order_crate_allocations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_crate_allocations_consistent();

-- The allocation's bottles: active members of its cycle at insert; insert-only.
CREATE FUNCTION order_allocation_bottles_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "order_crate_allocations" oa JOIN "crate_assignments" a ON a."cycle_id" = oa."cycle_id"
                  WHERE oa."id" = NEW."allocation_id" AND oa."released_at" IS NULL
                    AND a."id" = NEW."assignment_id" AND a."bottle_id" = NEW."bottle_id" AND a."released_at" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: an allocated bottle is an active member of the allocated crate' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "order_allocation_bottles_insert_check" BEFORE INSERT ON "order_allocation_bottles"
  FOR EACH ROW EXECUTE FUNCTION order_allocation_bottles_insert_check();
CREATE TRIGGER "order_allocation_bottles_immutable" BEFORE UPDATE OR DELETE ON "order_allocation_bottles"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "order_allocation_bottles_no_truncate" BEFORE TRUNCATE ON "order_allocation_bottles"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

CREATE TRIGGER "order_events_immutable" BEFORE UPDATE OR DELETE ON "order_events"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "order_events_no_truncate" BEFORE TRUNCATE ON "order_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- Crate cycles: FILLED ⇄ ALLOCATED; an ALLOCATED cycle is a finished crate held by one order
-- =============================================================================================

ALTER TABLE "crate_cycles" DROP CONSTRAINT "crate_cycles_filled_at_check";
ALTER TABLE "crate_cycles"
  ADD CONSTRAINT "crate_cycles_filled_at_check" CHECK (("status" IN ('FILLED', 'ALLOCATED')) = ("filled_at" IS NOT NULL));

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
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'OPEN_ASSEMBLY' AND NEW."status" IN ('READY_TO_FILL', 'FILLING', 'ABORTED'))
    OR (OLD."status" = 'READY_TO_FILL' AND NEW."status" IN ('OPEN_ASSEMBLY', 'FILLING', 'ABORTED'))
    OR (OLD."status" = 'FILLING' AND NEW."status" IN ('FILLED', 'ABORTED'))
    OR (OLD."status" = 'FILLED' AND NEW."status" IN ('FILLING', 'ALLOCATED'))
    OR (OLD."status" = 'ALLOCATED' AND NEW."status" = 'FILLED')) THEN
    RAISE EXCEPTION 'AYVO: crate cycle % → % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  -- FILLING is entered only together with a filled member (a fill scan or a repacked finished
  -- bottle), never by counts or by hand.
  IF NEW."status" = 'FILLING' AND OLD."status" IN ('OPEN_ASSEMBLY', 'READY_TO_FILL') AND NEW."filled_count" < 1 THEN
    RAISE EXCEPTION 'AYVO: a crate enters FILLING only with a filled member' USING ERRCODE = 'check_violation';
  END IF;
  -- Allocation and its release keep the finished crate exactly as it was.
  IF (OLD."status" = 'ALLOCATED' OR NEW."status" = 'ALLOCATED')
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
  allocated boolean;
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
     OR (cycle."status" IN ('FILLED', 'ALLOCATED') AND (active <> cycle."capacity" OR filled <> cycle."capacity"))
     OR (cycle."status" = 'ABORTED' AND active <> 0) THEN
    RAISE EXCEPTION 'AYVO: cycle status % does not match % members / % filled of %',
      cycle."status", active, filled, cycle."capacity" USING ERRCODE = 'check_violation';
  END IF;
  IF cycle."status" = 'READY_TO_FILL' AND (cycle."ready_to_fill_at" IS NULL OR NOT EXISTS (
       SELECT 1 FROM "crate_events" e WHERE e."cycle_id" = p_cycle_id AND e."type" = 'READY_TO_FILL')) THEN
    RAISE EXCEPTION 'AYVO: READY_TO_FILL without its event' USING ERRCODE = 'check_violation';
  END IF;
  IF cycle."status" IN ('FILLED', 'ALLOCATED') AND NOT EXISTS (
       SELECT 1 FROM "crate_events" e WHERE e."cycle_id" = p_cycle_id AND e."type" = 'CRATE_FILLED'
          AND e."occurred_at" = cycle."filled_at") THEN
    RAISE EXCEPTION 'AYVO: FILLED only by Hotovo (its CRATE_FILLED event)' USING ERRCODE = 'check_violation';
  END IF;
  -- Sticky FILLING: it had a filled member (it may have none now, doc 025 §3.2).
  IF cycle."status" = 'FILLING' AND NOT EXISTS (
       SELECT 1 FROM "crate_assignments" a JOIN "bottles" b ON b."id" = a."bottle_id"
        WHERE a."cycle_id" = p_cycle_id AND b."status" = 'FILLED') THEN
    RAISE EXCEPTION 'AYVO: a FILLING cycle has had a filled member' USING ERRCODE = 'check_violation';
  END IF;
  -- ALLOCATED ⇔ held by exactly one active order allocation (doc 028).
  allocated := EXISTS (SELECT 1 FROM "order_crate_allocations" oa
                        WHERE oa."cycle_id" = p_cycle_id AND oa."released_at" IS NULL);
  IF (cycle."status" = 'ALLOCATED') <> allocated THEN
    RAISE EXCEPTION 'AYVO: a crate cycle is ALLOCATED exactly while an order holds it' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- Crate members never leave an allocated crate (remove the crate from the order first).
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
  IF EXISTS (SELECT 1 FROM "crate_cycles" c WHERE c."id" = OLD."cycle_id" AND c."status" = 'ALLOCATED') THEN
    RAISE EXCEPTION 'AYVO: a bottle never leaves a crate allocated to an order' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =============================================================================================
-- Permissions (doc 028 §4): hotels company-wide; orders and picking at the active site with a
-- warehouse. Granted to ADMIN only (explicitly, doc 021); no other role is extended.
-- =============================================================================================

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('hotels:read', 'View hotels, their delivery address, contact and fulfilment site', false, false, false, NULL),
  ('hotels:manage', 'Create hotels (fulfilment site chosen explicitly)', false, false, false, NULL),
  ('orders:read', 'View the orders of the active site and their picked crates', false, false, true, 'WAREHOUSE'),
  ('orders:manage', 'Create and cancel orders of the active site (cancellation releases its crates)', false, false, true, 'WAREHOUSE'),
  ('orders:pick', 'Pick orders of the active site: load and remove finished crates, complete picking', false, false, true, 'WAREHOUSE');

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'hotels:read'),
  ('ADMIN', 'hotels:manage'),
  ('ADMIN', 'orders:read'),
  ('ADMIN', 'orders:manage'),
  ('ADMIN', 'orders:pick');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
