-- Supplier details and item barcodes (doc 033, owner 2026-10-21). Additive only: existing
-- suppliers keep their values, the new details stay empty (never guessed), receipts and documents
-- are not touched.

-- =============================================================================================
-- Suppliers: optional address, contact and note; corrections as append-only revisions
-- =============================================================================================

ALTER TABLE "suppliers"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "country_code" TEXT,
  ADD COLUMN "address_line1" TEXT,
  ADD COLUMN "address_line2" TEXT,
  ADD COLUMN "postal_code" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "contact_name" TEXT,
  ADD COLUMN "contact_phone" TEXT,
  ADD COLUMN "contact_email" TEXT,
  ADD COLUMN "note" TEXT;

-- A trimmed, non-empty optional text of at most max characters.
CREATE FUNCTION ayvo_optional_text_ok(p_value text, p_max integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT p_value IS NULL OR (length(p_value) BETWEEN 1 AND p_max AND p_value = btrim(p_value)) $$;

ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_revision_check" CHECK ("revision" >= 1),
  ADD CONSTRAINT "suppliers_details_check" CHECK (
    ("country_code" IS NULL OR "country_code" ~ '^[A-Z]{2}$')
    AND ayvo_optional_text_ok("address_line1", 200)
    AND ayvo_optional_text_ok("address_line2", 200)
    AND ayvo_optional_text_ok("postal_code", 20)
    AND ayvo_optional_text_ok("city", 120)
    AND ayvo_optional_text_ok("contact_name", 160)
    AND ("contact_phone" IS NULL OR "contact_phone" ~ '^\+?[0-9 ()/-]{6,30}$')
    AND ("contact_email" IS NULL OR (length("contact_email") <= 254 AND "contact_email" ~ '^[^\s@]+@[^\s@]+$'))
    AND ayvo_optional_text_ok("note", 1000));

-- Every version of a supplier's details. Revision 1 is the state at creation (for suppliers that
-- existed before this migration: their values as they are, without author or reason); every
-- later revision is a correction with its author, reason and request. Never changed or deleted.
CREATE TABLE "supplier_revisions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "supplier_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "company_id" TEXT,
    "vat_id" TEXT,
    "country_code" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "postal_code" TEXT,
    "city" TEXT,
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "note" TEXT,
    "reason" TEXT,
    "changed_by" UUID,
    "request_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_revisions_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "supplier_revisions_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "supplier_revisions_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "supplier_revisions_correction_check" CHECK (
      "revision" = 1
      OR ("reason" IS NOT NULL AND length(btrim("reason")) BETWEEN 3 AND 500
          AND "changed_by" IS NOT NULL AND "request_id" IS NOT NULL)),
    CONSTRAINT "supplier_revisions_details_check" CHECK (
      length(btrim("name")) BETWEEN 1 AND 120 AND "name" = btrim("name")
      AND ("company_id" IS NULL OR length("company_id") BETWEEN 1 AND 32)
      AND ("vat_id" IS NULL OR length("vat_id") BETWEEN 1 AND 32)
      AND ("country_code" IS NULL OR "country_code" ~ '^[A-Z]{2}$')
      AND ayvo_optional_text_ok("address_line1", 200)
      AND ayvo_optional_text_ok("address_line2", 200)
      AND ayvo_optional_text_ok("postal_code", 20)
      AND ayvo_optional_text_ok("city", 120)
      AND ayvo_optional_text_ok("contact_name", 160)
      AND ("contact_phone" IS NULL OR "contact_phone" ~ '^\+?[0-9 ()/-]{6,30}$')
      AND ("contact_email" IS NULL OR (length("contact_email") <= 254 AND "contact_email" ~ '^[^\s@]+@[^\s@]+$'))
      AND ayvo_optional_text_ok("note", 1000))
);
CREATE UNIQUE INDEX "supplier_revisions_supplier_id_revision_key" ON "supplier_revisions"("supplier_id", "revision");
CREATE UNIQUE INDEX "supplier_revisions_request_id_key" ON "supplier_revisions"("request_id");

CREATE TRIGGER "supplier_revisions_append_only" BEFORE UPDATE OR DELETE ON "supplier_revisions"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "supplier_revisions_no_truncate" BEFORE TRUNCATE ON "supplier_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- Revision 1 of every existing supplier: exactly its current values.
INSERT INTO "supplier_revisions" ("supplier_id", "revision", "name", "company_id", "vat_id", "created_at")
SELECT "id", 1, "name", "company_id", "vat_id", "created_at" FROM "suppliers";

-- The details of a supplier row and of a revision, compared as one value.
CREATE FUNCTION ayvo_supplier_details(r jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT jsonb_build_object(
    'name', r->'name', 'company_id', r->'company_id', 'vat_id', r->'vat_id',
    'country_code', r->'country_code', 'address_line1', r->'address_line1',
    'address_line2', r->'address_line2', 'postal_code', r->'postal_code', 'city', r->'city',
    'contact_name', r->'contact_name', 'contact_phone', r->'contact_phone',
    'contact_email', r->'contact_email', 'note', r->'note') $$;

-- The current row changes only (a) by the one-way archive, as before, or (b) to the next
-- revision, which must already be recorded with exactly the new values (same transaction).
-- An archived supplier never changes again.
CREATE OR REPLACE FUNCTION suppliers_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  rev jsonb;
BEGIN
  IF OLD."archived_at" IS NOT NULL THEN
    RAISE EXCEPTION 'AYVO: suppliers are immutable (only a one-way archive is allowed)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'archived_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'archived_at') THEN
    RETURN NEW; -- the archive (or nothing)
  END IF;
  IF NEW."archived_at" IS NOT NULL
     OR NEW."id" <> OLD."id" OR NEW."created_at" <> OLD."created_at"
     OR NEW."request_id" <> OLD."request_id" OR NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'AYVO: a supplier changes only to its next recorded revision'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT to_jsonb(r) INTO rev FROM "supplier_revisions" r
    WHERE r."supplier_id" = NEW."id" AND r."revision" = NEW."revision";
  IF rev IS NULL OR ayvo_supplier_details(rev) IS DISTINCT FROM ayvo_supplier_details(to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'AYVO: a supplier changes only to its next recorded revision'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- A new supplier is created together with its revision 1 (checked at commit).
CREATE FUNCTION suppliers_initial_revision() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  rev jsonb;
BEGIN
  SELECT to_jsonb(r) INTO rev FROM "supplier_revisions" r
    WHERE r."supplier_id" = NEW."id" AND r."revision" = 1;
  IF rev IS NULL THEN
    RAISE EXCEPTION 'AYVO: a supplier is created with its first revision'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "suppliers_initial_revision" AFTER INSERT ON "suppliers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION suppliers_initial_revision();

-- =============================================================================================
-- Item barcodes: several per item, one active assignment per code, retired never deleted
-- =============================================================================================

-- A goods barcode identifies a stock item only (never a supplier, quantity, pack size or lot).
-- Kept apart from the public QR identities of bottles and crates. The value is stored exactly as
-- scanned (text: leading zeros and letters kept), printable ASCII without spaces.
CREATE TABLE "inventory_item_barcodes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "item_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "retired_at" TIMESTAMPTZ(3),
    "retired_by" UUID,
    "retire_reason" TEXT,
    "retire_request_id" UUID,

    CONSTRAINT "inventory_item_barcodes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inventory_item_barcodes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "inventory_item_barcodes_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "inventory_item_barcodes_retired_by_fkey" FOREIGN KEY ("retired_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "inventory_item_barcodes_code_check" CHECK ("code" ~ '^[!-~]{1,64}$'),
    CONSTRAINT "inventory_item_barcodes_retired_check" CHECK (
      ("retired_at" IS NULL AND "retired_by" IS NULL AND "retire_reason" IS NULL AND "retire_request_id" IS NULL)
      OR ("retired_at" IS NOT NULL AND "retired_by" IS NOT NULL AND "retire_request_id" IS NOT NULL
          AND "retire_reason" IS NOT NULL AND length(btrim("retire_reason")) BETWEEN 3 AND 500))
);
CREATE UNIQUE INDEX "inventory_item_barcodes_request_id_key" ON "inventory_item_barcodes"("request_id");
CREATE UNIQUE INDEX "inventory_item_barcodes_retire_request_id_key" ON "inventory_item_barcodes"("retire_request_id");
-- One active assignment per exact code (a retired one may be assigned again).
CREATE UNIQUE INDEX "inventory_item_barcodes_active_code_key" ON "inventory_item_barcodes"("code")
  WHERE "retired_at" IS NULL;
CREATE INDEX "inventory_item_barcodes_item_id_idx" ON "inventory_item_barcodes"("item_id");
CREATE INDEX "inventory_item_barcodes_code_idx" ON "inventory_item_barcodes"("code");

-- Only the one-way retirement changes a row; an archived item gets no new code.
CREATE FUNCTION inventory_item_barcodes_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."retired_at" IS NOT NULL THEN
      RAISE EXCEPTION 'AYVO: a barcode is assigned active' USING ERRCODE = 'restrict_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "inventory_items" WHERE "id" = NEW."item_id" AND "archived_at" IS NOT NULL) THEN
      RAISE EXCEPTION 'AYVO: an archived item gets no barcode' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."retired_at" IS NOT NULL OR NEW."retired_at" IS NULL
     OR (to_jsonb(NEW) - ARRAY['retired_at', 'retired_by', 'retire_reason', 'retire_request_id'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['retired_at', 'retired_by', 'retire_reason', 'retire_request_id']) THEN
    RAISE EXCEPTION 'AYVO: a barcode assignment changes only by its one-way retirement'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "inventory_item_barcodes_guard" BEFORE INSERT OR UPDATE ON "inventory_item_barcodes"
  FOR EACH ROW EXECUTE FUNCTION inventory_item_barcodes_guard();
CREATE TRIGGER "inventory_item_barcodes_no_delete" BEFORE DELETE ON "inventory_item_barcodes"
  FOR EACH ROW EXECUTE FUNCTION ayvo_reject_modification();
CREATE TRIGGER "inventory_item_barcodes_no_truncate" BEFORE TRUNCATE ON "inventory_item_barcodes"
  FOR EACH STATEMENT EXECUTE FUNCTION ayvo_reject_modification();

-- =============================================================================================
-- Permissions: new administration, ADMIN only (doc 021: granted explicitly, never by code)
-- =============================================================================================

SELECT set_config('ayvo.catalogue_migration', 'on', false);

INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability") VALUES
  ('procurement:suppliers_edit', 'Correct supplier details (identification, address, contact, note) with a reason; every version kept', true, false, false, 'WAREHOUSE'),
  ('inventory:barcodes_manage', 'Assign goods barcodes to stock items and retire them with a reason (never deleted)', true, false, false, 'WAREHOUSE');

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('ADMIN', 'procurement:suppliers_edit'),
  ('ADMIN', 'inventory:barcodes_manage');

SELECT set_config('ayvo.catalogue_migration', 'off', false);
