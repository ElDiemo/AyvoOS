-- Weights and dimensions (doc 025 §10, PR W1, owner 2026-10-17): measured references for future
-- dispatch. Append-only; unknown = no row (never 0). Nothing existing is changed, no value is seeded.

-- CreateEnum
CREATE TYPE "DimensionSubject" AS ENUM ('CRATE', 'SHIPPING_PACKAGE');

-- CreateEnum
CREATE TYPE "ExtraPackaging" AS ENUM ('NONE', 'CARTON', 'PROTECTIVE_COVER', 'OTHER');

-- AlterEnum
-- CreateTable
CREATE TABLE "item_reference_weights" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "item_id" UUID NOT NULL,
    "mass_g" DECIMAL(12,3) NOT NULL,
    "sample_volume" DECIMAL(12,3),
    "measured_on" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "correction_of_id" UUID,
    "correction_reason" TEXT,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,

    CONSTRAINT "item_reference_weights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_reference_weights" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "product_id" UUID NOT NULL,
    "mass_g" DECIMAL(12,3) NOT NULL,
    "bottles_weighed" INTEGER NOT NULL,
    "measured_on" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "correction_of_id" UUID,
    "correction_reason" TEXT,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,

    CONSTRAINT "product_reference_weights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crate_type_tare_weights" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "crate_type_id" UUID NOT NULL,
    "mass_g" DECIMAL(12,3) NOT NULL,
    "configuration" TEXT NOT NULL,
    "measured_on" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "correction_of_id" UUID,
    "correction_reason" TEXT,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,

    CONSTRAINT "crate_type_tare_weights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crate_type_dimensions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "crate_type_id" UUID NOT NULL,
    "subject" "DimensionSubject" NOT NULL,
    "length_mm" INTEGER NOT NULL,
    "width_mm" INTEGER NOT NULL,
    "height_mm" INTEGER NOT NULL,
    "extra_packaging" "ExtraPackaging",
    "extra_description" TEXT,
    "extra_mass_g" DECIMAL(12,3),
    "extra_in_tare" BOOLEAN,
    "measured_on" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "correction_of_id" UUID,
    "correction_reason" TEXT,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,
    "operation_request_id" UUID NOT NULL,

    CONSTRAINT "crate_type_dimensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crate_cycle_weight_snapshots" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "cycle_id" UUID NOT NULL,
    "crate_event_id" UUID NOT NULL,
    "bottles" INTEGER NOT NULL,
    "product_weight_id" UUID,
    "tare_weight_id" UUID,
    "package_id" UUID,
    "expected_crate_g" DECIMAL(12,3),
    "expected_package_g" DECIMAL(12,3),
    "taken_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "crate_cycle_weight_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "item_reference_weights_operation_request_id_key" ON "item_reference_weights"("operation_request_id");

-- CreateIndex
CREATE INDEX "item_reference_weights_item_id_recorded_at_idx" ON "item_reference_weights"("item_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "product_reference_weights_operation_request_id_key" ON "product_reference_weights"("operation_request_id");

-- CreateIndex
CREATE INDEX "product_reference_weights_product_id_recorded_at_idx" ON "product_reference_weights"("product_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "crate_type_tare_weights_operation_request_id_key" ON "crate_type_tare_weights"("operation_request_id");

-- CreateIndex
CREATE INDEX "crate_type_tare_weights_crate_type_id_recorded_at_idx" ON "crate_type_tare_weights"("crate_type_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "crate_type_dimensions_operation_request_id_key" ON "crate_type_dimensions"("operation_request_id");

-- CreateIndex
CREATE INDEX "crate_type_dimensions_crate_type_id_subject_recorded_at_idx" ON "crate_type_dimensions"("crate_type_id", "subject", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "crate_cycle_weight_snapshots_crate_event_id_key" ON "crate_cycle_weight_snapshots"("crate_event_id");

-- CreateIndex
CREATE INDEX "crate_cycle_weight_snapshots_cycle_id_idx" ON "crate_cycle_weight_snapshots"("cycle_id");

-- AddForeignKey
ALTER TABLE "item_reference_weights" ADD CONSTRAINT "item_reference_weights_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_reference_weights" ADD CONSTRAINT "item_reference_weights_correction_of_id_fkey" FOREIGN KEY ("correction_of_id") REFERENCES "item_reference_weights"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_reference_weights" ADD CONSTRAINT "item_reference_weights_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_reference_weights" ADD CONSTRAINT "item_reference_weights_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reference_weights" ADD CONSTRAINT "product_reference_weights_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reference_weights" ADD CONSTRAINT "product_reference_weights_correction_of_id_fkey" FOREIGN KEY ("correction_of_id") REFERENCES "product_reference_weights"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reference_weights" ADD CONSTRAINT "product_reference_weights_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reference_weights" ADD CONSTRAINT "product_reference_weights_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_type_tare_weights" ADD CONSTRAINT "crate_type_tare_weights_crate_type_id_fkey" FOREIGN KEY ("crate_type_id") REFERENCES "crate_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_type_tare_weights" ADD CONSTRAINT "crate_type_tare_weights_correction_of_id_fkey" FOREIGN KEY ("correction_of_id") REFERENCES "crate_type_tare_weights"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_type_tare_weights" ADD CONSTRAINT "crate_type_tare_weights_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_type_tare_weights" ADD CONSTRAINT "crate_type_tare_weights_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_type_dimensions" ADD CONSTRAINT "crate_type_dimensions_crate_type_id_fkey" FOREIGN KEY ("crate_type_id") REFERENCES "crate_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_type_dimensions" ADD CONSTRAINT "crate_type_dimensions_correction_of_id_fkey" FOREIGN KEY ("correction_of_id") REFERENCES "crate_type_dimensions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_type_dimensions" ADD CONSTRAINT "crate_type_dimensions_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_type_dimensions" ADD CONSTRAINT "crate_type_dimensions_operation_request_id_fkey" FOREIGN KEY ("operation_request_id") REFERENCES "operation_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycle_weight_snapshots" ADD CONSTRAINT "crate_cycle_weight_snapshots_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "crate_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycle_weight_snapshots" ADD CONSTRAINT "crate_cycle_weight_snapshots_crate_event_id_fkey" FOREIGN KEY ("crate_event_id") REFERENCES "crate_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycle_weight_snapshots" ADD CONSTRAINT "crate_cycle_weight_snapshots_product_weight_id_fkey" FOREIGN KEY ("product_weight_id") REFERENCES "product_reference_weights"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycle_weight_snapshots" ADD CONSTRAINT "crate_cycle_weight_snapshots_tare_weight_id_fkey" FOREIGN KEY ("tare_weight_id") REFERENCES "crate_type_tare_weights"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crate_cycle_weight_snapshots" ADD CONSTRAINT "crate_cycle_weight_snapshots_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "crate_type_dimensions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================================
-- Shared rules: positive exact grams, a described method, a measurement date not in the future,
-- a correction names its reason. Every record is immutable (a correction is a new row).
-- =============================================================================================

CREATE FUNCTION ayvo_assert_measured_on(p_measured_on date) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- One day of slack for time zones; a date further in the future is not a measurement.
  IF p_measured_on > (now() AT TIME ZONE 'UTC')::date + 1 THEN
    RAISE EXCEPTION 'AYVO: a measurement date cannot be in the future' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

ALTER TABLE "item_reference_weights"
  ADD CONSTRAINT "item_reference_weights_mass_check" CHECK ("mass_g" > 0),
  ADD CONSTRAINT "item_reference_weights_sample_check" CHECK ("sample_volume" IS NULL OR "sample_volume" > 0),
  ADD CONSTRAINT "item_reference_weights_method_check" CHECK (btrim("method") <> '' AND length("method") <= 500),
  ADD CONSTRAINT "item_reference_weights_correction_check" CHECK (
    ("correction_of_id" IS NULL) = ("correction_reason" IS NULL)
    AND ("correction_reason" IS NULL OR btrim("correction_reason") <> ''));

ALTER TABLE "product_reference_weights"
  ADD CONSTRAINT "product_reference_weights_mass_check" CHECK ("mass_g" > 0),
  ADD CONSTRAINT "product_reference_weights_bottles_check" CHECK ("bottles_weighed" BETWEEN 1 AND 10000),
  ADD CONSTRAINT "product_reference_weights_method_check" CHECK (btrim("method") <> '' AND length("method") <= 500),
  ADD CONSTRAINT "product_reference_weights_correction_check" CHECK (
    ("correction_of_id" IS NULL) = ("correction_reason" IS NULL)
    AND ("correction_reason" IS NULL OR btrim("correction_reason") <> ''));

ALTER TABLE "crate_type_tare_weights"
  ADD CONSTRAINT "crate_type_tare_weights_mass_check" CHECK ("mass_g" > 0),
  ADD CONSTRAINT "crate_type_tare_weights_configuration_check" CHECK (btrim("configuration") <> '' AND length("configuration") <= 500),
  ADD CONSTRAINT "crate_type_tare_weights_method_check" CHECK (btrim("method") <> '' AND length("method") <= 500),
  ADD CONSTRAINT "crate_type_tare_weights_correction_check" CHECK (
    ("correction_of_id" IS NULL) = ("correction_reason" IS NULL)
    AND ("correction_reason" IS NULL OR btrim("correction_reason") <> ''));

ALTER TABLE "crate_type_dimensions"
  ADD CONSTRAINT "crate_type_dimensions_size_check" CHECK (
    "length_mm" BETWEEN 1 AND 10000 AND "width_mm" BETWEEN 1 AND 10000 AND "height_mm" BETWEEN 1 AND 10000),
  ADD CONSTRAINT "crate_type_dimensions_method_check" CHECK (btrim("method") <> '' AND length("method") <= 500),
  -- Only the shipping package has extra packaging; NONE carries nothing else; a real extra
  -- packaging is described and says whether the tare includes it (its mass may stay unknown).
  ADD CONSTRAINT "crate_type_dimensions_packaging_check" CHECK (
    (("subject" = 'CRATE') = ("extra_packaging" IS NULL))
    AND ("extra_packaging" IS DISTINCT FROM 'NONE'
         OR ("extra_description" IS NULL AND "extra_mass_g" IS NULL AND "extra_in_tare" IS NULL))
    AND ("extra_packaging" IS NULL OR "extra_packaging" = 'NONE'
         OR ("extra_description" IS NOT NULL AND btrim("extra_description") <> '' AND "extra_in_tare" IS NOT NULL))
    AND ("subject" = 'SHIPPING_PACKAGE' OR ("extra_description" IS NULL AND "extra_mass_g" IS NULL AND "extra_in_tare" IS NULL))
    AND ("extra_mass_g" IS NULL OR "extra_mass_g" > 0)),
  ADD CONSTRAINT "crate_type_dimensions_correction_check" CHECK (
    ("correction_of_id" IS NULL) = ("correction_reason" IS NULL)
    AND ("correction_reason" IS NULL OR btrim("correction_reason") <> ''));

-- A component weight: grams per base unit of a counted item, or a weighed sample of a stated
-- volume for a volume item (a liquid); never for a mass item (its quantity already is a mass).
CREATE FUNCTION item_reference_weights_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  dim "UnitDimension";
  kind "InventoryItemKind";
BEGIN
  SELECT u."dimension", i."kind" INTO dim, kind
    FROM "inventory_items" i JOIN "inventory_units" u ON u."id" = i."base_unit_id"
   WHERE i."id" = NEW."item_id";
  IF kind NOT IN ('NEW_BOTTLE', 'PUMP', 'LABEL_MEDIA', 'BULK_LIQUID') THEN
    RAISE EXCEPTION 'AYVO: reference weights are kept for bottle bodies, pumps, labels and liquids' USING ERRCODE = 'check_violation';
  END IF;
  IF dim = 'MASS' OR (dim = 'COUNT') <> (NEW."sample_volume" IS NULL) THEN
    RAISE EXCEPTION 'AYVO: a counted item has grams per unit; a volume item a weighed sample of a stated volume' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."correction_of_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "item_reference_weights" w WHERE w."id" = NEW."correction_of_id" AND w."item_id" = NEW."item_id") THEN
    RAISE EXCEPTION 'AYVO: a correction refers to a weight of the same item' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM ayvo_assert_measured_on(NEW."measured_on");
  RETURN NEW;
END
$$;

CREATE FUNCTION product_reference_weights_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."correction_of_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "product_reference_weights" w WHERE w."id" = NEW."correction_of_id" AND w."product_id" = NEW."product_id") THEN
    RAISE EXCEPTION 'AYVO: a correction refers to a weight of the same product' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM ayvo_assert_measured_on(NEW."measured_on");
  RETURN NEW;
END
$$;

CREATE FUNCTION crate_type_tare_weights_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."correction_of_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "crate_type_tare_weights" w WHERE w."id" = NEW."correction_of_id" AND w."crate_type_id" = NEW."crate_type_id") THEN
    RAISE EXCEPTION 'AYVO: a correction refers to a tare of the same crate type' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM ayvo_assert_measured_on(NEW."measured_on");
  RETURN NEW;
END
$$;

CREATE FUNCTION crate_type_dimensions_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."correction_of_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "crate_type_dimensions" d WHERE d."id" = NEW."correction_of_id"
          AND d."crate_type_id" = NEW."crate_type_id" AND d."subject" = NEW."subject") THEN
    RAISE EXCEPTION 'AYVO: a correction refers to dimensions of the same crate type and subject' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM ayvo_assert_measured_on(NEW."measured_on");
  RETURN NEW;
END
$$;

-- The snapshot of a Hotovo: its CRATE_FILLED event, the full crate, references of that cycle's
-- product and crate type (the shipping package dimensions record, not the crate's own).
CREATE FUNCTION crate_cycle_weight_snapshots_insert_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "crate_events" e JOIN "crate_cycles" c ON c."id" = e."cycle_id"
                  WHERE e."id" = NEW."crate_event_id" AND e."type" = 'CRATE_FILLED'
                    AND c."id" = NEW."cycle_id" AND c."capacity" = NEW."bottles") THEN
    RAISE EXCEPTION 'AYVO: a weight snapshot belongs to a Hotovo (CRATE_FILLED) of its full cycle' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."product_weight_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "product_reference_weights" w JOIN "crate_cycles" c ON c."product_id" = w."product_id"
        WHERE w."id" = NEW."product_weight_id" AND c."id" = NEW."cycle_id") THEN
    RAISE EXCEPTION 'AYVO: the snapshot uses a weight of the cycle''s product' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tare_weight_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "crate_type_tare_weights" w JOIN "crate_cycles" c ON c."crate_type_id" = w."crate_type_id"
        WHERE w."id" = NEW."tare_weight_id" AND c."id" = NEW."cycle_id") THEN
    RAISE EXCEPTION 'AYVO: the snapshot uses a tare of the cycle''s crate type' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."package_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "crate_type_dimensions" d JOIN "crate_cycles" c ON c."crate_type_id" = d."crate_type_id"
        WHERE d."id" = NEW."package_id" AND c."id" = NEW."cycle_id" AND d."subject" = 'SHIPPING_PACKAGE') THEN
    RAISE EXCEPTION 'AYVO: the snapshot uses the shipping package of the cycle''s crate type' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."expected_crate_g" IS NOT NULL AND NEW."expected_crate_g" <= 0)
     OR (NEW."expected_package_g" IS NOT NULL AND NEW."expected_package_g" <= 0) THEN
    RAISE EXCEPTION 'AYVO: an expected weight is positive or unknown' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "item_reference_weights_insert_check" BEFORE INSERT ON "item_reference_weights"
  FOR EACH ROW EXECUTE FUNCTION item_reference_weights_insert_check();
CREATE TRIGGER "product_reference_weights_insert_check" BEFORE INSERT ON "product_reference_weights"
  FOR EACH ROW EXECUTE FUNCTION product_reference_weights_insert_check();
CREATE TRIGGER "crate_type_tare_weights_insert_check" BEFORE INSERT ON "crate_type_tare_weights"
  FOR EACH ROW EXECUTE FUNCTION crate_type_tare_weights_insert_check();
CREATE TRIGGER "crate_type_dimensions_insert_check" BEFORE INSERT ON "crate_type_dimensions"
  FOR EACH ROW EXECUTE FUNCTION crate_type_dimensions_insert_check();
CREATE TRIGGER "crate_cycle_weight_snapshots_insert_check" BEFORE INSERT ON "crate_cycle_weight_snapshots"
  FOR EACH ROW EXECUTE FUNCTION crate_cycle_weight_snapshots_insert_check();

CREATE TRIGGER "item_reference_weights_immutable" BEFORE UPDATE OR DELETE ON "item_reference_weights"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "item_reference_weights_no_truncate" BEFORE TRUNCATE ON "item_reference_weights"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "product_reference_weights_immutable" BEFORE UPDATE OR DELETE ON "product_reference_weights"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "product_reference_weights_no_truncate" BEFORE TRUNCATE ON "product_reference_weights"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crate_type_tare_weights_immutable" BEFORE UPDATE OR DELETE ON "crate_type_tare_weights"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crate_type_tare_weights_no_truncate" BEFORE TRUNCATE ON "crate_type_tare_weights"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crate_type_dimensions_immutable" BEFORE UPDATE OR DELETE ON "crate_type_dimensions"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crate_type_dimensions_no_truncate" BEFORE TRUNCATE ON "crate_type_dimensions"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crate_cycle_weight_snapshots_immutable" BEFORE UPDATE OR DELETE ON "crate_cycle_weight_snapshots"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "crate_cycle_weight_snapshots_no_truncate" BEFORE TRUNCATE ON "crate_cycle_weight_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- Permission (doc 025 §7, owner B4): recording weights and dimensions — production supervisor,
-- warehouse supervisor and ADMIN (explicitly). Reading uses catalog:read.
-- =============================================================================================

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('catalog:weights_record', 'Record measured reference weights and dimensions of components, products and crate types (corrections keep the previous value)', false, false, false, NULL);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'catalog:weights_record'),
  ('PRODUCTION_SUPERVISOR', 'catalog:weights_record'),
  ('WAREHOUSE_SUPERVISOR', 'catalog:weights_record');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
