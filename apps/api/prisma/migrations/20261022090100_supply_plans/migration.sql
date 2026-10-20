-- Hotel supply plans and automatic orders (doc 032). Additive; existing orders are MANUAL.

-- ---------------------------------------------------------------------------------------------
-- 1. Hotels: optional practical details (never required of existing hotels).
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "hotels"
  ADD COLUMN "delivery_note" TEXT,
  ADD COLUMN "receiving_contact_name" TEXT,
  ADD COLUMN "receiving_contact_phone" TEXT,
  ADD COLUMN "receiving_contact_email" TEXT,
  ADD CONSTRAINT "hotels_practical_check" CHECK (
    ("delivery_note" IS NULL OR (btrim("delivery_note") <> '' AND length("delivery_note") <= 500))
    AND ("receiving_contact_name" IS NULL OR btrim("receiving_contact_name") <> '')
    AND ("receiving_contact_phone" IS NULL OR btrim("receiving_contact_phone") <> '')
    AND ("receiving_contact_email" IS NULL OR btrim("receiving_contact_email") <> ''));

-- ---------------------------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------------------------

-- One supply plan per hotel (current state; every change audited with its full snapshot).
CREATE TABLE "supply_plans" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "hotel_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    -- Who switched it on last (the creator of its automatic orders) and when.
    "activated_at" TIMESTAMPTZ(3),
    "activated_by" UUID,
    -- The last evaluation by the background round.
    "last_run_at" TIMESTAMPTZ(3),
    "last_run_ok_at" TIMESTAMPTZ(3),
    "last_run_error" TEXT,

    CONSTRAINT "supply_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supply_plans_status_check" CHECK ("status" IN ('INACTIVE', 'ACTIVE', 'PAUSED')),
    CONSTRAINT "supply_plans_version_check" CHECK ("version" >= 1),
    CONSTRAINT "supply_plans_validity_check" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
    CONSTRAINT "supply_plans_activation_check" CHECK (
      ("status" = 'INACTIVE' OR ("activated_at" IS NOT NULL AND "activated_by" IS NOT NULL))
      AND (("activated_at" IS NULL) = ("activated_by" IS NULL)))
);
CREATE UNIQUE INDEX "supply_plans_hotel_id_key" ON "supply_plans"("hotel_id");
CREATE INDEX "supply_plans_site_id_status_idx" ON "supply_plans"("site_id", "status");

-- A rule: product × whole crates × days of the month (1–31; a day a month lacks is skipped).
CREATE TABLE "supply_plan_rules" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "plan_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "crates" INTEGER NOT NULL,
    "days" SMALLINT[] NOT NULL,

    CONSTRAINT "supply_plan_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supply_plan_rules_crates_check" CHECK ("crates" BETWEEN 1 AND 999),
    CONSTRAINT "supply_plan_rules_days_check" CHECK (
      cardinality("days") BETWEEN 1 AND 31 AND 1 <= ALL ("days") AND 31 >= ALL ("days"))
);
CREATE UNIQUE INDEX "supply_plan_rules_plan_id_position_key" ON "supply_plan_rules"("plan_id", "position");

-- One occurrence of a plan = one local ship day of the serving site. UNIQUE per plan and day —
-- whatever the plan's version — so it makes at most one order, ever. ORDERED is final (also when
-- the order is later cancelled or its ship day moved); BLOCKED says why nothing was created.
CREATE TABLE "supply_plan_occurrences" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "plan_id" UUID NOT NULL,
    "ship_date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "order_id" UUID,
    "plan_version" INTEGER NOT NULL,
    -- What was (to be) ordered: lines with product, crates, crate type, capacity, bottles.
    "snapshot" JSONB NOT NULL,
    "blocked_code" TEXT,
    "blocked_detail" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supply_plan_occurrences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supply_plan_occurrences_status_check" CHECK (
      ("status" = 'ORDERED' AND "order_id" IS NOT NULL AND "blocked_code" IS NULL)
      OR ("status" = 'BLOCKED' AND "order_id" IS NULL AND "blocked_code" IS NOT NULL))
);
CREATE UNIQUE INDEX "supply_plan_occurrences_plan_id_ship_date_key" ON "supply_plan_occurrences"("plan_id", "ship_date");
CREATE UNIQUE INDEX "supply_plan_occurrences_order_id_key" ON "supply_plan_occurrences"("order_id");

-- Orders: their origin. A plan's order points to its occurrence (deferred: both are written in
-- one transaction).
ALTER TABLE "orders"
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "supply_occurrence_id" UUID,
  ADD CONSTRAINT "orders_origin_check" CHECK (
    "origin" IN ('MANUAL', 'SUPPLY_PLAN') AND (("origin" = 'SUPPLY_PLAN') = ("supply_occurrence_id" IS NOT NULL)));
CREATE UNIQUE INDEX "orders_supply_occurrence_id_key" ON "orders"("supply_occurrence_id");

ALTER TABLE "supply_plans" ADD CONSTRAINT "supply_plans_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supply_plans" ADD CONSTRAINT "supply_plans_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supply_plans" ADD CONSTRAINT "supply_plans_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supply_plans" ADD CONSTRAINT "supply_plans_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supply_plans" ADD CONSTRAINT "supply_plans_activated_by_fkey" FOREIGN KEY ("activated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supply_plan_rules" ADD CONSTRAINT "supply_plan_rules_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "supply_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supply_plan_rules" ADD CONSTRAINT "supply_plan_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supply_plan_occurrences" ADD CONSTRAINT "supply_plan_occurrences_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "supply_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supply_plan_occurrences" ADD CONSTRAINT "supply_plan_occurrences_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_supply_occurrence_id_fkey" FOREIGN KEY ("supply_occurrence_id")
  REFERENCES "supply_plan_occurrences"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------------------------
-- 3. Rules of the plans
-- ---------------------------------------------------------------------------------------------

-- A plan belongs to its hotel and that hotel's serving site for good; it is never deleted; it
-- moves only INACTIVE → ACTIVE ⇄ PAUSED.
CREATE FUNCTION supply_plans_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: supply plans are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM "hotels" h WHERE h."id" = NEW."hotel_id" AND h."fulfillment_site_id" = NEW."site_id") THEN
      RAISE EXCEPTION 'AYVO: a supply plan belongs to its hotel''s serving site' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'INACTIVE' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'AYVO: a new supply plan starts switched off, version 1' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."hotel_id" <> OLD."hotel_id" OR NEW."site_id" <> OLD."site_id"
     OR NEW."created_at" <> OLD."created_at" OR NEW."created_by" <> OLD."created_by" THEN
    RAISE EXCEPTION 'AYVO: a supply plan''s hotel and site are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'AYVO: a supply plan version never goes back' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" IN ('INACTIVE', 'PAUSED') AND NEW."status" = 'ACTIVE')
    OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'PAUSED')) THEN
    RAISE EXCEPTION 'AYVO: supply plan % → % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "supply_plans_guard" BEFORE INSERT OR UPDATE OR DELETE ON "supply_plans"
  FOR EACH ROW EXECUTE FUNCTION supply_plans_guard();
CREATE TRIGGER "supply_plans_no_truncate" BEFORE TRUNCATE ON "supply_plans"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "supply_plan_rules_no_truncate" BEFORE TRUNCATE ON "supply_plan_rules"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- An occurrence keeps its plan and day; once ORDERED it never changes; never deleted.
CREATE FUNCTION supply_plan_occurrences_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: supply plan occurrences are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."plan_id" <> OLD."plan_id" OR NEW."ship_date" <> OLD."ship_date" OR NEW."id" <> OLD."id" THEN
    RAISE EXCEPTION 'AYVO: an occurrence keeps its plan and day' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'ORDERED' THEN
    RAISE EXCEPTION 'AYVO: an ordered occurrence never changes (its order is the record)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "supply_plan_occurrences_guard" BEFORE UPDATE OR DELETE ON "supply_plan_occurrences"
  FOR EACH ROW EXECUTE FUNCTION supply_plan_occurrences_guard();
CREATE TRIGGER "supply_plan_occurrences_no_truncate" BEFORE TRUNCATE ON "supply_plan_occurrences"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- At commit: an ordered occurrence and its order point to each other, of the plan's hotel and site.
CREATE FUNCTION supply_plan_occurrences_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" = 'ORDERED' AND NOT EXISTS (
       SELECT 1 FROM "orders" o JOIN "supply_plans" p ON p."id" = NEW."plan_id"
        WHERE o."id" = NEW."order_id" AND o."supply_occurrence_id" = NEW."id" AND o."origin" = 'SUPPLY_PLAN'
          AND o."hotel_id" = p."hotel_id" AND o."site_id" = p."site_id") THEN
    RAISE EXCEPTION 'AYVO: an ordered occurrence has its own order of the plan''s hotel and site' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "supply_plan_occurrences_consistent" AFTER INSERT OR UPDATE ON "supply_plan_occurrences"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supply_plan_occurrences_consistent();

CREATE FUNCTION orders_origin_consistent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."origin" = 'SUPPLY_PLAN' AND NOT EXISTS (
       SELECT 1 FROM "supply_plan_occurrences" c
        WHERE c."id" = NEW."supply_occurrence_id" AND c."order_id" = NEW."id" AND c."status" = 'ORDERED') THEN
    RAISE EXCEPTION 'AYVO: an order from a supply plan belongs to its ordered occurrence' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "orders_origin_consistent" AFTER INSERT ON "orders"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orders_origin_consistent();

-- ---------------------------------------------------------------------------------------------
-- 4. Orders: the ship day may be changed explicitly (doc 032 §3) before the hand-over; the
--    origin never changes. Otherwise orders_guard of doc 031 unchanged.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION orders_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  mutable text[] := ARRAY['status','completed_at','completed_by','cancelled_at','cancelled_by','cancel_reason',
                          'requested_ship_date'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: orders are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'AYVO: an order snapshot is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  -- A ship day changes only by itself, before the carrier has the order.
  IF NEW."requested_ship_date" <> OLD."requested_ship_date" AND (
       NEW."status" <> OLD."status" OR OLD."status" NOT IN ('OPEN', 'READY_TO_DISPATCH', 'READY_FOR_PICKUP')) THEN
    RAISE EXCEPTION 'AYVO: the ship day changes only alone, before the hand-over' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('CANCELLED', 'DELIVERED') THEN
    RAISE EXCEPTION 'AYVO: a % order never changes', OLD."status" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'HANDED_TO_CARRIER' AND (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'AYVO: a handed-over order changes only to delivered' USING ERRCODE = 'restrict_violation';
  END IF;
  -- The carrier's proof (every parcel) may move an order on even when "ready for pickup" was not
  -- confirmed; the commit-time check (ayvo_assert_order) requires exactly that proof.
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'OPEN' AND NEW."status" IN ('READY_TO_DISPATCH', 'CANCELLED'))
    OR (OLD."status" = 'READY_TO_DISPATCH' AND NEW."status" IN ('CANCELLED', 'READY_FOR_PICKUP', 'HANDED_TO_CARRIER', 'DELIVERED'))
    OR (OLD."status" = 'READY_FOR_PICKUP' AND NEW."status" IN ('READY_TO_DISPATCH', 'HANDED_TO_CARRIER', 'DELIVERED'))
    OR (OLD."status" = 'HANDED_TO_CARRIER' AND NEW."status" = 'DELIVERED')) THEN
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

-- ---------------------------------------------------------------------------------------------
-- 5. Permission (doc 032 §5): plans managed by ADMIN only for now.
-- ---------------------------------------------------------------------------------------------

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('orders:plan_manage', 'Manage the supply plans of hotels served by the active site: rules, preview, switching on and pausing (orders are created from them automatically)', false, false, true, 'WAREHOUSE');

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'orders:plan_manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
