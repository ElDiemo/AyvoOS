-- Site ownership of production and purchasing records; purchase-price completion (doc 021, doc 022).
--
-- ADDITIVE: existing creation series, bottles, print jobs and supplier documents are assigned to
-- the initial site SITE-1 through column defaults (no UPDATE of immutable rows, no trigger
-- bypass), then the defaults are dropped. No bottle, event, movement or document is created.
-- The only grant removed is `production:templates_manage` from PRODUCTION_SUPERVISOR: label
-- templates are company-wide brand data and are no longer changed by a site-bound role.

-- =============================================================================================
-- Production records belong to the site that created them
-- =============================================================================================

ALTER TABLE "bottle_creation_batches"
  ADD COLUMN "site_id" UUID NOT NULL DEFAULT '01990000-0000-7000-8000-000000000001';
ALTER TABLE "bottle_creation_batches" ALTER COLUMN "site_id" DROP DEFAULT;
ALTER TABLE "bottle_creation_batches" ADD CONSTRAINT "bottle_creation_batches_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "bottle_creation_batches_id_site_id_key" ON "bottle_creation_batches"("id", "site_id");
CREATE INDEX "bottle_creation_batches_site_id_serial_idx" ON "bottle_creation_batches"("site_id", "serial");

-- A bottle and a print job always have their series' site (composite foreign keys).
ALTER TABLE "bottles"
  ADD COLUMN "site_id" UUID NOT NULL DEFAULT '01990000-0000-7000-8000-000000000001';
ALTER TABLE "bottles" ALTER COLUMN "site_id" DROP DEFAULT;
ALTER TABLE "bottles" DROP CONSTRAINT "bottles_creation_batch_id_fkey";
ALTER TABLE "bottles" ADD CONSTRAINT "bottles_creation_batch_id_site_id_fkey" FOREIGN KEY ("creation_batch_id", "site_id") REFERENCES "bottle_creation_batches"("id", "site_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bottles" ADD CONSTRAINT "bottles_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "bottles_site_id_serial_idx" ON "bottles"("site_id", "serial");

ALTER TABLE "label_print_jobs"
  ADD COLUMN "site_id" UUID NOT NULL DEFAULT '01990000-0000-7000-8000-000000000001';
ALTER TABLE "label_print_jobs" ALTER COLUMN "site_id" DROP DEFAULT;
ALTER TABLE "label_print_jobs" DROP CONSTRAINT "label_print_jobs_creation_batch_id_fkey";
ALTER TABLE "label_print_jobs" ADD CONSTRAINT "label_print_jobs_creation_batch_id_site_id_fkey" FOREIGN KEY ("creation_batch_id", "site_id") REFERENCES "bottle_creation_batches"("id", "site_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "label_print_jobs" ADD CONSTRAINT "label_print_jobs_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "label_print_jobs_site_id_serial_idx" ON "label_print_jobs"("site_id", "serial");

-- No implicit transfer: a bottle's and a print job's site never change (future transfers are
-- explicit, audited business operations with their own records).
CREATE FUNCTION site_id_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."site_id" <> OLD."site_id" THEN
    RAISE EXCEPTION 'AYVO: the site of % never changes (no implicit transfer)', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "bottles_site_immutable" BEFORE UPDATE ON "bottles"
  FOR EACH ROW EXECUTE FUNCTION site_id_immutable();
CREATE TRIGGER "label_print_jobs_site_immutable" BEFORE UPDATE ON "label_print_jobs"
  FOR EACH ROW EXECUTE FUNCTION site_id_immutable();

-- A label application consumes stock of the bottle's own site.
CREATE FUNCTION inventory_movements_label_site() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."bottle_event_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "bottle_events" e
       JOIN "bottles" b ON b."id" = e."bottle_id"
       JOIN "inventory_locations" l ON l."id" = NEW."location_id"
       WHERE e."id" = NEW."bottle_event_id" AND b."site_id" = l."site_id") THEN
    RAISE EXCEPTION 'AYVO: a bottle consumes stock only at its own site'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "inventory_movements_label_site" BEFORE INSERT ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION inventory_movements_label_site();

-- =============================================================================================
-- Purchasing paperwork belongs to the receiving site
-- =============================================================================================

ALTER TABLE "supplier_documents"
  ADD COLUMN "site_id" UUID NOT NULL DEFAULT '01990000-0000-7000-8000-000000000001';
ALTER TABLE "supplier_documents" ALTER COLUMN "site_id" DROP DEFAULT;
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "supplier_documents_site_id_supplier_id_idx" ON "supplier_documents"("site_id", "supplier_id");

-- A receipt links only documents of its own site; a correcting document stays at its site.
CREATE FUNCTION goods_receipt_documents_site() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM "goods_receipts" r JOIN "supplier_documents" d ON d."site_id" = r."site_id"
       WHERE r."id" = NEW."receipt_id" AND d."id" = NEW."document_id") THEN
    RAISE EXCEPTION 'AYVO: a receipt links only documents of its own site'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "goods_receipt_documents_site" BEFORE INSERT ON "goods_receipt_documents"
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_documents_site();

CREATE FUNCTION supplier_documents_site() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW."supersedes_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "supplier_documents" d
       WHERE d."id" = NEW."supersedes_id" AND d."site_id" = NEW."site_id") THEN
    RAISE EXCEPTION 'AYVO: a document supersedes only a document of its own site'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "supplier_documents_site" BEFORE INSERT ON "supplier_documents"
  FOR EACH ROW EXECUTE FUNCTION supplier_documents_site();

-- --- Purchase-price completion and corrections (append-only) ---------------------------------

-- Idempotent completion/correction requests (not used inside this migration).
ALTER TYPE "OperationKind" ADD VALUE 'RECEIPT_LINE_COST';

CREATE TABLE "goods_receipt_line_costs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "receipt_line_id" UUID NOT NULL,
    "unit_price" DECIMAL(19,4),
    "currency" CHAR(3),
    "vat_rate" DECIMAL(5,2),
    "reason" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipt_line_costs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "goods_receipt_line_costs_request_id_key" ON "goods_receipt_line_costs"("request_id");
CREATE INDEX "goods_receipt_line_costs_receipt_line_id_recorded_at_idx" ON "goods_receipt_line_costs"("receipt_line_id", "recorded_at");
ALTER TABLE "goods_receipt_line_costs" ADD CONSTRAINT "goods_receipt_line_costs_receipt_line_id_fkey" FOREIGN KEY ("receipt_line_id") REFERENCES "goods_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_line_costs" ADD CONSTRAINT "goods_receipt_line_costs_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt_line_costs"
  ADD CONSTRAINT "goods_receipt_line_costs_price_check" CHECK (
    ("unit_price" IS NULL) = ("currency" IS NULL)
    AND ("vat_rate" IS NULL OR "unit_price" IS NOT NULL)
    AND ("unit_price" IS NULL OR "unit_price" >= 0)
    AND ("vat_rate" IS NULL OR "vat_rate" BETWEEN 0 AND 100)
    AND ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$')),
  ADD CONSTRAINT "goods_receipt_line_costs_reason_check" CHECK (length(btrim("reason")) BETWEEN 3 AND 500);

CREATE FUNCTION goods_receipt_line_costs_site() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM "goods_receipt_lines" l JOIN "goods_receipts" r ON r."id" = l."receipt_id"
       WHERE l."id" = NEW."receipt_line_id" AND r."site_id" = NEW."site_id") THEN
    RAISE EXCEPTION 'AYVO: a price is recorded at the receipt''s own site'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "goods_receipt_line_costs_site" BEFORE INSERT ON "goods_receipt_line_costs"
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_line_costs_site();
CREATE TRIGGER "goods_receipt_line_costs_append_only" BEFORE UPDATE OR DELETE ON "goods_receipt_line_costs"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "goods_receipt_line_costs_no_truncate" BEFORE TRUNCATE ON "goods_receipt_line_costs"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- Catalogue: where each permission applies; cost writing; global templates
-- =============================================================================================

SELECT set_config('ayvo.catalogue_migration', 'on', false);

ALTER TABLE "permissions"
  ADD COLUMN "site_scoped" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "site_capability" "SiteCapability";
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_scope_check" CHECK (
  NOT ("site_scoped" AND "warehouse_scoped")
  AND ("site_capability" IS NULL OR "site_scoped" OR "warehouse_scoped"));

-- Warehouse-bound: the active site must run a warehouse.
UPDATE "permissions" SET "site_capability" = 'WAREHOUSE' WHERE "warehouse_scoped";
-- Site-bound production: series, bottles, print jobs, label applications of the active site.
UPDATE "permissions" SET "site_scoped" = true, "site_capability" = 'PRODUCTION'
  WHERE "code" IN ('production:read', 'production:bottles_create', 'production:labels_print');
-- Site-bound purchasing values and paperwork of the receiving site.
UPDATE "permissions" SET "site_scoped" = true
  WHERE "code" IN ('procurement:cost_read', 'procurement:documents_read');
UPDATE "permissions"
  SET "description" = 'Create and change company-wide label templates and artwork (global brand data)'
  WHERE "code" = 'production:templates_manage';

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped")
VALUES ('procurement:cost_write', 'Record and correct purchase prices, currencies and VAT rates of receipts of the active site', false, false, true);

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'procurement:cost_write'),
  ('FINANCE', 'procurement:cost_write');
-- A site-bound production supervisor no longer changes company-wide templates (ADMIN does, or
-- a custom role ADMIN creates deliberately).
DELETE FROM "role_permissions"
  WHERE "role_code" = 'PRODUCTION_SUPERVISOR' AND "permission_code" = 'production:templates_manage';

SELECT set_config('ayvo.catalogue_migration', 'off', false);
