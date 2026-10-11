-- Milestone 2A (doc 018), part 2 of 2: inventory foundation, supplier receiving, physical label
-- application. Generated tables first; the invariants Prisma cannot express follow at the end.


-- CreateEnum
CREATE TYPE "ComponentType" AS ENUM ('LABEL');

-- CreateEnum
CREATE TYPE "ComponentDisposition" AS ENUM ('REUSED', 'SCRAPPED', 'QUARANTINED', 'CLEANING_REQUIRED', 'RETURNED_TO_SUPPLIER');

-- CreateEnum
CREATE TYPE "UnitDimension" AS ENUM ('COUNT', 'VOLUME', 'MASS');

-- CreateEnum
CREATE TYPE "InventoryItemKind" AS ENUM ('NEW_BOTTLE', 'PUMP', 'LABEL_MEDIA', 'BULK_LIQUID', 'PACKAGING', 'COMPONENT');

-- CreateEnum
CREATE TYPE "LotTracking" AS ENUM ('NONE', 'REQUIRED');

-- CreateEnum
CREATE TYPE "InventoryLotKind" AS ENUM ('SUPPLIER', 'INTERNAL');

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('RECEIPT', 'RECEIPT_CORRECTION', 'LABEL_APPLICATION');

-- CreateEnum
CREATE TYPE "ConsumptionStage" AS ENUM ('LABEL_APPLICATION');

-- CreateEnum
CREATE TYPE "SupplierDocumentKind" AS ENUM ('INVOICE', 'DELIVERY_NOTE', 'OTHER_APPROVED');

-- CreateEnum
CREATE TYPE "GoodsReceiptType" AS ENUM ('PURCHASE');

-- CreateEnum
CREATE TYPE "OperationKind" AS ENUM ('SUPPLIER_CREATE', 'SUPPLIER_ARCHIVE', 'SUPPLIER_DOCUMENT_UPLOAD', 'GOODS_RECEIPT', 'RECEIPT_DOCUMENT_LINK', 'RECEIPT_CORRECTION', 'ITEM_SETTINGS', 'LABEL_APPLICATION');

-- CreateTable
CREATE TABLE "bottle_component_attachments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "bottle_id" UUID NOT NULL,
    "component_type" "ComponentType" NOT NULL,
    "label_qr_url" TEXT,
    "print_job_id" UUID,
    "print_job_position" INTEGER,
    "installed_at" TIMESTAMPTZ(3) NOT NULL,
    "installed_by" UUID,
    "installed_event_id" UUID NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" UUID,
    "removal_reason" TEXT,
    "disposition" "ComponentDisposition",
    "removal_event_id" UUID,

    CONSTRAINT "bottle_component_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_units" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dimension" "UnitDimension" NOT NULL,
    "decimal_places" SMALLINT NOT NULL,

    CONSTRAINT "inventory_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "InventoryItemKind" NOT NULL,
    "base_unit_id" UUID NOT NULL,
    "lot_tracking" "LotTracking" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_item_settings" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "item_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "reorder_point" DECIMAL(19,3),
    "target_level" DECIMAL(19,3),
    "preferred_supplier_id" UUID,
    "lead_time_days" INTEGER,
    "purchase_multiple" DECIMAL(19,3),
    "valid_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "request_id" UUID NOT NULL,

    CONSTRAINT "inventory_item_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_locations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "inventory_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_lots" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "item_id" UUID NOT NULL,
    "kind" "InventoryLotKind" NOT NULL,
    "code" TEXT NOT NULL,
    "supplier_id" UUID,
    "supplier_lot_code" TEXT,
    "origin_receipt_line_id" UUID,
    "expires_on" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "item_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "lot_id" UUID,
    "quantity_delta" DECIMAL(19,3) NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "receipt_line_id" UUID,
    "receipt_correction_id" UUID,
    "bottle_event_id" UUID,
    "bom_line_id" UUID,
    "balance_after" DECIMAL(19,3) NOT NULL DEFAULT 0,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "request_id" UUID,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balances" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "lot_id" UUID,
    "on_hand" DECIMAL(19,3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_versions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "stage" "ConsumptionStage" NOT NULL,
    "valid_from" TIMESTAMPTZ(3) NOT NULL,
    "valid_to" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bom_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "bom_version_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "quantity" DECIMAL(19,3) NOT NULL,

    CONSTRAINT "bom_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "company_id" TEXT,
    "vat_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),
    "request_id" UUID NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_documents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "supplier_id" UUID NOT NULL,
    "kind" "SupplierDocumentKind" NOT NULL,
    "document_number" TEXT NOT NULL,
    "issued_on" DATE NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "content_type" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "supersedes_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "request_id" UUID NOT NULL,

    CONSTRAINT "supplier_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "serial" BIGINT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "GoodsReceiptType" NOT NULL,
    "supplier_id" UUID NOT NULL,
    "supplier_reference" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "request_id" UUID NOT NULL,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_lines" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "quantity" DECIMAL(19,3) NOT NULL,
    "lot_id" UUID,
    "unit_price" DECIMAL(19,4),
    "currency" CHAR(3),
    "vat_rate" DECIMAL(5,2),

    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_documents" (
    "receipt_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "request_id" UUID NOT NULL,

    CONSTRAINT "goods_receipt_documents_pkey" PRIMARY KEY ("receipt_id","document_id")
);

-- CreateTable
CREATE TABLE "goods_receipt_corrections" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "receipt_line_id" UUID NOT NULL,
    "quantity_delta" DECIMAL(19,3) NOT NULL,
    "reason" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "request_id" UUID NOT NULL,

    CONSTRAINT "goods_receipt_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_requests" (
    "request_id" UUID NOT NULL,
    "kind" "OperationKind" NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_requests_pkey" PRIMARY KEY ("request_id")
);

-- CreateIndex
CREATE INDEX "bottle_component_attachments_bottle_id_idx" ON "bottle_component_attachments"("bottle_id");

-- CreateIndex
CREATE INDEX "bottle_component_attachments_installed_event_id_idx" ON "bottle_component_attachments"("installed_event_id");

-- CreateIndex
CREATE INDEX "bottle_component_attachments_print_job_id_print_job_positio_idx" ON "bottle_component_attachments"("print_job_id", "print_job_position");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_units_code_key" ON "inventory_units"("code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_code_key" ON "inventory_items"("code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_id_base_unit_id_key" ON "inventory_items"("id", "base_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_item_settings_request_id_key" ON "inventory_item_settings"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_item_settings_item_id_version_key" ON "inventory_item_settings"("item_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_locations_code_key" ON "inventory_locations"("code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_lots_origin_receipt_line_id_key" ON "inventory_lots"("origin_receipt_line_id");

-- CreateIndex
CREATE INDEX "inventory_lots_item_id_code_idx" ON "inventory_lots"("item_id", "code");

-- CreateIndex
CREATE INDEX "inventory_movements_item_id_location_id_lot_id_recorded_at_idx" ON "inventory_movements"("item_id", "location_id", "lot_id", "recorded_at");

-- CreateIndex
CREATE INDEX "inventory_movements_lot_id_idx" ON "inventory_movements"("lot_id");

-- CreateIndex
CREATE INDEX "inventory_movements_bottle_event_id_idx" ON "inventory_movements"("bottle_event_id");

-- CreateIndex
CREATE INDEX "inventory_movements_receipt_line_id_idx" ON "inventory_movements"("receipt_line_id");

-- CreateIndex
CREATE INDEX "inventory_movements_receipt_correction_id_idx" ON "inventory_movements"("receipt_correction_id");

-- CreateIndex
CREATE INDEX "inventory_balances_item_id_location_id_idx" ON "inventory_balances"("item_id", "location_id");

-- CreateIndex
CREATE INDEX "inventory_balances_lot_id_idx" ON "inventory_balances"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "bom_versions_code_version_key" ON "bom_versions"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "bom_lines_bom_version_id_line_no_key" ON "bom_lines"("bom_version_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_request_id_key" ON "suppliers"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_documents_storage_key_key" ON "supplier_documents"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_documents_request_id_key" ON "supplier_documents"("request_id");

-- CreateIndex
CREATE INDEX "supplier_documents_supplier_id_idx" ON "supplier_documents"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_serial_key" ON "goods_receipts"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_code_key" ON "goods_receipts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_request_id_key" ON "goods_receipts"("request_id");

-- CreateIndex
CREATE INDEX "goods_receipts_supplier_id_idx" ON "goods_receipts"("supplier_id");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_lot_id_idx" ON "goods_receipt_lines"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_lines_receipt_id_line_no_key" ON "goods_receipt_lines"("receipt_id", "line_no");

-- CreateIndex
CREATE INDEX "goods_receipt_documents_document_id_idx" ON "goods_receipt_documents"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_corrections_request_id_key" ON "goods_receipt_corrections"("request_id");

-- CreateIndex
CREATE INDEX "goods_receipt_corrections_receipt_line_id_idx" ON "goods_receipt_corrections"("receipt_line_id");

-- AddForeignKey
ALTER TABLE "bottle_component_attachments" ADD CONSTRAINT "bottle_component_attachments_bottle_id_fkey" FOREIGN KEY ("bottle_id") REFERENCES "bottles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_component_attachments" ADD CONSTRAINT "bottle_component_attachments_print_job_id_print_job_positi_fkey" FOREIGN KEY ("print_job_id", "print_job_position") REFERENCES "label_print_job_items"("print_job_id", "position") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_component_attachments" ADD CONSTRAINT "bottle_component_attachments_installed_event_id_fkey" FOREIGN KEY ("installed_event_id") REFERENCES "bottle_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bottle_component_attachments" ADD CONSTRAINT "bottle_component_attachments_removal_event_id_fkey" FOREIGN KEY ("removal_event_id") REFERENCES "bottle_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_base_unit_id_fkey" FOREIGN KEY ("base_unit_id") REFERENCES "inventory_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item_settings" ADD CONSTRAINT "inventory_item_settings_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item_settings" ADD CONSTRAINT "inventory_item_settings_preferred_supplier_id_fkey" FOREIGN KEY ("preferred_supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_origin_receipt_line_id_fkey" FOREIGN KEY ("origin_receipt_line_id") REFERENCES "goods_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  -- An internal lot and its receipt line are created in the same transaction (lot first).
  DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_id_unit_id_fkey" FOREIGN KEY ("item_id", "unit_id") REFERENCES "inventory_items"("id", "base_unit_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "inventory_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_receipt_line_id_fkey" FOREIGN KEY ("receipt_line_id") REFERENCES "goods_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_receipt_correction_id_fkey" FOREIGN KEY ("receipt_correction_id") REFERENCES "goods_receipt_corrections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_bottle_event_id_fkey" FOREIGN KEY ("bottle_event_id") REFERENCES "bottle_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_bom_line_id_fkey" FOREIGN KEY ("bom_line_id") REFERENCES "bom_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "inventory_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_bom_version_id_fkey" FOREIGN KEY ("bom_version_id") REFERENCES "bom_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_item_id_unit_id_fkey" FOREIGN KEY ("item_id", "unit_id") REFERENCES "inventory_items"("id", "base_unit_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "supplier_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_item_id_unit_id_fkey" FOREIGN KEY ("item_id", "unit_id") REFERENCES "inventory_items"("id", "base_unit_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "inventory_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_documents" ADD CONSTRAINT "goods_receipt_documents_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_documents" ADD CONSTRAINT "goods_receipt_documents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "supplier_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_corrections" ADD CONSTRAINT "goods_receipt_corrections_receipt_line_id_fkey" FOREIGN KEY ("receipt_line_id") REFERENCES "goods_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================================
-- Invariants Prisma cannot express (doc 018). Every rule below is also covered by tests.
-- =============================================================================================

INSERT INTO "code_counters" ("name", "last_value") VALUES ('goods_receipt', 0);

-- --- Shared helpers ---------------------------------------------------------------------------

-- A quantity may not have more decimals than its unit allows (no 0.5 bottle).
CREATE FUNCTION ayvo_assert_unit_scale(p_unit_id uuid, p_quantity numeric, p_what text) RETURNS void
  LANGUAGE plpgsql STABLE
  AS $$
DECLARE
  places smallint;
BEGIN
  IF p_quantity IS NULL THEN
    RETURN;
  END IF;
  SELECT "decimal_places" INTO places FROM "inventory_units" WHERE "id" = p_unit_id;
  IF places IS NULL THEN
    RAISE EXCEPTION 'AYVO: unknown unit for %', p_what USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF round(p_quantity, places) <> p_quantity THEN
    RAISE EXCEPTION 'AYVO: % has more decimals than its unit allows (%)', p_what, places
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- Same, for tables that only reference the item (its base unit applies).
CREATE FUNCTION ayvo_assert_item_scale(p_item_id uuid, p_quantity numeric, p_what text) RETURNS void
  LANGUAGE plpgsql STABLE
  AS $$
BEGIN
  PERFORM ayvo_assert_unit_scale((SELECT "base_unit_id" FROM "inventory_items" WHERE "id" = p_item_id),
                                 p_quantity, p_what);
END
$$;

-- --- Units, items, settings, locations ----------------------------------------------------------

ALTER TABLE "inventory_units"
  ADD CONSTRAINT "inventory_units_code_check" CHECK ("code" ~ '^[a-z]{1,10}$'),
  ADD CONSTRAINT "inventory_units_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 40),
  ADD CONSTRAINT "inventory_units_decimal_places_check" CHECK ("decimal_places" BETWEEN 0 AND 3);
CREATE TRIGGER "inventory_units_immutable" BEFORE UPDATE OR DELETE ON "inventory_units"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "inventory_units_no_truncate" BEFORE TRUNCATE ON "inventory_units"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  ADD CONSTRAINT "inventory_items_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120);

-- Identity of an item never changes; only the name may be edited and the archive is one-way.
CREATE FUNCTION inventory_items_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."base_unit_id" IS DISTINCT FROM OLD."base_unit_id"
     OR NEW."lot_tracking" IS DISTINCT FROM OLD."lot_tracking"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'AYVO: inventory item identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."archived_at" IS NOT NULL AND NEW."archived_at" IS DISTINCT FROM OLD."archived_at" THEN
    RAISE EXCEPTION 'AYVO: an archived inventory item stays archived' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "inventory_items_guard" BEFORE UPDATE ON "inventory_items"
  FOR EACH ROW EXECUTE FUNCTION inventory_items_guard();
CREATE TRIGGER "inventory_items_no_delete" BEFORE DELETE ON "inventory_items"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "inventory_items_no_truncate" BEFORE TRUNCATE ON "inventory_items"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

ALTER TABLE "inventory_item_settings"
  ADD CONSTRAINT "inventory_item_settings_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "inventory_item_settings_quantities_check"
    CHECK (coalesce("reorder_point", 0) >= 0 AND coalesce("target_level", 0) >= 0
           AND ("purchase_multiple" IS NULL OR "purchase_multiple" > 0)
           AND ("reorder_point" IS NULL OR "target_level" IS NULL OR "target_level" >= "reorder_point")),
  ADD CONSTRAINT "inventory_item_settings_lead_time_check"
    CHECK ("lead_time_days" IS NULL OR "lead_time_days" BETWEEN 0 AND 365);
CREATE FUNCTION inventory_item_settings_scale() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM ayvo_assert_item_scale(NEW."item_id", NEW."reorder_point", 'reorder point');
  PERFORM ayvo_assert_item_scale(NEW."item_id", NEW."target_level", 'target level');
  PERFORM ayvo_assert_item_scale(NEW."item_id", NEW."purchase_multiple", 'purchase multiple');
  RETURN NEW;
END
$$;
CREATE TRIGGER "inventory_item_settings_scale" BEFORE INSERT ON "inventory_item_settings"
  FOR EACH ROW EXECUTE FUNCTION inventory_item_settings_scale();
CREATE TRIGGER "inventory_item_settings_immutable" BEFORE UPDATE OR DELETE ON "inventory_item_settings"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "inventory_item_settings_no_truncate" BEFORE TRUNCATE ON "inventory_item_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

ALTER TABLE "inventory_locations"
  ADD CONSTRAINT "inventory_locations_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_-]{1,19}$'),
  ADD CONSTRAINT "inventory_locations_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 80);
CREATE TRIGGER "inventory_locations_immutable" BEFORE UPDATE OR DELETE ON "inventory_locations"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "inventory_locations_no_truncate" BEFORE TRUNCATE ON "inventory_locations"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- Suppliers and supplier documents ---------------------------------------------------------

ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120 AND "name" = btrim("name")),
  ADD CONSTRAINT "suppliers_company_id_check" CHECK ("company_id" IS NULL OR length("company_id") BETWEEN 1 AND 32),
  ADD CONSTRAINT "suppliers_vat_id_check" CHECK ("vat_id" IS NULL OR length("vat_id") BETWEEN 1 AND 32);
CREATE UNIQUE INDEX "suppliers_name_ci_key" ON "suppliers" (lower("name"));
CREATE FUNCTION suppliers_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (to_jsonb(NEW) - 'archived_at') IS DISTINCT FROM (to_jsonb(OLD) - 'archived_at')
     OR OLD."archived_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: suppliers are immutable (only a one-way archive is allowed)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "suppliers_guard" BEFORE UPDATE ON "suppliers"
  FOR EACH ROW EXECUTE FUNCTION suppliers_guard();
CREATE TRIGGER "suppliers_no_delete" BEFORE DELETE ON "suppliers"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "suppliers_no_truncate" BEFORE TRUNCATE ON "suppliers"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

ALTER TABLE "supplier_documents"
  ADD CONSTRAINT "supplier_documents_number_check" CHECK (length(btrim("document_number")) BETWEEN 1 AND 64),
  ADD CONSTRAINT "supplier_documents_byte_size_check" CHECK ("byte_size" > 0),
  ADD CONSTRAINT "supplier_documents_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "supplier_documents_content_type_check"
    CHECK ("content_type" IN ('application/pdf', 'image/jpeg', 'image/png')),
  ADD CONSTRAINT "supplier_documents_filename_check" CHECK (length("original_filename") BETWEEN 1 AND 255),
  ADD CONSTRAINT "supplier_documents_supersedes_check" CHECK ("supersedes_id" IS DISTINCT FROM "id");
CREATE FUNCTION supplier_documents_same_supplier() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."supersedes_id" IS NOT NULL
     AND (SELECT "supplier_id" FROM "supplier_documents" WHERE "id" = NEW."supersedes_id") <> NEW."supplier_id" THEN
    RAISE EXCEPTION 'AYVO: a document can only supersede a document of the same supplier'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "supplier_documents_same_supplier" BEFORE INSERT ON "supplier_documents"
  FOR EACH ROW EXECUTE FUNCTION supplier_documents_same_supplier();
CREATE TRIGGER "supplier_documents_immutable" BEFORE UPDATE OR DELETE ON "supplier_documents"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "supplier_documents_no_truncate" BEFORE TRUNCATE ON "supplier_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- Lots ----------------------------------------------------------------------------------------

ALTER TABLE "inventory_lots"
  ADD CONSTRAINT "inventory_lots_code_check" CHECK (length(btrim("code")) BETWEEN 1 AND 64 AND "code" = btrim("code")),
  ADD CONSTRAINT "inventory_lots_kind_check" CHECK (
    ("kind" = 'SUPPLIER' AND "supplier_id" IS NOT NULL AND "supplier_lot_code" IS NOT NULL
       AND "code" = "supplier_lot_code" AND "origin_receipt_line_id" IS NULL)
    OR ("kind" = 'INTERNAL' AND "origin_receipt_line_id" IS NOT NULL AND "supplier_lot_code" IS NULL));
-- A supplier lot is unique per (item, supplier, supplier lot code): two suppliers may use the same
-- lot code and get separate lots. Internal lot codes ("GR-000001/1") are unique per item.
CREATE UNIQUE INDEX "inventory_lots_supplier_lot_key"
  ON "inventory_lots" ("item_id", "supplier_id", "supplier_lot_code") WHERE "kind" = 'SUPPLIER';
CREATE UNIQUE INDEX "inventory_lots_internal_code_key"
  ON "inventory_lots" ("item_id", "code") WHERE "kind" = 'INTERNAL';
CREATE FUNCTION inventory_lots_item_tracked() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (SELECT "lot_tracking" FROM "inventory_items" WHERE "id" = NEW."item_id") <> 'REQUIRED' THEN
    RAISE EXCEPTION 'AYVO: lots exist only for lot-tracked items' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "inventory_lots_item_tracked" BEFORE INSERT ON "inventory_lots"
  FOR EACH ROW EXECUTE FUNCTION inventory_lots_item_tracked();
-- At commit: an internal lot belongs to exactly the receipt line that created it.
CREATE FUNCTION inventory_lots_internal_origin() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."kind" = 'INTERNAL' AND NOT EXISTS (
       SELECT 1 FROM "goods_receipt_lines"
       WHERE "id" = NEW."origin_receipt_line_id" AND "lot_id" = NEW."id" AND "item_id" = NEW."item_id") THEN
    RAISE EXCEPTION 'AYVO: an internal lot must be the lot of its origin receipt line'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "inventory_lots_internal_origin" AFTER INSERT ON "inventory_lots"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_lots_internal_origin();
CREATE TRIGGER "inventory_lots_immutable" BEFORE UPDATE OR DELETE ON "inventory_lots"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "inventory_lots_no_truncate" BEFORE TRUNCATE ON "inventory_lots"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- Goods receipts, lines, document links, corrections ---------------------------------------

ALTER TABLE "goods_receipts"
  ADD CONSTRAINT "goods_receipts_serial_check" CHECK ("serial" >= 1),
  ADD CONSTRAINT "goods_receipts_code_check" CHECK ("code" = ayvo_format_code('GR-', "serial")),
  ADD CONSTRAINT "goods_receipts_reference_check" CHECK (length(btrim("supplier_reference")) BETWEEN 1 AND 64),
  ADD CONSTRAINT "goods_receipts_note_check" CHECK ("note" IS NULL OR length("note") <= 500);
CREATE FUNCTION goods_receipts_received_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."received_at" > now() + interval '10 minutes' OR NEW."received_at" < timestamptz '2020-01-01' THEN
    RAISE EXCEPTION 'AYVO: receipt date must be between 2020-01-01 and now' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "goods_receipts_received_at" BEFORE INSERT ON "goods_receipts"
  FOR EACH ROW EXECUTE FUNCTION goods_receipts_received_at();
-- At commit: a receipt has lines, and a PURCHASE receipt an invoice or a delivery note.
CREATE FUNCTION goods_receipts_complete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "goods_receipt_lines" WHERE "receipt_id" = NEW."id") THEN
    RAISE EXCEPTION 'AYVO: a goods receipt needs at least one line' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."type" = 'PURCHASE' AND NOT EXISTS (
       SELECT 1 FROM "goods_receipt_documents" l JOIN "supplier_documents" d ON d."id" = l."document_id"
       WHERE l."receipt_id" = NEW."id" AND d."kind" IN ('INVOICE', 'DELIVERY_NOTE')) THEN
    RAISE EXCEPTION 'AYVO: a purchase receipt needs an invoice or a delivery note'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "goods_receipts_complete" AFTER INSERT ON "goods_receipts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION goods_receipts_complete();
CREATE TRIGGER "goods_receipts_immutable" BEFORE UPDATE OR DELETE ON "goods_receipts"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "goods_receipts_no_truncate" BEFORE TRUNCATE ON "goods_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

ALTER TABLE "goods_receipt_lines"
  ADD CONSTRAINT "goods_receipt_lines_line_no_check" CHECK ("line_no" >= 1),
  ADD CONSTRAINT "goods_receipt_lines_quantity_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "goods_receipt_lines_price_check" CHECK (
    ("unit_price" IS NULL) = ("currency" IS NULL)
    AND ("unit_price" IS NULL OR "unit_price" >= 0)
    AND ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$')
    AND ("vat_rate" IS NULL OR ("unit_price" IS NOT NULL AND "vat_rate" BETWEEN 0 AND 100)));
CREATE FUNCTION goods_receipt_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  tracking "LotTracking";
  lot record;
BEGIN
  PERFORM ayvo_assert_unit_scale(NEW."unit_id", NEW."quantity", 'receipt quantity');
  SELECT "lot_tracking" INTO tracking FROM "inventory_items" WHERE "id" = NEW."item_id";
  IF (tracking = 'REQUIRED') <> (NEW."lot_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'AYVO: a lot is required exactly for lot-tracked items' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lot_id" IS NOT NULL THEN
    SELECT * INTO lot FROM "inventory_lots" WHERE "id" = NEW."lot_id";
    IF lot."item_id" <> NEW."item_id" THEN
      RAISE EXCEPTION 'AYVO: the lot belongs to another item' USING ERRCODE = 'check_violation';
    END IF;
    IF lot."kind" = 'SUPPLIER'
       AND lot."supplier_id" <> (SELECT "supplier_id" FROM "goods_receipts" WHERE "id" = NEW."receipt_id") THEN
      RAISE EXCEPTION 'AYVO: a supplier lot can only be received from its supplier' USING ERRCODE = 'check_violation';
    END IF;
    IF lot."kind" = 'INTERNAL' AND lot."origin_receipt_line_id" <> NEW."id" THEN
      RAISE EXCEPTION 'AYVO: an internal lot belongs to exactly one receipt line' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "goods_receipt_lines_guard" BEFORE INSERT ON "goods_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_lines_guard();
-- At commit: every receipt line has posted exactly its RECEIPT movement.
CREATE FUNCTION goods_receipt_lines_posted() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "inventory_movements"
                 WHERE "receipt_line_id" = NEW."id" AND "type" = 'RECEIPT') THEN
    RAISE EXCEPTION 'AYVO: a receipt line must post its stock movement in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "goods_receipt_lines_posted" AFTER INSERT ON "goods_receipt_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION goods_receipt_lines_posted();
CREATE TRIGGER "goods_receipt_lines_immutable" BEFORE UPDATE OR DELETE ON "goods_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "goods_receipt_lines_no_truncate" BEFORE TRUNCATE ON "goods_receipt_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

CREATE FUNCTION goods_receipt_documents_same_supplier() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (SELECT "supplier_id" FROM "supplier_documents" WHERE "id" = NEW."document_id")
     <> (SELECT "supplier_id" FROM "goods_receipts" WHERE "id" = NEW."receipt_id") THEN
    RAISE EXCEPTION 'AYVO: a receipt can only link documents of its supplier' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "goods_receipt_documents_same_supplier" BEFORE INSERT ON "goods_receipt_documents"
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_documents_same_supplier();
-- Document links are append-only: documents can be added to a receipt, never removed.
CREATE TRIGGER "goods_receipt_documents_append_only" BEFORE UPDATE OR DELETE ON "goods_receipt_documents"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "goods_receipt_documents_no_truncate" BEFORE TRUNCATE ON "goods_receipt_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

ALTER TABLE "goods_receipt_corrections"
  ADD CONSTRAINT "goods_receipt_corrections_quantity_check" CHECK ("quantity_delta" <> 0),
  ADD CONSTRAINT "goods_receipt_corrections_reason_check" CHECK (length(btrim("reason")) BETWEEN 3 AND 500);
-- A receipt line is never corrected below zero. The line row lock serialises concurrent
-- corrections of the same line.
CREATE FUNCTION goods_receipt_corrections_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  line record;
  corrected numeric;
BEGIN
  SELECT * INTO line FROM "goods_receipt_lines" WHERE "id" = NEW."receipt_line_id" FOR UPDATE;
  PERFORM ayvo_assert_unit_scale(line."unit_id", NEW."quantity_delta", 'correction quantity');
  SELECT coalesce(sum("quantity_delta"), 0) INTO corrected
    FROM "goods_receipt_corrections" WHERE "receipt_line_id" = NEW."receipt_line_id";
  IF line."quantity" + corrected + NEW."quantity_delta" < 0 THEN
    RAISE EXCEPTION 'AYVO: the correction would make the receipt line negative'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "goods_receipt_corrections_guard" BEFORE INSERT ON "goods_receipt_corrections"
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_corrections_guard();
CREATE FUNCTION goods_receipt_corrections_posted() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "inventory_movements" WHERE "receipt_correction_id" = NEW."id") THEN
    RAISE EXCEPTION 'AYVO: a receipt correction must post its stock movement in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "goods_receipt_corrections_posted" AFTER INSERT ON "goods_receipt_corrections"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION goods_receipt_corrections_posted();
CREATE TRIGGER "goods_receipt_corrections_immutable" BEFORE UPDATE OR DELETE ON "goods_receipt_corrections"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "goods_receipt_corrections_no_truncate" BEFORE TRUNCATE ON "goods_receipt_corrections"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- Consumption rules (BOM) ------------------------------------------------------------------

ALTER TABLE "bom_versions"
  ADD CONSTRAINT "bom_versions_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  ADD CONSTRAINT "bom_versions_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "bom_versions_validity_check" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from");
CREATE TRIGGER "bom_versions_immutable" BEFORE UPDATE OR DELETE ON "bom_versions"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "bom_versions_no_truncate" BEFORE TRUNCATE ON "bom_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

ALTER TABLE "bom_lines"
  ADD CONSTRAINT "bom_lines_line_no_check" CHECK ("line_no" >= 1),
  ADD CONSTRAINT "bom_lines_quantity_check" CHECK ("quantity" > 0);
CREATE FUNCTION bom_lines_scale() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM ayvo_assert_unit_scale(NEW."unit_id", NEW."quantity", 'BOM quantity');
  RETURN NEW;
END
$$;
CREATE TRIGGER "bom_lines_scale" BEFORE INSERT ON "bom_lines"
  FOR EACH ROW EXECUTE FUNCTION bom_lines_scale();
CREATE TRIGGER "bom_lines_immutable" BEFORE UPDATE OR DELETE ON "bom_lines"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "bom_lines_no_truncate" BEFORE TRUNCATE ON "bom_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- The ledger and the protected balance -----------------------------------------------------

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_quantity_check" CHECK ("quantity_delta" <> 0),
  ADD CONSTRAINT "inventory_movements_balance_after_check" CHECK ("balance_after" >= 0),
  ADD CONSTRAINT "inventory_movements_source_check" CHECK (
    ("type" = 'RECEIPT' AND "quantity_delta" > 0 AND "receipt_line_id" IS NOT NULL
       AND "receipt_correction_id" IS NULL AND "bottle_event_id" IS NULL AND "bom_line_id" IS NULL)
    OR ("type" = 'RECEIPT_CORRECTION' AND "receipt_correction_id" IS NOT NULL
       AND "receipt_line_id" IS NULL AND "bottle_event_id" IS NULL AND "bom_line_id" IS NULL)
    OR ("type" = 'LABEL_APPLICATION' AND "quantity_delta" < 0 AND "bottle_event_id" IS NOT NULL
       AND "bom_line_id" IS NOT NULL AND "receipt_line_id" IS NULL AND "receipt_correction_id" IS NULL));
CREATE UNIQUE INDEX "inventory_movements_one_receipt_per_line"
  ON "inventory_movements" ("receipt_line_id") WHERE "type" = 'RECEIPT';
CREATE UNIQUE INDEX "inventory_movements_one_per_correction"
  ON "inventory_movements" ("receipt_correction_id") WHERE "receipt_correction_id" IS NOT NULL;
CREATE UNIQUE INDEX "inventory_movements_one_per_event_bom_line"
  ON "inventory_movements" ("bottle_event_id", "bom_line_id") WHERE "bottle_event_id" IS NOT NULL;

ALTER TABLE "inventory_balances"
  ADD CONSTRAINT "inventory_balances_on_hand_check" CHECK ("on_hand" >= 0);
CREATE UNIQUE INDEX "inventory_balances_item_location_key"
  ON "inventory_balances" ("item_id", "location_id") WHERE "lot_id" IS NULL;
CREATE UNIQUE INDEX "inventory_balances_item_location_lot_key"
  ON "inventory_balances" ("item_id", "location_id", "lot_id") WHERE "lot_id" IS NOT NULL;

-- Posts a movement: validates it against its source and updates the balance in the same
-- statement. A negative balance violates inventory_balances_on_hand_check and aborts the
-- whole transaction. This trigger is the ONLY writer of inventory_balances.
CREATE FUNCTION inventory_movements_post() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  tracking "LotTracking";
  src record;
BEGIN
  PERFORM ayvo_assert_unit_scale(NEW."unit_id", NEW."quantity_delta", 'movement quantity');

  SELECT "lot_tracking" INTO tracking FROM "inventory_items" WHERE "id" = NEW."item_id";
  IF (tracking = 'REQUIRED') <> (NEW."lot_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'AYVO: a lot is required exactly for lot-tracked items' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lot_id" IS NOT NULL
     AND (SELECT "item_id" FROM "inventory_lots" WHERE "id" = NEW."lot_id") <> NEW."item_id" THEN
    RAISE EXCEPTION 'AYVO: the lot belongs to another item' USING ERRCODE = 'check_violation';
  END IF;

  -- The movement must be exactly what its source says.
  IF NEW."type" = 'RECEIPT' THEN
    SELECT * INTO src FROM "goods_receipt_lines" WHERE "id" = NEW."receipt_line_id";
    IF src."item_id" <> NEW."item_id" OR src."lot_id" IS DISTINCT FROM NEW."lot_id"
       OR src."quantity" <> NEW."quantity_delta" THEN
      RAISE EXCEPTION 'AYVO: a receipt movement must match its receipt line' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."type" = 'RECEIPT_CORRECTION' THEN
    SELECT c."quantity_delta", l."item_id", l."lot_id" INTO src
      FROM "goods_receipt_corrections" c JOIN "goods_receipt_lines" l ON l."id" = c."receipt_line_id"
      WHERE c."id" = NEW."receipt_correction_id";
    IF src."item_id" <> NEW."item_id" OR src."lot_id" IS DISTINCT FROM NEW."lot_id"
       OR src."quantity_delta" <> NEW."quantity_delta" THEN
      RAISE EXCEPTION 'AYVO: a correction movement must match its correction' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."type" = 'LABEL_APPLICATION' THEN
    IF (SELECT "type" FROM "bottle_events" WHERE "id" = NEW."bottle_event_id") <> 'LABEL_APPLIED' THEN
      RAISE EXCEPTION 'AYVO: label application stock must be consumed by a LABEL_APPLIED event'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT b."item_id", b."quantity", v."stage" INTO src
      FROM "bom_lines" b JOIN "bom_versions" v ON v."id" = b."bom_version_id"
      WHERE b."id" = NEW."bom_line_id";
    IF src."stage" <> 'LABEL_APPLICATION' OR src."item_id" <> NEW."item_id"
       OR NEW."quantity_delta" <> -src."quantity" THEN
      RAISE EXCEPTION 'AYVO: a label application movement must match its BOM line' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Ensure the balance row exists (at 0), then apply the delta with a plain UPDATE: it takes
  -- the row lock and its CHECK (on_hand >= 0) rejects any overdraw. (An upsert cannot be used:
  -- PostgreSQL checks the proposed insert row — the bare negative delta — before ON CONFLICT.)
  IF NEW."lot_id" IS NULL THEN
    INSERT INTO "inventory_balances" ("item_id", "location_id", "lot_id", "on_hand")
      VALUES (NEW."item_id", NEW."location_id", NULL, 0)
      ON CONFLICT ("item_id", "location_id") WHERE "lot_id" IS NULL DO NOTHING;
    UPDATE "inventory_balances" SET "on_hand" = "on_hand" + NEW."quantity_delta", "updated_at" = now()
      WHERE "item_id" = NEW."item_id" AND "location_id" = NEW."location_id" AND "lot_id" IS NULL
      RETURNING "on_hand" INTO NEW."balance_after";
  ELSE
    INSERT INTO "inventory_balances" ("item_id", "location_id", "lot_id", "on_hand")
      VALUES (NEW."item_id", NEW."location_id", NEW."lot_id", 0)
      ON CONFLICT ("item_id", "location_id", "lot_id") WHERE "lot_id" IS NOT NULL DO NOTHING;
    UPDATE "inventory_balances" SET "on_hand" = "on_hand" + NEW."quantity_delta", "updated_at" = now()
      WHERE "item_id" = NEW."item_id" AND "location_id" = NEW."location_id" AND "lot_id" = NEW."lot_id"
      RETURNING "on_hand" INTO NEW."balance_after";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "inventory_movements_post" BEFORE INSERT ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION inventory_movements_post();
CREATE TRIGGER "inventory_movements_append_only" BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "inventory_movements_no_truncate" BEFORE TRUNCATE ON "inventory_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- Balances change only inside inventory_movements_post (trigger depth >= 2).
CREATE FUNCTION inventory_balances_ledger_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'AYVO: inventory balances change only through the stock ledger'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AYVO: inventory balances are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "inventory_balances_ledger_only" BEFORE INSERT OR UPDATE OR DELETE ON "inventory_balances"
  FOR EACH ROW EXECUTE FUNCTION inventory_balances_ledger_only();
CREATE TRIGGER "inventory_balances_no_truncate" BEFORE TRUNCATE ON "inventory_balances"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- Operational check: rows where a cached balance differs from Σ ledger (expected: none).
CREATE FUNCTION ayvo_inventory_drift()
  RETURNS TABLE ("item_id" uuid, "location_id" uuid, "lot_id" uuid, "on_hand" numeric, "ledger_total" numeric)
  LANGUAGE sql STABLE
  AS $$
  SELECT coalesce(b."item_id", m."item_id"), coalesce(b."location_id", m."location_id"),
         coalesce(b."lot_id", m."lot_id"), b."on_hand", m."total"
  FROM "inventory_balances" b
  FULL JOIN (SELECT "item_id", "location_id", "lot_id", sum("quantity_delta") AS "total"
             FROM "inventory_movements" GROUP BY 1, 2, 3) m
    ON m."item_id" = b."item_id" AND m."location_id" = b."location_id"
       AND m."lot_id" IS NOT DISTINCT FROM b."lot_id"
  WHERE b."on_hand" IS DISTINCT FROM m."total"
$$;

-- --- Bottles: physical label application -------------------------------------------------------

CREATE UNIQUE INDEX "bottle_events_one_label_applied_per_bottle"
  ON "bottle_events" ("bottle_id") WHERE "type" = 'LABEL_APPLIED';
ALTER TABLE "bottle_events"
  ADD CONSTRAINT "bottle_events_label_applied_context_check"
    CHECK ("type" <> 'LABEL_APPLIED' OR "creation_batch_id" IS NULL);

-- Allowed status transitions in this phase: CREATED → LABELED_EMPTY only, never back.
CREATE FUNCTION bottles_status_transition() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'CREATED' AND NEW."status" = 'LABELED_EMPTY') THEN
    RAISE EXCEPTION 'AYVO: bottle status % → % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "bottles_status_transition" BEFORE UPDATE OF "status" ON "bottles"
  FOR EACH ROW EXECUTE FUNCTION bottles_status_transition();

-- At commit: LABELED_EMPTY ⇔ a LABEL_APPLIED event.
CREATE FUNCTION bottles_labeled_has_event() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."status" = 'LABELED_EMPTY' AND NOT EXISTS (
       SELECT 1 FROM "bottle_events" WHERE "bottle_id" = NEW."id" AND "type" = 'LABEL_APPLIED') THEN
    RAISE EXCEPTION 'AYVO: a labelled bottle needs its LABEL_APPLIED event' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "bottles_labeled_has_event" AFTER UPDATE OF "status" ON "bottles"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bottles_labeled_has_event();

-- At commit: a LABEL_APPLIED event comes with the status change, its open LABEL attachment and
-- exactly the stock consumption of one complete LABEL_APPLICATION BOM version. Checked when the
-- event is inserted AND whenever a label-application movement is inserted later, so no
-- movement can ever be added to an already committed event.
CREATE FUNCTION ayvo_assert_label_application_complete(p_event_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  event record;
  versions int;
  consumed int;
  required int;
BEGIN
  SELECT * INTO event FROM "bottle_events" WHERE "id" = p_event_id;
  IF event."type" <> 'LABEL_APPLIED' THEN
    RAISE EXCEPTION 'AYVO: label application stock must be consumed by a LABEL_APPLIED event'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT "status" FROM "bottles" WHERE "id" = event."bottle_id") = 'CREATED' THEN
    RAISE EXCEPTION 'AYVO: LABEL_APPLIED requires the bottle status change' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "bottle_component_attachments"
                 WHERE "installed_event_id" = p_event_id AND "bottle_id" = event."bottle_id"
                   AND "component_type" = 'LABEL') THEN
    RAISE EXCEPTION 'AYVO: LABEL_APPLIED requires its label attachment' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(DISTINCT b."bom_version_id"), count(*) INTO versions, consumed
    FROM "inventory_movements" m JOIN "bom_lines" b ON b."id" = m."bom_line_id"
    WHERE m."bottle_event_id" = p_event_id AND m."type" = 'LABEL_APPLICATION';
  SELECT count(*) INTO required FROM "bom_lines"
    WHERE "bom_version_id" = (SELECT b."bom_version_id" FROM "inventory_movements" m
                              JOIN "bom_lines" b ON b."id" = m."bom_line_id"
                              WHERE m."bottle_event_id" = p_event_id LIMIT 1);
  IF versions <> 1 OR consumed <> required THEN
    RAISE EXCEPTION 'AYVO: LABEL_APPLIED must consume exactly one complete label-application BOM'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION bottle_events_label_applied_complete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."type" = 'LABEL_APPLIED' THEN
    PERFORM ayvo_assert_label_application_complete(NEW."id");
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "bottle_events_label_applied_complete" AFTER INSERT ON "bottle_events"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bottle_events_label_applied_complete();

CREATE FUNCTION inventory_movements_label_application_complete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."type" = 'LABEL_APPLICATION' THEN
    PERFORM ayvo_assert_label_application_complete(NEW."bottle_event_id");
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "inventory_movements_label_application_complete"
  AFTER INSERT ON "inventory_movements"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_movements_label_application_complete();

-- --- Component attachments (doc 018 §15) ------------------------------------------------------

ALTER TABLE "bottle_component_attachments"
  ADD CONSTRAINT "bottle_component_attachments_label_check" CHECK (
    "component_type" <> 'LABEL'
    OR ("label_qr_url" IS NOT NULL AND "print_job_id" IS NOT NULL AND "print_job_position" IS NOT NULL)),
  ADD CONSTRAINT "bottle_component_attachments_removal_check" CHECK (
    (("removed_at" IS NULL) = ("removal_reason" IS NULL)) AND (("removed_at" IS NULL) = ("disposition" IS NULL))
    AND ("removed_at" IS NOT NULL OR ("removed_by" IS NULL AND "removal_event_id" IS NULL))
    AND ("removed_at" IS NULL OR "removed_at" >= "installed_at")
    AND ("removal_reason" IS NULL OR length(btrim("removal_reason")) BETWEEN 3 AND 500));
CREATE UNIQUE INDEX "bottle_component_attachments_one_open_per_type"
  ON "bottle_component_attachments" ("bottle_id", "component_type") WHERE "removed_at" IS NULL;

-- A label attachment carries a label printed for THIS bottle (same URL) by a COMPLETED print job
-- and is installed by a LABEL_APPLIED event of this bottle: a QR identity can never move to
-- another bottle body.
CREATE FUNCTION bottle_component_attachments_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  item record;
  event record;
BEGIN
  SELECT * INTO event FROM "bottle_events" WHERE "id" = NEW."installed_event_id";
  IF event."bottle_id" <> NEW."bottle_id" THEN
    RAISE EXCEPTION 'AYVO: a component is installed by an event of the same bottle' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: a component attachment starts open' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."component_type" = 'LABEL' THEN
    IF event."type" <> 'LABEL_APPLIED' THEN
      RAISE EXCEPTION 'AYVO: a label is installed by a LABEL_APPLIED event' USING ERRCODE = 'check_violation';
    END IF;
    SELECT i."bottle_id", i."qr_url", j."status" INTO item
      FROM "label_print_job_items" i JOIN "label_print_jobs" j ON j."id" = i."print_job_id"
      WHERE i."print_job_id" = NEW."print_job_id" AND i."position" = NEW."print_job_position";
    IF item."bottle_id" <> NEW."bottle_id" OR item."qr_url" <> NEW."label_qr_url" THEN
      RAISE EXCEPTION 'AYVO: the label must be printed for this bottle with exactly this QR URL'
        USING ERRCODE = 'check_violation';
    END IF;
    IF item."status" <> 'COMPLETED' THEN
      RAISE EXCEPTION 'AYVO: only a label of a COMPLETED print job can be applied'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "bottle_component_attachments_insert" BEFORE INSERT ON "bottle_component_attachments"
  FOR EACH ROW EXECUTE FUNCTION bottle_component_attachments_insert();

-- Insert-only, except closing an open attachment exactly once.
CREATE FUNCTION bottle_component_attachments_close_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD."removed_at" IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['removed_at', 'removed_by', 'removal_reason', 'disposition', 'removal_event_id'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['removed_at', 'removed_by', 'removal_reason', 'disposition', 'removal_event_id']) THEN
    RAISE EXCEPTION 'AYVO: a component attachment can only be closed once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "bottle_component_attachments_close_once" BEFORE UPDATE ON "bottle_component_attachments"
  FOR EACH ROW EXECUTE FUNCTION bottle_component_attachments_close_once();
CREATE TRIGGER "bottle_component_attachments_no_delete" BEFORE DELETE ON "bottle_component_attachments"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "bottle_component_attachments_no_truncate" BEFORE TRUNCATE ON "bottle_component_attachments"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- Operation requests (idempotency) ---------------------------------------------------------

ALTER TABLE "operation_requests"
  ADD CONSTRAINT "operation_requests_payload_sha256_check" CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$');
CREATE FUNCTION operation_requests_result_once() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD."result" IS NOT NULL OR NEW."request_id" <> OLD."request_id" OR NEW."kind" <> OLD."kind"
     OR NEW."payload_sha256" <> OLD."payload_sha256" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'AYVO: an operation request is recorded once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "operation_requests_result_once" BEFORE UPDATE ON "operation_requests"
  FOR EACH ROW EXECUTE FUNCTION operation_requests_result_once();
CREATE TRIGGER "operation_requests_no_delete" BEFORE DELETE ON "operation_requests"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "operation_requests_no_truncate" BEFORE TRUNCATE ON "operation_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- --- Reference data (not stock: no receipt, no lot, no supplier is seeded) ---------------------

INSERT INTO "inventory_units" ("code", "name", "dimension", "decimal_places") VALUES
  ('pcs', 'kus', 'COUNT', 0),
  ('ml', 'mililitr', 'VOLUME', 3),
  ('g', 'gram', 'MASS', 3),
  ('sheet', 'arch', 'COUNT', 0),
  ('roll', 'role', 'COUNT', 0);

INSERT INTO "inventory_locations" ("code", "name") VALUES ('MAIN', 'Hlavní sklad');

INSERT INTO "inventory_items" ("code", "name", "kind", "base_unit_id", "lot_tracking")
  SELECT 'NEW_BOTTLE', 'Nová prázdná lahev', 'NEW_BOTTLE', "id", 'REQUIRED'
  FROM "inventory_units" WHERE "code" = 'pcs';

-- Label application consumes exactly one new bottle body (doc 018).
WITH v AS (
  INSERT INTO "bom_versions" ("code", "version", "stage", "valid_from")
  VALUES ('LABEL_APPLICATION', 1, 'LABEL_APPLICATION', timestamptz '2026-10-11 00:00:00+00')
  RETURNING "id"
)
INSERT INTO "bom_lines" ("bom_version_id", "line_no", "item_id", "unit_id", "quantity")
  SELECT v."id", 1, i."id", i."base_unit_id", 1 FROM v, "inventory_items" i WHERE i."code" = 'NEW_BOTTLE';
